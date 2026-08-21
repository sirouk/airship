/**
 * A file that holds someone's work.
 *
 * Airship's product spec sells "fork, resume, export, or delete work without
 * vendor lock-in", and until this module existed the product kept three of the
 * four: the only two callers of `downloadBytes` were one workspace file and the
 * whole encrypted Vault, and a Vault backup is a file only Airship can read.
 * A person could not take a conversation anywhere.
 *
 * What a bundle is
 * ----------------
 * One UTF-8 JSON object. `JSON.parse` reads it; no framing, no container, no
 * compression, no Airship-only encoding. Every value in it is already the
 * journal's own JSON: a `SessionRecord` exactly as the backend stores it, and
 * its `DurableEvent`s with their original ids, sequence numbers, `recordedAt`
 * stamps, `previousDigest` links and `digest`s. Other software can read a
 * conversation out of it, and can re-derive every digest from the same
 * preimage the journal hashes (`digestPreimage` below) without Airship.
 *
 * What a bundle is NOT
 * -------------------
 * - It is not a backup of your Vault key. Losing the key still loses the Vault;
 *   this file cannot restore one.
 * - A readable bundle is plaintext. Every message in it can be read by anyone
 *   who holds the file. That is the point of "readable", and it is the cost.
 * - A sealed bundle is the opposite trade: it is sealed with the active Vault's
 *   own key, so only Airship, opened against that same Vault, can read it back.
 *   No other software can, and neither can Airship on a different Vault.
 *
 * Storage-neutral by construction: a bundle is a file. Put it in a Vault, a
 * synced folder, a Git repository or on a USB stick. This module adds no
 * storage provider, no relay and no pairing service.
 */
import { isRecord } from "../core/records";
import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import type { DurableEvent, JournalBackend, JournalStateSource, SessionRecord } from "../core/journal";
// Type-only, so it is erased: this module never pulls the deferred capability
// pack that owns the merge primitive into its own chunk.
import type { migrateJournalState } from "../vault/runtime-adoption";
import { MEMORY_PATH, parseMemoryDocument, serializeMemoryDocument, type MemoryRecord } from "../tools/memory-document";
import type { PortableSealPort, WorkspacePort } from "../workspace/contracts";

export const WORK_BUNDLE_FORMAT = "airship.work-bundle";
export const WORK_BUNDLE_VERSION = 1;
/** A readable bundle really is JSON, so it says so rather than inventing a vendor type. */
export const WORK_BUNDLE_MEDIA_TYPE = "application/json";
/** Envelope binding for a sealed bundle; see `sealWorkBundle`. */
export const WORK_BUNDLE_SEAL_NAMESPACE = "airship/work-bundle/v1";
export const WORK_BUNDLE_SEAL_LOGICAL_ID = "work-bundle";
/** `parseMemoryDocument` refuses a document above this, so the merge must too. */
export const WORK_BUNDLE_MEMORY_LIMIT = 512;

export type WorkBundleConversation = Readonly<{
  session: SessionRecord;
  events: readonly DurableEvent[];
}>;

export type WorkBundleMemory = Readonly<{
  path: string;
  records: readonly MemoryRecord[];
}>;

export type WorkBundle = Readonly<{
  format: typeof WORK_BUNDLE_FORMAT;
  version: 1;
  exportedAt: string;
  conversations: readonly WorkBundleConversation[];
  /** `null`, never absent, so a reader can tell "no memory" from "old file". */
  memory: WorkBundleMemory | null;
}>;

/**
 * The exact preimage `EventJournal` hashes for one event.
 *
 * Restated here so a bundle is verifiable by software that does not have
 * Airship: SHA-256 over `stableStringify` of this object is the event's
 * `digest`, and each event's `previousDigest` is the one before it.
 */
export function digestPreimage(event: DurableEvent): JsonValue {
  return {
    version: 1,
    eventId: event.eventId,
    sessionId: event.sessionId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    previousDigest: event.previousDigest,
    type: event.type,
    turnId: event.turnId ?? null,
    operationId: event.operationId ?? null,
    payload: event.payload,
  };
}

