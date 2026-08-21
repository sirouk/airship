import { useId, useState } from "preact/hooks";
import type { JournalBackend, JournalStateSource } from "../core/journal";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import {
  applyWorkBundleImport,
  collectWorkBundle,
  isSealedWorkBundle,
  openSealedWorkBundle,
  parseWorkBundle,
  planWorkBundleImport,
  sealWorkBundle,
  serializeWorkBundle,
  supportsPortableSeal,
  verifyWorkBundleChain,
  workBundleFileName,
  WORK_BUNDLE_MEDIA_TYPE,
  type WorkBundle,
  type WorkBundleImportPlan,
  type WorkBundleImportResult,
} from "../sessions/work-bundle";
import type { WorkspacePort } from "../workspace/contracts";
import { downloadBytes, downloadText } from "./file-download";
import "./work-bundle-view.css";

export type WorkBundleRow = Readonly<{ id: string; title: string; events: number }>;

export type WorkBundleViewProps = Readonly<{
  /** The read side of this device's journal: what an export copies from. */
  journal: JournalStateSource;
  /** The write side: what an import merges into, through `migrateJournalState`. */
  target: JournalBackend;
  conversations: readonly WorkBundleRow[];
  profileId: string;
  profileName: string;
  /** The active profile's workspace, which is where memory.json lives. */
  workspace?: WorkspacePort;
  /** The storage authority. Sealing is offered only when it holds a Vault key. */
  storage?: unknown;
  /**
   * Whether `target` is the authority that will still be here when the merge
   * lands. See `WORK_BUNDLE_AUTHORITY_UNSETTLED`.
   */
  authoritySettled: boolean;
  onImported?: () => void | Promise<void>;
}>;

/**
 * Why bringing work in is refused while this device is still deciding where
 * its work lives.
 *
 * Measured on the first thing a person does on a new device: with a Local
 * Device Vault configured, the page-memory runtime boots first, adoption reads
 * that journal and then replaces it. An import that lands inside that window
 * is written into the journal being replaced — the panel said "1 conversation
 * added", the list held it for a moment, and it was gone after the adoption,
 * after Refresh and after a reload.
 *
 * Refused rather than queued, for the same reason the rest of this panel
 * refuses rather than merges: a queued import would run against a journal
 * nobody has looked at since, and the file is still on disk to choose again.
 * The chat route already waits for this same settled-authority signal before
 * it answers for an address.
 */
export const WORK_BUNDLE_AUTHORITY_UNSETTLED =
  "This device is still opening the storage its work lives in. Adding now would write into the journal it is about"
  + " to replace, so this is refused rather than queued. Nothing changed; choose the file again once it is open.";

type Incoming = Readonly<{
  name: string;
  sealed: boolean;
  bundle: WorkBundle;
  plan: WorkBundleImportPlan;
}>;

/**
 * The one place a person's work becomes a file, and comes back from one.
 *
 * Fetched only when someone asks to move work; nothing here is on the startup
 * path. It states, before it writes anything, how many conversations arrive,
 * which are already present, which are refused, and what it will not touch —
 * and it refuses rather than merges, because the alternative is a silent
 * overwrite of something a person cannot get back.
 */
