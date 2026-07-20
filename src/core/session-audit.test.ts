import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import type { CanonicalMessage, JsonValue, ToolCall, ToolDefinition } from "./contracts";
import { sha256, stableStringify } from "./hash";
import { EventJournal, type DurableEvent, type SessionRecord } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { createLocalReceipt } from "../receipts/types";
import { auditSessionHistory } from "./session-audit";

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
      { type: "tool.approved", turnId, operationId: call.id, payload: { callId: call.id, name: call.name } },
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
        payload: { toolName: "write_file" },
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
        payload: { toolName: "write_file" },
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

async function auditFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const session = (await fixture.journal.getSession(fixture.session.id))!;
  const events = await fixture.journal.readEvents(session.id);
  return auditSessionHistory({ session, events }, { checkedAt: "2026-07-18T00:01:00.000Z" });
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