/** Read the chosen conversations, and optionally this profile's memory, into a bundle. */
export async function collectWorkBundle(args: Readonly<{
  journal: JournalStateSource;
  sessionIds: readonly string[];
  exportedAt: string;
  memory?: Readonly<{ workspace: WorkspacePort; profileId: string }>;
}>): Promise<WorkBundle> {
  const conversations: WorkBundleConversation[] = [];
  for (const sessionId of args.sessionIds) {
    const session = await args.journal.getSession(sessionId);
    if (!session) throw new Error(`That conversation is no longer in this journal: ${sessionId}.`);
    const events = await args.journal.readEvents(sessionId);
    const last = events.at(-1);
    const headMatches = session.headSequence === 0
      ? events.length === 0 && session.headDigest === "genesis"
      : last?.sequence === session.headSequence && last?.digest === session.headDigest;
    if (!headMatches) throw new Error(`That conversation changed while it was being read: ${sessionId}.`);
    conversations.push(Object.freeze({ session: withoutCarriedPins(session), events: Object.freeze(events) }));
  }
  return Object.freeze({
    format: WORK_BUNDLE_FORMAT,
    version: 1,
    exportedAt: args.exportedAt,
    conversations: Object.freeze(conversations),
    memory: args.memory ? await readProfileMemory(args.memory.workspace, args.memory.profileId) : null,
  });
}

/**
 * Fields a bundle may neither carry out nor bring in.
 *
 * A digest chain certifies itself and nothing else. Any file can mint a
 * consistent one, so a verified chain is evidence that the events were not
 * edited after they were written — never evidence of who wrote them or of what
 * this device agreed to. Every field below is the opposite kind of fact: each
 * is authority a *device* grants. Three of them are read back by the journal
 * projection with the record's own value as the fallback
 * (`projectedSessionPins` in `src/core/journal.ts`), so a record that arrives
 * with one set keeps it for every later append — a crafted bundle could land
 * `full-access` on a conversation nobody put in that mode, and a model route
 * nobody chose. `importedAt` is the stamp the importing device writes, so a
 * file may neither claim to be native nor forge a date.
 *
 * Refusing them on the record was necessary and was not sufficient: the same
 * three pins ride into a journal as `session.approval-policy-changed` and
 * `session.model-changed` events, and the merge replays every event a file
 * carries. That half is closed where the projection is — a replay grants no
 * pin (`JournalAppendOptions`) — because the events are the conversation's real
 * history and refusing them would refuse the export button's own output.
 *
 * `headIncarnation` was already refused for the same reason and is kept in the
 * list rather than checked separately, so a pin added to `SessionRecord` later
 * has one obvious place to be declared.
 */
export const REFUSED_BUNDLE_PINS = Object.freeze([
  "headIncarnation",
  "approvalModeOverride",
  "modelOverride",
  "contextPolicyOverride",
  "importedAt",
] as const);

/**
 * Every field of a session record a bundle may carry. Nothing else lands.
 *
 * The record used to be cast — `value.session as unknown as SessionRecord` —
 * with five named pins refused and the rest of the object copied through
 * verbatim, so a file could deposit any key it liked on a journal record and,
 * more to the point, the next pin added to `SessionRecord` would be
 * file-granted from the day it was declared until somebody remembered to
 * extend the refusal list. An allowlist inverts that: a new field is refused
 * until it is deliberately named here, and `work-bundle.test.ts` fails the
 * build if a field of the record type is in neither list.
 */
export const WORK_BUNDLE_SESSION_FIELDS = Object.freeze([
  "id",
  "title",
  "manifest",
  "createdAt",
  "updatedAt",
  "headSequence",
  "headDigest",
] as const);

/** Said by both record-field refusals, so the bytes are written once. */
const REFUSED_FIELD_TAIL =
  " so nothing was written. Delete that field and choose the file again; its messages and digests import unchanged.";

/** The record without any device-granted pin, which is all a file may carry. */
function withoutCarriedPins(session: SessionRecord): SessionRecord {
  const portable = structuredClone(session);
  for (const pin of REFUSED_BUNDLE_PINS) delete portable[pin];
  return portable;
}

