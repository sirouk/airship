/**
 * Continual harness stores: state authority, refinement application, rollback.
 *
 * Upstream persists `harness_state.json` per scope on disk with atomic
 * tmp+rename writes. On device there is no filesystem the page may rely on, so
 * the port replaces file atomicity with STORE-LEVEL atomicity: every mutation
 * is one atomic batch through a persistence adapter (`HarnessKvAdapter`), one
 * serialized record per entry or refinement event. applyRefinement validates
 * every edit first and rejects the whole proposal with a named ValidationIssue
 * list when any edit fails — no partial multi-entry apply, deliberately
 * stronger than upstream's applied:false markers, because a half-applied
 * multi-edit refinement is exactly the state drift the rollback machinery then
 * has to chase. Optimistic concurrency has two layers, mirroring upstream's
 * baseline compare: proposal-level conflicts become named issues (the caller
 * gets the full rejection list at once), adapter-level compare-and-set failure
 * (a genuinely concurrent writer) throws OptimisticConcurrencyError naming the
 * entry.
 */

import {
  HARNESS_EDIT_ACTIONS,
  HARNESS_ENTRY_KINDS,
  type HarnessAppliedEdit,
  type HarnessEntry,
  type HarnessEntryKind,
  type HarnessProposal,
  type HarnessRefinementEdit,
  type HarnessRefinementEvent,
  type HarnessScope,
  type HarnessSkillReference,
  type HarnessSnapshot,
  type ValidationIssue,
} from "./types";

export { HARNESS_EDIT_ACTIONS, HARNESS_ENTRY_KINDS, HARNESS_SCOPES } from "./types";

/** Wire schema version; bump only with a migration path. */
export const HARNESS_SCHEMA_VERSION = 1;

/** Upstream derives missing ids from titles; parity, including the 80-char cap. */
export const MAX_SLUG_LENGTH = 80;

/** Adapter key layout; one KV record per entry and per refinement event. */
const ENTRY_KEY_PREFIX = "entry/";
const EVENT_KEY_PREFIX = "refinement/";

export class OptimisticConcurrencyError extends Error {
  readonly kind: HarnessEntryKind | undefined;
  readonly entryId: string;

  constructor(message: string, entry: { kind?: HarnessEntryKind; id: string }) {
    super(message);
    this.name = "OptimisticConcurrencyError";
    this.kind = entry.kind;
    this.entryId = entry.id;
  }
}

/**
 * Thrown when applyRefinement rejects a proposal: issues are the full,
 * positioned rejection list so the caller can show the model everything wrong
 * in one pass instead of discovering one issue per retry.
 */
export class HarnessApplyRejectedError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Refinement rejected with ${issues.length} validation issue(s): ` +
        issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; "),
    );
    this.name = "HarnessApplyRejectedError";
    this.issues = issues;
  }
}

/** Thrown by persistence adapters on compare-and-set failure; translated by the store. */
export class HarnessKvConflictError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Harness record changed underfoot: ${key}`);
    this.name = "HarnessKvConflictError";
    this.key = key;
  }
}

export type HarnessEntryInput = Readonly<{
  id?: string;
  kind: HarnessEntryKind;
  title: string;
  content: string;
  path?: string;
  reference?: unknown;
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type HarnessEntryPatch = Readonly<{
  title?: string;
  content?: string;
  path?: string;
  reference?: unknown;
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type HarnessRefinementApplyOptions = Readonly<{
  scope: HarnessScope;
  source: "manual" | "auto" | "rollback";
  id?: string;
  rollbackOf?: string;
  /**
   * Entries as captured at plan time. When present, the first edit in the
   * proposal touching a kind:id whose CURRENT state differs from the baseline
   * is rejected with an `optimistic_conflict` issue — upstream's "entry
   * changed during refinement planning" rule, because the LLM call between
   * plan and apply can take many seconds during which another writer may edit
   * the shared store.
   */
  baseline?: readonly HarnessEntry[];
}>;

export interface HarnessStore {
  list(scope?: HarnessScope, kind?: HarnessEntryKind): Promise<readonly HarnessEntry[]>;
  get(scope: HarnessScope, kind: HarnessEntryKind, id: string): Promise<HarnessEntry | undefined>;
  create(scope: HarnessScope, input: HarnessEntryInput): Promise<HarnessEntry>;
  update(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    patch: HarnessEntryPatch,
    options?: { expectedVersion?: number },
  ): Promise<HarnessEntry>;
  delete(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    options?: { expectedVersion?: number },
  ): Promise<boolean>;
  refinements(scope?: HarnessScope): Promise<readonly HarnessRefinementEvent[]>;
  getRefinement(id: string): Promise<HarnessRefinementEvent | undefined>;
  applyRefinement(
    proposal: HarnessProposal,
    options: HarnessRefinementApplyOptions,
  ): Promise<HarnessRefinementEvent>;
  rollback(refinementId: string): Promise<HarnessRefinementEvent>;
  snapshot(): Promise<HarnessSnapshot>;
  restore(snapshot: HarnessSnapshot): Promise<void>;
  snapshotId(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Canonicalization helpers (shape-tolerant readers for untrusted persisted or
// model-emitted JSON; fail closed by rejecting, never by coercing kinds).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** deterministicStringify: snapshot ids must not depend on key insertion order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * canonicalSkillReference: accepts upstream's `python_import`/`call_pattern`
 * aliases (kernel-written entries use both spellings) and returns the
 * canonical typed shape, or undefined when the reference cannot satisfy the
 * skill contract. Fail-closed: no pass-through of malformed references.
 */
export function canonicalSkillReference(value: unknown): HarnessSkillReference | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "python") return undefined;
  const importName =
    typeof value.import === "string" && value.import.length > 0
      ? value.import
      : typeof value.python_import === "string" && value.python_import.length > 0
        ? value.python_import
        : undefined;
  if (!importName) return undefined;
  const callable =
    typeof value.callable === "string" && value.callable.length > 0 ? value.callable : undefined;
  const callPattern =
    typeof value.call_pattern === "string" && value.call_pattern.length > 0
      ? value.call_pattern
      : typeof value.callPattern === "string" && value.callPattern.length > 0
        ? value.callPattern
        : undefined;
  if (!callable && !callPattern) return undefined;
  return {
    type: "python",
    import: importName,
    ...(callable ? { callable } : {}),
    ...(callPattern ? { callPattern } : {}),
  };
}

function canonicalScope(value: unknown, fallback: HarnessScope): HarnessScope {
  return value === "global" || value === "local" ? value : fallback;
}

/**
 * canonicalHarnessEntry: shape-tolerant reader for persisted records. A record
 * missing its id/kind/title/content spine is dropped (returns undefined), same
 * as upstream loadHarnessState skipping malformed records so one corrupt
 * record cannot break the whole session.
 */
export function canonicalHarnessEntry(value: unknown, fallbackScope: HarnessScope): HarnessEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    !HARNESS_ENTRY_KINDS.includes(value.kind as HarnessEntryKind) ||
    typeof value.title !== "string" ||
    typeof value.content !== "string"
  ) {
    return undefined;
  }
  const kind = value.kind as HarnessEntryKind;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : 0;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : createdAt;
  const version =
    typeof value.version === "number" && Number.isFinite(value.version) && value.version >= 1
      ? value.version
      : 1;
  const reference = kind === "skill" ? canonicalSkillReference(value.reference) : undefined;
  return {
    id: value.id,
    kind,
    title: value.title,
    content: value.content,
    ...(typeof value.path === "string" && value.path.length > 0 ? { path: value.path } : {}),
    scope: canonicalScope(value.scope, fallbackScope),
    ...(reference ? { reference } : {}),
    ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    source: value.source === "refine" ? "refine" : "agent",
    createdAt,
    updatedAt,
    version,
  };
}

function canonicalAppliedEdit(value: unknown): HarnessAppliedEdit | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind as HarnessEntryKind;
  const action = value.action as HarnessAppliedEdit["action"];
  if (!HARNESS_ENTRY_KINDS.includes(kind) || !HARNESS_EDIT_ACTIONS.includes(action)) return undefined;
  if (typeof value.id !== "string") return undefined;
  return {
    action,
    kind,
    id: value.id,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(value.reference !== undefined ? { reference: value.reference } : {}),
    ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(value.before !== undefined ? { before: canonicalHarnessEntry(value.before, "local") } : {}),
    ...(value.after !== undefined ? { after: canonicalHarnessEntry(value.after, "local") } : {}),
  };
}

