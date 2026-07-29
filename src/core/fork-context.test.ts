import { describe, expect, it } from "vitest";
import {
  MAX_FORK_CONTEXT_MESSAGES,
  canonicalForkContextSeed,
  createForkContextSeed,
  forkContextSeedMatchesScope,
  verifyForkContextSeed,
} from "./fork-context";

const BOUNDARY_DIGEST = `sha256:${"A".repeat(43)}`;
const HEAD_DIGEST = `sha256:${"B".repeat(43)}`;

describe("fork-context seed contract", () => {
  it("seals one destination-scoped commitment to an observed source head and audited boundary", async () => {
    const seed = await createForkContextSeed({
      forkSessionId: "fork-1",
      sourceSessionId: "source-1",
      sourceHeadSequence: 12,
      sourceHeadDigest: HEAD_DIGEST,
      sourceBoundarySequence: 9,
      sourceBoundaryDigest: BOUNDARY_DIGEST,
      messages: [
        { role: "user", content: "Original question" },
        { role: "assistant", content: "Original answer" },
      ],
    });

    expect(canonicalForkContextSeed(seed)).toEqual(seed);
    expect(await verifyForkContextSeed(seed)).toBe(true);
    expect(forkContextSeedMatchesScope(seed, {
      sessionId: "fork-1",
      lineage: {
        version: 1,
        kind: "fork",
        sourceSessionId: "source-1",
        sourceHeadSequence: 9,
        sourceHeadDigest: BOUNDARY_DIGEST,
        forkedAt: "2026-07-28T00:00:00.000Z",
      },
    })).toBe(true);
    expect(Object.isFrozen(seed.messages)).toBe(true);
  });

  it("detects a changed context commitment even when the replacement digest has a valid shape", async () => {
    const seed = await createForkContextSeed({
      forkSessionId: "fork-1",
      sourceSessionId: "source-1",
      sourceHeadSequence: 1,
      sourceHeadDigest: BOUNDARY_DIGEST,
      sourceBoundarySequence: 1,
      sourceBoundaryDigest: BOUNDARY_DIGEST,
      messages: [
        { role: "user", content: "Bound text" },
        { role: "assistant", content: "Bound answer" },
      ],
    });
    const tampered = { ...seed, contextDigest: HEAD_DIGEST };

    expect(canonicalForkContextSeed(tampered)).toBeDefined();
    expect(await verifyForkContextSeed(tampered)).toBe(false);
  });

  it("retains only a whole-turn suffix inside the bounded message contract", async () => {
    const messages = Array.from({ length: 150 }, (_, index) => [
      { role: "user" as const, content: `question-${index}` },
      { role: "assistant" as const, content: `answer-${index}` },
    ]).flat();
    const seed = await createForkContextSeed({
      forkSessionId: "fork-1",
      sourceSessionId: "source-1",
      sourceHeadSequence: 1,
      sourceHeadDigest: BOUNDARY_DIGEST,
      sourceBoundarySequence: 1,
      sourceBoundaryDigest: BOUNDARY_DIGEST,
      messages,
    });

    expect(seed.messages).toHaveLength(MAX_FORK_CONTEXT_MESSAGES);
    expect(seed.omittedMessages).toBe(messages.length - MAX_FORK_CONTEXT_MESSAGES);
    expect(seed.messages[0]).toEqual({ role: "user", content: "question-22" });
    expect(seed.messages.at(-1)).toEqual({ role: "assistant", content: "answer-149" });
    expect(await verifyForkContextSeed(seed)).toBe(true);
  });
});