async function readProfileMemory(workspace: WorkspacePort, profileId: string): Promise<WorkBundleMemory> {
  const file = await workspace.read(MEMORY_PATH);
  const records = file ? parseMemoryDocument(file.content).records : [];
  return Object.freeze({
    path: MEMORY_PATH,
    // Only this profile's own records. A legacy unscoped record is already
    // quarantined from recall here; copying it into a file would hand another
    // device something it will not read either.
    records: Object.freeze(records.filter((item) => item.scope.kind === "profile" && item.scope.profileId === profileId)),
  });
}

/** The bytes that get written to disk. Indented, because a person may read it. */
export function serializeWorkBundle(bundle: WorkBundle): string {
  return `${JSON.stringify(bundle, undefined, 2)}\n`;
}

/** `airship-work-2026-08-21-09-00.json`, or `…-09-00.sealed.json`. */
export function workBundleFileName(exportedAt: string, sealed: boolean): string {
  const stamp = exportedAt.replaceAll(":", "-").replace("T", "-").slice(0, 16);
  return `airship-work-${stamp}${sealed ? ".sealed" : ""}.json`;
}

/**
 * Structural validation of a file someone else may have written.
 *
 * Deliberately strict: this is untrusted input that will be handed to the
 * journal's merge primitive, and a permissive reader here would move the
 * refusal to a place with less to say about it.
 */
export function parseWorkBundle(text: string): WorkBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON, so it is not an Airship bundle.");
  }
  if (!isRecord(value) || value.format !== WORK_BUNDLE_FORMAT) {
    throw new Error("That file is JSON, but it is not an Airship work bundle.");
  }
  if (value.version !== WORK_BUNDLE_VERSION) {
    throw new Error(`This build reads work bundles at version ${String(WORK_BUNDLE_VERSION)}; that file states ${String(value.version)}.`);
  }
  if (typeof value.exportedAt !== "string" || !Array.isArray(value.conversations)) {
    throw new Error("That bundle is malformed.");
  }
  const conversations = value.conversations.map((entry) => parseConversation(entry));
  const ids = new Set(conversations.map((entry) => entry.session.id));
  if (ids.size !== conversations.length) throw new Error("That bundle names the same conversation twice.");
  return Object.freeze({
    format: WORK_BUNDLE_FORMAT,
    version: 1,
    exportedAt: value.exportedAt,
    conversations: Object.freeze(conversations),
    memory: value.memory == null ? null : parseBundleMemory(value.memory),
  });
}

function parseConversation(value: unknown): WorkBundleConversation {
  if (!isRecord(value) || !isRecord(value.session) || !Array.isArray(value.events)) {
    throw new Error("That bundle contains a conversation Airship cannot read.");
  }
  const record = value.session;
  const session = record as unknown as SessionRecord;
  if (
    typeof session.id !== "string" || !session.id
    || typeof session.title !== "string"
    || typeof session.createdAt !== "string"
    || typeof session.updatedAt !== "string"
    || typeof session.headSequence !== "number"
    || typeof session.headDigest !== "string"
    || !isRecord(session.manifest)
  ) {
    throw new Error("That bundle contains a conversation record Airship cannot read.");
  }
  // One question for both refusals, because they have the same answer: every
  // device-granted pin is outside the allowlist by construction, and so is a
  // key this build has never heard of.
  const refused = Object.keys(record).find((key) => !(WORK_BUNDLE_SESSION_FIELDS as readonly string[]).includes(key));
  if (refused !== undefined) {
    throw new Error(
      `That bundle carries ${refused} on conversation ${session.id}. An approval mode, a model, a context policy and a`
      + " storage fence are granted by the device that runs the conversation, never by a file, and a field this build"
      + " does not read is a grant it cannot check," + REFUSED_FIELD_TAIL,
    );
  }
  // Built field by field from the allowlist rather than copied, so the record
  // this function returns can hold nothing the check above did not see.
  const allowed: Record<string, unknown> = {};
  for (const field of WORK_BUNDLE_SESSION_FIELDS) allowed[field] = record[field];
  const events = value.events.map((event) => {
    if (
      !isRecord(event) || event.version !== 1
      || typeof event.eventId !== "string" || typeof event.type !== "string"
      || typeof event.sequence !== "number" || typeof event.recordedAt !== "string"
      || typeof event.previousDigest !== "string" || typeof event.digest !== "string"
      || event.sessionId !== session.id
      // A payload is not optional, even when it is `null`. `stableStringify`
      // cannot carry an undefined key, so a file that omits the field hashes
      // identically to one that carries `null` and its chain verifies — but
      // only the page-memory journal will store it. The encrypted lane refuses
      // it ("Encrypted journal event payload is missing"), so an import that
      // looked like it worked would take the whole Vault adoption down with it
      // later, when the person turned durability on. Refused here, where the
      // sentence can still name the file.
      || !("payload" in event)
    ) {
      throw new Error(`That bundle contains an event Airship cannot read: ${session.id}.`);
    }
    return event as unknown as DurableEvent;
  });
  return Object.freeze({ session: allowed as unknown as SessionRecord, events: Object.freeze(events) });
}