export function canonicalRefinementEvent(
  value: unknown,
  fallbackScope: HarnessScope,
): HarnessRefinementEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.summary !== "string") return undefined;
  const edits = Array.isArray(value.edits)
    ? value.edits.map(canonicalAppliedEdit).filter((edit): edit is HarnessAppliedEdit => edit !== undefined)
    : [];
  return {
    id: value.id,
    summary: value.summary,
    rationale: typeof value.rationale === "string" ? value.rationale : "",
    expectedOutcome: typeof value.expectedOutcome === "string" ? value.expectedOutcome : "",
    edits,
    ...(typeof value.rollbackOf === "string" ? { rollbackOf: value.rollbackOf } : {}),
    scope: canonicalScope(value.scope, fallbackScope),
    source: value.source === "auto" || value.source === "rollback" ? value.source : "manual",
    appliedAt: typeof value.appliedAt === "number" ? value.appliedAt : 0,
  };
}

/**
 * resolveHarnessRef: `local:`/`global:` id prefixes are display syntax from
 * the prompt overview; accepting them back verbatim mirrors the kernel-side
 * `_strip_scope_prefix`. A prefix routes the ref to the named scope; bare ids
 * keep the caller-provided scope.
 */
export function resolveHarnessRef(
  scope: HarnessScope,
  id: string,
): Readonly<{ scope: HarnessScope; id: string }> {
  const separator = id.indexOf(":");
  if (separator > 0 && separator < id.length - 1) {
    const prefix = id.slice(0, separator);
    if (prefix === "local" || prefix === "global") {
      return { scope: prefix, id: id.slice(separator + 1) };
    }
  }
  return { scope, id };
}

/** slug: verbatim port of upstream `slug` (lowercase, non-alnum runs -> "_", 80 chars). */
export function slugHarnessId(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return normalized || fallback;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
  return entry ? cloneJson(entry) : undefined;
}

// ---------------------------------------------------------------------------
// Refinement edit validation (pure; the all-or-nothing gate for applyRefinement).
// ---------------------------------------------------------------------------

export type PreparedRefinementEdit = Readonly<{
  index: number;
  action: HarnessAppliedEdit["action"];
  kind: HarnessEntryKind;
  id: string;
  title?: string;
  content?: string;
  path?: string;
  reference?: HarnessSkillReference;
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  reason?: string;
  before?: HarnessEntry;
}>;

export type ValidatedRefinement = Readonly<{
  issues: readonly ValidationIssue[];
  prepared: readonly PreparedRefinementEdit[];
}>;

/**
 * validateRefinementEdits: the all-or-nothing gate. Checks, in order per edit:
 * action/kind membership, base-system-prompt immutability, id presence,
 * title/content presence, skill reference + arguments contract, existence for
 * update/delete and non-existence for create, and the optimistic baseline
 * compare. Duplicated kind:id targets inside one proposal skip the baseline
 * compare after the first touch, mirroring upstream's proposalModifiedKeys
 * (the second edit's baseline IS the first edit's result). `entries` must
 * already be filtered to the target scope: that filter is what makes global
 * entries read-only during a local refinement — an update/delete against a
 * global id reports entry_not_found in the local scope, same as upstream
 * applying against a scope-segregated state file.
 */
