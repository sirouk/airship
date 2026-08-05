import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages } from "./agent";
import type { CanonicalMessage, JsonValue, ToolCall, ToolDefinition } from "./contracts";
import { sha256, stableStringify } from "./hash";
import { EventJournal, type DurableEvent, type SessionRecord } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { createLocalReceipt } from "../receipts/types";
import { auditSessionHistory } from "./session-audit";

/** The provenance a real ask-first approval journals; see approvalProvenanceIssue. */
const HUMAN_APPROVAL = { mode: "ask-first", source: "human", reason: "Allowed once by the user." } as const;

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a virtual workspace file",
  effect: "write",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

describe("auditSessionHistory", () => {
  it("verifies the chain, manifest, transcript request, response, and receipt bindings independently", async () => {
    const fixture = await createFixture([]);
    const turnId = "turn-final";
    const operationId = "inference-final";
    const user: CanonicalMessage = { role: "user", content: "Give me a concise status." };
    await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: user.content } }]);
    const requestDigest = await inferenceDigest(fixture.session, turnId, 0, [user]);
    await fixture.journal.append(fixture.session.id, [{
      type: "inference.started",
      turnId,
      operationId,
      payload: inferencePayload(fixture.session, turnId, 0, requestDigest),
    }]);
    const content = "Everything is operational.";
    const responseDigest = await sha256(content);
    const receipt = createLocalReceipt({
      sessionId: fixture.session.id,
      turnId,
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest,
      responseDigest,
      now: "2026-07-18T00:00:04.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "assistant.completed",
        turnId,
        operationId,
        payload: {
          message: { role: "assistant", content },
          finishReason: "stop",
          responseDigest,
          receipt: receipt as unknown as JsonValue,
        },
      },
      { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
    ]);

    const session = (await fixture.journal.getSession(fixture.session.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const report = await auditSessionHistory(
      { session, events },
      {
        checkedAt: "2026-07-18T00:01:00.000Z",
        trustedHead: { sequence: session.headSequence, digest: session.headDigest, source: "signed export fixture" },
      },
    );

    expect(report.status).toBe("verified");
    expect(report.authenticity).toBe("not-proven");
    expect(report.anchor).toEqual({ status: "matched", source: "signed export fixture" });
    expect(report.checks).toEqual({
      schema: true,
      chain: true,
      manifest: true,
      protocol: true,
      receiptBindings: true,
      complete: true,
    });
    expect(report.counts).toMatchObject({ events: 5, turns: 1, completedTurns: 1 });
    expect(report.findings).toEqual([]);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("reprojects failed and no-work cancelled turns before checking the next request", async () => {
    for (const terminal of ["turn.failed", "turn.cancelled"] as const) {
      const fixture = await createFixture([]);
      await fixture.journal.append(fixture.session.id, [
        { type: "turn.requested", turnId: "discarded-turn", payload: { content: "Do not replay this." } },
        { type: terminal, turnId: "discarded-turn", payload: { error: terminal === "turn.failed" ? "Provider failed." : "Stopped before work." } },
      ]);

      await appendCompletedTurn(fixture, "next-turn", "Continue safely.", []);
      const report = await auditFixture(fixture);
      expect(report.status, terminal).toBe("verified");
      expect(report.findings, terminal).toEqual([]);
    }
  });

  it("reprojects a cancelled turn's completed work as a checkpoint before the next request", async () => {
    const fixture = await createFixture([writeTool]);
    const turnId = "cancelled-after-work";
    const call: ToolCall = {
      id: "call-salvaged",
      name: "write_file",
      arguments: { path: "/workspace/report.md", content: "landed" },
    };
    const request: CanonicalMessage = { role: "user", content: "Write the report, then keep going." };
    await fixture.journal.append(fixture.session.id, [
      { type: "turn.requested", turnId, payload: { content: request.content } },
    ]);
    const firstDigest = await inferenceDigest(fixture.session, turnId, 0, [request]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "inference.started",
        turnId,
        operationId: "salvaged-inference",
        payload: inferencePayload(fixture.session, turnId, 0, firstDigest),
      },
      {
        type: "assistant.completed",
        turnId,
        operationId: "salvaged-inference",
        payload: { message: { role: "assistant", content: "", toolCalls: [call] }, finishReason: "tool-calls" },
      },
      { type: "tool.requested", turnId, operationId: call.id, payload: { call } },
      { type: "tool.approved", turnId, operationId: call.id, payload: { callId: call.id, name: call.name, approval: HUMAN_APPROVAL } },
      {
        type: "tool.resulted",
        turnId,
        operationId: call.id,
        payload: { callId: call.id, name: call.name, content: "Wrote report.md", isError: false, metadata: null },
      },
      { type: "turn.cancelled", turnId, payload: { error: "Stopped after the write." } },
    ]);

    const salvagedHistory = materializeMessages(await fixture.journal.readEvents(fixture.session.id));
    expect(salvagedHistory[0]?.content).toContain("cancelled before it finished");
    expect(salvagedHistory.some((message) => message.role === "tool" && message.content === "Wrote report.md")).toBe(true);
    await appendCompletedTurn(fixture, "after-salvage", "Summarize what landed.", salvagedHistory);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.findings).toEqual([]);
  });

  it("audits an ordered multi-step tool lifecycle and its transcript-derived second request", async () => {
    const fixture = await createFixture([writeTool]);
    const turnId = "turn-tools";
    const firstInference = "inference-0";
    const secondInference = "inference-1";
    const call: ToolCall = {
      id: "call-write-1",
      name: "write_file",
      arguments: { path: "/workspace/report.md", content: "verified" },
    };
    const user: CanonicalMessage = { role: "user", content: "Create a report." };
    await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: user.content } }]);
    const firstDigest = await inferenceDigest(fixture.session, turnId, 0, [user]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "inference.started",
        turnId,
        operationId: firstInference,
        payload: inferencePayload(fixture.session, turnId, 0, firstDigest),
      },
      {
        type: "assistant.completed",
        turnId,
        operationId: firstInference,
        payload: { message: { role: "assistant", content: "", toolCalls: [call] }, finishReason: "tool-calls" },
      },
      { type: "tool.requested", turnId, operationId: call.id, payload: { call } },
      { type: "tool.approved", turnId, operationId: call.id, payload: { callId: call.id, name: call.name, approval: HUMAN_APPROVAL } },
      {
        type: "tool.resulted",
        turnId,
        operationId: call.id,
        payload: { callId: call.id, name: call.name, content: "Wrote report.md", isError: false, metadata: null },
      },
    ]);
    const transcript: CanonicalMessage[] = [
      user,
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", toolCallId: call.id, content: "Wrote report.md" },
    ];
    const secondDigest = await inferenceDigest(fixture.session, turnId, 1, transcript);
    await fixture.journal.append(fixture.session.id, [{
      type: "inference.started",
      turnId,
      operationId: secondInference,
      payload: inferencePayload(fixture.session, turnId, 1, secondDigest),
    }]);
    const content = "The report is ready.";
    const responseDigest = await sha256(content);
    const receipt = createLocalReceipt({
      sessionId: fixture.session.id,
      turnId,
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest: secondDigest,
      responseDigest,
      now: "2026-07-18T00:00:10.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "assistant.completed",
        turnId,
        operationId: secondInference,
        payload: {
          message: { role: "assistant", content },
          finishReason: "stop",
          responseDigest,
          receipt: receipt as unknown as JsonValue,
        },
      },
      { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.counts).toMatchObject({ toolOperations: 1, terminalToolOperations: 1, completedTurns: 1 });
    expect(report.findings).toEqual([]);
  });

  /*
   * Auto Approve pays a provider for a verdict on every effectful call. That
   * inference has no step of its own — it happens while a call waits for a
   * decision — so the journal had nowhere to put its cost and the charge was
   * invisible. It is admitted against the pending call, and only there.
   */
  it("admits a safety-review usage against the call it adjudicates, and only while that call is pending", async () => {
    const call: ToolCall = {
      id: "call-write-review",
      name: "write_file",
      arguments: { path: "/workspace/report.md", content: "verified" },
    };
    const build = async (reviewUsageAfterTerminal: boolean) => {
      const fixture = await createFixture([writeTool]);
      const turnId = "turn-review";
      const firstInference = "inference-review-0";
      const secondInference = "inference-review-1";
      const user: CanonicalMessage = { role: "user", content: "Create a report." };
      await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: user.content } }]);
      const firstDigest = await inferenceDigest(fixture.session, turnId, 0, [user]);
      const reviewUsage = {
        type: "inference.usage" as const,
        turnId,
        operationId: call.id,
        payload: { inputTokens: 412, outputTokens: 19, source: "approval-review", model: "review-model" },
      };
      const result = {
        type: "tool.resulted" as const,
        turnId,
        operationId: call.id,
        payload: { callId: call.id, name: call.name, content: "Wrote report.md", isError: false, metadata: null },
      };
      await fixture.journal.append(fixture.session.id, [
        {
          type: "inference.started",
          turnId,
          operationId: firstInference,
          payload: inferencePayload(fixture.session, turnId, 0, firstDigest),
        },
        {
          type: "assistant.completed",
          turnId,
          operationId: firstInference,
          payload: { message: { role: "assistant", content: "", toolCalls: [call] }, finishReason: "tool-calls" },
        },
        { type: "tool.requested", turnId, operationId: call.id, payload: { call } },
        ...(reviewUsageAfterTerminal ? [] : [reviewUsage]),
        { type: "tool.approved", turnId, operationId: call.id, payload: { callId: call.id, name: call.name, approval: HUMAN_APPROVAL } },
        result,
        ...(reviewUsageAfterTerminal ? [reviewUsage] : []),
      ]);
      const transcript: CanonicalMessage[] = [
        user,
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, content: "Wrote report.md" },
      ];
      const secondDigest = await inferenceDigest(fixture.session, turnId, 1, transcript);
      const content = "The report is ready.";
      const responseDigest = await sha256(content);
      const receipt = createLocalReceipt({
        sessionId: fixture.session.id,
        turnId,
        provider: fixture.session.manifest.providerId,
        model: fixture.session.manifest.model,
        requestDigest: secondDigest,
        responseDigest,
        now: "2026-07-18T00:00:10.000Z",
      });
      await fixture.journal.append(fixture.session.id, [
        {
          type: "inference.started",
          turnId,
          operationId: secondInference,
          payload: inferencePayload(fixture.session, turnId, 1, secondDigest),
        },
        {
          type: "assistant.completed",
          turnId,
          operationId: secondInference,
          payload: {
            message: { role: "assistant", content },
            finishReason: "stop",
            responseDigest,
            receipt: receipt as unknown as JsonValue,
          },
        },
        { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
      ]);
      return auditFixture(fixture);
    };

    const pending = await build(false);
    expect(pending.status).toBe("verified");
    expect(pending.findings).toEqual([]);

    // The relaxation is a window, not a hole: once the call is decided and
    // terminal, a usage claiming its ID is still an orphan.
    const afterTerminal = await build(true);
    expect(afterTerminal.status).toBe("invalid");
    expect(afterTerminal.findings.map((finding) => finding.code)).toContain("INFERENCE_USAGE_ORPHANED");
  });

  it("verifies completed, denied, and failed local commands without admitting them to provider context", async () => {
    const fixture = await createFixture([writeTool]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "local.command.requested",
        turnId: "local-complete",
        operationId: "local-operation-complete",
        payload: {
          content: "/write report.md verified",
          toolName: "write_file",
          arguments: { path: "report.md", content: "verified" },
        },
      },
      {
        type: "local.command.approved",
        turnId: "local-complete",
        operationId: "local-operation-complete",
        payload: { toolName: "write_file", approval: HUMAN_APPROVAL },
      },
      {
        type: "local.command.completed",
        turnId: "local-complete",
        operationId: "local-operation-complete",
        payload: {
          content: "Wrote report.md",
          toolName: "write_file",
          isError: false,
          metadata: { path: "report.md" },
        },
      },
      {
        type: "local.command.requested",
        turnId: "local-denied",
        operationId: "local-operation-denied",
        payload: {
          content: "/write protected.md blocked",
          toolName: "write_file",
          arguments: { path: "protected.md", content: "blocked" },
        },
      },
      {
        type: "local.command.denied",
        turnId: "local-denied",
        operationId: "local-operation-denied",
        payload: { content: "Permission denied locally.", toolName: "write_file" },
      },
      {
        type: "local.command.requested",
        turnId: "local-failed",
        operationId: "local-operation-failed",
        payload: {
          content: "/write failed.md unavailable",
          toolName: "write_file",
          arguments: { path: "failed.md", content: "unavailable" },
        },
      },
      {
        type: "local.command.approved",
        turnId: "local-failed",
        operationId: "local-operation-failed",
        payload: { toolName: "write_file", approval: HUMAN_APPROVAL },
      },
      {
        type: "local.command.failed",
        turnId: "local-failed",
        operationId: "local-operation-failed",
        payload: { content: "The local write failed safely.", toolName: "write_file", cancelled: false },
      },
    ]);

    const turnId = "turn-after-local-commands";
    const operationId = "inference-after-local-commands";
    const user: CanonicalMessage = { role: "user", content: "Summarize only this provider turn." };
    await fixture.journal.append(fixture.session.id, [
      { type: "turn.requested", turnId, payload: { content: user.content } },
    ]);
    // Local-command request/result text is intentionally absent from this canonical provider transcript.
    const requestDigest = await inferenceDigest(fixture.session, turnId, 0, [user]);
    await fixture.journal.append(fixture.session.id, [{
      type: "inference.started",
      turnId,
      operationId,
      payload: inferencePayload(fixture.session, turnId, 0, requestDigest),
    }]);
    const content = "This provider turn is isolated from local slash commands.";
    const responseDigest = await sha256(content);
    const receipt = createLocalReceipt({
      sessionId: fixture.session.id,
      turnId,
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest,
      responseDigest,
      now: "2026-07-18T00:00:20.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "assistant.completed",
        turnId,
        operationId,
        payload: {
          message: { role: "assistant", content },
          finishReason: "stop",
          responseDigest,
          receipt: receipt as unknown as JsonValue,
        },
      },
      { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.counts).toMatchObject({
      turns: 1,
      completedTurns: 1,
      localCommands: 3,
      terminalLocalCommands: 3,
      unknownEvents: 0,
    });
    expect(report.findings).toEqual([]);
  });

  /*
   * Provenance is the whole answer to "who let this run". It was journaled from
   * the day approval modes shipped and read by nobody: a `tool.approved`
   * carrying `approval: null` audited clean, and so did one claiming Full Access
   * authority inside a session pinned to ask-first. A field no side of the
   * contract validates is decoration that looks like evidence.
   */
  it("refuses a tool approval that does not name the authority that allowed it", async () => {
    const report = await auditFixture(await approvalFixture(null));

    expect(report.status).toBe("invalid");
    expect(report.checks.protocol).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain("TOOL_APPROVAL_PROVENANCE_INVALID");
  });

  it("refuses a tool approval claiming an approval mode the manifest never pinned", async () => {
    const report = await auditFixture(await approvalFixture(
      { mode: "full-access", source: "bounded-browser-sandbox", reason: "Allowed by Full Access." },
      await askFirstProfile(),
    ));

    expect(report.status).toBe("invalid");
    expect(report.findings.map((finding) => finding.code)).toContain("TOOL_APPROVAL_PROVENANCE_INVALID");
  });

  it("accepts a tool approval whose provenance matches the pinned approval mode", async () => {
    const report = await auditFixture(await approvalFixture(HUMAN_APPROVAL, await askFirstProfile()));

    expect(report.findings.map((finding) => finding.code)).not.toContain("TOOL_APPROVAL_PROVENANCE_INVALID");
  });

  /*
   * Naming a conversation is a second provider request, issued beside the turn
   * and previously against an invented session id, so its receipt proved
   * nothing about the conversation it named and its tokens were unrecordable.
   */
  it("binds the conversation-naming inference, its receipt and its cost to the session it named", async () => {
    const fixture = await createFixture([writeTool]);
    const namingTurnId = "naming-1";
    const namingOperationId = "naming-request-1";
    const receipt = createLocalReceipt({
      sessionId: fixture.session.id,
      turnId: namingTurnId,
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest: await sha256("naming-request"),
      responseDigest: await sha256("Workspace boundaries"),
      now: "2026-07-18T00:00:04.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "conversation.named",
        turnId: namingTurnId,
        operationId: namingOperationId,
        payload: {
          title: "Workspace boundaries",
          answer: "Workspace boundaries",
          model: fixture.session.manifest.model,
          receipt: receipt as unknown as JsonValue,
        },
      },
      {
        type: "inference.usage",
        turnId: namingTurnId,
        operationId: namingOperationId,
        payload: { inputTokens: 96, outputTokens: 4, source: "conversation-naming" },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.findings).toEqual([]);
  });

  it("refuses a naming receipt bound to another session, and usage naming no declared inference", async () => {
    const fixture = await createFixture([writeTool]);
    const strayReceipt = createLocalReceipt({
      sessionId: "some-other-session",
      turnId: "naming-2",
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest: await sha256("naming-request"),
      responseDigest: await sha256("Elsewhere"),
      now: "2026-07-18T00:00:05.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "conversation.named",
        turnId: "naming-2",
        operationId: "naming-request-2",
        payload: { title: "Elsewhere", model: fixture.session.manifest.model, receipt: strayReceipt as unknown as JsonValue },
      },
      {
        type: "inference.usage",
        turnId: "naming-3",
        operationId: "naming-request-3",
        payload: { inputTokens: 1 },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain("CONVERSATION_NAMING_INVALID");
    expect(codes).toContain("INFERENCE_USAGE_ORPHANED");
  });

  /*
   * A naming request that came back with a refusal or an essay was still made,
   * still billed and still attested; only the rename is skipped. Requiring a
   * title here would have meant the one audit-clean option was to journal
   * nothing — which is the unaudited paid request this record exists to end.
   * The title is the outcome; the verbatim answer is the evidence.
   */
  it("accepts a naming record whose answer yielded no title, and still refuses one that states neither", async () => {
    const fixture = await createFixture([writeTool]);
    const refusal = "I'm sorry, but I can't help with naming this conversation.";
    const receipt = createLocalReceipt({
      sessionId: fixture.session.id,
      turnId: "naming-4",
      provider: fixture.session.manifest.providerId,
      model: fixture.session.manifest.model,
      requestDigest: await sha256("naming-request"),
      responseDigest: await sha256(refusal),
      now: "2026-07-18T00:00:06.000Z",
    });
    await fixture.journal.append(fixture.session.id, [
      {
        type: "conversation.named",
        turnId: "naming-4",
        operationId: "naming-request-4",
        payload: {
          answer: refusal,
          model: fixture.session.manifest.model,
          receipt: receipt as unknown as JsonValue,
        },
      },
      {
        type: "inference.usage",
        turnId: "naming-4",
        operationId: "naming-request-4",
        payload: { inputTokens: 88, outputTokens: 14, source: "conversation-naming" },
      },
    ]);

    expect((await auditFixture(fixture)).status).toBe("verified");

    // Absent is allowed; empty and malformed are not. A record that names
    // neither a title nor the answer it was rejected from is a charge with no
    // content at all, and a 4 KiB "title" must not be excused by an answer.
    const empty = await createFixture([writeTool]);
    await empty.journal.append(empty.session.id, [
      {
        type: "conversation.named",
        turnId: "naming-5",
        operationId: "naming-request-5",
        payload: { model: empty.session.manifest.model },
      },
      {
        type: "conversation.named",
        turnId: "naming-6",
        operationId: "naming-request-6",
        payload: { title: "x".repeat(400), answer: refusal, model: empty.session.manifest.model },
      },
    ]);
    const emptyReport = await auditFixture(empty);
    expect(emptyReport.status).toBe("invalid");
    expect(
      emptyReport.findings.filter((finding) => finding.code === "CONVERSATION_NAMING_INVALID"),
    ).toHaveLength(2);
  });

  /*
   * The interface's own effects — a stage or commit, a repository import, a
   * vault probe that writes immutable objects — were adjudicated and then
   * forgotten. They are not turn events and never become them, so they are
   * evidence in their own right or they are nothing.
   */
  it("records a human-initiated decision as complete evidence, outside the turn protocol", async () => {
    const fixture = await createFixture([writeTool], await askFirstProfile());
    await fixture.journal.append(fixture.session.id, [{
      type: "human.intent.reviewed",
      turnId: "human-git-1",
      operationId: "git-1",
      payload: {
        toolName: "git_commit",
        effect: "write",
        decision: "allow",
        summary: "Commit staged changes in the browser-owned repository.",
        arguments: { message: "Ship it" },
        approval: HUMAN_APPROVAL,
      },
    }]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.findings).toEqual([]);
    // The measured failure this closes: an export taken immediately after two
    // approved, write-effect Git operations reported `"toolOperations": 0`
    // beside `"complete": true`, because no field in `counts` had a place for
    // an effect a person authorised themselves.
    expect(report.counts.humanIntentDecisions).toBe(1);
    expect(report.counts.humanIntentAllowed).toBe(1);
  });

  it("counts a denial as evidence and separates it from what was permitted", async () => {
    const fixture = await createFixture([writeTool], await askFirstProfile());
    await fixture.journal.append(fixture.session.id, [{
      type: "human.intent.reviewed",
      turnId: "human-git-2",
      operationId: "git-2",
      payload: {
        toolName: "git_stage",
        effect: "write",
        decision: "deny",
        summary: "Stage 1 path(s).",
        arguments: { paths: ["README.md"] },
        approval: HUMAN_APPROVAL,
      },
    }]);

    const report = await auditFixture(fixture);
    expect(report.counts.humanIntentDecisions).toBe(1);
    expect(report.counts.humanIntentAllowed).toBe(0);
  });

  it("refuses a human-initiated decision that names no authority or no outcome", async () => {
    const fixture = await createFixture([writeTool], await askFirstProfile());
    await fixture.journal.append(fixture.session.id, [
      {
        type: "human.intent.reviewed",
        turnId: "human-vault-1",
        operationId: "vault-probe-1",
        payload: { toolName: "vault_live_conformance", effect: "network", decision: "allow", approval: null },
      },
      {
        type: "human.intent.reviewed",
        turnId: "human-vault-2",
        operationId: "vault-probe-2",
        payload: { toolName: "vault_live_conformance", effect: "network", approval: HUMAN_APPROVAL },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain("HUMAN_INTENT_PROVENANCE_INVALID");
    expect(codes).toContain("HUMAN_INTENT_INVALID");
  });

  it("refuses a local-command approval that does not name its authority", async () => {
    const fixture = await createFixture([writeTool]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "local.command.requested",
        turnId: "local-unprovenanced",
        operationId: "local-operation-unprovenanced",
        payload: {
          content: "/write report.md verified",
          toolName: "write_file",
          arguments: { path: "report.md", content: "verified" },
        },
      },
      {
        type: "local.command.approved",
        turnId: "local-unprovenanced",
        operationId: "local-operation-unprovenanced",
        payload: { toolName: "write_file", approval: null },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.findings.map((finding) => finding.code)).toContain("TOOL_APPROVAL_PROVENANCE_INVALID");
  });

  it("rejects out-of-order and malformed local-command terminals", async () => {
    const fixture = await createFixture([writeTool]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "local.command.requested",
        turnId: "local-unapproved",
        operationId: "local-operation-unapproved",
        payload: {
          content: "/write report.md unexpected",
          toolName: "write_file",
          arguments: { path: "report.md", content: "unexpected" },
        },
      },
      {
        type: "local.command.completed",
        turnId: "local-unapproved",
        operationId: "local-operation-unapproved",
        payload: { content: "unexpected", toolName: "write_file", isError: false },
      },
      {
        type: "local.command.requested",
        turnId: "local-malformed-failure",
        operationId: "local-operation-malformed-failure",
        payload: {
          content: "/write failed.md unavailable",
          toolName: "write_file",
          arguments: { path: "failed.md", content: "unavailable" },
        },
      },
      {
        type: "local.command.failed",
        turnId: "local-malformed-failure",
        operationId: "local-operation-malformed-failure",
        payload: { content: "failed", toolName: "write_file", cancelled: "not-a-boolean" },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    expect(report.checks.protocol).toBe(false);
    expect(report.counts).toMatchObject({ localCommands: 2, terminalLocalCommands: 0 });
    expect(report.findings.filter((finding) => finding.code === "LOCAL_COMMAND_TERMINAL_INVALID")).toHaveLength(2);
  });

  it("rejects changed local-command identity and leaves the original operation unterminated", async () => {
    const fixture = await createFixture([writeTool]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "local.command.requested",
        turnId: "local-pinned",
        operationId: "local-operation-pinned",
        payload: {
          content: "/write report.md verified",
          toolName: "write_file",
          arguments: { path: "report.md", content: "verified" },
        },
      },
      {
        type: "local.command.failed",
        turnId: "local-pinned",
        operationId: "local-operation-substituted",
        payload: { content: "failed", toolName: "write_file", cancelled: false },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    expect(report.checks.complete).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOCAL_COMMAND_EVENT_ORPHANED", operationId: "local-operation-substituted" }),
      expect.objectContaining({ code: "LOCAL_COMMAND_INCOMPLETE", operationId: "local-operation-pinned" }),
    ]));
  });

  it("rejects reuse of local-command turn and operation identities", async () => {
    const fixture = await createFixture([writeTool]);
    await fixture.journal.append(fixture.session.id, [
      {
        type: "local.command.requested",
        turnId: "local-used-turn",
        operationId: "local-used-operation",
        payload: {
          content: "/write report.md verified",
          toolName: "write_file",
          arguments: { path: "report.md", content: "verified" },
        },
      },
      {
        type: "local.command.denied",
        turnId: "local-used-turn",
        operationId: "local-used-operation",
        payload: { content: "Denied.", toolName: "write_file" },
      },
      {
        type: "local.command.requested",
        turnId: "local-used-turn",
        operationId: "local-new-operation",
        payload: {
          content: "/write second.md second",
          toolName: "write_file",
          arguments: { path: "second.md", content: "second" },
        },
      },
      {
        type: "local.command.requested",
        turnId: "local-new-turn",
        operationId: "local-used-operation",
        payload: {
          content: "/write third.md third",
          toolName: "write_file",
          arguments: { path: "third.md", content: "third" },
        },
      },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    expect(report.counts).toMatchObject({ localCommands: 1, terminalLocalCommands: 1 });
    expect(report.findings.filter((finding) => finding.code === "LOCAL_COMMAND_REQUEST_INVALID")).toHaveLength(2);
  });

  it("hard-fails overlapping and abandoned local commands while preserving ordinary turn rules", async () => {
    const overlap = await createFixture([writeTool]);
    await overlap.journal.append(overlap.session.id, [
      { type: "turn.requested", turnId: "provider-active", payload: { content: "Start a provider turn." } },
      {
        type: "local.command.requested",
        turnId: "local-overlap",
        operationId: "local-operation-overlap",
        payload: {
          content: "/write report.md verified",
          toolName: "write_file",
          arguments: { path: "report.md", content: "verified" },
        },
      },
    ]);
    const overlapReport = await auditFixture(overlap);
    expect(overlapReport.status).toBe("invalid");
    expect(overlapReport.findings.map((finding) => finding.code)).toContain("LOCAL_COMMAND_OVERLAP");

    const abandoned = await createFixture([writeTool]);
    await abandoned.journal.append(abandoned.session.id, [{
      type: "local.command.requested",
      turnId: "local-abandoned",
      operationId: "local-operation-abandoned",
      payload: {
        content: "/write report.md verified",
        toolName: "write_file",
        arguments: { path: "report.md", content: "verified" },
      },
    }]);
    const abandonedReport = await auditFixture(abandoned);
    expect(abandonedReport.status).toBe("invalid");
    expect(abandonedReport.checks.complete).toBe(false);
    expect(abandonedReport.counts).toMatchObject({ localCommands: 1, terminalLocalCommands: 0 });
    expect(abandonedReport.findings).toContainEqual(expect.objectContaining({
      code: "LOCAL_COMMAND_INCOMPLETE",
      severity: "error",
      turnId: "local-abandoned",
      operationId: "local-operation-abandoned",
    }));
  });

  it("separates hash-chain tampering from manifest and protocol checks", async () => {
    const fixture = await createFixture([]);
    await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId: "turn-tamper", payload: { content: "original" } }]);
    const session = (await fixture.journal.getSession(fixture.session.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const tampered = structuredClone(events);
    (tampered[1]!.payload as { content: string }).content = "changed after commit";

    const report = await auditSessionHistory({ session, events: tampered });
    expect(report.status).toBe("invalid");
    expect(report.checks.chain).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain("EVENT_DIGEST_MISMATCH");
  });

  it("reports a crash prefix as incomplete without calling an intact chain corrupt", async () => {
    const fixture = await createFixture([]);
    const turnId = "turn-crash";
    const messages: CanonicalMessage[] = [{ role: "user", content: "Begin work." }];
    await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: "Begin work." } }]);
    const requestDigest = await inferenceDigest(fixture.session, turnId, 0, messages);
    await fixture.journal.append(fixture.session.id, [{
      type: "inference.started",
      turnId,
      operationId: "inference-crashed",
      payload: inferencePayload(fixture.session, turnId, 0, requestDigest),
    }]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("incomplete");
    expect(report.checks.chain).toBe(true);
    expect(report.checks.protocol).toBe(true);
    expect(report.checks.complete).toBe(false);
    expect(report.findings).toEqual([expect.objectContaining({ code: "TURN_INCOMPLETE", severity: "warning" })]);
  });

  it("rejects a cryptographically intact tool result that has no approval", async () => {
    const fixture = await createFixture([writeTool]);
    const turnId = "turn-unapproved";
    const call: ToolCall = { id: "call-unapproved", name: "write_file", arguments: { path: "/workspace/a", content: "x" } };
    const user: CanonicalMessage = { role: "user", content: "Write it." };
    await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: user.content } }]);
    const digest = await inferenceDigest(fixture.session, turnId, 0, [user]);
    await fixture.journal.append(fixture.session.id, [
      { type: "inference.started", turnId, operationId: "inference-unapproved", payload: inferencePayload(fixture.session, turnId, 0, digest) },
      { type: "assistant.completed", turnId, operationId: "inference-unapproved", payload: { message: { role: "assistant", content: "", toolCalls: [call] }, finishReason: "tool-calls" } },
      { type: "tool.requested", turnId, operationId: call.id, payload: { call } },
      { type: "tool.resulted", turnId, operationId: call.id, payload: { callId: call.id, name: call.name, content: "done", isError: false, metadata: null } },
    ]);

    const report = await auditFixture(fixture);
    expect(report.status).toBe("invalid");
    expect(report.checks.chain).toBe(true);
    expect(report.checks.protocol).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain("TOOL_TERMINAL_INVALID");
  });

  it("fails a separately anchored export when the trusted head differs", async () => {
    const fixture = await createFixture([]);
    const session = (await fixture.journal.getSession(fixture.session.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const report = await auditSessionHistory(
      { session, events },
      { trustedHead: { sequence: session.headSequence, digest: `sha256:${"A".repeat(43)}`, source: "transparency log" } },
    );

    expect(report.status).toBe("invalid");
    expect(report.anchor.status).toBe("mismatched");
    expect(report.findings.map((finding) => finding.code)).toContain("TRUSTED_HEAD_MISMATCH");
  });

  it("checks the immutable profile skill-set binding without claiming to reconstruct external profile catalogs", async () => {
    const resolvedSkills = [{ skillId: "research", digest: await sha256("research-v1"), promptOrder: -10 }];
    const fixture = await createFixture([], {
      version: 1,
      profileId: "investigator",
      profileRevision: await sha256("profile-v1"),
      themeId: "foundry",
      themeDigest: await sha256("theme-v1"),
      resolvedSkills,
      skillSetDigest: await sha256(stableStringify(resolvedSkills as unknown as JsonValue)),
      resolutionDigest: await sha256("resolution-v1"),
    });

    const report = await auditFixture(fixture);
    expect(report.status).toBe("verified");
    expect(report.checks.manifest).toBe(true);

    const session = (await fixture.journal.getSession(fixture.session.id))!;
    session.manifest.profile!.skillSetDigest = await sha256("different-set");
    const events = await fixture.journal.readEvents(session.id);
    const tampered = await auditSessionHistory({ session, events });
    expect(tampered.status).toBe("invalid");
    expect(tampered.findings.map((finding) => finding.code)).toContain("SKILL_SET_DIGEST_MISMATCH");
  });

  it("requires every v2 profile-silo field while preserving valid v1 historical pins", async () => {
    const resolvedSkills: never[] = [];
    const fixture = await createFixture([], {
      version: 2,
      profileId: "general",
      profileRevision: await sha256("profile-v2"),
      themeId: "foundry",
      themeDigest: await sha256("theme-v2"),
      resolvedSkills,
      skillSetDigest: await sha256(stableStringify(resolvedSkills as unknown as JsonValue)),
      resolutionDigest: await sha256("resolution-v2"),
      workspaceBinding: { kind: "active-workspace" },
      memoryScope: "profile",
      approvalMode: "ask-first",
      minimumPosture: "encrypted-unattested",
    });

    expect((await auditFixture(fixture)).status).toBe("verified");
    const session = (await fixture.journal.getSession(fixture.session.id))!;
    const malformed: Record<string, unknown> = { ...session.manifest.profile! };
    delete malformed.approvalMode;
    session.manifest.profile = malformed as typeof session.manifest.profile;
    const report = await auditSessionHistory({ session, events: await fixture.journal.readEvents(session.id) });
    expect(report.findings.map((finding) => finding.code)).toContain("PROFILE_SILO_INVALID");
  });
});

