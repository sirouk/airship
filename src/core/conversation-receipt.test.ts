import { describe, expect, it } from "vitest";
import type { ConversationReceipt } from "./conversation-receipt";
import { finalizeProviderReceipt } from "./conversation-receipt";

const AUTHORITY = Object.freeze({
  sessionId: "session-1",
  turnId: "turn-1",
  provider: "final-provider",
  model: "provider/model",
});
import { stableStringify } from "./hash";

describe("finalizeProviderReceipt", () => {
  it("drops undeclared and malformed nested receipt fields before journaling", () => {
    const receipt = {
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      model: "provider/model",
      timings: { queuedMs: 5, skippedMs: Number.NaN },
      toolCalls: [
        { id: "call-1", name: undefined },
        { id: "call-2", name: "read_file", extra: "drop-me" },
      ],
      extra: { nested: "drop-me" },
    } as unknown as ConversationReceipt;

    const finalized = finalizeProviderReceipt(receipt, {
      ...AUTHORITY,
      requestDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      responseDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });

    expect(stableStringify(finalized as unknown as Parameters<typeof stableStringify>[0])).not.toContain("undefined");
    expect(finalized).toMatchObject({
      provider: "final-provider",
      requestDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      responseDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      toolCalls: [{ id: "call-2", name: "read_file" }],
    });
    expect((finalized as Record<string, unknown>).extra).toBeUndefined();
    expect(finalized.timings).toBeUndefined();
    const recoveredToolCall = (finalized.toolCalls?.[0] ?? {}) as Record<string, unknown>;
    expect(recoveredToolCall.extra).toBeUndefined();
  });

  it("omits empty sanitized timing and tool-call collections", () => {
    const finalized = finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      timings: {},
      toolCalls: [{ id: "call-1", name: undefined }],
    } as unknown as ConversationReceipt, AUTHORITY);

    expect(finalized.timings).toBeUndefined();
    expect(finalized.toolCalls).toBeUndefined();
  });

  it("drops oversized or negative timing collections and oversized tool-call arrays", () => {
    const oversizedTimings = Object.fromEntries(
      Array.from({ length: 129 }, (_unused, index) => [`metric-${index}`, index]),
    );
    const oversizedToolCalls = Array.from({ length: 513 }, (_unused, index) => ({
      id: `call-${index}`,
      name: "read_file",
    }));
    const finalized = finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      timings: oversizedTimings,
      toolCalls: oversizedToolCalls,
    } as unknown as ConversationReceipt, AUTHORITY);
    const negativeTiming = finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      timings: { totalMs: -1 },
    } as unknown as ConversationReceipt, AUTHORITY);

    expect(finalized.timings).toBeUndefined();
    expect(finalized.toolCalls).toBeUndefined();
    expect(negativeTiming.timings).toBeUndefined();
  });

  it("fails closed on malformed required identity, timestamp, digest, and provider fields", () => {
    expect(() => finalizeProviderReceipt({
      version: 1,
      receiptId: "",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
    } as unknown as ConversationReceipt, AUTHORITY)).toThrow(/Conversation receipt ID is invalid/u);

    expect(() => finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "not-a-timestamp",
      provider: "upstream",
    } as unknown as ConversationReceipt, AUTHORITY)).toThrow(/must be canonical ISO 8601/u);

    expect(() => finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      requestDigest: "sha256:not-valid",
    } as unknown as ConversationReceipt, AUTHORITY)).toThrow(/Conversation request digest is invalid/u);

    expect(() => finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
    } as unknown as ConversationReceipt, { ...AUTHORITY, provider: "" })).toThrow(/Conversation provider ID is invalid/u);
  });

  it("rejects provider receipt identity that is foreign to the active route", () => {
    const receipt = {
      version: 1,
      receiptId: "urn:receipt:foreign",
      sessionId: "other-session",
      turnId: "other-turn",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      model: "other-model",
    } as unknown as ConversationReceipt;

    expect(() => finalizeProviderReceipt(receipt, AUTHORITY))
      .toThrow(/identity does not match the active turn/u);
    expect(() => finalizeProviderReceipt({
      ...receipt,
      sessionId: AUTHORITY.sessionId,
      turnId: AUTHORITY.turnId,
    }, AUTHORITY)).toThrow(/model does not match the active inference route/u);
  });

  it("drops oversized tool-call ids and names instead of keeping unbounded text", () => {
    const finalized = finalizeProviderReceipt({
      version: 1,
      receiptId: "urn:receipt:test",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
      toolCalls: [{ id: "c".repeat(513), name: "read_file" }, { id: "call-2", name: "n".repeat(513) }],
    } as unknown as ConversationReceipt, AUTHORITY);

    expect(finalized.toolCalls).toBeUndefined();
  });

  it("rejects top-level accessors without invoking provider-controlled code", () => {
    let accessed = false;
    const receipt = Object.defineProperty({
      version: 1,
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-24T12:00:00.000Z",
      provider: "upstream",
    }, "receiptId", {
      enumerable: true,
      get() {
        accessed = true;
        return "urn:receipt:test";
      },
    }) as unknown as ConversationReceipt;

    expect(() => finalizeProviderReceipt(receipt, AUTHORITY)).toThrow(/version is invalid/u);
    expect(accessed).toBe(false);
  });
});