export function validateRefinementEdits(
  entries: readonly HarnessEntry[],
  edits: readonly HarnessRefinementEdit[],
  options: HarnessRefinementApplyOptions,
): ValidatedRefinement {
  const issues: ValidationIssue[] = [];
  const prepared: PreparedRefinementEdit[] = [];
  const baselineByKey = new Map<string, string>();
  for (const entry of options.baseline ?? []) {
    baselineByKey.set(`${entry.kind}:${entry.id}`, stableStringify(entry));
  }
  const hasBaseline = options.baseline !== undefined;
  const byKey = new Map<string, HarnessEntry | undefined>();
  for (const entry of entries) {
    byKey.set(`${entry.kind}:${entry.id}`, entry);
  }
  const proposalModifiedKeys = new Set<string>();

  edits.forEach((edit, index) => {
    const fail = (code: ValidationIssue["code"], message: string, kind?: HarnessEntryKind, id?: string): void => {
      issues.push({ code, message, editIndex: index, ...(kind ? { kind } : {}), ...(id ? { id } : {}) });
    };
    if (!HARNESS_EDIT_ACTIONS.includes(edit.action)) {
      fail("unsupported_action", `unsupported action ${String(edit.action)}`, undefined, edit.id);
      return;
    }
    if (!HARNESS_ENTRY_KINDS.includes(edit.kind)) {
      fail("unsupported_kind", `unsupported kind ${String(edit.kind)}`, undefined, edit.id);
      return;
    }
    const kind = edit.kind as HarnessEntryKind;
    const computedId =
      edit.id !== undefined
        ? resolveHarnessRef(options.scope, edit.id).id
        : edit.action === "create"
          ? slugHarnessId(edit.title ?? kind, kind)
          : undefined;
    if (kind === "prompt" && computedId === "base_system_prompt") {
      fail("immutable_entry", "base system prompt is not editable", kind, computedId);
      return;
    }
    if (edit.action !== "create" && computedId === undefined) {
      fail("missing_id", `${edit.action} requires id`, kind, undefined);
      return;
    }
    const id = computedId ?? "";
    if (edit.action !== "delete" && (!edit.title || !edit.content)) {
      fail("missing_fields", `${edit.action} requires title and content`, kind, id);
      return;
    }
    if (edit.action !== "delete" && kind === "skill" && edit.arguments === undefined) {
      fail("skill_reference_invalid", `${edit.action} skill requires arguments`, kind, id);
      return;
    }
    const key = `${kind}:${id}`;
    const before = byKey.get(key);
    let reference: HarnessSkillReference | undefined;
    if (edit.action !== "delete" && kind === "skill") {
      // An update that omits `reference` preserves the existing one (mirrors
      // kernel-side update_skill), so canonicalize against the current entry.
      const source = edit.reference !== undefined ? edit.reference : before?.reference;
      const canonical = canonicalSkillReference(source);
      if (!canonical) {
        // An update whose target does not exist fails below with
        // entry_not_found; a reference issue too would only mislead.
        if (!(edit.action === "update" && before === undefined)) {
          fail(
            "skill_reference_invalid",
            `${edit.action} skill requires a python reference with an import and a callable or call_pattern`,
            kind,
            id,
          );
          return;
        }
      } else {
        reference = canonical;
      }
    }
    if (hasBaseline && !proposalModifiedKeys.has(key)) {
      const baselineSerialized = baselineByKey.get(key);
      const currentSerialized = before === undefined ? undefined : stableStringify(before);
      if (currentSerialized !== baselineSerialized) {
        fail("optimistic_conflict", "entry changed during refinement planning", kind, id);
        return;
      }
    }
    if (edit.action === "delete" && before === undefined) {
      fail("entry_not_found", `entry not found in the ${options.scope} scope: ${kind}:${id}`, kind, id);
      return;
    }
    if (edit.action === "create" && before !== undefined) {
      fail("entry_exists", `entry already exists in the ${options.scope} scope: ${kind}:${id}`, kind, id);
      return;
    }
    if (edit.action === "update" && before === undefined) {
      fail("entry_not_found", `entry not found in the ${options.scope} scope: ${kind}:${id}`, kind, id);
      return;
    }
    proposalModifiedKeys.add(key);
    prepared.push({
      index,
      action: edit.action,
      kind,
      id,
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.content !== undefined ? { content: edit.content } : {}),
      ...(edit.path !== undefined ? { path: edit.path } : {}),
      ...(reference ? { reference } : {}),
      ...(edit.arguments !== undefined ? { arguments: edit.arguments } : {}),
      ...(isRecord(edit.metadata) ? { metadata: edit.metadata } : {}),
      ...(edit.reason !== undefined ? { reason: edit.reason } : {}),
      ...(before ? { before: cloneEntry(before) } : {}),
    });
    // Later edits to the same key validate against this proposal's own write.
    if (edit.action === "delete") {
      byKey.set(key, undefined);
    } else {
      const mergedReference = reference ?? before?.reference;
      const mergedArguments = edit.arguments ?? before?.arguments;
      const mergedMetadata = edit.metadata ?? before?.metadata;
      byKey.set(key, {
        id,
        kind,
        title: edit.title ?? before?.title ?? id,
        content: edit.content ?? before?.content ?? "",
        path: edit.path ?? before?.path ?? "general",
        scope: before?.scope ?? options.scope,
        ...(mergedReference ? { reference: mergedReference } : {}),
        ...(mergedArguments ? { arguments: mergedArguments } : {}),
        ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
        source: "refine",
        createdAt: before?.createdAt ?? 0,
        updatedAt: before?.updatedAt ?? 0,
        version: before ? before.version + 1 : 1,
      });
    }
  });

  return { issues, prepared };
}

// ---------------------------------------------------------------------------
// Persistence seam. The adapter is the ONLY thing that changes between
// volatile and durable stores: same record vocabulary, same batch protocol.
// ---------------------------------------------------------------------------

export type HarnessKvRecord = Readonly<{ key: string; value: string }>;

