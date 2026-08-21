import { describe, expect, it } from "vitest";
import { ApprovalBroker, approvalOutcomeReason, approvalRequestId, approvalWasAnswered } from "./broker";
import { createApprovalModePolicy } from "./modes";
import type { ToolContext, ToolDefinition } from "../core/contracts";

const writeTool: ToolDefinition = {
  name: "text_editor",
  description: "edit a workspace file",
  effect: "write",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

function context(controller: AbortController): ToolContext {
  return { sessionId: "s", turnId: "t", operationId: "o", signal: controller.signal } as ToolContext;
}

/**
 * Stop is not Deny.
 *
 * A cancelled turn settled its outstanding request as `deny`, which
 * `approvalWasAnswered` reads as a decision, so the journal recorded
 * `source: "human"` and "Denied without approval" for a question the person was
 * never shown an answer to. The gate is unchanged; only the record is.
 */
describe("an aborted turn withdraws its request rather than denying it", () => {
  it("records a withdrawal, not a human refusal, when the turn is stopped", async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    const policy = createApprovalModePolicy({ mode: "ask-first", broker });
    const identity = context(controller);
    const review = policy.review(writeTool, {}, identity);
    await Promise.resolve();
    controller.abort();
    await expect(review).resolves.toBe("deny");
    const provenance = policy.takeProvenance?.(identity);
    expect(provenance?.source).toBe("unattended");
    expect(provenance?.reason).toBe(approvalOutcomeReason("withdrawn"));
    expect(approvalWasAnswered("withdrawn")).toBe(false);
  });

  it("records a withdrawal when the turn was already aborted before the request", async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    controller.abort();
    const identity = context(controller);
    await expect(broker.request(writeTool, {}, identity)).resolves.toBe("deny");
    expect(broker.takeOutcome(approvalRequestId(identity))).toBe("withdrawn");
  });

  it("keeps the person's own Deny a human refusal", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "ask-first", broker });
    const identity = context(new AbortController());
    const review = policy.review(writeTool, {}, identity);
    await Promise.resolve();
    expect(broker.decide(broker.snapshot().pending[0]!.id, "deny")).toBe(true);
    await expect(review).resolves.toBe("deny");
    expect(policy.takeProvenance?.(identity)?.source).toBe("human");
  });
});