function parseBundleMemory(value: unknown): WorkBundleMemory {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.records)) {
    throw new Error("That bundle's memory section is malformed.");
  }
  // Validated by the one reader memory.json already has, so a bundle can never
  // introduce a record the product's own parser would later reject.
  const document = parseMemoryDocument(JSON.stringify({ version: 2, records: value.records }));
  return Object.freeze({ path: value.path, records: document.records });
}

export type WorkBundleChainReport = Readonly<{
  sessionId: string;
  verified: boolean;
  reason?: string;
}>;

/**
 * Recompute every digest in the bundle from its own bytes.
 *
 * This is what makes "the digests survived" a checked claim rather than a
 * promise: the chain is re-derived from the events in the file, linked
 * `previousDigest` to `digest`, and matched against the record's head. A file
 * that fails here is refused before the merge primitive is ever called.
 */
export async function verifyWorkBundleChain(bundle: WorkBundle): Promise<readonly WorkBundleChainReport[]> {
  const reports: WorkBundleChainReport[] = [];
  for (const entry of bundle.conversations) {
    reports.push(Object.freeze({ sessionId: entry.session.id, ...(await verifyOneChain(entry)) }));
  }
  return Object.freeze(reports);
}

async function verifyOneChain(entry: WorkBundleConversation): Promise<Readonly<{ verified: boolean; reason?: string }>> {
  /*
   * The pinned system prompt, against the digest the manifest states for it.
   *
   * The record is not covered by the chain — only the events are — and this
   * prompt is sent to the provider on every turn the conversation ever takes
   * (`src/core/agent.ts`). Resume compares the digest, so a file whose prompt
   * and digest disagree would present one text for checking and send another.
   * The journal's own audit already treats this as an invariant
   * (`SYSTEM_PROMPT_DIGEST_MISMATCH`); import must not be the one door that
   * skips it.
   */
  const { systemPrompt, systemPromptDigest } = entry.session.manifest;
  if (typeof systemPrompt !== "string" || (await sha256(systemPrompt)) !== systemPromptDigest) {
    return {
      verified: false,
      reason: "its pinned system prompt is not the one its own digest names, so the instructions in the file are not"
        + " the ones it commits to. Ask the device that holds it to write the bundle again",
    };
  }
  let previousDigest = "genesis";
  let sequence = 0;
  for (const event of entry.events) {
    sequence += 1;
    if (event.sequence !== sequence) return { verified: false, reason: `event ${String(event.sequence)} is out of order` };
    if (event.previousDigest !== previousDigest) return { verified: false, reason: `event ${String(event.sequence)} does not link to the one before it` };
    const recomputed = await sha256(stableStringify(digestPreimage(event)));
    if (recomputed !== event.digest) return { verified: false, reason: `event ${String(event.sequence)} does not hash to its recorded digest` };
    previousDigest = event.digest;
  }
  if (entry.session.headSequence !== sequence || entry.session.headDigest !== previousDigest) {
    return { verified: false, reason: "the recorded head does not match the events" };
  }
  return { verified: true };
}

