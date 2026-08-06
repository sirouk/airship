/**
 * Harness facade: the model/host-facing surface of the continual harness.
 *
 * Two consumers live behind this one class. The prompt pipeline calls
 * formatForPrompt(), which is a verbatim port of upstream
 * `formatHarnessStateForPrompt` INCLUDING its default caps (6 entries per
 * kind, 5 refinement events, 180-char bodies) — those caps are the token
 * budget of the system prompt, so they are constants, not configuration. The
 * host and kernel call the CRUD/refine API, which mirrors upstream semantics:
 * direct edits land with source "agent" and produce NO refinement event
 * (before/after snapshots exist only on refine-applied edits), while
 * proposeAndApply plans, validates, applies, and restores a pre-apply
 * snapshot if anything fails mid-flight.
 */

import {
  planRefinement,
  reviewAutoRefine,
  type AutoRefineReview,
  type AutoRefineReviewContext,
  type HarnessCompletionClient,
  type HarnessRefinementPlan,
} from "./planner";
import {
  HarnessApplyRejectedError,
  OptimisticConcurrencyError,
  resolveHarnessRef,
  type HarnessEntryInput,
  type HarnessEntryPatch,
  type HarnessStore,
} from "./store";
import type {
  HarnessEntry,
  HarnessEntryKind,
  HarnessProposal,
  HarnessRefinementEvent,
  HarnessScope,
  HarnessSnapshot,
} from "./types";
import { HARNESS_ENTRY_KINDS } from "./types";

/** System-prompt projection caps, verbatim from upstream formatHarnessStateForPrompt. */
export const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
export const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
export const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

export type HarnessPromptOptions = Readonly<{
  maxEntriesPerKind?: number;
  maxRefinements?: number;
  maxContentLength?: number;
  /**
   * Defaults OFF in the port: the kernel-side `refine.run()` / IPython IPC is
   * deferred (see PORT.md), so the projections must not advertise call forms
   * that do not exist in this build. Upstream defaults true.
   */
  includeIpythonExamples?: boolean;
  includeRefineExamples?: boolean;
  includeShellExamples?: boolean;
}>;

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Verbatim port of upstream formatHarnessStateForPrompt (caps, copy, ordering,
 * overflow lines). The state input is the merged local+global projection; the
 * port represents merged state as a flat entry list instead of a kind-keyed
 * record, but the rendered text is upstream's.
 */
export function formatHarnessStateForPrompt(
  entries: readonly HarnessEntry[],
  refinements: readonly HarnessRefinementEvent[],
  options: HarnessPromptOptions = {},
): string {
  const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
  const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
  const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
  const includeIpythonExamples = options.includeIpythonExamples ?? false;
  const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
  const lines = [
    "# Continual Harness State",
    "",
    "Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
    "The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
    "Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
    "Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
    "",
    includeRefineExamples
      ? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
      : "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
    "",
    includeIpythonExamples
      ? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in IPython; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm('sub-task')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
      : options.includeShellExamples
        ? "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without IPython; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents an IPython kernel."
        : "Call contract: continual harness entries are routing/context hints only in sessions without IPython or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
    "",
  ];

  let totalEntries = 0;
  for (const kind of HARNESS_ENTRY_KINDS) {
    const kindEntries = entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) =>
        [a.path ?? "general", a.title, a.id].join(" ").localeCompare([b.path ?? "general", b.title, b.id].join(" ")),
      );
    totalEntries += kindEntries.length;
    // Render subagent specs as a task-shaped roster the model can match
    // against — the analogue of Claude Code's agent-type menu — rather than a
    // bare count. In IPython sessions, include the native `rlm` invocation hint.
    if (kind === "subagent" && kindEntries.length > 0 && includeIpythonExamples) {
      lines.push(
        `${kind}: ${kindEntries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
      );
    } else {
      lines.push(`${kind}: ${kindEntries.length}`);
    }
    for (const entry of kindEntries.slice(0, maxEntriesPerKind)) {
      const argumentsText =
        entry.kind === "skill" && entry.arguments && Object.keys(entry.arguments).length > 0
          ? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
          : "";
      const referenceText =
        entry.kind === "skill" && entry.reference && Object.keys(entry.reference).length > 0
          ? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
          : "";
      lines.push(
        `- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path ?? "general"}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
          entry.content,
          maxContentLength,
        )}`,
      );
    }
    const overflow = kindEntries.length - Math.min(kindEntries.length, maxEntriesPerKind);
    if (overflow > 0) {
      lines.push(`- +${overflow} more ${kind} entries`);
    }
    lines.push("");
  }

  if (totalEntries === 0) {
    lines.push("No saved harness entries yet.", "");
  }

  lines.push(`recent refinements: ${refinements.length}`);
  for (const event of refinements.slice(-maxRefinements)) {
    const changes =
      event.edits.length > 0 ? event.edits.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`).join(", ") : "no applied edits";
    const outcome = event.expectedOutcome
      ? `; outcome: ${compactText(event.expectedOutcome, maxContentLength)}`
      : "";
    lines.push(`- [${event.id}] ${compactText(event.summary, maxContentLength)}: ${changes}${outcome}`);
  }
  const refinementOverflow = refinements.length - Math.min(refinements.length, maxRefinements);
  if (refinementOverflow > 0) {
    lines.push(`- +${refinementOverflow} older refinement events`);
  }

  return lines.join("\n").trim();
}

