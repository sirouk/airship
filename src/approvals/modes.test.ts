import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { ApprovalBroker } from "./broker";
import { approvalProvenance, createApprovalModePolicy, type SafetyReviewResult } from "./modes";

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a bounded workspace file.",
  effect: "write",
  inputSchema: { type: "object" },
};

function context(operationId = "operation"): ToolContext {
  return {
    sessionId: "session",
    turnId: "turn",
    operationId,
    signal: new AbortController().signal,
  };
}

describe("approval modes", () => {
  it("Ask First automatically permits reads and prompts for every stronger effect", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "ask-first", broker });
    const readContext = context("read");
    await expect(policy.review({ ...writeTool, effect: "read" }, {}, readContext)).resolves.toBe("allow");
    expect(approvalProvenance(policy, readContext)).toMatchObject({ mode: "ask-first", source: "automatic-read" });

    const writeContext = context("write");
    const decision = policy.review(writeTool, { path: "notes/a.md" }, writeContext);
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "allow");
    await expect(decision).resolves.toBe("allow");
    expect(approvalProvenance(policy, writeContext)).toMatchObject({ source: "human" });
  });

  it("Full Access permits every existing effect without consulting the broker", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "full-access", broker });
    for (const effect of ["write", "network", "execute", "identity"] as const) {
      const toolContext = context(effect);
      await expect(policy.review({ ...writeTool, effect }, {}, toolContext)).resolves.toBe("allow");
      expect(approvalProvenance(policy, toolContext)).toMatchObject({
        mode: "full-access",
        source: "bounded-browser-sandbox",
      });
    }
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  it("Auto Approve allows only a structured safe verdict and denies an unsafe verdict", async () => {
    const broker = new ApprovalBroker();
    const safetyReview = vi.fn(async (_tool: ToolDefinition, _args: JsonValue): Promise<SafetyReviewResult> => ({
      verdict: "safe" as const,
      reason: "The write stays inside the revision-bound workspace.",
      requestId: "review-safe",
      model: "review-model",
    }));
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker, safetyReview });
    const safeContext = context("safe");
    await expect(policy.review(writeTool, { path: "notes/a.md" }, safeContext)).resolves.toBe("allow");
    expect(approvalProvenance(policy, safeContext)).toEqual({
      mode: "auto-approve",
      source: "model-review",
      reason: "The write stays inside the revision-bound workspace.",
      reviewRequestId: "review-safe",
      reviewModel: "review-model",
    });

    safetyReview.mockResolvedValueOnce({ verdict: "unsafe", reason: "Unexpected destructive scope" });
    const unsafeContext = context("unsafe");
    await expect(policy.review(writeTool, {}, unsafeContext)).resolves.toBe("deny");
    expect(broker.snapshot().pending).toHaveLength(0);
    expect(approvalProvenance(policy, unsafeContext)).toMatchObject({ source: "model-review" });
  });

  it("Auto Approve fails closed to a human prompt when review is unavailable or malformed", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({
      mode: "auto-approve",
      broker,
      safetyReview: async () => ({ verdict: "indeterminate", reason: "Malformed structured output." }),
    });
    const toolContext = context();
    const decision = policy.review(writeTool, {}, toolContext);
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "deny");
    await expect(decision).resolves.toBe("deny");
    expect(approvalProvenance(policy, toolContext)).toMatchObject({
      mode: "auto-approve",
      source: "human-fallback",
    });
    expect(approvalProvenance(policy, toolContext)).toBeUndefined();
  });
});
