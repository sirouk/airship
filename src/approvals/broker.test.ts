import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { ApprovalBroker, approvalOutcomeReason, approvalRequestId, createBrokeredApprovalPolicy, redactForDisplay } from "./broker";

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

  /**
   * An expiry entered the journal — the product's evidence chain — as a denial,
   * so a request the person was never at the screen to answer was recorded, and
   * replayed, as one they refused. The gate still reads `deny`, because an
   * unanswered request must not run; only the outcome beside it tells the truth.
   */
  it("records an expiry as an expiry while still failing the gate closed", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ decisionTimeoutMs: 10 });
      const identity = context();
      const result = broker.request(writeTool, {}, identity);
      await vi.advanceTimersByTimeAsync(11);

      await expect(result).resolves.toBe("deny");
      const id = approvalRequestId(identity);
      expect(broker.takeOutcome(id)).toBe("expired");
      expect(approvalOutcomeReason("expired")).not.toMatch(/denied/iu);
      // One-shot, like every other record this codebase hands to a writer.
      expect(broker.takeOutcome(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a refusal a refusal and never reports an allow as either", async () => {
    const broker = new ApprovalBroker();
    const allowed = context();
    const allow = broker.request(writeTool, {}, allowed);
    broker.decide(approvalRequestId(allowed), "allow");
    await expect(allow).resolves.toBe("allow");
    expect(broker.takeOutcome(approvalRequestId(allowed))).toBe("allow");

    const refused: ToolContext = { ...context(), operationId: "operation-2" };
    const deny = broker.request(writeTool, {}, refused);
    broker.decide(approvalRequestId(refused), "deny");
    await expect(deny).resolves.toBe("deny");
    expect(broker.takeOutcome(approvalRequestId(refused))).toBe("deny");

    // The dock may state a decision; it may not state the absence of one.
    expect(broker.decide(approvalRequestId(refused), "expired" as never)).toBe(false);
    expect(approvalOutcomeReason("allow")).not.toBe(approvalOutcomeReason("deny"));
  });

  /**
   * Escape filed a denial, so the reflex that dismisses the slash menu one line
   * above the composer destroyed the command it dismissed — measured as
   * "Permission denied for local /update-memory. No tool effect ran" with no
   * Retry on the turn. Deferring answers nothing: the promise stays unresolved,
   * the clock is untouched, and the request only stops being modal.
   */
  it("keeps a deferred request live, unanswered, and out of the modal queue", async () => {
    const broker = new ApprovalBroker();
    const identity = context();
    const decision = broker.request(writeTool, { path: "note.md" }, identity);
    const id = approvalRequestId(identity);

    expect(broker.defer(id)).toBe(true);
    expect(broker.defer(id)).toBe(false);
    expect(broker.snapshot().pending).toHaveLength(0);
    expect(broker.snapshot().deferred).toHaveLength(1);
    expect(broker.takeOutcome(id)).toBeUndefined();

    expect(broker.resume(id)).toBe(true);
    expect(broker.snapshot().pending).toHaveLength(1);
    expect(broker.snapshot().deferred).toHaveLength(0);
    broker.decide(id, "allow");
    await expect(decision).resolves.toBe("allow");
  });

  it("still expires a deferred request, and still fails it closed", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ decisionTimeoutMs: 10 });
      const identity = context();
      const decision = broker.request(writeTool, {}, identity);
      broker.defer(approvalRequestId(identity));
      await vi.advanceTimersByTimeAsync(11);
      await expect(decision).resolves.toBe("deny");
      expect(broker.snapshot().deferred).toHaveLength(0);
      expect(broker.takeOutcome(approvalRequestId(identity))).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The outcome of a security decision was never announced: a denial resolved
   * into "Airship's turn ended." and an allow into "Local command complete; no
   * model request made". A surface that has to speak the outcome cannot consume
   * `takeOutcome` to do it — that record belongs to the journal — so settlement
   * is published separately, carrying the request that is already gone from
   * every snapshot by the time there is anything to say.
   */
  it("publishes each settlement with its request, without consuming the record", async () => {
    const broker = new ApprovalBroker();
    const settled: string[] = [];
    broker.subscribeSettled(({ request, outcome }) => settled.push(`${request.toolName}:${outcome}`));

    const allowed = context();
    const allow = broker.request(writeTool, { path: "a.md" }, allowed);
    broker.decide(approvalRequestId(allowed), "allow");
    await expect(allow).resolves.toBe("allow");

    const refused: ToolContext = { ...context(), operationId: "operation-2" };
    const deny = broker.request(writeTool, { path: "b.md" }, refused);
    broker.decide(approvalRequestId(refused), "deny");
    await expect(deny).resolves.toBe("deny");

    expect(settled).toEqual(["write_file:allow", "write_file:deny"]);
    // The journal's copy is untouched by anything that merely spoke it.
    expect(broker.takeOutcome(approvalRequestId(allowed))).toBe("allow");
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