export function WorkBundleView({
  journal,
  target,
  conversations,
  profileId,
  profileName,
  workspace,
  storage,
  authoritySettled,
  onImported,
}: WorkBundleViewProps) {
  const seal = supportsPortableSeal(storage) ? storage : undefined;
  /*
   * `undefined` is "everything, because nothing has been unpicked yet".
   *
   * Seeding the state with the list at mount looked equivalent and was not: a
   * `useState` initializer runs once, so opening this panel while the journal
   * read was still in flight left every row unchecked and the count reading
   * "0 of 12" over a full list.
   */
  const [chosen, setChosen] = useState<readonly string[]>();
  const selected = chosen ?? conversations.map((row) => row.id);
  const [withMemory, setWithMemory] = useState(false);
  /*
   * Bringing memory in is a second decision, and it starts as "no".
   *
   * The button says how many conversations will be added. It used to add every
   * memory record in the file as well, whatever it said, because the caller
   * passed `includeMemory` whenever the file had a memory section at all.
   */
  const [addMemory, setAddMemory] = useState(false);
  const [sealed, setSealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string>();
  const [incoming, setIncoming] = useState<Incoming>();
  const [outcome, setOutcome] = useState<WorkBundleImportResult>();
  const formatId = useId();
  const headingId = useId();

  function toggle(id: string): void {
    setChosen(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  }

  async function exportBundle(): Promise<void> {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const exportedAt = new Date().toISOString();
      const bundle = await collectWorkBundle({
        journal,
        sessionIds: conversations.filter((row) => selected.includes(row.id)).map((row) => row.id),
        exportedAt,
        ...(withMemory && workspace ? { memory: { workspace, profileId } } : {}),
      });
      const useSeal = sealed ? seal : undefined;
      const filename = workBundleFileName(exportedAt, Boolean(useSeal));
      if (useSeal) downloadBytes(await sealWorkBundle(useSeal, bundle), filename, WORK_BUNDLE_MEDIA_TYPE);
      else downloadText(serializeWorkBundle(bundle), filename, WORK_BUNDLE_MEDIA_TYPE);
      setAnnouncement(
        `${filename} written with ${countLabel(bundle.conversations.length)}`
        + `${bundle.memory ? ` and ${String(bundle.memory.records.length)} memory records` : " and no memory records"}. `
        + (useSeal
          ? "It is sealed with this Vault's key: only Airship, opened against this same Vault, can read it."
          : "It is readable JSON: anyone who holds this file can read every message in it."),
      );
    } catch (failure) {
      setError(reason(failure, "The bundle could not be written. Nothing left this browser."));
    } finally {
      setBusy(false);
    }
  }

  async function inspect(file: File): Promise<void> {
    setBusy(true);
    setError(undefined);
    setOutcome(undefined);
    setIncoming(undefined);
    try {
      const text = await file.text();
      const isSealed = isSealedWorkBundle(text);
      if (isSealed && !seal) {
        throw new Error("That bundle is sealed, and no Vault is open here to unseal it.");
      }
      const bundle = isSealed && seal
        ? await openSealedWorkBundle(seal, new TextEncoder().encode(text))
        : parseWorkBundle(text);
      const chain = await verifyWorkBundleChain(bundle);
      const plan = await planWorkBundleImport({ bundle, journal, chain, workspace, profileId });
      setAddMemory(false);
      setIncoming(Object.freeze({ name: file.name, sealed: isSealed, bundle, plan }));
      setAnnouncement(planSentence(plan));
    } catch (failure) {
      setError(reason(failure, "That file could not be read as an Airship bundle. Nothing changed."));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (busy || !incoming) return;
    // The gate, not a caveat: the button below is already disabled, and this
    // is what answers a call that reached here anyway.
    if (!authoritySettled) {
      setError(WORK_BUNDLE_AUTHORITY_UNSETTLED);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // The merge primitive lives in the deferred capability pack, and is
      // fetched at the moment it is used rather than when this panel opens.
      const { migrateJournalState } = await loadDeferredCapabilities();
      const result = await applyWorkBundleImport({
        bundle: incoming.bundle,
        plan: incoming.plan,
        target,
        migrate: migrateJournalState,
        workspace,
        profileId,
        includeMemory: addMemory,
      });
      setOutcome(result);
      setIncoming(undefined);
      setAnnouncement(resultSentence(result));
      await onImported?.();
    } catch (failure) {
      setError(reason(failure, "The import stopped. Conversations already added stay added; nothing was overwritten."));
    } finally {
      setBusy(false);
    }
  }

  const importable = incoming?.plan.conversations.filter((entry) => entry.state === "new").length ?? 0;
  const offeredMemory = incoming?.plan.memory;
  const addableMemory = addMemory ? offeredMemory?.add ?? 0 : 0;

  return (
    <section class="work-bundle" aria-labelledby={headingId}>
      <h2 class="work-bundle__heading" id={headingId}>Move work in or out</h2>
      <p class="work-bundle__lede">
        A bundle is one file that holds the conversations you pick, and — if you ask — the memory records
        written under {profileName}. It is not a backup of your Vault key: this file cannot restore a Vault,
        and losing the key still loses the Vault.
      </p>

      <div class="work-bundle__columns">
        <div class="work-bundle__column">
          <h3 class="work-bundle__subhead">Take work out</h3>
          <fieldset class="work-bundle__set">
            <legend class="eyebrow">Conversations ({String(selected.length)} of {String(conversations.length)})</legend>
            <div class="work-bundle__actions">
              <button class="small-button" type="button" onClick={() => setChosen(conversations.map((row) => row.id))}>
                Select all
              </button>
              <button class="small-button" type="button" onClick={() => setChosen([])}>Clear</button>
            </div>
            <ul class="work-bundle__list">
              {conversations.map((row) => (
                <li key={row.id}>
                  <label class="work-bundle__check">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                    <span class="work-bundle__title">{row.title}</span>
                    <small>{countLabel(row.events, "event")}</small>
                  </label>
                </li>
              ))}
            </ul>
            {conversations.length === 0 ? <p class="work-bundle__note">There is nothing here to take out yet.</p> : null}
          </fieldset>

          <label class="work-bundle__check work-bundle__check--wide">
            <input
              type="checkbox"
              checked={withMemory && Boolean(workspace)}
              disabled={!workspace}
              onChange={() => setWithMemory((current) => !current)}
            />
            <span>Include the memory records written under {profileName}</span>
          </label>

          <fieldset class="work-bundle__set" aria-describedby={formatId}>
            <legend class="eyebrow">Format</legend>
            <label class="work-bundle__check work-bundle__check--wide">
              <input type="radio" name="work-bundle-format" checked={!sealed} onChange={() => setSealed(false)} />
              <span>Readable JSON — any software that reads JSON can read it</span>
            </label>
            <label class="work-bundle__check work-bundle__check--wide">
              <input
                type="radio"
                name="work-bundle-format"
                checked={sealed && Boolean(seal)}
                disabled={!seal}
                onChange={() => setSealed(true)}
              />
              <span>Sealed with this Vault&rsquo;s key</span>
            </label>
            <p class="work-bundle__note" id={formatId}>
              {sealed && seal
                ? "Sealed uses this Vault's own encryption. Only Airship, opened against this same Vault, can read it back — no other software can, and neither can Airship on a different Vault."
                : seal
                  ? "Readable means plaintext. Every message is in the file in the clear, and anyone who holds it can read them."
                  : "Readable means plaintext. Every message is in the file in the clear. Sealing needs an open Vault; this browser is not using one."}
            </p>
          </fieldset>

          <button class="primary" type="button" disabled={busy || selected.length === 0} onClick={() => void exportBundle()}>
            Write bundle file
          </button>
        </div>

        <div class="work-bundle__column">
          <h3 class="work-bundle__subhead">Bring work in</h3>
          <label class="work-bundle__file">
            <span>Choose a bundle file</span>
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                input.value = "";
                if (file) void inspect(file);
              }}
            />
          </label>

          {incoming ? (
            <div class="work-bundle__preview">
              <p class="work-bundle__note">
                {incoming.name} · {incoming.sealed ? "sealed, opened with this Vault" : "readable JSON"} ·
                {" "}written {incoming.plan.exportedAt}
              </p>
              <p>{planSentence(incoming.plan)}</p>
              <ul class="work-bundle__list work-bundle__list--plain">
                {incoming.plan.conversations.map((entry) => (
                  <li key={entry.sessionId}>
                    <span class="work-bundle__title">{entry.title}</span>
                    <small class={entry.state === "new" || entry.state === "present" ? undefined : "work-bundle__refused"}>
                      {stateWord(entry.state)}{entry.reason ? ` — ${entry.reason}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
              {offeredMemory ? (
                <label class="work-bundle__check work-bundle__check--wide">
                  <input type="checkbox" checked={addMemory} onChange={() => setAddMemory((current) => !current)} />
                  <span>
                    Also add {String(offeredMemory.add)} of this file&rsquo;s memory records to {profileName}
                    {offeredMemory.foreign > 0
                      ? `. ${String(offeredMemory.foreign)} are written for another profile and cannot be added here.`
                      : "."}
                  </span>
                </label>
              ) : null}
              <p class="work-bundle__note">{untouchedSentence(incoming.plan, addMemory)}</p>
              {authoritySettled ? null : <p class="work-bundle__refused">{WORK_BUNDLE_AUTHORITY_UNSETTLED}</p>}
              <button
                class="primary"
                type="button"
                disabled={busy || !authoritySettled || (importable === 0 && addableMemory === 0)}
                onClick={() => void runImport()}
              >
                {!authoritySettled
                  ? "Waiting for this storage"
                  : importable === 0 && addableMemory === 0
                    ? "Nothing here to add"
                    : `Add ${countLabel(importable)}${addableMemory > 0 ? ` and ${String(addableMemory)} memory records` : ""}`}
              </button>
            </div>
          ) : null}

          {outcome ? (
            <div class="work-bundle__preview">
              <p>{resultSentence(outcome)}</p>
              <ul class="work-bundle__list work-bundle__list--plain">
                {outcome.conversations.map((entry) => (
                  <li key={entry.sessionId}>
                    <span class="work-bundle__title">{entry.title}</span>
                    <small class={entry.outcome === "refused" ? "work-bundle__refused" : undefined}>
                      {entry.outcome}{entry.reason ? ` — ${entry.reason}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <p class="work-bundle__refused" role="alert">{error}</p> : null}
      <p class="work-bundle__status" role="status">{announcement}</p>
    </section>
  );
}

/** Exactly what the plan found, in the order a person needs to hear it. */
export function planSentence(plan: WorkBundleImportPlan): string {
  const counts = countStates(plan);
  const parts = [`This bundle holds ${countLabel(plan.conversations.length)}.`];
  parts.push(`${String(counts.new)} will be added.`);
  if (counts.present > 0) parts.push(`${String(counts.present)} ${counts.present === 1 ? "is" : "are"} already here and will be skipped.`);
  // Two things are refused as a conflict and the sentence has to admit both:
  // a different conversation already under that id, and a conversation the
  // file addresses to a profile that is not the one doing the importing. The
  // row below each states which; this is the count, and it names the pair.
  if (counts.conflict > 0) parts.push(`${String(counts.conflict)} will be refused: different work under that id, or another profile's.`);
  if (counts.unreadable > 0) parts.push(`${String(counts.unreadable)} will be refused: the digest chain did not verify.`);
  if (plan.memory) {
    parts.push(
      `Memory: ${String(plan.memory.offered)} records offered, ${String(plan.memory.add)} new`
      + `, ${String(plan.memory.present)} already present`
      + `${plan.memory.conflict > 0 ? `, ${String(plan.memory.conflict)} refused as different work under the same id` : ""}`
      + `${plan.memory.foreign > 0 ? `, ${String(plan.memory.foreign)} refused as written for another profile` : ""}`
      + `${plan.memory.overflow > 0 ? `, ${String(plan.memory.overflow)} over the 512-record limit` : ""}.`
      + " Memory is added only if you ask for it.",
    );
  }
  return parts.join(" ");
}

/**
 * What this import will leave exactly as it is.
 *
 * `includeMemory` is the checkbox, not the file: a bundle that carries memory
 * records still touches none of yours until you ask, and this sentence has to
 * agree with the button beside it.
 */
export function untouchedSentence(plan: WorkBundleImportPlan, includeMemory = false): string {
  const others = plan.untouchedConversations;
  return `Not touched: ${others === 0 ? "no other conversation is here" : countLabel(others) + " already here"}`
    + `${plan.memory && includeMemory ? "" : ", your memory records"}`
    + ", your workspace files, your profiles and skills, and your Vault key.";
}

export function resultSentence(result: WorkBundleImportResult): string {
  const parts = [`${countLabel(result.imported)} added.`];
  if (result.skipped > 0) parts.push(`${String(result.skipped)} skipped as already present.`);
  if (result.refused > 0) parts.push(`${String(result.refused)} refused and left alone.`);
  if (result.memory) {
    parts.push(
      `Memory: ${String(result.memory.added)} records added, ${String(result.memory.present)} already present`
      + `, ${String(result.memory.conflict + result.memory.foreign)} refused.`,
    );
  }
  return parts.join(" ");
}

function countStates(plan: WorkBundleImportPlan) {
  return {
    new: plan.conversations.filter((entry) => entry.state === "new").length,
    present: plan.conversations.filter((entry) => entry.state === "present").length,
    conflict: plan.conversations.filter((entry) => entry.state === "conflict").length,
    unreadable: plan.conversations.filter((entry) => entry.state === "unreadable").length,
  };
}

function stateWord(state: string): string {
  if (state === "new") return "will be added";
  if (state === "present") return "already here";
  return "refused";
}

function countLabel(count: number, noun = "conversation"): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function reason(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}
