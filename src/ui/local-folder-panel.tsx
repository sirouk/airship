import { useEffect, useId, useState } from "preact/hooks";
import {
  LOCAL_FOLDER_MAX_ENTRIES,
  forgetLocalFolder,
  LOCAL_FOLDER_UNSUPPORTED_NOTICE,
  LocalFolderAccessError,
  localFolderAttachmentRecorded,
  localFolderPickerAvailable,
  openLocalFolder,
  reconnectLocalFolder,
  restoreLocalFolder,
  type LocalFolderRecord,
  type LocalFolderWorkspacePort,
} from "../workspace/local-folder";

/**
 * What the route knows about the folder right now.
 *
 * `blocked` is a first-class state rather than an error, because it is the
 * ordinary one: a browser drops a directory grant when the tab closes, so the
 * common case on a second visit is a remembered folder that cannot be read
 * until the person says so again.
 */
export type LocalFolderState =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "attached"; name: string; mountPath: string }>
  | Readonly<{ kind: "blocked"; name: string; record: LocalFolderRecord; reason: string }>;

/**
 * The tier, in the six rows the Vault route compares every destination with.
 *
 * Same questions, same order, same voice — a person deciding where their work
 * lives should be able to read this column against Local Device and Google
 * Drive without translating. It is stated here rather than in the Vault
 * selector because this is not a Vault backend: a folder cannot hold the
 * encrypted journal, the profile catalog or the session records, and offering
 * it as one would be a promise Airship could not keep.
 */
export const LOCAL_FOLDER_TIER = Object.freeze({
  title: "Folder on this device",
  description: "Your own folder, opened in place and never copied",
  note: "This device, this browser, revocable. Airship reads and writes the files where they already are and stores no copy of the folder: not in the Vault, not in Airship's Git, not off this device. A file the agent reads becomes part of that conversation, which a readable bundle carries in the clear. The folder is not added to the searchable index Airship can publish to your Vault, so ask for its files by path.",
  facts: Object.freeze({
    survives: "Yes · the files are already yours",
    offline: "Yes",
    reach: "No · this browser profile only",
    supply: "A folder, and permission each session",
    keep: "The folder — Airship stores no copy of it; a file the agent reads is in that conversation",
    lose: "Revoking permission · moving the folder",
  }),
} as const);

export const LOCAL_FOLDER_FACT_ROWS: readonly (readonly [keyof typeof LOCAL_FOLDER_TIER.facts, string])[] = Object.freeze([
  ["survives", "Survives closing the tab"],
  ["offline", "Works offline"],
  ["reach", "Reaches other devices"],
  ["supply", "You supply"],
  ["keep", "You keep"],
  ["lose", "What can lose it"],
] as const);

/** What Airship does with an attached folder, in the words the route uses. */
export function localFolderAttachedSummary(name: string, mountPath: string): string {
  return `“${name}” is open at ${mountPath} for this profile only. The Explorer, the editor and the agent read and `
    + "write it through the permission you granted this browser. Every agent write still goes through approvals, and "
    + "this folder is reviewed in every approval mode — Auto Approve and Full Access included — because a write here "
    + "lands on your own disk and cannot be undone. The Terminal does not carry it at all. A file read from here "
    + "becomes part of that conversation.";
}

export const LOCAL_FOLDER_FORGET_NOTE =
  "Forgetting removes the folder from Airship and drops the stored permission. Nothing on your device is deleted or moved.";

/* The number is read from the bound it describes, so the two cannot drift. */
export const LOCAL_FOLDER_BOUNDS_NOTE =
  `Airship lists up to ${LOCAL_FOLDER_MAX_ENTRIES.toLocaleString("en-US")} files from a folder and skips its .git directory. `
  + "A larger folder is refused rather than shown in part — open a subfolder instead.";

/** The sentence a failed verb leaves on the panel. Never a code, never silence. */
export function localFolderFailureNotice(error: unknown): string {
  if (error instanceof LocalFolderAccessError) return error.message;
  return error instanceof Error
    ? `Airship could not complete that: ${error.message}`
    : "Airship could not complete that, and the browser gave no reason.";
}

export type LocalFolderPanelProps = Readonly<{
  /**
   * The Profile this panel opens, remembers and forgets a folder for.
   *
   * A folder is a Profile's attachment, exactly like its workspace subtree and
   * its Git object database. Passing it here is what keeps one Profile's
   * folder out of another's `/workspace`.
   */
  profileId: string;
  /**
   * Publishes the folder to the shell, which rebinds the workspace authority
   * every consumer reads — Explorer, editor, terminal and the agent's tools.
   * `undefined` detaches it.
   */
  onFolderChanged(folder: LocalFolderWorkspacePort | undefined): void | Promise<void>;
}>;

