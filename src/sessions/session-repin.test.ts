import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import type { CanonicalMessage, JsonValue } from "../core/contracts";
import { createLocalReceipt } from "../core/conversation-receipt";
import { sha256, stableStringify } from "../core/hash";
import { EventJournal, type SessionRecord } from "../core/journal";
import { journalRePinsToRoute } from "../core/session-repin-record";
import { MemoryJournalBackend } from "../core/memory-journal";
import { auditSessionHistory } from "../core/session-audit";
import { sessionAuditRefusesResume } from "../core/session-audit-admission";
import { assessSessionHistoryAsync } from "./async-assessment";
import { decideSessionResume, extractSessionPins, type ActiveSessionRuntime } from "./domain";
import { SessionLibrary } from "./library";
import { forkRequirement } from "../ui/sessions-presentation";
import {
  SESSION_RE_PINNED_DIFFERENCES,
  SESSION_RE_PINNED_EVENT_TYPE,
  journalSessionRePin,
} from "./session-repin";

/*
 * The complaint, verbatim:
 *
 *   "resume blocked should NEVER be a problem! this is ridiculous! I can see
 *    the thread but I can't click on it? we should never have to Fork to
 *    continue ever!"
 *
 * The environment it was said in, reproduced here exactly: Ephemeral storage,
 * LM Studio on 127.0.0.1:1234, a model id LM Studio spells with `@` because
 * two quantizations of it are held, fourteen events, two turns, the last one
 * completed, fourteen of fourteen inspected.
 *
 * Driven in a browser at the base commit, this journal audits clean — and the
 * conversation was still offered exactly one enabled verb, `Fork to continue`,
 * the moment the page held a different inference connection than the one the
 * thread was born on. Nothing about the record had changed. A fork does not
 * put the old connection back either; it only leaves the transcript behind.
 */
const MODEL = "qwen3.8-27b-obliterated@q6_k";
const WORKSPACE = "memory://airship-page::airship-profile=general";

/** The exact shape the shell pins for a loopback LM Studio connection. */
function lmStudioBinding(generation: number) {
  return {
    version: 2 as const,
    connectionId: "lm-studio-local",
    connectionGeneration: generation,
    providerId: "lm-studio",
    providerLabel: "LM Studio",
    providerRevision: 1,
    authMethod: "local-none" as const,
    transportBoundary: "loopback-local" as const,
    transportId: "lm-studio-openai-local-v1",
    protocol: "openai-compatible" as const,
    modelId: MODEL,
    boundAt: "2026-08-21T00:00:00.000Z",
  };
}

function runtimeFor(session: SessionRecord, generation: number): ActiveSessionRuntime {
  return Object.freeze({
    providerId: "lm-studio",
    model: MODEL,
    inferenceBinding: lmStudioBinding(generation),
    posture: "local" as const,
    toolManifestDigest: session.manifest.toolManifestDigest,
    workspaceId: WORKSPACE,
  });
}

async function fourteenEventJournal() {
  let tick = 0;
  let id = 0;
  const now = () => `2026-08-21T21:00:${String(tick++).padStart(2, "0")}.000Z`;
  const journal = new EventJournal(new MemoryJournalBackend(), now, () => `event-${++id}`);
  const manifest = await createSessionManifest({
    systemPrompt: "Be exact and preserve evidence.",
    providerId: "lm-studio",
    model: MODEL,
    inferenceBinding: lmStudioBinding(1),
    tools: [],
    workspaceId: WORKSPACE,
    capabilityTier: "web-baseline",
    now: "2026-08-21T21:00:00.000Z",
  });
  const created = await journal.createSession("First question.", manifest);
  const history: CanonicalMessage[] = [];
  for (const [index, prompt] of ["First question.", "Second question."].entries()) {
    await appendCompletedTurn(journal, created.id, manifest, `turn-${index}`, prompt, history);
    history.push({ role: "user", content: prompt }, { role: "assistant", content: `Answer ${index}.` });
  }
  // The bookkeeping a real thread accumulates: a rename, and a star turned on
  // and off again. Fourteen events, two turns, the last one completed.
  await journal.renameSession(created.id, "First question.");
  await journal.append(created.id, [{ type: "session.favorite.changed", payload: { favorite: true } }]);
  await journal.append(created.id, [{ type: "session.favorite.changed", payload: { favorite: false } }]);
  const session = (await journal.getSession(created.id))!;
  return { journal, session, events: await journal.readEvents(session.id) };
}

