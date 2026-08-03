import type { JsonValue } from "../core/contracts";
import type { GitOperation } from "../git/types";

/**
 * The tool vocabulary a request's consequence is derived in.
 *
 * `writeApprovalFacts` reads a tool *name* and answers what the call does. The
 * registry's Git tools are `git_change` and `git_configure`, and the model's
 * calls arrive under those names — but the Workspace panel does not go through
 * the registry: it calls `decideHumanIntent` with a tool definition it
 * synthesises on the spot, named `git_${operation.kind}`. So `git_stage` and
 * `git_commit` — the only irreversible actions in the product — matched no
 * case and rendered as "Target: Adapter-selected target / Change: Consequence
 * not derivable", while the very same dialog held the file path in its raw
 * arguments.
 *
 * One adapter, not a second derivation: this maps the synthesised name and its
 * payload onto the registered vocabulary that already knows how to describe
 * them, so the person's own staging request and the model's `git_change` call
 * produce the identical sentence.
 */
export type ApprovalDerivationInput = Readonly<{
  toolName: string;
  argumentsValue: JsonValue;
}>;

/** The prefix `decideHumanIntent`'s Git caller mints its tool names under. */
const GIT_TOOL_PREFIX = "git_";

type GitDerivation = Readonly<{ tool: "git_change" | "git_configure"; action: string }>;

/**
 * Every Git operation, and the registered action whose consequence describes it.
 *
 * Exhaustive over `GitOperation["kind"]` on purpose: a new Git verb fails to
 * compile here instead of shipping as a runtime shrug in a permission dialog.
 * `null` is a decision, not a gap — `clone`, `fetch` and `push` are network and
 * identity effects whose own descriptor summary already names the remote and
 * the branch ("Push main to origin"), and routing them through a worktree-change
 * vocabulary would describe them as something they are not.
 *
 * The action strings are the registry's own enum members wherever one exists,
 * so the two call paths cannot drift into two names for one effect. The two
 * worktree verbs have no registry action; they keep the same spelling shape.
 */
const GIT_DERIVATION: Readonly<Record<GitOperation["kind"], GitDerivation | null>> = Object.freeze({
  status: null,
  diff: null,
  log: null,
  show: null,
  clone: null,
  fetch: null,
  push: null,
  stage: { tool: "git_change", action: "stage" },
  unstage: { tool: "git_change", action: "unstage" },
  commit: { tool: "git_change", action: "commit" },
  "branch-create": { tool: "git_change", action: "create_branch" },
  "branch-switch": { tool: "git_change", action: "switch_branch" },
  merge: { tool: "git_change", action: "merge" },
  stash: { tool: "git_change", action: "stash" },
  restore: { tool: "git_change", action: "restore" },
  reset: { tool: "git_change", action: "reset" },
  "worktree-create": { tool: "git_change", action: "create_worktree" },
  "worktree-remove": { tool: "git_change", action: "remove_worktree" },
  "tag-create": { tool: "git_configure", action: "create_tag" },
  "tag-delete": { tool: "git_configure", action: "delete_tag" },
  "remote-add": { tool: "git_configure", action: "add_remote" },
  "remote-set-url": { tool: "git_configure", action: "set_remote_url" },
  "remote-remove": { tool: "git_configure", action: "remove_remote" },
});

/**
 * The name a human-proposed Git operation is brokered under.
 *
 * Exported so the two ends of this seam share one spelling. `reviewGitOperation`
 * in `src/ui/app.tsx` still writes the template inline — that file was owned by
 * another pass — and this is the constant it should read.
 */
export function gitApprovalToolName(kind: GitOperation["kind"]): string {
  return `${GIT_TOOL_PREFIX}${kind}`;
}

/**
 * Restate a brokered request in the vocabulary its consequence is derived in.
 *
 * Everything the registry dispatches passes through untouched; only the
 * synthesised Git names are rewritten, and only their `action` is added — the
 * payload already carries `repositoryId`, `worktreeId`, `paths` and `name`,
 * which is exactly what the registered derivation reads. The raw arguments the
 * dialog discloses are never taken from here: this is what the request *means*,
 * not what was sent.
 */
export function approvalDerivationInput(toolName: string, argumentsValue: JsonValue): ApprovalDerivationInput {
  if (!toolName.startsWith(GIT_TOOL_PREFIX)) return Object.freeze({ toolName, argumentsValue });
  const kind = toolName.slice(GIT_TOOL_PREFIX.length) as GitOperation["kind"];
  const derivation = Object.hasOwn(GIT_DERIVATION, kind) ? GIT_DERIVATION[kind] : null;
  if (!derivation) return Object.freeze({ toolName, argumentsValue });
  const record = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ? argumentsValue
    : {};
  return Object.freeze({
    toolName: derivation.tool,
    argumentsValue: Object.freeze({ ...record, action: derivation.action }),
  });
}