/**
 * The Workspace route's storage-tier panel for a folder on this device.
 *
 * Every verb here runs inside the click that asked for it, because Chromium
 * shows the directory picker and the permission prompt only during a user
 * gesture. Restoring a remembered folder deliberately does not prompt: it
 * reports what the grant already is, and the person presses one button.
 */
export function LocalFolderPanel({ profileId, onFolderChanged }: LocalFolderPanelProps) {
  const [state, setState] = useState<LocalFolderState>(() =>
    localFolderPickerAvailable() ? { kind: "absent" } : { kind: "unsupported" });
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  /**
   * True from the press that asks for a folder until one is chosen or the ask
   * is cancelled.
   *
   * This state exists because two contracts meet on this route and only one of
   * them can have the pixels at rest: the tier has to state its terms in
   * rendered text, and `e2e/responsive-breakpoints.spec.ts` measures how much
   * of a phone viewport is spent before the first file row. So the terms are
   * printed by the gesture that is about to need them. The picker still opens
   * inside a click — the second one — which is all Chromium requires.
   */
  const [deciding, setDeciding] = useState(false);
  const headingId = useId();

  useEffect(() => {
    if (!localFolderPickerAvailable() || !localFolderAttachmentRecorded(profileId)) return;
    let current = true;
    void (async () => {
      try {
        const restored = await restoreLocalFolder(profileId);
        if (!current) return;
        if (restored.state === "attached") {
          await restored.port.list();
          if (!current) return;
          setState({ kind: "attached", name: restored.record.name, mountPath: restored.record.mountPath });
          await onFolderChanged(restored.port);
        } else if (restored.state === "blocked") {
          setState({
            kind: "blocked",
            name: restored.record.name,
            record: restored.record,
            reason: restored.reason.message,
          });
        }
      } catch (error) {
        if (current) setNotice(localFolderFailureNotice(error));
      }
    })();
    return () => { current = false; };
  }, [profileId]);

  async function run(verb: () => Promise<void>): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      await verb();
    } catch (error) {
      setNotice(localFolderFailureNotice(error));
    } finally {
      setBusy(false);
    }
  }

  const attach = (port: LocalFolderWorkspacePort) => async () => {
    /*
     * List once before anything binds to it.
     *
     * A folder past the listing bound, or one whose grant died between the
     * pick and the first read, must be refused here — where the refusal is a
     * sentence beside the button that caused it. Bound later, the same failure
     * would surface as the whole Explorer refusing to draw, including the
     * workspace files that have nothing to do with the folder.
     */
    await port.list();
    setDeciding(false);
    setState({ kind: "attached", name: port.folderName, mountPath: port.mountPath });
    await onFolderChanged(port);
  };

  const pick = () => run(async () => {
    const port = await openLocalFolder({ profileId });
    await attach(port)();
  });

  if (state.kind === "unsupported") {
    return <section class="local-folder" aria-labelledby={headingId}>
      <h3 class="local-folder__title" id={headingId}>{LOCAL_FOLDER_TIER.title}</h3>
      <p class="local-folder__note">{LOCAL_FOLDER_UNSUPPORTED_NOTICE}</p>
    </section>;
  }

  /*
   * Nothing here folds away, and nothing here is a disclosure.
   *
   * It used to be one. The whole tier — the mount path, "reviewed in every
   * approval mode", "The Terminal does not carry it at all", and the six
   * answers every storage tier gives — sat inside a `<details>` that is closed
   * on load and that nothing ever opened, including at the one moment it
   * mattered: after a real directory was attached. Measured on the built tree
   * at 390×664, the panel's rendered text was `Folder on this device / None
   * open / Open a folder…` and nothing else, while its `textContent` ran to
   * 1,041 characters. The e2e specs asserted those promises with
   * `toContainText`, which reads `textContent`, so they passed on text nobody
   * could see.
   *
   * What a person sees now, decided rather than folded:
   *
   * - With no folder open: the tier, its state, and the sentence that is the
   *   whole truth of that state — nothing on this device is readable. That is
   *   all, because `e2e/responsive-breakpoints.spec.ts` measures the share of a
   *   phone spent before the first file row and the workbench is what this
   *   route is for.
   * - Asking for a folder prints the terms. "Open a folder…" does not open the
   *   picker; it renders the tier's promise, its listing bound and the six
   *   answers, above "Choose a folder…" and "Cancel". The picker opens inside
   *   that second click, which is still the user gesture Chromium requires. So
   *   the terms cannot be skipped: they are on screen, unfolded, between the
   *   intent and the directory handle.
   * - With a folder open: all of it, for as long as the folder is attached —
   *   where it is mounted, that every write is reviewed in every approval mode,
   *   that the Terminal does not carry it, that a file the agent reads is in
   *   the conversation, what forgetting does, and the six answers. That state
   *   costs the workbench height, and it is the state in which a person's own
   *   disk is attached to an agent.
   */
  const terms = deciding || state.kind !== "absent";
  return <section class="local-folder" aria-labelledby={headingId}>
    <div class="local-folder__head">
      <h3 class="local-folder__title" id={headingId}>{LOCAL_FOLDER_TIER.title}</h3>
      <span class="local-folder__state">{state.kind === "attached"
        ? state.name
        : state.kind === "blocked" ? "Reconnect needed" : "None open"}</span>
      <span class="local-folder__actions">
      {state.kind === "absent" && !deciding ? <button
        type="button"
        class="primary"
        disabled={busy}
        onClick={() => setDeciding(true)}
      >Open a folder…</button> : null}
      {state.kind === "blocked" ? <button
        type="button"
        class="primary"
        disabled={busy}
        data-local-folder-reconnect
        onClick={() => run(async () => {
          const port = await reconnectLocalFolder(state.record);
          await attach(port)();
        })}
      >Reconnect folder</button> : null}
      {state.kind === "attached" ? <button
        type="button"
        disabled={busy}
        data-local-folder-change
        onClick={pick}
      >Open a different folder…</button> : null}
      {state.kind === "absent" ? null : <button
        type="button"
        disabled={busy}
        data-local-folder-forget
        onClick={() => run(async () => {
          await forgetLocalFolder(profileId);
          setState({ kind: "absent" });
          await onFolderChanged(undefined);
        })}
      >Forget folder</button>}
      </span>
    </div>
    {/*
      * The terms, in a band the workbench can survive.
      *
      * `.editor-route` is a fixed frame — `.main` is `overflow: hidden` for it
      * — so a panel taller than the frame does not scroll the route, it
      * subtracts from the surface below. Measured at 390×664 with every
      * sentence rendered at full height: the workbench went to exactly 0px and
      * the Explorer disappeared. So on a phone the band takes a fifth of the
      * viewport and scrolls inside itself, and every sentence stays rendered
      * text that `innerText` returns. That is the trade `chat.css` already
      * makes for the session bar's instrument strip: a reading you have to
      * scroll to is still a reading, and one behind a closed disclosure is not.
      */}
    <div class="local-folder__terms">
      {/*
        * The one live region, and it is the visible sentence.
        *
        * The panel used to hold a `live` ref that was assigned on attach and on
        * forget and rendered nowhere, and its only `role="status"` was inside
        * the closed disclosure — so opening or forgetting a folder said nothing
        * to a screen reader at all. This paragraph is rendered in every state,
        * so the announcement and the sentence on screen are the same words.
        */}
      <p class="local-folder__status" role="status" aria-live="polite">
        {state.kind === "attached"
          ? localFolderAttachedSummary(state.name, state.mountPath)
          : state.kind === "blocked"
            ? state.reason
            : "No folder is open. Nothing on this device is readable by Airship until you open one."}
      </p>
      {notice ? <p class="local-folder__notice" role="alert">{notice}</p> : null}
      {terms ? <>
      <p class="local-folder__note">{LOCAL_FOLDER_TIER.note}</p>
      <p class="local-folder__note">{state.kind === "absent" ? LOCAL_FOLDER_BOUNDS_NOTE : LOCAL_FOLDER_FORGET_NOTE}</p>
      {/*
        * The same six answers every storage tier gives, on the surface that
        * changes them. On a phone the row scrolls sideways rather than
        * stacking into six full-width rows, for the reason above.
        */}
      <dl class="local-folder__facts">
        {LOCAL_FOLDER_FACT_ROWS.map(([key, label]) => <div class="local-folder__fact" key={key}>
          <dt>{label}</dt>
          <dd>{LOCAL_FOLDER_TIER.facts[key]}</dd>
        </div>)}
      </dl>
      </> : null}
    </div>
    {deciding ? <span class="local-folder__decide">
      <button type="button" class="primary" disabled={busy} data-local-folder-open onClick={pick}>Choose a folder…</button>
      <button type="button" disabled={busy} onClick={() => setDeciding(false)}>Cancel</button>
    </span> : null}
  </section>;
}