/**
 * mergeHarnessScopes: local shadowing global, verbatim upstream semantics from
 * mergeHarnessStates — same kind:id in both scopes yields two display entries,
 * the local one shown with its `local:` scoping. The port keeps both entries
 * (scope is already on the record), sorted per projection rules elsewhere.
 */
export function mergeHarnessScopes(entries: readonly HarnessEntry[]): readonly HarnessEntry[] {
  const globals = entries.filter((entry) => entry.scope === "global");
  const locals = entries.filter((entry) => entry.scope === "local");
  const localKeys = new Set(locals.map((entry) => `${entry.kind}:${entry.id}`));
  // A local entry shadows the global entry with the same kind:id for OVERVIEW
  // purposes (upstream renames the local key `local:<id>` so both survive;
  // here both survive with the scope tag doing the same job), but the merged
  // count must not double-report the pair. Shadowing is therefore: global
  // entries whose kind:id also exists locally are dropped from projections.
  return [...globals.filter((entry) => !localKeys.has(`${entry.kind}:${entry.id}`)), ...locals];
}

/** overview caps, as data: same numbers as constants, for hosts that cannot import. */
export type HarnessOverview = Readonly<{
  counts: Readonly<Record<HarnessEntryKind, number>>;
  refinementCount: number;
  entries: readonly HarnessEntry[];
  refinements: readonly HarnessRefinementEvent[];
  caps: Readonly<{ entriesPerKind: number; refinementEvents: number; contentChars: number }>;
}>;

export type RefineInput = Readonly<{
  scope?: HarnessScope;
  instructions?: string;
  trajectorySlice: string;
  client: HarnessCompletionClient;
  modelMaxOutputTokens: number;
  /** Provenance of the trigger; autoRefine passes "auto", /refine "manual". */
  source?: "manual" | "auto";
}>;

export type AutoRefineInput = Readonly<{
  trajectorySlice: string;
  context: AutoRefineReviewContext;
  client: HarnessCompletionClient;
  modelMaxOutputTokens: number;
}>;

export type AutoRefineResult =
  | Readonly<{ status: "skipped"; review: AutoRefineReview }>
  | Readonly<{ status: "applied"; review: AutoRefineReview; event: HarnessRefinementEvent }>;

export class Harness {
  constructor(private readonly store: HarnessStore) {}

  // -- Prompt projections ---------------------------------------------------

  async formatForPrompt(options: HarnessPromptOptions = {}): Promise<string> {
    const entries = mergeHarnessScopes(await this.store.list());
    const refinements = await this.store.refinements();
    return formatHarnessStateForPrompt(entries, refinements, options);
  }

