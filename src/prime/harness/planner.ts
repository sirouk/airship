/**
 * Refinement planner: the prompt-side of the continual harness.
 *
 * Ports upstream `planRefinement` / `reviewAutoRefine` /
 * `parseProposal` / `extractJsonObject` from
 * packages/coding-agent/src/core/refinement/refinement.ts. The LLM call
 * itself is deferred to the host through the injected
 * `HarnessCompletionClient` (upstream calls completeSimple directly; airship
 * routes inference through InferenceTransport — the adapter seam lives in the
 * host, not here). Everything surrounding the call is 1:1: the tagged user
 * prompt layout, the scope policy paragraphs, trajectory caps, output-token
 * budgets as Math.min(model budget, ceiling), the lenient JSON acceptance
 * (prose wrapping, fenced blocks, brace slicing), and the truncation
 * diagnosis that tells "ran out of output budget" apart from "malformed JSON"
 * — because the retry guidance differs.
 */

import { isRecord } from "../../core/records";
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  AUTO_REFINE_REVIEW_TRAILER,
  REFINEMENT_SCOPE_INSTRUCTION_GLOBAL,
  REFINEMENT_SCOPE_INSTRUCTION_LOCAL,
  REFINEMENT_SYSTEM_PROMPT,
  REFINEMENT_USER_PROMPT_TRAILER,
  TRUNCATED_JSON_ERROR,
} from "./prompt";
import type {
  HarnessEntry,
  HarnessEntryKind,
  HarnessProposal,
  HarnessRefinementEdit,
  HarnessRefinementEvent,
  HarnessScope,
} from "./types";
import { HARNESS_ENTRY_KINDS } from "./types";

/**
 * Output budgets are derived from the model instead of fixed literals
 * (upstream: Math.min(model.maxTokens, ceiling)) because /refine input scales
 * with harness size, and a constant cap silently truncates exactly the large
 * multi-edit proposals that matter most. The caller passes the model's
 * maxOutputTokens; these ceilings keep small models honest.
 */
export const MAX_REFINEMENT_OUTPUT_TOKENS = 32_000;
export const MAX_AUTO_REFINE_REVIEW_OUTPUT_TOKENS = 4_096;

/** Trajectory slices fed to the refine prompts; verbatim upstream caps. */
export const MAX_REFINEMENT_TRAJECTORY_CHARS = 80_000;
export const MAX_AUTO_REFINE_REVIEW_TRAJECTORY_CHARS = 40_000;

/** overviewForPrompt caps: 40 entries per kind, 240-char fields. */
export const MAX_PLANNER_OVERVIEW_ENTRIES_PER_KIND = 40;
export const MAX_PLANNER_OVERVIEW_FIELD_CHARS = 240;

/** historyForPrompt shows the newest 20 refinement events. */
export const MAX_PLANNER_HISTORY_EVENTS = 20;

/** Minimal completion port; the host bridges this to InferenceTransport. */
export type HarnessCompletionRequest = Readonly<{
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}>;

export type HarnessCompletionResult = Readonly<{
  stopReason: "stop" | "length" | "error";
  text: string;
  errorMessage?: string;
}>;

export interface HarnessCompletionClient {
  complete(request: HarnessCompletionRequest): Promise<HarnessCompletionResult>;
}

export type HarnessRefinementPlan = Readonly<{
  proposal: HarnessProposal;
  /** Suggested event id; the store still owns uniqueness. */
  id: string;
  /**
   * Entries as the planner saw them — pass through to applyRefinement as the
   * optimistic baseline so a concurrent write during the (many-seconds) LLM
   * call rejects instead of interleaving.
   */
  baseline: readonly HarnessEntry[];
}>;

export type PlanRefinementInput = Readonly<{
  scope: HarnessScope;
  trajectorySlice: string;
  entries: readonly HarnessEntry[];
  refinements: readonly HarnessRefinementEvent[];
  instructions?: string;
  client: HarnessCompletionClient;
  modelMaxOutputTokens: number;
  now?: number;
}>;

export type AutoRefineReviewReason = "turn_interval" | "compact";

export type AutoRefineReviewContext = Readonly<{
  reason: AutoRefineReviewReason;
  turnsSinceLastReview: number;
}>;

export type AutoRefineReview = Readonly<{
  shouldRefine: boolean;
  rationale: string;
  instructions?: string;
}>;

function boundText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * overviewForPrompt: verbatim port of upstream's planner-side overview (NOT
 * the system-prompt projection — that one lives in harness.ts with the 6/5/180
 * caps). Larger caps because the refiner must see enough to avoid duplicate
 * proposals.
 */
