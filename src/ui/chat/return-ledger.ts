/**
 * The fact that work existed, kept where the work itself could not be.
 *
 * Measured in the Journey Atlas: a person who had sent two turns on Tuesday
 * closed the browser and reopened it, and the return screen was byte-identical
 * to a first-ever visit — `composer notice = null`, "All conversations" reading
 * "1 conversation", `localStorage = ["airship.display-preferences.v1"]`. Airship
 * could not tell them what they had lost because it had discarded even the
 * knowledge that there was something to lose.
 *
 * This ledger keeps that knowledge and nothing else: an opaque conversation id,
 * how many messages it held, when it was last active, and which durability
 * posture was in force. No title, no prompt, no reply, no digest. That boundary
 * is the point — the Vault route promises a page-memory session "What can lose
 * it: Closing the page", and a ledger that quietly retained titles in
 * `localStorage` would make that sentence false in order to report on it. What
 * survives here is a count and a clock, which is exactly what the return screen
 * needs to say and no more.
 *
 * Scope is the browser profile, matching the storage the entries describe: the
 * page-memory journal and the Local Device Vault are both per-origin, so a
 * per-origin ledger cannot report a loss to a browser profile that never held
 * the work.
 */

/**
 * The declared meaning of "ephemeral", in the words every surface must use.
 *
 * The lane's open question was whether this ledger contradicts the Vault
 * route's "Survives closing the tab: No · released with the page". The policy,
 * decided here because this module is the only thing that implements it:
 *
 *   **Ephemeral is a promise about content, not about the existence of a
 *   record.** Nothing a person wrote — no title, prompt, reply, digest or file
 *   path — is written outside page memory. What survives the page is a count,
 *   a clock, an opaque id and which storage posture was in force, kept per
 *   browser profile so a returning person can be told that something was not
 *   kept. Nothing here can reconstruct a word of it.
 *
 * `normalizeEntry` is what makes that a boundary rather than an intention: it
 * is applied on the write path as well as the read path, so a caller cannot
 * persist a field this policy does not name, whatever it hands in.
 * `return-ledger.test.ts` pins both halves.
 */
export const EPHEMERAL_RETENTION_DISCLOSURE =
  "Nothing you write leaves page memory: no title, no message, no digest. Airship keeps one line per conversation in this browser — how many messages it held and when it was last open — so a return can tell you something was not kept. Dismissing that report deletes it.";

/** Every field this ledger is permitted to persist. The disclosure above names them. */
export const RETURN_LEDGER_FIELDS = Object.freeze([
  "sessionId", "profileId", "messageCount", "lastActiveAt", "posture", "pageSession", "lost",
] as const);

/** Storage the ledger needs; narrowed so a test can hand it a plain map. */
import type { ReturnLedgerStorage } from "./ledger-storage";

export type { ReturnLedgerStorage };

/**
 * Where the conversation's journal lived while it was being written.
 *
 * A missing conversation means two different things under the two postures, and
 * the return screen must not say the same sentence about both: page memory
 * releasing a session is the documented behaviour of a choice the person made,
 * while an adopted Vault losing one is eviction or a wipe and is news.
 */
export type ReturnLedgerPosture = "page-memory" | "durable";

export type ReturnLedgerEntry = Readonly<{
  sessionId: string;
  profileId: string;
  messageCount: number;
  /** ISO-8601, so `formatInstant` renders it in the reader's own zone. */
  lastActiveAt: string;
  posture: ReturnLedgerPosture;
  /**
   * Which page session recorded this. A conversation that is absent from the
   * journal while its own page is still open was deleted or never materialized;
   * only an absence that outlived the page it was written in is a returning
   * person's lost work.
   */
  pageSession: string;
  /**
   * Set once reconciliation has established the conversation is gone. A lost
   * entry is never re-tested against the journal, so a conversation the person
   * deleted cannot be resurrected into a second, false, tombstone.
   */
  lost?: true;
}>;

export { browserReturnLedgerStorage } from "./ledger-storage";

