import { describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy, ToolContext, ToolDefinition } from "../core/contracts";
import { approvalProvenance } from "./modes";
import { SwitchableApprovalPolicy } from "./switchable-policy";

const tool: ToolDefinition = {
  name: "write_file",
  description: "Write one file",
  effect: "write",
  inputSchema: { type: "object" },
};

describe("SwitchableApprovalPolicy", () => {
  it("uses the replacement for a tool review reached by an already-running turn", async () => {
    const ask = policy("deny", "ask-first");
    const full = policy("allow", "full-access");
    const switchable = new SwitchableApprovalPolicy(ask);
    switchable.replace(full);
    const operation = context("replacement");

    await expect(switchable.review(tool, {}, operation)).resolves.toBe("allow");
    expect(full.review).toHaveBeenCalledOnce();
    expect(ask.review).not.toHaveBeenCalled();
    expect(approvalProvenance(switchable, operation)).toMatchObject({ mode: "full-access" });
  });

  it("keeps provenance bound to the delegate that completed an in-flight review", async () => {
    let finish!: () => void;
    const pending: ApprovalPolicy = {
      review: vi.fn(() => new Promise<"allow">((resolve) => { finish = () => resolve("allow"); })),
      takeProvenance: () => ({ mode: "ask-first", source: "human", reason: "Allowed once." }),
    };
    const switchable = new SwitchableApprovalPolicy(pending);
    const operation = context("in-flight");
    const decision = switchable.review(tool, {}, operation);
    switchable.replace(policy("deny", "auto-approve"));
    finish();

    await expect(decision).resolves.toBe("allow");
    expect(approvalProvenance(switchable, operation)).toMatchObject({ mode: "ask-first", source: "human" });
  });
});

function context(operationId: string): ToolContext {
  return { sessionId: "session", turnId: "turn", operationId, signal: new AbortController().signal };
}

function policy(decision: "allow" | "deny", mode: "ask-first" | "auto-approve" | "full-access"): ApprovalPolicy {
  return {
    review: vi.fn(async () => decision),
    takeProvenance: () => ({ mode, source: mode === "full-access" ? "bounded-browser-sandbox" : "human", reason: mode }),
  };
}