export function overviewForPrompt(entries: readonly HarnessEntry[]): string {
  const lines: string[] = [];
  for (const kind of HARNESS_ENTRY_KINDS) {
    const scoped = entries.filter((entry) => entry.kind === kind);
    lines.push(`${kind}: ${scoped.length}`);
    for (const entry of scoped.slice(0, MAX_PLANNER_OVERVIEW_ENTRIES_PER_KIND)) {
      const content = entry.content.replace(/\s+/g, " ").slice(0, MAX_PLANNER_OVERVIEW_FIELD_CHARS);
      const argumentsText =
        entry.kind === "skill" && entry.arguments && Object.keys(entry.arguments).length > 0
          ? ` args=${JSON.stringify(entry.arguments).slice(0, MAX_PLANNER_OVERVIEW_FIELD_CHARS)}`
          : "";
      const referenceText =
        entry.kind === "skill" && entry.reference && Object.keys(entry.reference).length > 0
          ? ` ref=${JSON.stringify(entry.reference).slice(0, MAX_PLANNER_OVERVIEW_FIELD_CHARS)}`
          : "";
      lines.push(
        `- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path ?? "general"}, v${entry.version})${referenceText}${argumentsText}: ${content}`,
      );
    }
    if (scoped.length > MAX_PLANNER_OVERVIEW_ENTRIES_PER_KIND) {
      lines.push(`- +${scoped.length - MAX_PLANNER_OVERVIEW_ENTRIES_PER_KIND} more ${kind} entries`);
    }
  }
  return lines.join("\n");
}

