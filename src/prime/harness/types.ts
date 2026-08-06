/**
 * Continual harness state model for the prime port.
 *
 * The upstream shapes live in
 * packages/coding-agent/src/core/refinement/refinement.ts and must stay
 * shape-identical with the kernel-side prime-agent-runtime/src/rlm/harness.py
 * (the host reads what the kernel writes). This module keeps the same record
 * vocabulary with two deliberate type-level deviations, documented in
 * PORT.md: timestamps are epoch-millis numbers instead of ISO strings
 * (`created_at` -> `createdAt`), and `scope` is required instead of optional.
 * Both keep persistence honest: numbers compare and serialize without locale
 * surprises, and an entry that cannot name its scope used to silently inherit
 * whatever store happened to load it.
 */

export type HarnessEntryKind = "prompt" | "memory" | "skill" | "subagent";

/** Frozen so exhaustive maps and validators share one source of truth. */
export const HARNESS_ENTRY_KINDS: readonly HarnessEntryKind[] = Object.freeze([
  "prompt",
  "memory",
  "skill",
  "subagent",
] as const);

export type HarnessScope = "local" | "global";

export const HARNESS_SCOPES: readonly HarnessScope[] = Object.freeze(["local", "global"] as const);

/**
 * Who wrote the entry. "refine" entries carry before/after provenance through
 * refinement events; "agent" entries are direct CRUD by the model or the host
 * and deliberately produce no history event (mirrors upstream).
 */
export type HarnessEntrySource = "agent" | "refine";

export type HarnessEntry = Readonly<{
  id: string;
  kind: HarnessEntryKind;
  title: string;
  content: string;
  /** Optional grouping path; upstream defaults to "general" ("policy" for prompt notes). */
  path?: string;
  scope: HarnessScope;
  /** Skill entries only; validated by `canonicalSkillReference`. */
  reference?: HarnessSkillReference;
  /** Skill argument contract: input name -> {type, required, description, ...}. */
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  source: HarnessEntrySource;
  createdAt: number;
  updatedAt: number;
  version: number;
}>;

/**
 * Upstream stores the reference as an open record and validates structurally.
 * The port types the canonical shape and accepts upstream's two aliases
 * (`python_import`, `call_pattern` — see canonicalSkillReference in store.ts)
 * because kernel-written entries use them.
 */
export type HarnessSkillReference = Readonly<{
  type: "python";
  import: string;
  callable?: string;
  callPattern?: string;
}>;

export type HarnessEditAction = "create" | "update" | "delete";

export const HARNESS_EDIT_ACTIONS: readonly HarnessEditAction[] = Object.freeze([
  "create",
  "update",
  "delete",
] as const);

/**
 * One edit inside a refinement proposal, exactly the JSON shape the refine
 * prompt asks the model for. `reference` is unknown here because proposal
 * parsing is lenient on purpose (upstream mirrors acceptance before
 * validation); validateRefinementEdits canonicalizes it.
 */
export type HarnessRefinementEdit = Readonly<{
  action: HarnessEditAction;
  kind: HarnessEntryKind;
  id?: string;
  title?: string;
  content?: string;
  path?: string;
  reference?: unknown;
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  reason?: string;
}>;

export type HarnessProposal = Readonly<{
  summary: string;
  rationale: string;
  expectedOutcome: string;
  edits: readonly HarnessRefinementEdit[];
}>;

/** An edit after validation and application, with full provenance. */
export type HarnessAppliedEdit = Readonly<{
  action: HarnessEditAction;
  kind: HarnessEntryKind;
  id: string;
  title?: string;
  content?: string;
  path?: string;
  reference?: unknown;
  arguments?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  reason?: string;
  before?: HarnessEntry;
  after?: HarnessEntry;
}>;

/**
 * Every applied (or rolled-back) refinement appends one event per scope store.
 * Rollback events are refinement events in their own right with `rollbackOf`
 * set, mirroring upstream recording rollback results as refinements.
 */
export type HarnessRefinementEvent = Readonly<{
  id: string;
  summary: string;
  rationale: string;
  expectedOutcome: string;
  edits: readonly HarnessAppliedEdit[];
  /** Set when this event replays inverse edits of an earlier refinement. */
  rollbackOf?: string;
  scope: HarnessScope;
  source: "manual" | "auto" | "rollback";
  appliedAt: number;
}>;

/**
 * A rejected edit, named and positioned. Named codes (not bare strings) exist
 * so the review surface and tests branch on the failure class, not on message
 * text that may be reworded.
 */
export type ValidationIssue = Readonly<{
  code:
    | "unsupported_action"
    | "unsupported_kind"
    | "immutable_entry"
    | "missing_id"
    | "missing_fields"
    | "skill_reference_invalid"
    | "entry_not_found"
    | "entry_exists"
    | "optimistic_conflict";
  message: string;
  editIndex: number;
  kind?: HarnessEntryKind;
  id?: string;
}>;

/** Fully serializable copy of one store's contents; restore() must accept it verbatim. */
export type HarnessSnapshot = Readonly<{
  schema: number;
  entries: readonly HarnessEntry[];
  refinements: readonly HarnessRefinementEvent[];
}>;
