import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalProvenance,
  JsonValue,
  ToolContext,
  ToolDefinition,
} from "../core/contracts";
import { isLocalFolderMountPath } from "../workspace/contracts";
import { approvalOutcomeReason, approvalRequestId, type ApprovalBroker } from "./broker";

export type ApprovalMode = ApprovalProvenance["mode"];

const MAX_PROVENANCE = 512;

/**
 * Why a write to an attached folder is reviewed in every mode.
 *
 * The other two automatic reasons in this file both end in a confinement that
 * is true — "its declared browser tool boundary", "its workspace path
 * confinement" — and neither of them holds here. A folder the person opened
 * from their own device is written in place: no copy, no Vault, no Git object
 * database, and nothing Airship can undo. The mode still governs everything
 * else; this one class of effect asks.
 */
const ATTACHED_FOLDER_REVIEW_REASON =
  "This call names a folder on your own device, not the browser workspace. Airship writes such a folder in place,"
  + " so nothing here can undo it — every approval mode reviews it.";

/**
 * True when these arguments name a path inside the folder mount.
 *
 * The question is asked of the arguments because no tool can answer it: every
 * tool in `src/tools` takes one `/workspace`-rooted path and hands it to a
 * `WorkspacePort`, and it is the composed port — not the tool — that decides a
 * path under the reserved mount belongs to a real directory. `path`,
 * `sourcePath`, `destinationPath` and `edits[].path` are four spellings
 * already, so every string is normalised rather than a list of key names
 * maintained here. A string that is not a workspace path at all throws in
 * normalisation and is simply not one.
 */