export type WorkBundleConversationState = "new" | "present" | "conflict" | "unreadable";

export type WorkBundleConversationPlan = Readonly<{
  sessionId: string;
  title: string;
  events: number;
  state: WorkBundleConversationState;
  reason?: string;
}>;

export type WorkBundleMemoryPlan = Readonly<{
  offered: number;
  add: number;
  present: number;
  conflict: number;
  /** Records that would push memory.json past the limit its parser enforces. */
  overflow: number;
  /**
   * Records scoped to some other profile, or to no profile at all.
   *
   * Export narrows to the exporting profile; import narrowed to nothing, so a
   * file could write records into a silo the person reading it never chose —
   * and `scopedMemories` would then serve them to that profile's turns.
   */
  foreign: number;
}>;

export type WorkBundleImportPlan = Readonly<{
  exportedAt: string;
  conversations: readonly WorkBundleConversationPlan[];
  memory?: WorkBundleMemoryPlan;
  /** Conversations already in this journal that this bundle does not name. */
  untouchedConversations: number;
}>;

/**
 * Say exactly what an import will do, before it does anything.
 *
 * Nothing here writes. The counts are the ones the sentence in the UI states,
 * and `applyWorkBundleImport` re-checks each of them against the live journal
 * at the moment it writes, because a plan read a second ago is a claim about
 * the past.
 */
export async function planWorkBundleImport(args: Readonly<{
  bundle: WorkBundle;
  journal: JournalStateSource;
  chain: readonly WorkBundleChainReport[];
  workspace?: WorkspacePort;
  /** The profile whose memory.json this is, and the only silo import may write. */
  profileId?: string;
}>): Promise<WorkBundleImportPlan> {
  const existing = await args.journal.listSessions();
  const byId = new Map(existing.map((session) => [session.id, session]));
  const conversations = args.bundle.conversations.map((entry) => {
    const chain = args.chain.find((report) => report.sessionId === entry.session.id);
    if (chain && !chain.verified) {
      return plan(entry, "unreadable", `Refused: ${chain.reason ?? "its digest chain did not verify"}.`);
    }
    const foreign = foreignProfileRefusal(entry.session, args.profileId);
    if (foreign) return plan(entry, "conflict", foreign);
    const present = byId.get(entry.session.id);
    if (!present) return plan(entry, "new");
    return samePortableSession(present, entry.session)
      ? plan(entry, "present", "Already here with the same digest head; it will be skipped.")
      : plan(entry, "conflict", "Refused: this journal holds a different conversation under that id.");
  });
  const named = new Set(conversations.map((entry) => entry.sessionId));
  return Object.freeze({
    exportedAt: args.bundle.exportedAt,
    conversations: Object.freeze(conversations),
    ...(args.bundle.memory && args.workspace && args.profileId
      ? { memory: await planMemoryMerge(args.bundle.memory, args.workspace, args.profileId) }
      : {}),
    untouchedConversations: existing.filter((session) => !named.has(session.id)).length,
  });
}

/**
 * Why a conversation the file addresses to another Profile is refused.
 *
 * A conversation lands in the Profile its manifest names, and that name comes
 * from the file. Measured: imported from a panel bound to General, zero
 * conversations landed in General and one landed in `finance`. Every reader of
 * the journal narrows on `manifest.profile.profileId` — the rail, the durable
 * active-conversation pointer, `profileOwnedSessions` — so a file naming a
 * Profile this device does not have lands a conversation no route can reach,
 * and one naming a Profile it does have deposits work in a silo the person
 * importing never chose. Rescoping the pin would forge it, so the conversation
 * is refused by name instead, exactly as a foreign memory record already is.
 *
 * Asked again by the applier rather than trusted from the plan: a plan read a
 * second ago is a claim about the past, and about the profile it was read for.
 */
function foreignProfileRefusal(session: SessionRecord, profileId: string | undefined): string | undefined {
  const named = session.manifest.profile?.profileId;
  if (!profileId || named === undefined || named === profileId) return undefined;
  return `Refused: this conversation is pinned to the ${named} profile. An import lands in the profile doing the`
    + " importing, so switch to that one and choose the file again.";
}

