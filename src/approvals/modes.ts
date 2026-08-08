import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalProvenance,
  JsonValue,
  ToolContext,
  ToolDefinition,
} from "../core/contracts";
import { approvalOutcomeReason, approvalRequestId, type ApprovalBroker } from "./broker";

export type ApprovalMode = ApprovalProvenance["mode"];

export type SafetyReviewResult = Readonly<{
  verdict: "safe" | "unsafe" | "indeterminate";
  reason: string;
  requestId?: string;
  model?: string;
  /**
   * What the review itself cost, when the transport reported it. Auto Approve
   * issues one provider request per effectful action, so leaving this off the
   * result made those requests structurally unrecordable rather than merely
   * unrecorded. Absent means "not reported", never zero.
   */
  inputTokens?: number;
  outputTokens?: number;
}>;

export type SafetyReview = (
  tool: ToolDefinition,
  displayArguments: JsonValue,
  context: ToolContext,
) => Promise<SafetyReviewResult>;

const MAX_PROVENANCE = 512;

export function createApprovalModePolicy(options: Readonly<{
  mode: ApprovalMode;
  broker: ApprovalBroker;
  safetyReview?: SafetyReview;
}>): ApprovalPolicy {
  const provenance = new Map<string, ApprovalProvenance>();

  function remember(context: ToolContext, value: ApprovalProvenance): void {
    if (provenance.size >= MAX_PROVENANCE) provenance.delete(provenance.keys().next().value as string);
    provenance.set(contextKey(context), Object.freeze(value));
  }

  return {
    async review(tool, argumentsValue, context) {
      if (tool.effect === "read") {
        remember(context, {
          mode: options.mode,
          source: "automatic-read",
          reason: "Read-only browser tool effects are allowed automatically.",
        });
        return "allow";
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
          source: "human",
          reason: approvalOutcomeReason(outcome),
        });
        return decision;
      }

      let review: SafetyReviewResult;
      try {
        review = options.safetyReview
          ? await options.safetyReview(tool, argumentsValue, context)
          : { verdict: "indeterminate", reason: "No safety-review transport is available." };
      } catch (error) {
        review = {
          verdict: "indeterminate",
          reason: error instanceof Error ? `Safety review failed: ${error.message}` : "Safety review failed.",
        };
      }
      if (review.verdict === "safe") {
        remember(context, {
          mode: options.mode,
          source: "model-review",
          reason: review.reason,
          ...(review.requestId ? { reviewRequestId: review.requestId } : {}),
          ...(review.model ? { reviewModel: review.model } : {}),
        });
        return "allow";
      }
      if (review.verdict === "unsafe") {
        remember(context, {
          mode: options.mode,
          source: "model-review",
          reason: review.reason,
          ...(review.requestId ? { reviewRequestId: review.requestId } : {}),
          ...(review.model ? { reviewModel: review.model } : {}),
        });
        return "deny";
      }

      const decision = await options.broker.request(tool, argumentsValue, context);
      const fallbackOutcome = options.broker.takeOutcome(approvalRequestId(context)) ?? decision;
      remember(context, {
        mode: options.mode,
        source: "human-fallback",
        reason: `${review.reason} ${approvalOutcomeReason(fallbackOutcome)}`,
        ...(review.requestId ? { reviewRequestId: review.requestId } : {}),
        ...(review.model ? { reviewModel: review.model } : {}),
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
 * Auto Approve's whole premise is "have a model review what the model wants to
 * do". When the proposer is the human at the keyboard — staging a commit,
 * importing a repository, probing a vault — asking a model for permission
 * inverts the relationship, and a model verdict of `unsafe` becomes a machine
 * vetoing its operator. So Auto Approve resolves to the same thing Ask First
 * does here: the person is asked.
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
      source: "human" as const,
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
            provenance: {
              mode: options.mode,
              source: "automatic-read",
              reason: "Read-only browser tool effects are allowed automatically.",
            },
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