function namesAttachedFolder(value: JsonValue): boolean {
  if (typeof value === "string") {
    try {
      return isLocalFolderMountPath(value);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(namesAttachedFolder);
  return typeof value === "object" && value !== null && Object.values(value).some(namesAttachedFolder);
}

function automaticReadProvenance(mode: ApprovalMode): ApprovalProvenance {
  return {
    mode,
    source: "automatic-read",
    reason: "Read-only browser tool effects are allowed automatically.",
  };
}

export function createApprovalModePolicy(options: Readonly<{
  mode: ApprovalMode;
  broker: ApprovalBroker;
}>): ApprovalPolicy {
  const provenance = new Map<string, ApprovalProvenance>();

  function remember(context: ToolContext, value: ApprovalProvenance): void {
    if (provenance.size >= MAX_PROVENANCE) provenance.delete(provenance.keys().next().value as string);
    provenance.set(contextKey(context), Object.freeze(value));
  }

  return {
    async review(tool, argumentsValue, context) {
      if (tool.effect === "read") {
        remember(context, automaticReadProvenance(options.mode));
        return "allow";
      }

      // Ask First already asks, and its record already says a person answered.
      if (options.mode !== "ask-first" && namesAttachedFolder(argumentsValue)) {
        const decision = await options.broker.request(tool, argumentsValue, context);
        const outcome = options.broker.takeOutcome(approvalRequestId(context)) ?? decision;
        remember(context, {
          mode: options.mode,
          source: outcome === "unavailable" ? "unattended" : "human-fallback",
          reason: `${ATTACHED_FOLDER_REVIEW_REASON} ${approvalOutcomeReason(outcome)}`,
        });
        return decision;
      }

      if (options.mode === "full-access") {
        remember(context, {
          mode: options.mode,
          source: "bounded-browser-sandbox",
          reason: fullAccessReason(tool.effect),
        });
        return "allow";
      }

      if (options.mode === "ask-first") {
        const decision = await options.broker.request(tool, argumentsValue, context);
        /*
         * The gate's answer and the record's answer are not the same fact. An
         * expiry resolves as `deny` because an unanswered request must not run,
         * but the journal is the evidence chain, and a person who walked away
         * from the screen did not refuse anything. The broker keeps the wider
         * outcome for exactly one reader; this is that reader, which is why the
         * record no longer has to write "Denied or expired" and leave whoever
         * reads it back to guess which. Falling back to the decision keeps the
         * sentence honest if the record was never taken.
         */
        const outcome = options.broker.takeOutcome(approvalRequestId(context)) ?? decision;
        remember(context, {
          mode: options.mode,
          // Never `human` for a request no person was shown; see `ApprovalOutcome`.
          source: outcome === "unavailable" ? "unattended" : "human",
          reason: approvalOutcomeReason(outcome),
        });
        return decision;
      }

      // Auto Approve is a deterministic middle tier. It never asks the
      // inference model to authorize its own action and never creates a hidden
      // paid request. Registered write effects stay inside their declared
      // browser/tool boundary; execute, network, and identity effects ask.
      if (tool.effect === "write") {
        remember(context, {
          mode: options.mode,
          source: "bounded-browser-sandbox",
          reason: "Allowed by Auto Approve's deterministic policy for a registered write effect inside its declared browser tool boundary.",
        });
        return "allow";
      }

      const decision = await options.broker.request(tool, argumentsValue, context);
      const fallbackOutcome = options.broker.takeOutcome(approvalRequestId(context)) ?? decision;
      remember(context, {
        mode: options.mode,
        source: fallbackOutcome === "unavailable" ? "unattended" : "human-fallback",
        reason: `Auto Approve requires a person for ${tool.effect} effects. ${approvalOutcomeReason(fallbackOutcome)}`,
      });
      return decision;
    },
    takeProvenance(context) {
      const key = contextKey(context);
      const value = provenance.get(key);
      provenance.delete(key);
      return value;
    },
  };
}

/**
 * What Full Access actually allowed, in the terms of the effect it allowed.
 *
 * One constant used to answer for every effect class, and it said "path
 * boundaries" — a property the workspace tools really do have and the network
 * ones do not. A `network` allow is confined to HTTPS and to whatever the
 * origin's CORS policy permits; no path, host or allow-list narrows it. The
 * journaled reason is the durable record of why an effect ran unprompted, so it
 * has to name the confinement that existed rather than borrow one.
 */
function fullAccessReason(effect: ToolDefinition["effect"]): string {
  if (effect === "network" || effect === "identity") {
    return "Allowed by Full Access; this effect sends data to a remote origin over HTTPS and is not path-confined or host-restricted.";
  }
  if (effect === "execute") {
    return "Allowed by Full Access inside the existing browser execution capability; no host shell or capability beyond it was granted.";
  }
  return "Allowed by Full Access inside the existing browser capability and its workspace path confinement.";
}

export type HumanIntentReview = Readonly<{
  decision: ApprovalDecision;
  provenance: ApprovalProvenance;
}>;

/**
 * Adjudicate an effect the *person* proposed, not one the model asked for.
 *
 * Human-proposed actions remain human decisions. Auto Approve only applies its
 * deterministic write-effect rule to model-proposed tool calls; staging a
 * commit, importing a repository, or probing storage still asks the person.
 *
 * Full Access is unchanged, because it is the person's own standing decision
 * that their actions need no prompt.
 *
 * The provenance still names the mode the session is pinned to — that is the
 * authority in force — with `human` as the source that actually decided, which
 * is exactly what the audit's closed vocabulary expects.
 */
export async function decideHumanIntent(options: Readonly<{
  mode: ApprovalMode;
  broker: ApprovalBroker;
  tool: ToolDefinition;
  argumentsValue: JsonValue;
  context: ToolContext;
}>): Promise<HumanIntentReview> {
  if (options.mode === "full-access") {
    return Object.freeze({
      decision: "allow" as const,
      provenance: Object.freeze({
        mode: options.mode,
        source: "bounded-browser-sandbox" as const,
        reason: fullAccessReason(options.tool.effect),
      }),
    });
  }
  const decision = await options.broker.request(options.tool, options.argumentsValue, options.context);
  const outcome = options.broker.takeOutcome(approvalRequestId(options.context)) ?? decision;
  return Object.freeze({
    decision,
    provenance: Object.freeze({
      mode: options.mode,
      source: outcome === "unavailable" ? "unattended" as const : "human" as const,
      // The allow sentence stays its own: this is the one path where the person
      // proposed the effect as well as permitting it, and the record says so.
      reason: outcome === "allow"
        ? "Allowed once by the user, who proposed the action."
        : approvalOutcomeReason(outcome),
    }),
  });
}

/**
 * `decideHumanIntent` as an `ApprovalPolicy`, for the one human-proposed effect
 * that must keep the tool registry's ticket seam.
 *
 * Git, GitHub import and the vault probe call `decideHumanIntent` directly
 * because they execute their own effect. A local slash command does not: it
 * runs through `ToolRegistry.review` → `executeApproved`, where the review call
 * is what mints the approval ticket that binds the exact argument digest and
 * abort signal to the execution. Deciding outside that seam and then executing
 * would mean issuing a ticket no policy granted, so the decision is injected as
 * the policy instead and every registry guard stays in force.
 *
 * What this changes for `/write`, `/execute-shell` and their peers under Auto
 * Approve: the person's own typed command is no longer shipped to a review
 * model, no longer bills them for a provider request they never asked for, and
 * — the reason this is a defect rather than a preference — can no longer be
 * *denied outright* by an `unsafe` verdict. That branch of
 * `createApprovalModePolicy` returns `deny` with no human fallback, which is a
 * model vetoing the operator who typed the command. Ask First and Full Access
 * are unchanged; Auto Approve now asks, which is strictly more human control,
 * never less.
 */
export function createHumanIntentPolicy(options: Readonly<{
  mode: ApprovalMode;
  broker: ApprovalBroker;
}>): ApprovalPolicy {
  const provenance = new Map<string, ApprovalProvenance>();
  return {
    async review(tool, argumentsValue, context) {
      // Reads stay automatic here exactly as they are in the mode policy. A
      // human-proposed effect is the thing worth adjudicating; prompting for a
      // read the person just asked for would be noise, and the provenance
      // vocabulary already has the word for why it ran.
      const reviewed: HumanIntentReview = tool.effect === "read"
        ? {
            decision: "allow",
            provenance: automaticReadProvenance(options.mode),
          }
        : await decideHumanIntent({ ...options, tool, argumentsValue, context });
      if (provenance.size >= MAX_PROVENANCE) provenance.delete(provenance.keys().next().value as string);
      provenance.set(contextKey(context), Object.freeze(reviewed.provenance));
      return reviewed.decision;
    },
    takeProvenance(context) {
      const key = contextKey(context);
      const value = provenance.get(key);
      provenance.delete(key);
      return value;
    },
  };
}

export function approvalProvenance(
  policy: ApprovalPolicy,
  context: ToolContext,
): ApprovalProvenance | undefined {
  return policy.takeProvenance?.(context);
}

function contextKey(context: ToolContext): string {
  return [context.sessionId, context.turnId, context.operationId]
    .map((part) => `${part.length}:${part}`)
    .join("|");
}