function plan(
  entry: WorkBundleConversation,
  state: WorkBundleConversationState,
  reason?: string,
): WorkBundleConversationPlan {
  return Object.freeze({
    sessionId: entry.session.id,
    title: entry.session.title,
    events: entry.events.length,
    state,
    ...(reason ? { reason } : {}),
  });
}

/**
 * The same comparison `migrateJournalState` makes before it refuses a session.
 *
 * Restated rather than imported because the merge primitive lives in the
 * deferred capability pack and this plan must be readable without fetching it.
 * The plan is advisory; the primitive stays the authority, and it re-checks.
 */
function samePortableSession(left: SessionRecord, right: SessionRecord): boolean {
  // Every device-granted pin is dropped from both sides, not just the storage
  // fence: the conversation already here may have been put in Auto Approve or
  // moved to another model on this device, and neither decision makes it a
  // *different* conversation from the one in the file. Comparing them would
  // report an identical thread as a conflict and refuse to skip it.
  return stableStringify(withoutCarriedPins(left) as unknown as JsonValue)
    === stableStringify(withoutCarriedPins(right) as unknown as JsonValue);
}

async function planMemoryMerge(
  memory: WorkBundleMemory,
  workspace: WorkspacePort,
  profileId: string,
): Promise<WorkBundleMemoryPlan> {
  const merge = await mergeMemoryRecords(memory, workspace, profileId);
  return Object.freeze({
    offered: memory.records.length,
    add: merge.added.length,
    present: merge.present,
    conflict: merge.conflicts.length,
    overflow: merge.overflow,
    foreign: merge.foreign,
  });
}

type MemoryMerge = Readonly<{
  existing: readonly MemoryRecord[];
  added: readonly MemoryRecord[];
  present: number;
  conflicts: readonly string[];
  overflow: number;
  foreign: number;
  revision: string | null;
}>;

/**
 * Merge a file's memory records into one profile's memory.json.
 *
 * `profileId` is the silo this merge may write, and it is not advisory: a
 * record carries its own scope, `readProfileMemory` narrows an export to the
 * exporting profile, and every reader of memory.json narrows on the pinned
 * profile. Import used to narrow on nothing, so a file could deposit records
 * addressed to a profile the person had not chosen — including one this
 * browser has never had — and `scopedMemories` would hand them to that
 * profile's turns as its own notes. A record for anyone else is counted and
 * dropped here rather than rewritten to fit: rescoping someone else's note
 * would forge its provenance instead of refusing it.
 */
async function mergeMemoryRecords(
  memory: WorkBundleMemory,
  workspace: WorkspacePort,
  profileId: string,
): Promise<MemoryMerge> {
  const file = await workspace.read(MEMORY_PATH);
  const existing = file ? parseMemoryDocument(file.content).records : [];
  const byId = new Map(existing.map((item) => [item.id, item]));
  const added: MemoryRecord[] = [];
  const conflicts: string[] = [];
  let present = 0;
  let overflow = 0;
  let foreign = 0;
  for (const record of memory.records) {
    if (record.scope.kind !== "profile" || record.scope.profileId !== profileId) {
      foreign += 1;
      continue;
    }
    const held = byId.get(record.id);
    if (held) {
      if (stableStringify(held as unknown as JsonValue) === stableStringify(record as unknown as JsonValue)) present += 1;
      else conflicts.push(record.id);
      continue;
    }
    if (existing.length + added.length >= WORK_BUNDLE_MEMORY_LIMIT) {
      overflow += 1;
      continue;
    }
    added.push(record);
  }
  return Object.freeze({
    existing,
    added: Object.freeze(added),
    present,
    conflicts: Object.freeze(conflicts),
    overflow,
    foreign,
    revision: file?.revision ?? null,
  });
}

export type WorkBundleImportOutcome = Readonly<{
  sessionId: string;
  title: string;
  outcome: "imported" | "skipped" | "refused";
  reason?: string;
}>;