/**
 * expectedValue semantics: undefined = unchecked write; null = the key must
 * NOT exist; a string = byte-for-byte compare-and-set. The null case is what
 * makes concurrent creates of the same id fail instead of silently
 * last-write-wins.
 */
export type HarnessKvWrite =
  | Readonly<{ type: "put"; key: string; value: string; expectedValue?: string | null }>
  | Readonly<{ type: "delete"; key: string; expectedValue?: string | null }>;

export interface HarnessKvAdapter {
  /** Full read; stores are small (capped projections) so scans are cheap and honest. */
  readAll(): Promise<readonly HarnessKvRecord[]>;
  /**
   * Atomic batch. Every expectation must hold against currently stored state;
   * any mismatch aborts the WHOLE batch and throws HarnessKvConflictError
   * naming the first conflicting key. This is the store-level replacement for
   * upstream's tmp+rename file atomicity.
   */
  transact(writes: readonly HarnessKvWrite[]): Promise<void>;
}

export class InMemoryHarnessKvAdapter implements HarnessKvAdapter {
  private readonly records = new Map<string, string>();

  readAll(): Promise<readonly HarnessKvRecord[]> {
    return Promise.resolve([...this.records.entries()].map(([key, value]) => ({ key, value })));
  }

  async transact(writes: readonly HarnessKvWrite[]): Promise<void> {
    // Validate against a staging copy first so a mid-batch conflict cannot
    // leave the map half-written; in-memory, the copy is the atomicity.
    const staged = new Map(this.records);
    for (const write of writes) {
      const current = staged.get(write.key);
      const expectationHolds =
        write.expectedValue === undefined
          ? true
          : write.expectedValue === null
            ? current === undefined
            : current === write.expectedValue;
      if (!expectationHolds) {
        throw new HarnessKvConflictError(write.key);
      }
      if (write.type === "put") {
        staged.set(write.key, write.value);
      } else {
        staged.delete(write.key);
      }
    }
    this.records.clear();
    for (const [key, value] of staged) this.records.set(key, value);
    return Promise.resolve();
  }
}

function entryKey(scope: HarnessScope, kind: HarnessEntryKind, id: string): string {
  return `${ENTRY_KEY_PREFIX}${scope}/${kind}/${id}`;
}

function refinementKey(scope: HarnessScope, id: string): string {
  return `${EVENT_KEY_PREFIX}${scope}/${id}`;
}

function keyScope(key: string, prefix: string): HarnessScope {
  return key.slice(prefix.length, prefix.length + 6) === "global" ? "global" : "local";
}

export type HarnessStoreOptions = Readonly<{
  /** Injectable clock so tests and deterministic replay never depend on wall time. */
  now?: () => number;
  /**
   * Injectable event id factory; defaults to upstream's `refine_<compact-iso>`
   * shape. Collisions (two applies inside one 10 ms tick) get a `_2` suffix.
   */
  createEventId?: (appliedAt: number) => string;
}>;

type StoreCache = {
  entries: Map<string, { entry: HarnessEntry; serialized: string }>;
  refinements: Map<string, HarnessRefinementEvent>;
};