/** historyForPrompt: upstream shape — summary, applied edit list, expected outcome. */
export function historyForPrompt(refinements: readonly HarnessRefinementEvent[]): string {
  if (refinements.length === 0) {
    return "No prior refinement history.";
  }
  return refinements
    .slice(-MAX_PLANNER_HISTORY_EVENTS)
    .map((event) => {
      const edits = event.edits.map((edit) => `applied ${edit.action} ${edit.kind}:${edit.id}`).join(", ");
      const rollback = event.rollbackOf ? ` rollbackOf=${event.rollbackOf}` : "";
      return `[${event.id}]${rollback} ${event.summary}\n${edits}\nExpected outcome: ${event.expectedOutcome}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Shape-safe JSON acceptance, verbatim port of upstream's extraction ladder.
// ---------------------------------------------------------------------------

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete
 * in this sense, while a complete-but-malformed reply is balanced. Brace
 * slicing can also produce a balanced fragment, so callers treat "balanced" as
 * malformed.
 */
function isIncompleteJson(candidate: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (error) {
    // A truncated reply and a malformed one both fail here, and JSON.parse
    // describes the fragment rather than the cause. Name the cause instead.
    if (isIncompleteJson(candidate)) {
      throw new Error(TRUNCATED_JSON_ERROR);
    }
    throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // A reply truncated after a nested closing brace still looks well-formed
    // here, so this path needs the same diagnosis as the slicing fallback.
    return parseJsonCandidate(trimmed);
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1] !== undefined) {
    return parseJsonCandidate(fenced[1].trim());
  }
  // Brace slicing recovers JSON wrapped in prose. On a reply truncated inside
  // the edits array it slices to an earlier edit's closing brace, so a failure
  // here is diagnosed against the original text rather than the balanced
  // fragment.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return parseJsonCandidate(trimmed.slice(start));
    }
  }
  if (isIncompleteJson(trimmed)) {
    throw new Error(TRUNCATED_JSON_ERROR);
  }
  throw new Error("Refiner did not return a JSON object");
}


/**
 * parseProposal: upstream's lenient acceptance — missing summary/rationale
 * fields default rather than reject, non-object edits are filtered out, and
 * per-edit field type checks never throw. Validation against the proposal
 * contract (kinds, skill references, id existence) happens in
 * validateRefinementEdits at apply time, not here; the planner must not turn
 * one bad edit into a wasted LLM call when the others are fine.
 */
export function parseHarnessProposal(text: string): HarnessProposal {
  const value = extractJsonObject(text);
  if (!isRecord(value)) {
    throw new Error("Refiner JSON must be an object");
  }
  const edits = Array.isArray(value.edits) ? value.edits : [];
  return {
    summary: typeof value.summary === "string" ? value.summary : "Refined continual harness state",
    rationale: typeof value.rationale === "string" ? value.rationale : "",
    expectedOutcome: typeof value.expectedOutcome === "string" ? value.expectedOutcome : "",
    edits: edits.filter(isRecord).map((edit): HarnessRefinementEdit => {
      return {
        action: edit.action as HarnessRefinementEdit["action"],
        kind: edit.kind as HarnessEntryKind,
        ...(typeof edit.id === "string" ? { id: edit.id } : {}),
        ...(typeof edit.title === "string" ? { title: edit.title } : {}),
        ...(typeof edit.content === "string" ? { content: edit.content } : {}),
        ...(typeof edit.path === "string" ? { path: edit.path } : {}),
        ...(edit.reference !== undefined ? { reference: edit.reference } : {}),
        ...(isRecord(edit.arguments) ? { arguments: edit.arguments } : {}),
        ...(isRecord(edit.metadata) ? { metadata: edit.metadata } : {}),
        ...(typeof edit.reason === "string" ? { reason: edit.reason } : {}),
      };
    }),
  };
}

/** Compact-ISO event id, same shape as upstream planRefinement's `refine_<digits>`. */
function refinementEventId(at: number): string {
  return `refine_${new Date(at).toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

/**
 * planRefinement: the /refine LLM pass. Builds the verbatim user prompt —
 * tagged sections in upstream order (current state, history, conversation,
 * scope policy, optional user instructions, trailer) — calls the injected
 * completion client once, and parses with the upstream ladder. The baseline
 * handed back MUST be forwarded to applyRefinement: capturing it at plan time
 * is the whole point of the optimistic-concurrency rule.
 */
export async function planRefinement(input: PlanRefinementInput): Promise<HarnessRefinementPlan> {
  const conversationText = input.trajectorySlice.slice(-MAX_REFINEMENT_TRAJECTORY_CHARS);
  const scopeInstruction =
    input.scope === "global" ? REFINEMENT_SCOPE_INSTRUCTION_GLOBAL : REFINEMENT_SCOPE_INSTRUCTION_LOCAL;
  const userPrompt = [
    `<current_harness_state>\n${overviewForPrompt(input.entries)}\n</current_harness_state>`,
    `<refinement_history>\n${historyForPrompt(input.refinements)}\n</refinement_history>`,
    `<conversation>\n${conversationText}\n</conversation>`,
    `<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
    input.instructions ? `<user_refine_instructions>\n${input.instructions}\n</user_refine_instructions>` : "",
    REFINEMENT_USER_PROMPT_TRAILER,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await input.client.complete({
    systemPrompt: REFINEMENT_SYSTEM_PROMPT,
    userPrompt,
    maxOutputTokens: Math.min(input.modelMaxOutputTokens, MAX_REFINEMENT_OUTPUT_TOKENS),
  });
  if (response.stopReason === "error") {
    throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
  }
  return {
    proposal: parseHarnessProposal(response.text),
    id: refinementEventId(input.now ?? Date.now()),
    baseline: input.entries,
  };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
  const value = extractJsonObject(text);
  if (!isRecord(value)) {
    throw new Error("Auto-refine review JSON must be an object");
  }
  return {
    // Strict === true: a model answering "true" as a string must NOT open the
    // gate; upstream has the same strictness for the same reason.
    shouldRefine: value.shouldRefine === true,
    rationale: typeof value.rationale === "string" ? value.rationale : "No rationale provided.",
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

export type ReviewAutoRefineInput = Readonly<{
  trajectorySlice: string;
  entries: readonly HarnessEntry[];
  refinements: readonly HarnessRefinementEvent[];
  context: AutoRefineReviewContext;
  client: HarnessCompletionClient;
  modelMaxOutputTokens: number;
}>;

/**
 * reviewAutoRefine: the auto-refine gate. Upstream calls this BEFORE spending
 * a full refine pass at turn-interval and post-compaction checkpoints; a
 * rejected gate is the normal path (one-off noise, transient tool output) and
 * must be cheap, so the trajectory slice is the smaller 40k cap.
 */
export async function reviewAutoRefine(input: ReviewAutoRefineInput): Promise<AutoRefineReview> {
  const conversationText = input.trajectorySlice.slice(-MAX_AUTO_REFINE_REVIEW_TRAJECTORY_CHARS);
  const userPrompt = [
    `<trigger>\n${input.context.reason}; ${input.context.turnsSinceLastReview} assistant turns since last auto-refine review\n</trigger>`,
    `<current_harness_state>\n${overviewForPrompt(input.entries)}\n</current_harness_state>`,
    `<refinement_history>\n${historyForPrompt(input.refinements)}\n</refinement_history>`,
    `<conversation>\n${conversationText}\n</conversation>`,
    AUTO_REFINE_REVIEW_TRAILER,
  ].join("\n\n");

  const response = await input.client.complete({
    systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
    userPrompt,
    maxOutputTokens: Math.min(input.modelMaxOutputTokens, MAX_AUTO_REFINE_REVIEW_OUTPUT_TOKENS),
  });
  if (response.stopReason === "error") {
    throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
  }
  if (response.stopReason === "length") {
    throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
  }
  return parseAutoRefineReview(response.text);
}
