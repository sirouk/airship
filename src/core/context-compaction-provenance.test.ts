import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages } from "./agent";
import type { JsonValue } from "./contracts";
import {
  canonicalContextSummary,
  createSessionContextPolicy,
  planContextCompression,
  type CanonicalContextSummary,
  type ContextSummarizer,
  type ContextSummaryOutput,
} from "./context-compressor";
import { INFERENCE_CONTEXT_SUMMARIZER_ID } from "./context-policy";
import { sha256, stableStringify } from "./hash";
import { EventJournal, type DurableEvent } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

const OPTIONS = {
  contextWindowTokens: 2_048,
  threshold: 0.8,
  preserveRecentTurns: 1,
  maxSummaryDeltaBytes: 12 * 1024,
} as const;

const PROVIDER_ID = "test-provider";
const MODEL = "test-model";

describe("compacted-tier provenance is held to the pinned policy", () => {
  it("accepts an honest tier and rejects one whose provenance names material this session never pinned", async () => {
    const prefix = await compactedPrefix(summarizerPortSummarizer());
    const honest = prefix.summary.compaction;
    expect(honest?.method).toBe("summarizer-port-v1");
    expect(honest?.provenance).toMatchObject({ providerId: PROVIDER_ID, model: MODEL });
    await expect(findings(prefix)).resolves.not.toContain("CONTEXT_SUMMARY_INVALID");

    // Every one of these keeps the tier internally consistent — the provenance
    // still commits to this exact body, and the whole commitment is resealed —
    // so nothing but a cross-check against the manifest and the pinned
    // summarizer policy can tell them from the honest tier above.
    const forgeries: readonly Readonly<Record<string, unknown>>[] = [
      { providerId: "other-provider" },
      { model: "other-model" },
      { posture: "plaintext-remote" },
    ];
    for (const field of forgeries) {
      const tampered = await compactedPrefix(summarizerPortSummarizer(), (compaction) => ({
        ...compaction,
        provenance: { ...(compaction.provenance as Record<string, unknown>), ...field },
      }));
      await expect(findings(tampered)).resolves.toContain("CONTEXT_SUMMARY_INVALID");
    }
  });

  it("rejects a tier body larger than the session's pinned summary budget", async () => {
    let oversizedBytes = 0;
    // Over the pinned budget but under the canonicalizer's 64 KiB hard ceiling,
    // which accepts both. Only the policy bound separates them, and the
    // oversized body would otherwise ride into every future prompt.
    const tampered = await compactedPrefix(summarizerPortSummarizer(), async (compaction) => {
      const body = `${compaction.body as string} ${"padding ".repeat(2_000)}`;
      oversizedBytes = new TextEncoder().encode(body).byteLength;
      const bodyDigest = await sha256(body);
      return {
        ...compaction,
        body,
        bodyDigest,
        provenance: { ...(compaction.provenance as Record<string, unknown>), responseDigest: bodyDigest },
      };
    });
    expect(oversizedBytes).toBeGreaterThan(OPTIONS.maxSummaryDeltaBytes);
    expect(oversizedBytes).toBeLessThan(64 * 1024);
    // Canonicalization accepts it, which is exactly why the policy bound has to
    // be the thing that refuses it.
    expect(canonicalContextSummary(tampered.summary)).toBeDefined();
    await expect(findings(tampered)).resolves.toContain("CONTEXT_SUMMARY_INVALID");
  });

  it("records why a tier fell back to extractive instead of committing it silently", async () => {
    // A summarizer that answers a compaction request with a bare string cannot
    // carry provenance, so its tier is refused. The commitment has to say that
    // happened; otherwise the degraded tier is indistinguishable from a session
    // that never configured a summarizer at all.
    for (const [failing, expected] of [
      [stringTierSummarizer(), "invalid-output"],
      [throwingTierSummarizer(), "adapter-error"],
    ] as const) {
      const prefix = await compactedPrefix(failing);
      const compaction = prefix.summary.compaction!;
      expect(compaction.method).toBe("extractive-fallback-v1");
      expect(compaction.provenance).toBeUndefined();
      expect(compaction.attempt).toEqual({
        summarizerId: INFERENCE_CONTEXT_SUMMARIZER_ID,
        outcome: "failed-fallback",
        failure: expected,
      });
      // A recorded fallback the policy permits is still a valid commitment.
      await expect(findings(prefix)).resolves.not.toContain("CONTEXT_SUMMARY_INVALID");

      // Stripping the record turns it back into an unexplained downgrade, which
      // replay must refuse rather than accept as an ordinary extractive tier.
      const stripped = await compactedPrefix(failing, ({ attempt, ...silent }) => {
        void attempt;
        return silent;
      });
      await expect(findings(stripped)).resolves.toContain("CONTEXT_SUMMARY_INVALID");
    }
  }, 30_000);
});

type CompactedPrefix = Readonly<{
  session: Awaited<ReturnType<EventJournal["createSession"]>>;
  events: readonly DurableEvent[];
  summary: CanonicalContextSummary;
}>;

async function findings(prefix: CompactedPrefix): Promise<string[]> {
  const audit = await auditSessionHistory({ session: prefix.session, events: prefix.events });
  return audit.findings.map((finding) => finding.code);
}

/**
 * Rewrite the compacted tier and re-seal the whole-commitment digest, so
 * `verifyContextSummary`'s outer checks all still pass and the policy
 * cross-check under test is the one that has to fire. The result is appended by
 * the journal itself, so the event digest chain stays sound too: a tamper the
 * journal would reject proves nothing about the summary rules.
 */