export type WorkBundleImportResult = Readonly<{
  conversations: readonly WorkBundleImportOutcome[];
  imported: number;
  skipped: number;
  refused: number;
  memory?: Readonly<{ added: number; present: number; conflict: number; overflow: number; foreign: number }>;
}>;

/**
 * The merge primitive `migrateJournalState` already is, applied per session.
 *
 * `migrateJournalState` preserves session ids, event bytes, sequence numbers
 * and digest heads, skips a session already present, and refuses one that
 * conflicts. That is exactly the behaviour import needs and exactly what vault
 * `restore` is not — `restore` is `replaceAll`, so carrying a phone's work back
 * to a laptop destroys the laptop's newer work. It is called once per
 * conversation so that one refusal names one conversation instead of aborting
 * the whole import: the person is told which one, and everything else lands.
 */
export async function applyWorkBundleImport(args: Readonly<{
  bundle: WorkBundle;
  plan: WorkBundleImportPlan;
  target: JournalBackend;
  migrate: MigrateJournalState;
  workspace?: WorkspacePort;
  /** The one memory silo this import may write; see `mergeMemoryRecords`. */
  profileId?: string;
  /**
   * Memory is opt-in and stays that way.
   *
   * The panel used to pass `true` whenever the file happened to contain
   * records, while its button read "Add N conversations" — so a person who
   * agreed to conversations also got someone else's notes, permanently, with
   * no sentence anywhere that said so.
   */
  includeMemory?: boolean;
  /** Stamped on every record this import writes; defaults to now. */
  importedAt?: string;
}>): Promise<WorkBundleImportResult> {
  const importedAt = args.importedAt ?? new Date().toISOString();
  const outcomes: WorkBundleImportOutcome[] = [];
  for (const entry of args.bundle.conversations) {
    const planned = args.plan.conversations.find((candidate) => candidate.sessionId === entry.session.id);
    const foreign = foreignProfileRefusal(entry.session, args.profileId);
    if (foreign || planned?.state === "unreadable" || planned?.state === "conflict") {
      outcomes.push(Object.freeze({
        sessionId: entry.session.id,
        title: entry.session.title,
        outcome: "refused",
        reason: foreign ?? planned?.reason ?? "Refused.",
      }));
      continue;
    }
    try {
      const before = await args.target.getSession(entry.session.id);
      /*
       * A conversation already here keeps the pins this device gave it.
       *
       * `migrateJournalState` compares the whole record and refuses any
       * difference, and every field in `REFUSED_BUNDLE_PINS` is one this
       * device may legitimately have set — a mode chosen here, a model chosen
       * here, an earlier import stamp. Handing it the file's blank values
       * would report an identical conversation as a conflict and refuse to
       * skip it; handing it this device's own values leaves the comparison
       * meaningful for everything a file actually carries.
       */
      await args.migrate(oneConversationSource(entry, before ? devicePins(before) : { importedAt }), args.target);
      outcomes.push(Object.freeze({
        sessionId: entry.session.id,
        title: entry.session.title,
        outcome: before ? "skipped" : "imported",
        ...(before ? { reason: "Already here with the same digest head." } : {}),
      }));
    } catch (error) {
      outcomes.push(Object.freeze({
        sessionId: entry.session.id,
        title: entry.session.title,
        outcome: "refused",
        reason: error instanceof Error ? error.message : "This conversation was refused.",
      }));
    }
  }
  const memory = args.includeMemory && args.bundle.memory && args.workspace && args.profileId
    ? await commitMemoryMerge(args.bundle.memory, args.workspace, args.profileId)
    : undefined;
  return Object.freeze({
    conversations: Object.freeze(outcomes),
    imported: outcomes.filter((entry) => entry.outcome === "imported").length,
    skipped: outcomes.filter((entry) => entry.outcome === "skipped").length,
    refused: outcomes.filter((entry) => entry.outcome === "refused").length,
    ...(memory ? { memory } : {}),
  });
}

