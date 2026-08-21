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

  /*
   * Turns run per conversation, so a page-wide denial is a page-wide claim.
   *
   * The shell denies outstanding requests when the visible conversation's
   * approval mode changes, on the rule that a prompt belongs to the policy that
   * created it. Opening a thread pinned to a different mode changes that value
   * without changing anything about a thread still answering in the background,
   * and denying its request would file a refusal nobody made.
   */
  it("denies one conversation's requests without touching another's", async () => {
    const broker = new ApprovalBroker();
    const here = { ...context(), sessionId: "here" };
    const there = { ...context(), sessionId: "there" };
    const mine = broker.request(writeTool, { path: "a.md" }, here);
    const theirs = broker.request(writeTool, { path: "b.md" }, there);
    expect(broker.snapshot().pending).toHaveLength(2);

    broker.settleAll("page", "here");
    await expect(mine).resolves.toBe("deny");
    expect(broker.snapshot().pending.map((request) => request.sessionId)).toEqual(["there"]);
    // Still closed, and no longer a decision: nobody was asked about a mode change.
    expect(broker.takeOutcome(approvalRequestId(here))).toBe("withdrawn");

    // The page-wide form still exists, and still means every conversation:
    // teardown and a failed dialog chunk are page-wide losses of authority.
    broker.settleAll("page");
    await expect(theirs).resolves.toBe("deny");
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  /*
   * `settleAll` is the only helper that takes a whole page's worth of live
   * requests off the table, and four callers reach it: the person's own "Deny
   * pending request" control, the failed approval-dialog chunk, the shell's
   * teardown, and a conversation whose approval mode changed. The first is a
   * refusal; the other three are the absence of one. They used to be one word.
   */
  it("distinguishes the person's refusal from a request the page withdrew", async () => {
    const broker = new ApprovalBroker();
    const settled: string[] = [];
    broker.subscribeSettled((settlement) => settled.push(settlement.outcome));
    const refused = broker.request(writeTool, { path: "a.md" }, { ...context(), operationId: "refused" });
    broker.settleAll("human");
    await expect(refused).resolves.toBe("deny");
    expect(broker.takeOutcome(approvalRequestId({ ...context(), operationId: "refused" }))).toBe("deny");
    expect(approvalOutcomeReason("deny")).toBe("Denied without approval; the effect did not run.");

    const withdrawn = broker.request(writeTool, { path: "b.md" }, { ...context(), operationId: "withdrawn" });
    broker.settleAll("page");
    // Fails closed exactly as before. Only the record can tell the two apart.
    await expect(withdrawn).resolves.toBe("deny");
    expect(broker.takeOutcome(approvalRequestId({ ...context(), operationId: "withdrawn" }))).toBe("withdrawn");
    expect(settled).toEqual(["deny", "withdrawn"]);
  });

  /*
   * One sentence for all three automatic callers, and deliberately parallel to
   * the expiry sentence beside it: both are the absence of a decision. It does
   * not claim nobody was *asked*, because a conversation whose approval mode
   * changed may well have had its prompt on screen; what is true of all three
   * is that nobody answered before the page took the question away.
   */
  it("says a withdrawal is the absence of a decision, not a refusal", () => {
    expect(approvalOutcomeReason("withdrawn"))
      .toBe("No decision was recorded; the page withdrew this request before anyone answered it.");
    expect(approvalOutcomeReason("withdrawn")).not.toMatch(/denied/iu);
  });

  /*
   * The modal dialog is the shell's only self-inflicted inert state, and turns
   * run in parallel. A request from the thread on screen is the interruption it
   * has always been; a request from a thread answering in the background may
   * not stop the work somebody is doing to ask about work they are not looking
   * at, so it is filed as waiting on the same clock.
   */
  it("files a request from a background conversation as waiting, not as a demand", async () => {
    const broker = new ApprovalBroker();
    broker.focusSession("here");
    const mine = broker.request(writeTool, { path: "a.md" }, { ...context(), sessionId: "here" });
    const theirs = broker.request(writeTool, { path: "b.md" }, { ...context(), sessionId: "there", operationId: "operation-2" });

    const snapshot = broker.snapshot();
    expect(snapshot.pending.map((entry) => entry.sessionId)).toEqual(["here"]);
    expect(snapshot.deferred.map((entry) => entry.sessionId)).toEqual(["there"]);
    // Waiting is not decided: same queue, same clock, same closed gate.
    expect(snapshot.deferred[0]!.expiresAt).toBeTruthy();

    // And it is reachable: the bar's Review is `resume`, which asks it here.
    expect(broker.resume(snapshot.deferred[0]!.id)).toBe(true);
    expect(broker.snapshot().pending).toHaveLength(2);

    broker.settleAll("page");
    await expect(mine).resolves.toBe("deny");
    await expect(theirs).resolves.toBe("deny");
  });

  it("treats every conversation as the foreground until a host says otherwise", async () => {
    const broker = new ApprovalBroker();
    const decision = broker.request(writeTool, {}, { ...context(), sessionId: "unbound" });
    expect(broker.snapshot().pending).toHaveLength(1);
    expect(broker.snapshot().deferred).toHaveLength(0);
    broker.settleAll("page");
    await expect(decision).resolves.toBe("deny");
  });

  it("auto-allows configured read effects but brokers mutations", async () => {
    const broker = new ApprovalBroker();
    const policy = createBrokeredApprovalPolicy(broker);
    const readTool = { ...writeTool, name: "read_file", effect: "read" as const };
    await expect(policy.review(readTool, {}, context())).resolves.toBe("allow");
    const mutation = policy.review(writeTool, {}, context());
    expect(broker.snapshot().pending).toHaveLength(1);
    broker.settleAll("page");
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
    // An elision that says only "…" leaves its reader unable to tell 600
    // characters from 600 kilobytes, so it states what it kept and what existed.
    expect(String(display.text).startsWith("x".repeat(512))).toBe(true);
    expect(display.text).toContain("[512 of 600 characters shown]");
    expect((display.nested as Record<string, JsonValue>).password).toBe("[redacted]");
    expect(display.list).toHaveLength(33);
  });

  it("takes the string budget from its caller, because the dock and the safety reviewer are not one reader", () => {
    const value: JsonValue = { script: "s".repeat(4_000), authorization: "Bearer sensitive" };
    const reviewed = redactForDisplay(value, 8_192) as Record<string, JsonValue>;
    // The reviewer adjudicates the script itself; the dock's 512 would leave it
    // approving a preamble. Every other bound is unchanged by the wider budget.
    expect(reviewed.script).toBe("s".repeat(4_000));
    expect(reviewed.authorization).toBe("[redacted]");
  });
});