export const RETURN_LEDGER_KEY = "airship.return-ledger.v1";

/**
 * Enough to describe a working week, small enough that the read stays cheap on
 * the boot path. Oldest entries fall off first.
 */
const MAX_ENTRIES = 40;

/**
 * A tombstone answers "what happened to my work" for a person who is still
 * looking for it. After a fortnight nobody is, and an undismissed notice that
 * outlives its own usefulness is the kind of standing alarm the Atlas measured
 * teaching people to ignore warnings.
 */
const TOMBSTONE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export function readReturnLedger(
  storage: ReturnLedgerStorage,
  now: number = Date.now(),
): readonly ReturnLedgerEntry[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(RETURN_LEDGER_KEY);
  } catch {
    // A private mode without storage simply has nothing to report.
    return Object.freeze([]);
  }
  if (!raw) return Object.freeze([]);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return Object.freeze([]);
    return Object.freeze(
      parsed
        .map((value) => normalizeEntry(value))
        .filter((entry): entry is ReturnLedgerEntry => Boolean(entry))
        .filter((entry) => !isExpiredTombstone(entry, now))
        .slice(0, MAX_ENTRIES),
    );
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Records that a conversation is holding work right now.
 *
 * Called on the transitions that make a conversation worth mourning — its first
 * user message, and every message after — so a conversation that was only ever
 * a boot-minted empty shell never enters the ledger and can never be reported
 * as lost. That is what keeps a first-ever visit silent.
 */
export function recordReturnLedgerEntry(
  storage: ReturnLedgerStorage,
  entry: ReturnLedgerEntry,
  now: number = Date.now(),
): void {
  if (!entry.sessionId || entry.messageCount <= 0) return;
  const current = readReturnLedger(storage, now);
  const existing = current.find((candidate) => candidate.sessionId === entry.sessionId);
  // A conversation that has already been mourned is not brought back to life by
  // a late write from the page that lost it.
  if (existing?.lost) return;
  /*
   * Normalized on the way in, not only on the way out.
   *
   * The read path already dropped undeclared fields, which made the boundary
   * true for this build and only this build: `writeLedger` serialized whatever
   * object the caller handed over, so one future call site passing the session
   * record — with its title in it — would have written a conversation's name
   * into `localStorage` under a policy that promises it never leaves page
   * memory, and nothing would have failed. The declared shape is enforced at
   * the only point where bytes are produced.
   */
  const declared = normalizeEntry(entry);
  if (!declared) return;
  writeLedger(storage, [
    declared,
    ...current.filter((candidate) => candidate.sessionId !== entry.sessionId),
  ]);
}

/**
 * Compares the ledger with the journal that actually loaded, and returns the
 * work that did not come back.
 *
 * A conversation the journal produced keeps its entry and loses any tombstone:
 * this is what lets a late Vault adoption withdraw a verdict a page-memory
 * journal reached a second earlier, rather than leaving a false loss on screen.
 * A conversation that vanished while its own page was open was deleted, not
 * lost, and leaves the ledger without a word. Everything else is marked `lost`
 * and kept, so the report survives a second reload by a person who has not read
 * it yet, until they dismiss it.
 */
export function reconcileReturnLedger(
  storage: ReturnLedgerStorage,
  options: Readonly<{ present: ReadonlySet<string>; pageSession: string }>,
  now: number = Date.now(),
): readonly ReturnLedgerEntry[] {
  const current = readReturnLedger(storage, now);
  const kept: ReturnLedgerEntry[] = [];
  for (const entry of current) {
    if (options.present.has(entry.sessionId)) {
      const { lost: _wasLost, ...survivor } = entry;
      kept.push(Object.freeze(survivor));
      continue;
    }
    if (!entry.lost && entry.pageSession === options.pageSession) continue;
    kept.push(Object.freeze({ ...entry, lost: true as const }));
  }
  writeLedger(storage, kept);
  return Object.freeze(kept.filter((entry) => entry.lost));
}