async function appendCompletedTurn(
  journal: EventJournal,
  sessionId: string,
  manifest: SessionRecord["manifest"],
  turnId: string,
  content: string,
  priorMessages: readonly CanonicalMessage[],
): Promise<void> {
  await journal.append(sessionId, [{ type: "turn.requested", turnId, payload: { content } }]);
  const idempotencyKey = `${sessionId}:${turnId}:0`;
  const requestDigest = await sha256(stableStringify({
    model: manifest.model,
    systemPromptDigest: manifest.systemPromptDigest,
    messages: [...priorMessages, { role: "user", content }],
    tools: manifest.tools,
    idempotencyKey,
  } as unknown as JsonValue));
  const answer = `Answer ${turnId.slice(-1)}.`;
  const responseDigest = await sha256(answer);
  const receipt = createLocalReceipt({
    sessionId,
    turnId,
    provider: "lm-studio",
    model: MODEL,
    requestDigest,
    responseDigest,
    now: "2026-08-21T21:00:30.000Z",
  });
  await journal.append(sessionId, [
    {
      type: "inference.started",
      turnId,
      operationId: `${turnId}-inference`,
      payload: { step: 0, providerId: "lm-studio", model: MODEL, posture: "local", requestDigest, idempotencyKey },
    },
    {
      type: "inference.usage",
      turnId,
      operationId: `${turnId}-inference`,
      payload: { inputTokens: 120, outputTokens: 45 },
    },
    {
      type: "assistant.completed",
      turnId,
      operationId: `${turnId}-inference`,
      payload: {
        message: { role: "assistant", content: answer },
        finishReason: "stop",
        responseDigest,
        receipt: receipt as unknown as JsonValue,
      },
    },
    { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
  ]);
}

describe("the conversation a person could see but could not click", () => {
  it("audits clean at fourteen of fourteen events with its last turn completed", async () => {
    const { session, events } = await fourteenEventJournal();
    expect(events).toHaveLength(14);
    const assessment = await assessSessionHistoryAsync(session, events);
    expect(assessment.checkedEvents).toBe(14);
    expect(assessment.totalEvents).toBe(14);
    expect(assessment.completedTurnCount).toBe(2);
    expect(assessment.issues).toEqual([]);
    expect(assessment.status).toBe("consistent");
    expect(assessment.label).toBe("Locally consistent");
  });

  /*
   * The measured defect, in one assertion: the page holds LM Studio on a later
   * connection generation — which is all that quitting the server and checking
   * it again produces — and the conversation is refused.
   */
  it("continues on the active connection instead of offering only a fork", async () => {
    const { session, events } = await fourteenEventJournal();
    const pins = extractSessionPins(session, events);
    const assessment = await assessSessionHistoryAsync(session, events);

    const reconnected = decideSessionResume(pins, assessment, runtimeFor(session, 2));
    expect(reconnected.action).toBe("resume");
    expect(reconnected.label).toBe("Ready to resume");
    // The difference is still reported, by name, in the same words as before.
    expect(reconnected.reasons.map((reason) => reason.code)).toContain("INFERENCE_CONNECTION_MISMATCH");
    // And one plain sentence, composed where the person reads it, says what
    // continuing will do about it.
    const summary = forkRequirement(reconnected).reasons[0];
    expect(summary?.code).toBe("RE_PINNED_ON_CONTINUE");
    expect(summary?.message).toBe(
      "Continuing re-pins the inference connection to what is active, and journals it. Fork keeps the old pin.",
    );
    // Nothing here refuses the record itself.
    expect(reconnected.reasons.some((reason) => reason.severity === "error")).toBe(false);
  });

  it("still refuses a record it could not append to, and still names the fork", async () => {
    const { session, events } = await fourteenEventJournal();
    const pins = extractSessionPins(session, events);
    const broken = [...events];
    broken[6] = { ...broken[6]!, previousDigest: `sha256:${"A".repeat(43)}` };
    const assessment = await assessSessionHistoryAsync(session, broken);

    expect(assessment.status).toBe("suspect");
    expect(assessment.label).toBe("Needs review");
    expect(decideSessionResume(pins, assessment, runtimeFor(session, 1)).action).toBe("blocked");
    const report = await auditSessionHistory({ session, events: broken });
    expect(sessionAuditRefusesResume(report)).toBe(true);
  });
});

describe("journalSessionRePin", () => {
  it("records one credential-free route, and the audit accepts it", async () => {
    const { journal, session, events } = await fourteenEventJournal();
    const detail = await new SessionLibrary(journal).inspect(session.id, runtimeFor(session, 2));
    expect(detail.compatibility?.action).toBe("resume");

    const written = await journalSessionRePin(journal, detail, {
      transport: { id: "lm-studio-openai-local-v1", posture: "local" },
      workspaceId: WORKSPACE,
      inferenceBinding: { providerId: "lm-studio" },
    });
    expect(written).toEqual(["INFERENCE_CONNECTION_MISMATCH"]);

    const after = await journal.readEvents(session.id);
    expect(after).toHaveLength(events.length + 1);
    const record = after.at(-1)!;
    expect(record.type).toBe(SESSION_RE_PINNED_EVENT_TYPE);
    expect(record.payload).toEqual({
      version: 1,
      providerId: "lm-studio",
      model: MODEL,
      posture: "local",
      toolManifestDigest: session.manifest.toolManifestDigest,
      workspaceId: WORKSPACE,
      differences: ["INFERENCE_CONNECTION_MISMATCH"],
    });
    // Nothing that could carry a secret, and nothing the audit refuses.
    expect(JSON.stringify(record.payload)).not.toMatch(/token|key|secret|Bearer|127\.0\.0\.1/iu);
    const stored = (await journal.getSession(session.id))!;
    const report = await auditSessionHistory({ session: stored, events: after });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("verified");
  });

  it("is idempotent for the same route, so navigation is not journal noise", async () => {
    const { journal, session } = await fourteenEventJournal();
    const authority = {
      transport: { id: "lm-studio-openai-local-v1", posture: "local" },
      workspaceId: WORKSPACE,
      inferenceBinding: { providerId: "lm-studio" },
    };
    const detail = await new SessionLibrary(journal).inspect(session.id, runtimeFor(session, 2));
    await journalSessionRePin(journal, detail, authority);
    const head = (await journal.getSession(session.id))!.headSequence;
    expect(await journalSessionRePin(journal, detail, authority)).toEqual([]);
    expect((await journal.getSession(session.id))!.headSequence).toBe(head);
  });

  it("writes nothing when nothing moved", async () => {
    const { journal, session } = await fourteenEventJournal();
    const detail = await new SessionLibrary(journal).inspect(session.id, runtimeFor(session, 1));
    expect(detail.compatibility?.action).toBe("resume");
    expect(await journalSessionRePin(journal, detail, {
      transport: { id: "lm-studio-openai-local-v1", posture: "local" },
      workspaceId: WORKSPACE,
      inferenceBinding: { providerId: "lm-studio" },
    })).toEqual([]);
    expect(await journal.readEvents(session.id)).toHaveLength(14);
  });

  /*
   * The list this module holds and the rule `decideSessionResume` applies are
   * two statements of one thing, so they are checked against each other rather
   * than transcribed. Every difference named here must stop requiring a fork,
   * and a difference that still requires one must not be named here.
   */
  it("names exactly the differences that stopped requiring a fork", async () => {
    const { session, events } = await fourteenEventJournal();
    const pins = extractSessionPins(session, events);
    const assessment = await assessSessionHistoryAsync(session, events);
    const base = runtimeFor(session, 1);
    const drifts: readonly ActiveSessionRuntime[] = [
      { ...base, providerId: "other-provider" },
      { ...base, model: "other/model" },
      { ...base, inferenceBinding: lmStudioBinding(2) },
      { ...base, toolManifestDigest: `sha256:${"B".repeat(43)}` },
      { ...base, workspaceId: "memory://elsewhere" },
      { ...base, posture: "plaintext-remote" },
    ];
    for (const runtime of drifts) {
      const decision = decideSessionResume(pins, assessment, runtime);
      const named = decision.reasons
        .filter((reason) => reason.severity === "warning")
        .map((reason) => reason.code);
      expect(named.length, JSON.stringify(named)).toBeGreaterThan(0);
      expect(named.every((code) => SESSION_RE_PINNED_DIFFERENCES.has(code))).toBe(true);
      expect(decision.action).toBe("resume");
    }
  });

  /*
   * A conversation that arrived in a bundle keeps the older rule, because its
   * pins were composed on another device and this one cannot vouch for them.
   */
  it("leaves an imported conversation on its existing rule", async () => {
    const { session, events } = await fourteenEventJournal();
    const imported: SessionRecord = { ...session, importedAt: "2026-08-21T20:00:00.000Z" };
    const pins = extractSessionPins(imported, events);
    const assessment = await assessSessionHistoryAsync(imported, events);
    const decision = decideSessionResume(pins, assessment, runtimeFor(session, 2));
    expect(decision.action).toBe("fork-required");
    expect(decision.reasons.map((reason) => reason.code)).toContain("ARRIVED_IN_A_BUNDLE");
    expect(forkRequirement(decision).reasons.map((reason) => reason.code)).not.toContain("RE_PINNED_ON_CONTINUE");
  });

  /* The turn admission reads the same record, so the two halves agree. */
  it("makes the journaled route admissible to a turn, and no other", async () => {
    const { journal, session } = await fourteenEventJournal();
    const detail = await new SessionLibrary(journal).inspect(session.id, runtimeFor(session, 2));
    await journalSessionRePin(journal, detail, {
      transport: { id: "lm-studio-openai-local-v1", posture: "local" },
      workspaceId: WORKSPACE,
      inferenceBinding: { providerId: "lm-studio" },
    });
    const after = await journal.readEvents(session.id);
    expect(journalRePinsToRoute(after, "lm-studio", "local")).toBe(true);
    expect(journalRePinsToRoute(after, "some-other-provider", "local")).toBe(false);
    expect(journalRePinsToRoute(after, "lm-studio", "plaintext-remote")).toBe(false);
  });
});