async function createFixture(tools: ToolDefinition[], profile?: SessionRecord["manifest"]["profile"]) {
  let tick = 0;
  let id = 0;
  const now = () => `2026-07-18T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  const backend = new MemoryJournalBackend();
  const journal = new EventJournal(backend, now, () => `event-${++id}`);
  const manifest = await createSessionManifest({
    systemPrompt: "Be exact and preserve evidence.",
    providerId: "demo",
    model: "airship/test-model",
    tools,
    workspaceId: "memory://audit-test",
    capabilityTier: "web-baseline",
    profile,
    now: "2026-07-18T00:00:00.000Z",
  });
  const session = await journal.createSession("Audit fixture", manifest);
  return { journal, session };
}

/** A turn stopped at `tool.approved`, so the approval's provenance is the subject under audit. */
async function approvalFixture(approval: JsonValue, profile?: SessionRecord["manifest"]["profile"]) {
  const fixture = await createFixture([writeTool], profile);
  const turnId = "turn-approval";
  const operationId = "inference-approval";
  const call: ToolCall = {
    id: "call-approval",
    name: "write_file",
    arguments: { path: "/workspace/report.md", content: "verified" },
  };
  const user: CanonicalMessage = { role: "user", content: "Create a report." };
  await fixture.journal.append(fixture.session.id, [{ type: "turn.requested", turnId, payload: { content: user.content } }]);
  const digest = await inferenceDigest(fixture.session, turnId, 0, [user]);
  await fixture.journal.append(fixture.session.id, [
    { type: "inference.started", turnId, operationId, payload: inferencePayload(fixture.session, turnId, 0, digest) },
    {
      type: "assistant.completed",
      turnId,
      operationId,
      payload: { message: { role: "assistant", content: "", toolCalls: [call] }, finishReason: "tool-calls" },
    },
    { type: "tool.requested", turnId, operationId: call.id, payload: { call } },
    { type: "tool.approved", turnId, operationId: call.id, payload: { callId: call.id, name: call.name, approval } },
  ]);
  return fixture;
}

async function askFirstProfile(): Promise<SessionRecord["manifest"]["profile"]> {
  const resolvedSkills: never[] = [];
  return {
    version: 2,
    profileId: "general",
    profileRevision: await sha256("profile-v2"),
    themeId: "foundry",
    themeDigest: await sha256("theme-v2"),
    resolvedSkills,
    skillSetDigest: await sha256(stableStringify(resolvedSkills as unknown as JsonValue)),
    resolutionDigest: await sha256("resolution-v2"),
    workspaceBinding: { kind: "active-workspace" },
    memoryScope: "profile",
    approvalMode: "ask-first",
    minimumPosture: "encrypted-unattested",
  };
}

async function auditFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const session = (await fixture.journal.getSession(fixture.session.id))!;
  const events = await fixture.journal.readEvents(session.id);
  return auditSessionHistory({ session, events }, { checkedAt: "2026-07-18T00:01:00.000Z" });
}

async function appendCompletedTurn(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  turnId: string,
  requestContent: string,
  priorMessages: readonly CanonicalMessage[],
): Promise<void> {
  const request: CanonicalMessage = { role: "user", content: requestContent };
  await fixture.journal.append(fixture.session.id, [
    { type: "turn.requested", turnId, payload: { content: requestContent } },
  ]);
  const requestDigest = await inferenceDigest(
    fixture.session,
    turnId,
    0,
    [...priorMessages, request],
  );
  const operationId = `${turnId}-inference`;
  const response = `Completed ${turnId}.`;
  const responseDigest = await sha256(response);
  const receipt = createLocalReceipt({
    sessionId: fixture.session.id,
    turnId,
    provider: fixture.session.manifest.providerId,
    model: fixture.session.manifest.model,
    requestDigest,
    responseDigest,
    now: "2026-07-18T00:00:40.000Z",
  });
  await fixture.journal.append(fixture.session.id, [
    {
      type: "inference.started",
      turnId,
      operationId,
      payload: inferencePayload(fixture.session, turnId, 0, requestDigest),
    },
    {
      type: "assistant.completed",
      turnId,
      operationId,
      payload: {
        message: { role: "assistant", content: response },
        finishReason: "stop",
        responseDigest,
        receipt: receipt as unknown as JsonValue,
      },
    },
    { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
  ]);
}

async function inferenceDigest(
  session: SessionRecord,
  turnId: string,
  step: number,
  messages: CanonicalMessage[],
): Promise<string> {
  return sha256(stableStringify({
    model: session.manifest.model,
    systemPromptDigest: session.manifest.systemPromptDigest,
    messages,
    tools: session.manifest.tools,
    idempotencyKey: `${session.id}:${turnId}:${step}`,
  } as unknown as JsonValue));
}

function inferencePayload(session: SessionRecord, turnId: string, step: number, requestDigest: string): JsonValue {
  return {
    step,
    providerId: session.manifest.providerId,
    model: session.manifest.model,
    posture: "local",
    requestDigest,
    idempotencyKey: `${session.id}:${turnId}:${step}`,
  };
}