/** Drops entries the person has acknowledged, or that a report no longer covers. */
/**
 * Retire every continuity record at once, for a deliberate wipe.
 *
 * A Vault wipe empties the journal on purpose, and the ledger learns a
 * conversation is gone by finding it absent from the journal. Without this, the
 * reload at the end of a wipe came back and mourned every conversation the
 * person had just chosen to destroy — a loss report, a count, and an offer to
 * set up durability, for work deliberately thrown away. Same rule as a single
 * deletion: the only moment that knows it was a decision has to say so.
 */
export function clearReturnLedger(storage: ReturnLedgerStorage): void {
  try {
    storage.removeItem(RETURN_LEDGER_KEY);
  } catch {
    // A storage that refuses leaves the records in place, which errs toward
    // reporting a deliberate wipe as loss rather than losing work in silence.
  }
}

export function forgetReturnLedgerEntries(
  storage: ReturnLedgerStorage,
  sessionIds: readonly string[],
  now: number = Date.now(),
): void {
  const dropped = new Set(sessionIds);
  writeLedger(storage, readReturnLedger(storage, now).filter((entry) => !dropped.has(entry.sessionId)));
}

export type UnrecoveredWork = Readonly<{
  sessionIds: readonly string[];
  conversations: number;
  messages: number;
  /** The newest `lastActiveAt` across the lost entries, ISO-8601. */
  lastActiveAt: string;
  /** True when any lost conversation was written under an adopted Vault. */
  includesDurable: boolean;
  /** True when any lost conversation was written to page memory only. */
  includesPageMemory: boolean;
}>;

/**
 * One reading for the whole loss, because a returning person needs a number and
 * a time before they need a list. The per-conversation detail is deliberately
 * absent: the ledger never held a title to show.
 */
export function summarizeUnrecoveredWork(
  entries: readonly ReturnLedgerEntry[],
): UnrecoveredWork | undefined {
  if (entries.length === 0) return undefined;
  const lastActiveAt = entries
    .map((entry) => entry.lastActiveAt)
    .reduce((latest, candidate) => (candidate > latest ? candidate : latest));
  return Object.freeze({
    sessionIds: Object.freeze(entries.map((entry) => entry.sessionId)),
    conversations: entries.length,
    messages: entries.reduce((total, entry) => total + entry.messageCount, 0),
    lastActiveAt,
    includesDurable: entries.some((entry) => entry.posture === "durable"),
    includesPageMemory: entries.some((entry) => entry.posture === "page-memory"),
  });
}

function writeLedger(storage: ReturnLedgerStorage, entries: readonly ReturnLedgerEntry[]): void {
  try {
    if (entries.length === 0) {
      storage.removeItem(RETURN_LEDGER_KEY);
      return;
    }
    storage.setItem(RETURN_LEDGER_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Reporting a loss is best-effort; refusing to run without storage would
    // turn a missing quota into a second failure on the same screen.
  }
}

function isExpiredTombstone(entry: ReturnLedgerEntry, now: number): boolean {
  if (!entry.lost) return false;
  const recordedAt = Date.parse(entry.lastActiveAt);
  return Number.isFinite(recordedAt) && now - recordedAt > TOMBSTONE_LIFETIME_MS;
}

function normalizeEntry(value: unknown): ReturnLedgerEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const sessionId = candidate.sessionId;
  const lastActiveAt = candidate.lastActiveAt;
  const messageCount = candidate.messageCount;
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  if (typeof lastActiveAt !== "string" || !lastActiveAt) return undefined;
  if (typeof messageCount !== "number" || !Number.isFinite(messageCount)) return undefined;
  return Object.freeze({
    sessionId,
    profileId: typeof candidate.profileId === "string" ? candidate.profileId : "",
    messageCount: Math.max(0, Math.trunc(messageCount)),
    lastActiveAt,
    posture: candidate.posture === "durable" ? "durable" : "page-memory",
    pageSession: typeof candidate.pageSession === "string" ? candidate.pageSession : "",
    ...(candidate.lost === true ? { lost: true as const } : {}),
  });
}