function compareEntriesForList(a: HarnessEntry, b: HarnessEntry): number {
  // Upstream kernel list() sorts by (kind, path, title, id); projections stay stable.
  return (
    a.kind.localeCompare(b.kind) ||
    (a.path ?? "general").localeCompare(b.path ?? "general") ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Shared store authority. Holds an in-memory cache hydrated once from the
 * adapter; every mutation validates against the cache, builds one atomic
 * write batch with compare-and-set expectations taken from the cache, and
 * only then commits the cache. An adapter-level CAS mismatch means another
 * writer owns the record: the cache is dropped (the next read re-syncs, the
 * kernel-side equivalent of `_sync_from_disk`) and OptimisticConcurrencyError
 * names the contested entry.
 */
export abstract class HarnessStoreBase implements HarnessStore {
  private cache?: StoreCache;
  private readonly nowFn: () => number;
  private readonly createEventIdFn: (appliedAt: number) => string;

  constructor(private readonly adapter: HarnessKvAdapter, options: HarnessStoreOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
    this.createEventIdFn = options.createEventId ?? ((appliedAt) => defaultRefinementId(new Date(appliedAt)));
  }

  private async ensureCache(): Promise<StoreCache> {
    if (this.cache) return this.cache;
    const records = await this.adapter.readAll();
    const entries = new Map<string, { entry: HarnessEntry; serialized: string }>();
    const refinements = new Map<string, HarnessRefinementEvent>();
    for (const record of records) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.value);
      } catch {
        // One corrupt record must not break the store (upstream: a corrupt
        // state file degrades to empty). Skipping it lets later writes heal.
        continue;
      }
      if (record.key.startsWith(ENTRY_KEY_PREFIX)) {
        const entry = canonicalHarnessEntry(parsed, keyScope(record.key, ENTRY_KEY_PREFIX));
        if (entry) entries.set(`${entry.scope}:${entry.kind}:${entry.id}`, { entry, serialized: record.value });
      } else if (record.key.startsWith(EVENT_KEY_PREFIX)) {
        const event = canonicalRefinementEvent(parsed, keyScope(record.key, EVENT_KEY_PREFIX));
        if (event) refinements.set(`${event.scope}:${event.id}`, event);
      }
    }
    this.cache = { entries, refinements };
    return this.cache;
  }

  private async commit(writes: readonly HarnessKvWrite[], apply: (cache: StoreCache) => void): Promise<void> {
    const cache = await this.ensureCache();
    try {
      await this.adapter.transact(writes);
    } catch (error) {
      // Any failed batch invalidates the cache: a conflict means another
      // writer owns current state, and a generic adapter failure may have
      // applied a partial batch (custom adapters are allowed to degrade).
      // Rehydrating on the next read is the only honest recovery.
      this.cache = undefined;
      if (error instanceof HarnessKvConflictError) {
        // A create-intent write (put with expectedValue null) that collides on
        // an entry key names the duplicate rather than a generic conflict: a
        // concurrent create of the same id and a stale-cache duplicate create
        // are the same human-facing truth, and the reachability of last-write-
        // wins was never one of them.
        const duplicate = writes.find(
          (write) => write.type === "put" && write.expectedValue === null && write.key === error.key && error.key.startsWith(ENTRY_KEY_PREFIX),
        );
        if (duplicate) {
          throw new Error(`${translateConflictKey(duplicate.key).split("/")[1]} entry '${translateConflictKey(duplicate.key).split("/").pop()}' already exists in the ${translateConflictKey(duplicate.key).split("/")[0]} scope`);
        }
        throw new OptimisticConcurrencyError(
          `Harness state changed concurrently (${translateConflictKey(error.key)}); re-read and retry the operation.`,
          { id: translateConflictKey(error.key) },
        );
      }
      throw error;
    }
    apply(cache);
  }

  async list(scope?: HarnessScope, kind?: HarnessEntryKind): Promise<readonly HarnessEntry[]> {
    const cache = await this.ensureCache();
    return [...cache.entries.values()]
      .map((record) => cloneJson(record.entry))
      .filter((entry) => (scope === undefined || entry.scope === scope) && (kind === undefined || entry.kind === kind))
      .sort(compareEntriesForList);
  }

  async get(scope: HarnessScope, kind: HarnessEntryKind, id: string): Promise<HarnessEntry | undefined> {
    const cache = await this.ensureCache();
    const ref = resolveHarnessRef(scope, id);
    return cloneEntry(cache.entries.get(`${ref.scope}:${kind}:${ref.id}`)?.entry);
  }

  async create(scope: HarnessScope, input: HarnessEntryInput): Promise<HarnessEntry> {
    const ref = resolveHarnessRef(scope, input.id ?? slugHarnessId(input.title, input.kind));
    const cache = await this.ensureCache();
    const cacheKey = `${ref.scope}:${input.kind}:${ref.id}`;
    if (cache.entries.has(cacheKey)) {
      throw new Error(`${input.kind} entry '${ref.id}' already exists in the ${ref.scope} scope`);
    }
    const reference =
      input.kind === "skill" && input.reference !== undefined ? canonicalSkillReference(input.reference) : undefined;
    if (input.kind === "skill" && input.reference !== undefined && !reference) {
      throw new Error("skill entries require a python reference with an import and a callable or call_pattern");
    }
    const now = this.nowFn();
    const entry: HarnessEntry = {
      id: ref.id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      path: input.path ?? "general",
      scope: ref.scope,
      ...(reference ? { reference } : {}),
      ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      source: "agent",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const serialized = stableStringify(entry);
    await this.commit(
      [{ type: "put", key: entryKey(ref.scope, input.kind, ref.id), value: serialized, expectedValue: null }],
      (state) => state.entries.set(cacheKey, { entry, serialized }),
    );
    return cloneJson(entry);
  }

  async update(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    patch: HarnessEntryPatch,
    options: { expectedVersion?: number } = {},
  ): Promise<HarnessEntry> {
    const ref = resolveHarnessRef(scope, id);
    const cache = await this.ensureCache();
    const cacheKey = `${ref.scope}:${kind}:${ref.id}`;
    const current = cache.entries.get(cacheKey);
    if (!current) {
      throw new Error(`${kind} entry '${ref.id}' does not exist in the ${ref.scope} scope`);
    }
    if (options.expectedVersion !== undefined && current.entry.version !== options.expectedVersion) {
      throw new OptimisticConcurrencyError(
        `Harness entry changed concurrently (${kind}:${ref.id} at version ${current.entry.version}, expected ${options.expectedVersion}); re-read and retry the operation.`,
        { kind, id: ref.id },
      );
    }
    const reference = patch.reference !== undefined ? canonicalSkillReference(patch.reference) : undefined;
    if (patch.reference !== undefined && !reference) {
      throw new Error("skill reference must be type python with an import and a callable or call_pattern");
    }
    const now = this.nowFn();
    // Omitted patch fields preserve the current values, mirroring kernel-side
    // _upsert so a title-only update does not wipe a skill's contract.
    const entry: HarnessEntry = {
      ...current.entry,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.path !== undefined ? { path: patch.path } : {}),
      ...(patch.reference !== undefined ? { reference } : {}),
      ...(patch.arguments !== undefined ? { arguments: patch.arguments } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: now,
      version: current.entry.version + 1,
    };
    const serialized = stableStringify(entry);
    await this.commit(
      [{ type: "put", key: entryKey(ref.scope, kind, ref.id), value: serialized, expectedValue: current.serialized }],
      (state) => state.entries.set(cacheKey, { entry, serialized }),
    );
    return cloneJson(entry);
  }

  async delete(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    options: { expectedVersion?: number } = {},
  ): Promise<boolean> {
    const ref = resolveHarnessRef(scope, id);
    const cache = await this.ensureCache();
    const cacheKey = `${ref.scope}:${kind}:${ref.id}`;
    const current = cache.entries.get(cacheKey);
    if (!current) return false;
    if (options.expectedVersion !== undefined && current.entry.version !== options.expectedVersion) {
      throw new OptimisticConcurrencyError(
        `Harness entry changed concurrently (${kind}:${ref.id} at version ${current.entry.version}, expected ${options.expectedVersion}); re-read and retry the operation.`,
        { kind, id: ref.id },
      );
    }
    await this.commit(
      [{ type: "delete", key: entryKey(ref.scope, kind, ref.id), expectedValue: current.serialized }],
      (state) => state.entries.delete(cacheKey),
    );
    return true;
  }

  async refinements(scope?: HarnessScope): Promise<readonly HarnessRefinementEvent[]> {
    const cache = await this.ensureCache();
    return [...cache.refinements.values()]
      .filter((event) => scope === undefined || event.scope === scope)
      .sort((a, b) => a.appliedAt - b.appliedAt || a.id.localeCompare(b.id))
      .map((event) => cloneJson(event));
  }

  async getRefinement(id: string): Promise<HarnessRefinementEvent | undefined> {
    const cache = await this.ensureCache();
    const event = cache.refinements.get(`local:${id}`) ?? cache.refinements.get(`global:${id}`);
    return event ? cloneJson(event) : undefined;
  }

  async applyRefinement(
    proposal: HarnessProposal,
    options: HarnessRefinementApplyOptions,
  ): Promise<HarnessRefinementEvent> {
    const scopeEntries = await this.list(options.scope);
    const { issues, prepared } = validateRefinementEdits(scopeEntries, proposal.edits, options);
    if (issues.length > 0) {
      throw new HarnessApplyRejectedError(issues);
    }
    const now = this.nowFn();
    const cache = await this.ensureCache();
    const appliedEdits: HarnessAppliedEdit[] = [];
    const writes: HarnessKvWrite[] = [];
    // Cache images as this proposal itself mutates them. Tracking (not the raw
    // cache) is what makes a multi-edit proposal hitting the same key atomic
    // AND sequential: the second edit's expectation is the first edit's write.
    const trackedSerialized = new Map<string, string | undefined>();
    const trackedEntries = new Map<string, HarnessEntry | undefined>();
    const currentEntryFor = (cacheKey: string): HarnessEntry | undefined =>
      trackedEntries.has(cacheKey) ? trackedEntries.get(cacheKey) : cache.entries.get(cacheKey)?.entry;
    const expectedFor = (cacheKey: string): string | null => {
      const value = trackedSerialized.has(cacheKey)
        ? trackedSerialized.get(cacheKey)
        : cache.entries.get(cacheKey)?.serialized;
      return value === undefined ? null : value;
    };

    for (const edit of prepared) {
      const cacheKey = `${options.scope}:${edit.kind}:${edit.id}`;
      const before = cloneEntry(currentEntryFor(cacheKey));
      const expectedValue = expectedFor(cacheKey);
      if (edit.action === "delete") {
        appliedEdits.push({ ...stripPrepared(edit), ...(before ? { before } : {}) });
        writes.push({ type: "delete", key: entryKey(options.scope, edit.kind, edit.id), expectedValue });
        trackedSerialized.set(cacheKey, undefined);
        trackedEntries.set(cacheKey, undefined);
        continue;
      }
      const afterReference = edit.reference ?? before?.reference;
      const afterArguments = edit.arguments ?? before?.arguments;
      const afterMetadata = edit.metadata ?? before?.metadata;
      const after: HarnessEntry = {
        id: edit.id,
        kind: edit.kind,
        title: edit.title ?? before?.title ?? edit.id,
        content: edit.content ?? before?.content ?? "",
        path: edit.path ?? before?.path ?? "general",
        scope: before?.scope ?? options.scope,
        ...(afterReference ? { reference: afterReference } : {}),
        ...(afterArguments ? { arguments: afterArguments } : {}),
        ...(afterMetadata ? { metadata: afterMetadata } : {}),
        source: "refine",
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
        version: before ? before.version + 1 : 1,
      };
      const serialized = stableStringify(after);
      appliedEdits.push({ ...stripPrepared(edit), ...(before ? { before } : {}), after: cloneJson(after) });
      writes.push({ type: "put", key: entryKey(options.scope, edit.kind, edit.id), value: serialized, expectedValue });
      trackedSerialized.set(cacheKey, serialized);
      trackedEntries.set(cacheKey, after);
    }

    const eventId = this.uniqueEventId(options.id, cache, now);
    const event: HarnessRefinementEvent = {
      id: eventId,
      summary: proposal.summary,
      rationale: proposal.rationale,
      expectedOutcome: proposal.expectedOutcome,
      edits: appliedEdits,
      ...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
      scope: options.scope,
      source: options.source,
      appliedAt: now,
    };
    writes.push({ type: "put", key: refinementKey(options.scope, eventId), value: stableStringify(event) });

    await this.commit(writes, (state) => {
      for (const edit of appliedEdits) {
        const cacheKey = `${options.scope}:${edit.kind}:${edit.id}`;
        if (edit.action === "delete") {
          state.entries.delete(cacheKey);
        } else if (edit.after) {
          state.entries.set(cacheKey, { entry: cloneJson(edit.after), serialized: stableStringify(edit.after) });
        }
      }
      state.refinements.set(`${options.scope}:${eventId}`, cloneJson(event));
    });
    return cloneJson(event);
  }

  async rollback(refinementId: string): Promise<HarnessRefinementEvent> {
    const target = await this.getRefinement(refinementId);
    if (!target) {
      throw new Error(`Refinement '${refinementId}' not found`);
    }
    // Rollback restores exact recorded records; it never re-applies proposal
    // inputs. Restoring "before" verbatim (timestamps, source, version) keeps
    // snapshots byte-identical across a refinement/rollback roundtrip, and
    // the KV expectedValue guards make any drift after the refinement a
    // refusal instead of a stomp.
    const now = this.nowFn();
    const cache = await this.ensureCache();
    const writes: HarnessKvWrite[] = [];
    const restores: Array<{ edit: HarnessAppliedEdit; kind: HarnessEntryKind; id: string; entry?: HarnessEntry }> = [];

    for (const edit of [...target.edits].reverse()) {
      const cacheKey = `${target.scope}:${edit.kind}:${edit.id}`;
      const key = entryKey(target.scope, edit.kind, edit.id);
      const current = cache.entries.get(cacheKey);

      if (edit.after !== undefined && edit.before !== undefined) {
        if (!current) {
          throw new Error(`Harness rollback refused: entry '${edit.id}' vanished after refinement ${target.id}.`);
        }
        if (current.serialized !== stableStringify(edit.after)) {
          throw new OptimisticConcurrencyError(
            `Harness entry drifted after refinement ${target.id} (${edit.kind}:${edit.id}); rollback refuses to stomp a newer write.`,
            { kind: edit.kind, id: edit.id },
          );
        }
        writes.push({
          type: "put",
          key,
          value: stableStringify(edit.before),
          expectedValue: current.serialized,
        });
        restores.push({
          edit: {
            action: "update",
            kind: edit.kind,
            id: edit.id,
            ...(edit.before?.title !== undefined ? { title: edit.before.title } : {}),
            ...(edit.before?.content !== undefined ? { content: edit.before.content } : {}),
            ...(edit.before?.path !== undefined ? { path: edit.before.path } : {}),
            before: cloneJson(edit.after),
            after: cloneJson(edit.before),
            reason: `Rollback ${target.id}`,
          } as HarnessAppliedEdit,
          kind: edit.kind,
          id: edit.id,
          entry: cloneJson(edit.before),
        });
      } else if (edit.after !== undefined) {
        if (!current) {
          throw new Error(`Harness rollback refused: entry '${edit.id}' vanished after refinement ${target.id}.`);
        }
        if (current.serialized !== stableStringify(edit.after)) {
          throw new OptimisticConcurrencyError(
            `Harness entry drifted after refinement ${target.id} (${edit.kind}:${edit.id}); rollback refuses to stomp a newer write.`,
            { kind: edit.kind, id: edit.id },
          );
        }
        writes.push({ type: "delete", key, expectedValue: stableStringify(edit.after) });
        restores.push({
          edit: {
            action: "delete",
            kind: edit.kind,
            id: edit.id,
            before: cloneJson(edit.after),
            reason: `Rollback ${target.id}`,
          } as HarnessAppliedEdit,
          kind: edit.kind,
          id: edit.id,
        });
      } else if (edit.before !== undefined) {
        writes.push({
          type: "put",
          key,
          value: stableStringify(edit.before),
          expectedValue: current?.serialized ?? null,
        });
        restores.push({
          edit: {
            action: "create",
            kind: edit.kind,
            id: edit.id,
            ...(edit.before?.title !== undefined ? { title: edit.before.title } : {}),
            ...(edit.before?.content !== undefined ? { content: edit.before.content } : {}),
            ...(edit.before?.path !== undefined ? { path: edit.before.path } : {}),
            after: cloneJson(edit.before),
            reason: `Rollback ${target.id}`,
          } as HarnessAppliedEdit,
          kind: edit.kind,
          id: edit.id,
          entry: cloneJson(edit.before),
        });
      }
    }

    const appliedEdits: HarnessAppliedEdit[] = restores.map((restore) => restore.edit);
    const eventId = this.uniqueEventId(undefined, cache, now);
    const event: HarnessRefinementEvent = {
      id: eventId,
      summary: `Rollback refinement ${target.id}`,
      rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
      expectedOutcome: `${target.edits.length} recorded edits reversed.`,
      edits: appliedEdits,
      rollbackOf: target.id,
      scope: target.scope,
      source: "rollback",
      appliedAt: now,
    };
    writes.push({ type: "put", key: refinementKey(target.scope, eventId), value: stableStringify(event) });

    await this.commit(writes, (state) => {
      for (const restore of restores) {
        const cacheKey = `${target.scope}:${restore.kind}:${restore.id}`;
        if (restore.edit.action === "delete") {
          state.entries.delete(cacheKey);
        } else if (restore.entry !== undefined) {
          state.entries.set(cacheKey, {
            entry: cloneJson(restore.entry),
            serialized: stableStringify(restore.entry),
          });
        }
      }
      state.refinements.set(`${target.scope}:${eventId}`, cloneJson(event));
    });
    return cloneJson(event);
  }

  async snapshot(): Promise<HarnessSnapshot> {
    const entries = await this.list();
    const events = await this.refinements();
    return { schema: HARNESS_SCHEMA_VERSION, entries, refinements: events };
  }

  async restore(snapshot: HarnessSnapshot): Promise<void> {
    const cache = await this.ensureCache();
    const entries = snapshot.entries
      .map((entry) => canonicalHarnessEntry(entry, entry.scope))
      .filter((entry): entry is HarnessEntry => entry !== undefined);
    const events = snapshot.refinements
      .map((event) => canonicalRefinementEvent(event, event.scope))
      .filter((event): event is HarnessRefinementEvent => event !== undefined);
    const wantedEntries = new Map<string, string>();
    for (const entry of entries) {
      wantedEntries.set(entryKey(entry.scope, entry.kind, entry.id), stableStringify(entry));
    }
    const wantedEvents = new Map<string, string>();
    for (const event of events) {
      wantedEvents.set(refinementKey(event.scope, event.id), stableStringify(event));
    }
    const writes: HarnessKvWrite[] = [];
    // Replace, not merge: a restore must not resurrect state the snapshot
    // never knew about, or "all-or-nothing" stops meaning anything.
    for (const { entry, serialized } of cache.entries.values()) {
      const key = entryKey(entry.scope, entry.kind, entry.id);
      const wanted = wantedEntries.get(key);
      if (wanted === undefined) {
        writes.push({ type: "delete", key, expectedValue: serialized });
      } else if (wanted !== serialized) {
        writes.push({ type: "put", key, value: wanted, expectedValue: serialized });
      }
      wantedEntries.delete(key);
    }
    for (const [key, value] of wantedEntries) {
      writes.push({ type: "put", key, value, expectedValue: null });
    }
    for (const event of cache.refinements.values()) {
      const key = refinementKey(event.scope, event.id);
      const currentSerialized = stableStringify(event);
      const wanted = wantedEvents.get(key);
      if (wanted === undefined) {
        writes.push({ type: "delete", key, expectedValue: currentSerialized });
      } else if (wanted !== currentSerialized) {
        writes.push({ type: "put", key, value: wanted, expectedValue: currentSerialized });
      }
      wantedEvents.delete(key);
    }
    for (const [key, value] of wantedEvents) {
      writes.push({ type: "put", key, value, expectedValue: null });
    }
    await this.commit(writes, (state) => {
      state.entries.clear();
      state.refinements.clear();
      for (const entry of entries) {
        state.entries.set(`${entry.scope}:${entry.kind}:${entry.id}`, {
          entry: cloneJson(entry),
          serialized: stableStringify(entry),
        });
      }
      for (const event of events) {
        state.refinements.set(`${event.scope}:${event.id}`, cloneJson(event));
      }
    });
  }

  async snapshotId(): Promise<string> {
    const snapshot = await this.snapshot();
    // WebCrypto digest: no Node APIs, and deterministic because stableStringify
    // sorts keys — two stores holding equal state agree on the id.
    const bytes = new TextEncoder().encode(stableStringify(snapshot));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${base64UrlEncode(new Uint8Array(digest))}`;
  }

  private uniqueEventId(requested: string | undefined, cache: StoreCache, now: number): string {
    const collides = (id: string): boolean =>
      cache.refinements.has(`local:${id}`) || cache.refinements.has(`global:${id}`);
    if (requested && !collides(requested)) return requested;
    const base = requested ?? this.createEventIdFn(now);
    if (!collides(base)) return base;
    let counter = 2;
    while (collides(`${base}_${counter}`)) counter += 1;
    return `${base}_${counter}`;
  }
}

function stripPrepared(edit: PreparedRefinementEdit): Omit<HarnessAppliedEdit, "before" | "after"> {
  return {
    action: edit.action,
    kind: edit.kind,
    id: edit.id,
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.content !== undefined ? { content: edit.content } : {}),
    ...(edit.path !== undefined ? { path: edit.path } : {}),
    ...(edit.reference !== undefined ? { reference: edit.reference } : {}),
    ...(edit.arguments !== undefined ? { arguments: edit.arguments } : {}),
    ...(edit.metadata !== undefined ? { metadata: edit.metadata } : {}),
    ...(edit.reason !== undefined ? { reason: edit.reason } : {}),
  };
}

/** Upstream refine event ids are `refine_<compact ISO>`; collisions get suffixed by uniqueEventId. */
function defaultRefinementId(date: Date): string {
  return `refine_${date.toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function translateConflictKey(key: string): string {
  return key.startsWith(ENTRY_KEY_PREFIX) ? key.slice(ENTRY_KEY_PREFIX.length) : key;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Volatile default store. "Deterministic" is a constructor option, not a
 * separate class: pass `now`/`createEventId` and every artifact of a scripted
 * run (ids, timestamps, snapshot ids) is reproducible.
 */
export class InMemoryHarnessStore extends HarnessStoreBase {
  constructor(options: HarnessStoreOptions = {}) {
    super(new InMemoryHarnessKvAdapter(), options);
  }
}

// ---------------------------------------------------------------------------
// IndexedDB persistence. One object store, one atomic transaction per batch;
// the compare-and-set expectation is re-read inside the transaction, which is
// what makes concurrent tabs fail closed instead of silently interleaving.
// ---------------------------------------------------------------------------

const HARNESS_KV_OBJECT_STORE = "kv";

function idbRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Harness IndexedDB request failed")), {
      once: true,
    });
  });
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("Harness IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("Harness IndexedDB transaction failed")),
      { once: true },
    );
  });
}

