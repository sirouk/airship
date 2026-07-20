import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { ApprovalBroker, createBrokeredApprovalPolicy, redactForDisplay } from "./broker";

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a file in the active workspace.",
  effect: "write",
  inputSchema: {},
};

function context(controller = new AbortController()): ToolContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    operationId: "operation-1",
    signal: controller.signal,
  };
}

describe("ApprovalBroker", () => {
  it("publishes a redacted request and settles it exactly once", async () => {
    const broker = new ApprovalBroker({ now: () => "2026-07-18T00:00:00.000Z" });
    const snapshots: number[] = [];
    broker.subscribe((snapshot) => snapshots.push(snapshot.pending.length));
    const decision = broker.request(writeTool, { path: "note.md", apiKey: "do-not-show" }, context());
    const [pending] = broker.snapshot().pending;

    expect(pending).toMatchObject({
      toolName: "write_file",
      effect: "write",
      risk: "change",
      requestedAt: "2026-07-18T00:00:00.000Z",
      displayArguments: { path: "note.md", apiKey: "[redacted]" },
    });
    expect(broker.decide(pending!.id, "allow")).toBe(true);
    expect(broker.decide(pending!.id, "deny")).toBe(false);
    await expect(decision).resolves.toBe("allow");
    expect(snapshots).toEqual([0, 1, 0]);
  });

  it("fails closed on abort, duplicate operation identity, and queue overflow", async () => {
    const broker = new ApprovalBroker({ maxPending: 1 });
    const controller = new AbortController();
    const first = broker.request(writeTool, {}, context(controller));
    await expect(broker.request(writeTool, {}, context())).resolves.toBe("deny");
    controller.abort();
    await expect(first).resolves.toBe("deny");
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  it("fails closed when a decision times out", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ decisionTimeoutMs: 10 });
      const result = broker.request(writeTool, {}, context());
      await vi.advanceTimersByTimeAsync(11);
      await expect(result).resolves.toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-allows configured read effects but brokers mutations", async () => {
    const broker = new ApprovalBroker();
    const policy = createBrokeredApprovalPolicy(broker);
    const readTool = { ...writeTool, name: "read_file", effect: "read" as const };
    await expect(policy.review(readTool, {}, context())).resolves.toBe("allow");
    const mutation = policy.review(writeTool, {}, context());
    expect(broker.snapshot().pending).toHaveLength(1);
    broker.denyAll();
    await expect(mutation).resolves.toBe("deny");
  });
});

describe("redactForDisplay", () => {
  it("bounds strings, arrays, depth, and secret-bearing keys", () => {
    const value: JsonValue = {
      authorization: "Bearer sensitive",
      text: "x".repeat(600),
      nested: { password: "sensitive", visible: true },
      list: Array.from({ length: 40 }, (_, index) => index),
    };
    const display = redactForDisplay(value) as Record<string, JsonValue>;
    expect(display.authorization).toBe("[redacted]");
    expect(String(display.text)).toHaveLength(513);
    expect((display.nested as Record<string, JsonValue>).password).toBe("[redacted]");
    expect(display.list).toHaveLength(33);
  });
});