  async overview(): Promise<HarnessOverview> {
    const entries = mergeHarnessScopes(await this.store.list());
    const refinements = await this.store.refinements();
    const counts = Object.fromEntries(
      HARNESS_ENTRY_KINDS.map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]),
    ) as Record<HarnessEntryKind, number>;
    return {
      counts,
      refinementCount: refinements.length,
      entries,
      refinements: refinements.slice(-DEFAULT_OVERVIEW_REFINEMENT_LIMIT),
      caps: {
        entriesPerKind: DEFAULT_OVERVIEW_ENTRY_LIMIT,
        refinementEvents: DEFAULT_OVERVIEW_REFINEMENT_LIMIT,
        contentChars: DEFAULT_OVERVIEW_CONTENT_LIMIT,
      },
    };
  }

  // -- Direct CRUD (source "agent"; NO refinement history, per upstream) ----

  createEntry(scope: HarnessScope, input: HarnessEntryInput): Promise<HarnessEntry> {
    return this.store.create(scope, input);
  }

  updateEntry(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    patch: HarnessEntryPatch,
    options?: { expectedVersion?: number },
  ): Promise<HarnessEntry> {
    return this.store.update(scope, kind, id, patch, options);
  }

  deleteEntry(
    scope: HarnessScope,
    kind: HarnessEntryKind,
    id: string,
    options?: { expectedVersion?: number },
  ): Promise<boolean> {
    return this.store.delete(scope, kind, id, options);
  }

  getEntry(scope: HarnessScope, kind: HarnessEntryKind, id: string): Promise<HarnessEntry | undefined> {
    return this.store.get(scope, kind, id);
  }

  listEntries(scope?: HarnessScope, kind?: HarnessEntryKind): Promise<readonly HarnessEntry[]> {
    return this.store.list(scope, kind);
  }

  // -- Refinement pipeline ---------------------------------------------------

  /**
   * planRefinement: LLM pass; captures the baseline used at apply time. The
   * caller may run turns between plan and proposeAndApply — the baseline is
   * what makes that safe (upstream's plan/apply split for the same reason).
   */
  async planRefinement(input: RefineInput): Promise<HarnessRefinementPlan> {
    const scope = input.scope ?? "local";
    // The planner sees the MERGED state as context (global entries are
    // read-only context for a local refinement, per the scope policy), but the
    // baseline is the target scope only — that is exactly what validation
    // compares against.
    const scopedEntries = await this.store.list(scope);
    const refinements = await this.store.refinements();
    return planRefinement({
      scope,
      trajectorySlice: input.trajectorySlice,
      entries: scopedEntries,
      refinements,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      client: input.client,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
    });
  }

  /**
   * proposeAndApply: validate-all-then-apply with rollback-on-failure. The
   * underlying apply is a single atomic adapter batch, so a adapter-level
   * failure already wrote nothing; the defensive snapshot/restore is the
   * second line for store implementations whose batch protocol degrades
   * (a custom adapter without transactions). Validation failures
   * (HarnessApplyRejectedError) write nothing and are NOT restored-over —
   * the snapshot restore exists purely to undo partial APPLY, never to hide
   * rejection from the caller.
   */
  async proposeAndApply(
    proposal: HarnessProposal,
    options: Readonly<{
      scope: HarnessScope;
      source?: "manual" | "auto";
      baseline?: readonly HarnessEntry[];
    }>,
  ): Promise<HarnessRefinementEvent> {
    const safety = await this.store.snapshot();
    try {
      return await this.store.applyRefinement(proposal, {
        scope: options.scope,
        source: options.source ?? "manual",
        ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
      });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError || error instanceof HarnessApplyRejectedError) {
        throw error;
      }
      await this.store.restore(safety);
      throw error;
    }
  }

  /** refine: plan -> apply in one call (upstream refineHarness shape). */
  async refine(input: RefineInput): Promise<HarnessRefinementEvent> {
    const scope = input.scope ?? "local";
    const plan = await this.planRefinement(input);
    const event = await this.proposeAndApply(plan.proposal, {
      scope,
      source: input.source ?? "manual",
      baseline: plan.baseline,
    });
    return event;
  }

  /**
   * autoRefine: review gate first (upstream AUTO_REFINE_REVIEW flow). The
   * skipped path is a first-class result, not an error: most checkpoints
   * should skip, and the caller logs the gate rationale either way.
   */
  async autoRefine(input: AutoRefineInput): Promise<AutoRefineResult> {
    const localEntries = await this.store.list("local");
    const refinements = await this.store.refinements();
    const review = await reviewAutoRefine({
      trajectorySlice: input.trajectorySlice,
      entries: localEntries,
      refinements,
      context: input.context,
      client: input.client,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
    });
    if (!review.shouldRefine) {
      return { status: "skipped", review };
    }
    const event = await this.refine({
      scope: "local",
      ...(review.instructions !== undefined ? { instructions: review.instructions } : {}),
      trajectorySlice: input.trajectorySlice,
      client: input.client,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      source: "auto",
    });
    return { status: "applied", review, event };
  }

  rollback(refinementId: string): Promise<HarnessRefinementEvent> {
    return this.store.rollback(refinementId);
  }

  snapshot(): Promise<HarnessSnapshot> {
    return this.store.snapshot();
  }

  restore(snapshot: HarnessSnapshot): Promise<void> {
    return this.store.restore(snapshot);
  }

  snapshotId(): Promise<string> {
    return this.store.snapshotId();
  }
}

export { HarnessApplyRejectedError, OptimisticConcurrencyError, resolveHarnessRef };