export type IndexedDbHarnessKvOptions = Readonly<{
  databaseName?: string;
  /** Test seam: any IDBFactory-compatible surface. */
  indexedDB?: IDBFactory;
}>;

export class IndexedDbHarnessKvAdapter implements HarnessKvAdapter {
  private databasePromise?: Promise<IDBDatabase>;
  private readonly databaseName: string;
  private readonly factory: IDBFactory | undefined;

  constructor(options: IndexedDbHarnessKvOptions = {}) {
    this.databaseName = options.databaseName ?? "airship-prime-harness-v1";
    this.factory = options.indexedDB;
  }

  async readAll(): Promise<readonly HarnessKvRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(HARNESS_KV_OBJECT_STORE, "readonly");
    const done = idbTransactionDone(transaction);
    const rows = (await idbRequestResult(transaction.objectStore(HARNESS_KV_OBJECT_STORE).getAll())) as HarnessKvRecord[];
    await done;
    return rows;
  }

  async transact(writes: readonly HarnessKvWrite[]): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(HARNESS_KV_OBJECT_STORE, "readwrite");
    const done = idbTransactionDone(transaction);
    const store = transaction.objectStore(HARNESS_KV_OBJECT_STORE);
    for (const write of writes) {
      if (write.expectedValue !== undefined) {
        // The re-read inside this transaction is the atomicity argument: if
        // the stored value diverged from the caller's expectation, the abort
        // rolls back every earlier write in this batch.
        const current = (await idbRequestResult(store.get(write.key))) as HarnessKvRecord | undefined;
        const expectationHolds =
          write.expectedValue === null ? current === undefined : current?.value === write.expectedValue;
        if (!expectationHolds) {
          transaction.abort();
          await done.catch(() => undefined);
          throw new HarnessKvConflictError(write.key);
        }
      }
      if (write.type === "put") {
        const record: HarnessKvRecord = { key: write.key, value: write.value };
        store.put(record);
      } else {
        store.delete(write.key);
      }
    }
    await done;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const factory = this.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
      if (!factory) {
        reject(new Error("IndexedDB is unavailable in this context; use InMemoryHarnessStore instead"));
        return;
      }
      const request = factory.open(this.databaseName, 1);
      request.addEventListener(
        "upgradeneeded",
        () => {
          if (!request.result.objectStoreNames.contains(HARNESS_KV_OBJECT_STORE)) {
            request.result.createObjectStore(HARNESS_KV_OBJECT_STORE, { keyPath: "key" });
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to open harness store")), {
        once: true,
      });
    });
    return this.databasePromise;
  }
}

/** On-device durable store; global harness state = IndexedDB (see PORT.md). */
export class IndexedDBHarnessStore extends HarnessStoreBase {
  constructor(options: IndexedDbHarnessKvOptions & HarnessStoreOptions = {}) {
    super(new IndexedDbHarnessKvAdapter(options), options);
  }
}
