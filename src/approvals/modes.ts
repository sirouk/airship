import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalProvenance,
  JsonValue,
  ToolContext,
  ToolDefinition,
} from "../core/contracts";
import type { ApprovalBroker } from "./broker";

export type ApprovalMode = ApprovalProvenance["mode"];

export type SafetyReviewResult = Readonly<{
  verdict: "safe" | "unsafe" | "indeterminate";
  reason: string;
  requestId?: string;
  model?: string;
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
          reason: "Allowed by Full Access inside the existing browser capability and path boundaries.",
        });
        return "allow";
      }

      if (options.mode === "ask-first") {
        const decision = await options.broker.request(tool, argumentsValue, context);
        remember(context, {
          mode: options.mode,
          source: "human",
          reason: decision === "allow" ? "Allowed once by the user." : "Denied or expired without user approval.",
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
      remember(context, {
        mode: options.mode,
        source: "human-fallback",
        reason: `${review.reason} ${decision === "allow" ? "Allowed once by the user." : "Denied or expired without user approval."}`,
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