async function resealTier(
  summary: CanonicalContextSummary,
  compaction: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { summaryDigest, ...rest } = summary as unknown as Record<string, unknown>;
  void summaryDigest;
  const commitment = { ...rest, compaction };
  return { ...commitment, summaryDigest: await sha256(stableStringify(commitment as JsonValue)) };
}

/**
 * Drive real compressions until one commits a compacted tier, then return the
 * event prefix ending at that commitment. Truncating there keeps the assertion
 * about one tier: a later summary chained to a tampered one would fail its own
 * digest check and mask which rule actually fired.
 */
async function compactedPrefix(
  summarizer: ContextSummarizer,
  tamper?: (compaction: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<CompactedPrefix> {
  const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
  const manifest = await createSessionManifest({
    systemPrompt: "Compact.",
    providerId: PROVIDER_ID,
    model: MODEL,
    // Pinned so the posture half of the cross-check is live: an unpinned
    // manifest legitimately cannot refuse any posture.
    securityPosture: "local",
    tools: [],
    workspaceId: "memory://compaction-provenance",
    now: "2026-07-22T00:00:00.000Z",
    contextPolicy: createSessionContextPolicy({
      contextWindowTokens: OPTIONS.contextWindowTokens,
      source: { kind: "runtime-config", label: "compaction provenance fixture" },
      compression: {
        threshold: OPTIONS.threshold,
        preserveRecentTurns: OPTIONS.preserveRecentTurns,
        maxSummaryDeltaBytes: OPTIONS.maxSummaryDeltaBytes,
      },
      summarizer: {
        mode: "inference-transport",
        adapterId: INFERENCE_CONTEXT_SUMMARIZER_ID,
        onFailure: "extractive-fallback",
      },
    }),
  });
  const session = await journal.createSession("Compaction provenance", manifest);
  for (let round = 0; round < 12; round += 1) {
    for (let turn = 0; turn < 2; turn += 1) {
      const turnId = `round-${round}-turn-${turn}`;
      await journal.append(session.id, [
        { type: "turn.requested", turnId, payload: { content: `${turnId} ${"payload ".repeat(4_000)}` } },
        { type: "turn.completed", turnId, payload: { responseDigest: `response-${turnId}`, receiptId: null } },
      ]);
    }
    const events = await journal.readEvents(session.id);
    const summary = await planContextCompression({
      events,
      messages: materializeMessages(events, { injectLatestContext: false }),
      projectedUserContent: `round ${round} continues ${"payload ".repeat(4_000)}`,
      systemPrompt: manifest.systemPrompt,
      tools: [],
      options: OPTIONS,
      summarizer,
      summarizerFailure: "extractive-fallback",
    });
    if (!summary) continue;
    const payload = summary.compaction && tamper
      ? await resealTier(summary, await tamper({ ...summary.compaction }))
      : summary;
    await journal.append(session.id, [{ type: "context.summary.updated", payload: payload as never }]);
    if (summary.compaction) {
      const committed = canonicalContextSummary(payload);
      if (!committed) throw new Error("The committed tier no longer canonicalizes.");
      return Object.freeze({
        session: (await journal.getSession(session.id))!,
        events: Object.freeze(await journal.readEvents(session.id)),
        summary: committed,
      });
    }
  }
  throw new Error("The fixture never produced a compacted tier.");
}

/** Emits deltas large enough to exhaust the projection budget and force a tier. */
function deltaText(request: { sourceStartSequence: number; sourceEndSequence: number }): string {
  return `MARKER events ${request.sourceStartSequence}-${request.sourceEndSequence} ${"detail ".repeat(1_500)}`.trim();
}

async function evidenced(text: string, requestKey: string): Promise<ContextSummaryOutput> {
  return {
    text,
    provenance: {
      kind: "inference-transport-v1",
      adapterId: INFERENCE_CONTEXT_SUMMARIZER_ID,
      providerId: PROVIDER_ID,
      model: MODEL,
      posture: "local",
      requestDigest: await sha256(`request-${requestKey}`),
      responseDigest: await sha256(text),
    },
  };
}

function summarizerPortSummarizer(): ContextSummarizer {
  return {
    id: INFERENCE_CONTEXT_SUMMARIZER_ID,
    async summarize(request) {
      const text = request.compaction
        ? `MERGED L${request.compaction.level}: ${request.compaction.subsumed.map((entry) => entry.text.slice(0, 96)).join(" || ")}`
          .slice(0, request.maximumOutputBytes).trim()
        : deltaText(request);
      return evidenced(text, `${request.sourceStartSequence}-${request.sourceEndSequence}`);
    },
  };
}

/**
 * The adapter this package's port change is about: it answers a compaction
 * request with a bare string. That used to typecheck against
 * `Promise<string | ContextSummaryOutput>`; the cast reproduces what an untyped
 * adapter can still send across the port at runtime.
 */
function stringTierSummarizer(): ContextSummarizer {
  return {
    id: INFERENCE_CONTEXT_SUMMARIZER_ID,
    summarize: (async (request: Parameters<ContextSummarizer["summarize"]>[0]) => (
      request.compaction
        ? "MERGED without any provenance at all"
        : await evidenced(deltaText(request), `${request.sourceStartSequence}-${request.sourceEndSequence}`)
    )) as unknown as ContextSummarizer["summarize"],
  };
}

function throwingTierSummarizer(): ContextSummarizer {
  return {
    id: INFERENCE_CONTEXT_SUMMARIZER_ID,
    async summarize(request) {
      if (request.compaction) throw new Error("compaction adapter is offline");
      return evidenced(deltaText(request), `${request.sourceStartSequence}-${request.sourceEndSequence}`);
    },
  };
}
