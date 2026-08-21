import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { ApprovalBroker } from "./broker";
import { approvalProvenance, createApprovalModePolicy } from "./modes";

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

  it("Full Access records the confinement each effect actually had, not one borrowed sentence", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "full-access", broker });
    const reasonFor = async (effect: ToolDefinition["effect"]): Promise<string> => {
      const toolContext = context(`full-${effect}`);
      await policy.review({ ...writeTool, effect }, {}, toolContext);
      return approvalProvenance(policy, toolContext)?.reason ?? "";
    };

    const write = await reasonFor("write");
    const network = await reasonFor("network");

    // The journaled reason is the durable record of why an effect ran without a
    // prompt. A network allow is confined to HTTPS and to the origin's CORS
    // policy; nothing path-confines it, so it must not say so.
    expect(network).not.toBe(write);
    expect(network).not.toContain("path boundaries");
    expect(network).toContain("not path-confined");
    expect(network).toContain("remote origin");
    expect(write).toContain("path confinement");
  });

  it("Auto Approve deterministically permits registered write effects without inference", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker });
    const writeContext = context("auto-write");

    await expect(policy.review(writeTool, { path: "notes/a.md" }, writeContext)).resolves.toBe("allow");
    expect(approvalProvenance(policy, writeContext)).toMatchObject({
      mode: "auto-approve",
      source: "bounded-browser-sandbox",
    });
    expect(approvalProvenance(policy, writeContext)).toBeUndefined();
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  it("Auto Approve asks a person for execute, network, and identity effects", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker });
    for (const effect of ["execute", "network", "identity"] as const) {
      const toolContext = context(`auto-${effect}`);
      const decision = policy.review({ ...writeTool, effect }, {}, toolContext);
      await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
      broker.decide(broker.snapshot().pending[0]!.id, "deny");
      await expect(decision).resolves.toBe("deny");
      expect(approvalProvenance(policy, toolContext)).toMatchObject({
        mode: "auto-approve",
        source: "human-fallback",
      });
    }
  });

  /*
   * The gate and the record answer different questions. An unanswered request
   * must not run, so it resolves `deny` — but the journal is the evidence
   * chain, and a person who walked away from the screen refused nothing. The
   * broker has kept that distinction all along in `takeOutcome`; until now
   * nothing read it, so every expiry was written down as "Denied or expired"
   * and left its reader to guess.
   */
  it("records an unanswered Ask First request as an expiry, not as a refusal", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ decisionTimeoutMs: 10 });
      const policy = createApprovalModePolicy({ mode: "ask-first", broker });
      const writeContext = context("expired");
      const decision = policy.review(writeTool, {}, writeContext);
      await vi.advanceTimersByTimeAsync(11);
      // The gate still fails closed; only the record tells the two apart.
      await expect(decision).resolves.toBe("deny");
      const reason = approvalProvenance(policy, writeContext)?.reason ?? "";
      expect(reason).not.toMatch(/denied/iu);
      expect(reason).toMatch(/expired/iu);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * F3. Auto Approve and Full Access answer for the browser workspace. Neither
   * of them was ever shown a path that is a real directory on a real disk: the
   * mount is composed under `WorkspacePort`, and no tool in `src/tools`
   * distinguishes the two, so a `write_file` to `/workspace/local/…` ran
   * unprompted, in place, with no undo, and was journaled as being "inside its
   * declared browser tool boundary".
   */
  it("reviews a write to an attached folder in every automatic mode, and says why", async () => {
    for (const mode of ["auto-approve", "full-access"] as const) {
      const broker = new ApprovalBroker();
      const policy = createApprovalModePolicy({ mode, broker });
      const toolContext = context(`folder-${mode}`);
      const decision = policy.review(writeTool, { path: "/workspace/local/airship/src/main.ts", content: "x" }, toolContext);
      await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
      broker.decide(broker.snapshot().pending[0]!.id, "deny");
      await expect(decision).resolves.toBe("deny");
      const provenance = approvalProvenance(policy, toolContext);
      expect(provenance).toMatchObject({ mode, source: "human-fallback" });
      expect(provenance?.reason).toContain("folder on your own device");
      expect(provenance?.reason).toContain("nothing here can undo it");
      expect(provenance?.reason).toContain("every approval mode reviews it");
      expect(provenance?.reason).not.toContain("browser tool boundary");
    }
  });

  it("finds the folder path wherever the tool spells it, and leaves workspace paths alone", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker });
    const asked = async (argumentsValue: JsonValue, operationId: string): Promise<boolean> => {
      const toolContext = context(operationId);
      const decision = policy.review(writeTool, argumentsValue, toolContext);
      // `review` reaches the broker synchronously up to its first await, so one
      // settled microtask is enough to see whether a request was filed at all.
      await Promise.resolve();
      const pending = broker.snapshot().pending;
      if (pending.length > 0) broker.decide(pending[0]!.id, "allow");
      await expect(decision).resolves.toBe("allow");
      return pending.length > 0;
    };

    // Relative, and normalised: `local/x` is the same directory as the absolute form.
    expect(await asked({ path: "local/notes.md", content: "x" }, "relative")).toBe(true);
    // A doubled separator normalises into the mount too, and must not slip past.
    expect(await asked({ path: "/workspace//local/notes.md", content: "x" }, "doubled")).toBe(true);
    expect(await asked({ sourcePath: "/workspace/a.md", destinationPath: "/workspace/local/a.md" }, "move")).toBe(true);
    expect(await asked({ edits: [{ path: "/workspace/local/a.md", newText: "x" }] }, "batch")).toBe(true);
    expect(await asked({ path: "/workspace/notes.md", content: "x" }, "ordinary")).toBe(false);
  });

  it("still reads an attached folder without asking, because reading it changes nothing", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker });
    const toolContext = context("folder-read");
    await expect(policy.review({ ...writeTool, effect: "read" }, { path: "/workspace/local/a.md" }, toolContext))
      .resolves.toBe("allow");
    expect(broker.snapshot().pending).toHaveLength(0);
    expect(approvalProvenance(policy, toolContext)).toMatchObject({ source: "automatic-read" });
  });

  /*
   * A page-wide cap that background conversations can fill without the person
   * seeing anything was journaled as a refusal the person made.
   */
  it("never records a queue-full refusal as a decision a person made", async () => {
    const broker = new ApprovalBroker({ maxPending: 1 });
    const policy = createApprovalModePolicy({ mode: "ask-first", broker });
    const first = policy.review(writeTool, { path: "a.md" }, context("first"));
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));

    const blockedContext = context("second");
    await expect(policy.review(writeTool, { path: "b.md" }, blockedContext)).resolves.toBe("deny");
    const provenance = approvalProvenance(policy, blockedContext);
    expect(provenance).toMatchObject({ mode: "ask-first", source: "unattended" });
    expect(provenance?.reason).toContain("Nobody was asked");
    expect(provenance?.reason).toContain("most approval requests it allows at once");
    expect(provenance?.reason).toContain("Answer the requests that are waiting");
    expect(provenance?.reason).not.toContain("Denied without approval");

    broker.decide(broker.snapshot().pending[0]!.id, "deny");
    await first;
  });
});