async function commitMemoryMerge(
  memory: WorkBundleMemory,
  workspace: WorkspacePort,
  profileId: string,
): Promise<Readonly<{ added: number; present: number; conflict: number; overflow: number; foreign: number }>> {
  const merge = await mergeMemoryRecords(memory, workspace, profileId);
  if (merge.added.length > 0) {
    const next = serializeMemoryDocument([...merge.existing, ...merge.added]);
    // Re-read through the product's own parser before the write, so a merge can
    // never leave memory.json in a state the recall path would refuse.
    parseMemoryDocument(next);
    await workspace.write(MEMORY_PATH, next, { expectedRevision: merge.revision });
  }
  return Object.freeze({
    added: merge.added.length,
    present: merge.present,
    conflict: merge.conflicts.length,
    overflow: merge.overflow,
    foreign: merge.foreign,
  });
}

/** The device-granted pins on a record this journal already holds. */
function devicePins(session: SessionRecord): Partial<SessionRecord> {
  const pins: Record<string, unknown> = {};
  for (const pin of REFUSED_BUNDLE_PINS) {
    if (session[pin] !== undefined) pins[pin] = session[pin];
  }
  return pins as Partial<SessionRecord>;
}

/** What `migrateJournalState` reads from a source; see `JournalStateSource`. */
function oneConversationSource(entry: WorkBundleConversation, device: Partial<SessionRecord>): JournalStateSource {
  /*
   * The record is stamped as arriving from a file, here, by the device that
   * took it in.
   *
   * Everything else about the conversation is the source device's: its title,
   * its events, and its manifest — which pins the `systemPrompt` sent to the
   * provider on every turn it ever takes. A verified digest chain says those
   * bytes were not edited after they were written; it cannot say this browser
   * agreed to them, because any file can carry a chain that verifies. So the
   * conversation arrives readable and complete, and continues by Fork under a
   * profile resolved here — the same rule `adoptionCarriedNote` states for
   * work carried into a Vault.
   */
  const session = { ...structuredClone(entry.session), ...device };
  const events = structuredClone(entry.events) as DurableEvent[];
  return {
    listSessions: async () => [structuredClone(session)],
    getSession: async (sessionId: string) => (sessionId === session.id ? structuredClone(session) : undefined),
    readEvents: async (sessionId: string, afterSequence = 0) => (
      sessionId === session.id ? events.filter((event) => event.sequence > afterSequence).map((event) => structuredClone(event)) : []
    ),
  };
}

/** The merge primitive, passed in by the caller that fetched the pack. */
export type MigrateJournalState = typeof migrateJournalState;

/**
 * True for a storage authority that can seal a portable artifact.
 *
 * Lives here rather than beside the interface because the interface is types
 * only — free — and this predicate is executable, and nothing on the startup
 * path asks the question.
 */
export function supportsPortableSeal(port: unknown): port is PortableSealPort {
  const candidate = port as Partial<PortableSealPort> | undefined;
  return typeof candidate?.sealPortable === "function" && typeof candidate.openPortable === "function";
}

/** A sealed bundle: the vault envelope's own JSON, around the bundle's bytes. */
export function sealWorkBundle(seal: PortableSealPort, bundle: WorkBundle): Promise<Uint8Array> {
  return seal.sealPortable(WORK_BUNDLE_SEAL_NAMESPACE, new TextEncoder().encode(serializeWorkBundle(bundle)));
}

/** True when these bytes are a sealed bundle rather than a readable one. */
export function isSealedWorkBundle(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.suite === "AES-256-GCM/HKDF-SHA-256" && typeof value.ciphertext === "string";
  } catch {
    return false;
  }
}

/**
 * Open a sealed bundle with the active Vault.
 *
 * A sealed bundle can only be opened by Airship, against the Vault whose key
 * sealed it. That is the whole cost of choosing sealed, and the failure below
 * is what a person meets when they carry one to a different Vault.
 */
export async function openSealedWorkBundle(seal: PortableSealPort, sealed: Uint8Array): Promise<WorkBundle> {
  let plaintext: Uint8Array;
  try {
    plaintext = await seal.openPortable(WORK_BUNDLE_SEAL_NAMESPACE, sealed);
  } catch {
    throw new Error("This sealed bundle was not sealed by the Vault that is open here, so it cannot be opened.");
  }
  return parseWorkBundle(new TextDecoder().decode(plaintext));
}

