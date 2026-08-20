/**
 * Conversation naming parity tests: the pure mirrors (prompt heuristic,
 * title usability), the naming drafts' byte-shape against airship's writer,
 * and the runtime-facade flow (heuristic rename on first prompt, paid model
 * naming journaled with receipt + usage, final rename) via the faux lane.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import type { InferenceTransport, JsonValue } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { stableStringify, sha256 } from "../../core/hash";
import type { ConversationReceipt } from "../../receipts/types";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import {
  PRIME_CONVERSATION_NAMING_PROMPT,
  PRIME_MAX_NAMING_ANSWER_CHARS,
  PRIME_NAMING_USAGE_SOURCE,
  primeConversationNamingDrafts,
  primeConversationTitleFromModel,
  primeConversationTitleFromPrompt,
  primeUsableConversationTitle,
} from "./naming";
import { PrimeRuntime } from "./runtime";

/**
 * The naming chain runs off the prompt's await path on purpose: assertions
 * poll the journal instead of sleeping a fixed window that loses to
 * crypto-module warmup on contended hosts.
 */
async function waitForJournal<T>(probe: () => Promise<T | undefined | false>, attempts = 300): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("journal condition never observed");
}

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("primeConversationTitleFromPrompt", () => {
  it("collapses whitespace and control characters, then caps at 64 with ellipsis", () => {
    expect(primeConversationTitleFromPrompt("  draft the\nQ3   pricing memo  ")).toBe("draft the Q3 pricing memo");
    const long = "word ".repeat(30).trim();
    const titled = primeConversationTitleFromPrompt(long);
    expect(titled.length).toBeLessThanOrEqual(64);
    expect(titled.endsWith("…")).toBe(true);
    expect(primeConversationTitleFromPrompt("\u0001\u007f")).toBe("");
  });
});

describe("primeUsableConversationTitle", () => {
  it("strips packaging quotes and trailing punctuation", () => {
    expect(primeUsableConversationTitle('"Pricing memo intro."')).toBe("Pricing memo intro");
    expect(primeUsableConversationTitle("'Weekly sync agenda'")).toBe("Weekly sync agenda");
  });

  it("refuses empties, over-long titles, and anything over eight words", () => {
    expect(primeUsableConversationTitle("   ")).toBeUndefined();
    expect(primeUsableConversationTitle("x".repeat(65))).toBeUndefined();
    expect(primeUsableConversationTitle("one two three four five six seven eight nine")).toBeUndefined();
    expect(primeUsableConversationTitle("eight words is still a fine title okay")).toBe("eight words is still a fine title okay");
  });
});

/** Yield-in-order transport for the naming lane; records every request. */
function namingTransport(answer: string, opts?: { usage?: { inputTokens?: number; outputTokens?: number }; receipt?: ConversationReceipt }) {
  const requests: { requestId: string; systemPrompt: string; messages: unknown; idempotencyKey: string }[] = [];
  const transport: InferenceTransport = {
    id: "faux",
    stream(request: Parameters<InferenceTransport["stream"]>[0]) {
      requests.push({
        requestId: request.requestId,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        idempotencyKey: request.idempotencyKey,
      });
      return (async function* (): AsyncGenerator<never> {
        if (answer) yield { type: "text-delta", text: answer } as never;
        if (opts?.usage) yield { type: "usage", ...(opts.usage as object) } as never;
        yield { type: "completed", finishReason: "stop", ...(opts?.receipt ? { receipt: opts.receipt } : {}) } as never;
        return;
      })();
    },
  } as unknown as InferenceTransport;
  return { transport, requests };
}

describe("primeConversationTitleFromModel", () => {
  const identity = { sessionId: "s-naming", turnId: "naming-test", operationId: "naming-request-test" };

  it("returns title+answer+usage+finalized receipt bound to the request digest", async () => {
    const receipt = { id: "rcpt-1", responseDigest: "taken-on-stream" } as unknown as ConversationReceipt;
    const { transport, requests } = namingTransport("Pricing memo intro", { usage: { inputTokens: 41, outputTokens: 5 }, receipt });
    const named = await primeConversationTitleFromModel({ transport, model: "m1", content: "draft the pricing memo", identity });
    expect(named?.title).toBe("Pricing memo intro");
    expect(named?.answer).toBe("Pricing memo intro");
    expect(named?.usage).toEqual({ inputTokens: 41, outputTokens: 5 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toBe(identity.operationId);
    expect(requests[0]?.idempotencyKey).toBe(identity.operationId);
    expect(requests[0]?.systemPrompt).toBe(PRIME_CONVERSATION_NAMING_PROMPT);
    // Receipt was finalized against the recomputed request digest, and the
    // stored answer is exactly what sha256(text) seals — nothing is trusted.
    const requestDigest = await sha256(stableStringify({
      model: "m1",
      systemPrompt: PRIME_CONVERSATION_NAMING_PROMPT,
      messages: [{ role: "user", content: "draft the pricing memo" }],
      tools: [],
      idempotencyKey: identity.operationId,
    } as unknown as JsonValue));
    const bindings = named?.receipt?.bindings as { requestDigest?: string; responseDigest?: string } | undefined;
    expect(bindings?.requestDigest).toBe(requestDigest);
    expect(bindings?.responseDigest).toBe(await sha256(named?.answer ?? ""));
  });

  it("drops the title but keeps the answer and usage when the model refuses to name", async () => {
    // Eleven words: a refusal sentence, never an adoptable title, short
    // enough to stay under the stream-abandon line so usage still arrives.
    const refusal = "I cannot assist with the request to name this conversation at all";
    const { transport } = namingTransport(refusal, { usage: { inputTokens: 10, outputTokens: 20 } });
    const named = await primeConversationTitleFromModel({ transport, model: "m1", content: "x", identity });
    expect(named?.title).toBeUndefined();
    expect(named?.answer).toBe(refusal);
    expect(named?.usage).toBeDefined();
  });

  it("returns undefined when nothing attestable happens", async () => {
    const { transport } = namingTransport("");
    const named = await primeConversationTitleFromModel({ transport, model: "m1", content: "x", identity });
    expect(named).toBeUndefined();
  });

  it("clamps answers to the audit-record bound as they accumulate", async () => {
    const { transport } = namingTransport("t".repeat(PRIME_MAX_NAMING_ANSWER_CHARS + 500));
    const named = await primeConversationTitleFromModel({ transport, model: "m1", content: "x", identity });
    expect(named?.answer.length).toBeLessThanOrEqual(PRIME_MAX_NAMING_ANSWER_CHARS);
  });
});

describe("primeConversationNamingDrafts", () => {
  it("journals named + usage as airship's writer does, in that order", () => {
    const drafts = primeConversationNamingDrafts(
      { title: "Memo title", answer: "Memo title", usage: { inputTokens: 3, outputTokens: 2 } },
      { model: "m1", turnId: "naming-t", operationId: "naming-request-t" },
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      type: "conversation.named",
      turnId: "naming-t",
      operationId: "naming-request-t",
      payload: { title: "Memo title", answer: "Memo title", model: "m1" },
    });
    expect(drafts[1]).toMatchObject({
      type: "inference.usage",
      turnId: "naming-t",
      operationId: "naming-request-t",
      payload: { inputTokens: 3, outputTokens: 2, source: PRIME_NAMING_USAGE_SOURCE },
    });
  });

  it("records an unusable answer without a title and without usage", () => {
    const drafts = primeConversationNamingDrafts(
      { answer: "I cannot help" },
      { model: "m1", turnId: "naming-t", operationId: "naming-request-t" },
    );
    expect(drafts).toHaveLength(1);
    const payload = drafts[0]?.payload as Record<string, unknown>;
    expect(payload?.title).toBeUndefined();
    expect(payload?.answer).toBe("I cannot help");
  });
});

describe("PrimeRuntime naming flow", () => {
  it("names the session heuristically on first prompt, then journals the paid naming and final rename", async () => {
    const registration = registerFauxProvider({});
    registrations.push(registration);
    const model = registration.getModel();
    if (!model) throw new Error("no model");
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    const runtime = new PrimeRuntime({ journal, registry, approvalPolicy: allowAllForTests });
    registration.setResponses([fauxAssistantMessage("turn answer")]);
    const receipt = { id: "naming-rcpt" } as unknown as ConversationReceipt;
    const nameTransport = namingTransport("Memo intro title", { usage: { inputTokens: 12, outputTokens: 4 }, receipt });

    const session = await runtime.createSession({
      model,
      transport: nameTransport.transport,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: model.id,
        workspaceId: "ws-naming",
      },
    });
    const result = await runtime.prompt(session.id, "draft memo intro");
    expect(result.outcome).toBe("completed");

    // The heuristic lands first and synchronously enough to observe here.
    // Poll so a slow first settle cannot masquerade as a skipped heuristic.
    const afterHeuristic = await waitForJournal(async () => {
      const record = await journal.getSession(session.id);
      return record && record.title !== "Prime conversation" ? record : undefined;
    });
    expect(afterHeuristic.title).toBe("draft memo intro");

    // The paid naming chain is fire-and-forget; poll until it lands.
    const events = await waitForJournal(async () => {
      const read = await journal.readEvents(session.id);
      return read.some((event) => event.type === "conversation.named") ? read : undefined;
    });
    const namedEvent = events.find((event) => event.type === "conversation.named");
    // The turn lanes also journal inference.usage: the naming lane is the
    // one marked by its source, exactly like the audit keys on.
    const usageEvent = events.find(
      (event) => event.type === "inference.usage"
        && (event.payload as { source?: string } | undefined)?.source === PRIME_NAMING_USAGE_SOURCE,
    );
    expect(namedEvent).toBeDefined();
    expect((namedEvent?.payload as { source?: string } | undefined)?.source).toBeUndefined();
    expect((namedEvent?.payload as { title?: string } | undefined)?.title).toBe("Memo intro title");
    expect((namedEvent?.payload as { receipt?: { id?: string } } | undefined)?.receipt?.id).toBe("naming-rcpt");
    expect(usageEvent).toBeDefined();
    expect((usageEvent?.payload as { source?: string } | undefined)?.source).toBe(PRIME_NAMING_USAGE_SOURCE);
    expect(namedEvent?.turnId).toMatch(/^naming-/);
    expect(namedEvent?.operationId).toMatch(/^naming-request-/);
    expect(usageEvent?.turnId).toBe(namedEvent?.turnId);

    const afterNaming = await waitForJournal(async () => {
      const record = await journal.getSession(session.id);
      return record?.title === "Memo intro title" ? record : undefined;
    });
    expect(afterNaming.title).toBe("Memo intro title");
  });

  it("skips naming entirely for explicitly titled sessions", async () => {
    const registration = registerFauxProvider({});
    registrations.push(registration);
    const model = registration.getModel();
    if (!model) throw new Error("no model");
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    const runtime = new PrimeRuntime({ journal, registry, approvalPolicy: allowAllForTests });
    registration.setResponses([fauxAssistantMessage("ok")]);
    const nameTransport = namingTransport("Should not land");
    const session = await runtime.createSession({
      title: "explicit title",
      model,
      transport: nameTransport.transport,
      manifest: { systemPrompt: "p", providerId: "faux", model: model.id, workspaceId: "ws-naming" },
    });
    await runtime.prompt(session.id, "anything");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const events = await journal.readEvents(session.id);
    expect(events.some((event) => event.type === "conversation.named")).toBe(false);
    expect(nameTransport.requests.every((request) => request.systemPrompt !== PRIME_CONVERSATION_NAMING_PROMPT)).toBe(true);
    expect((await journal.getSession(session.id))?.title).toBe("explicit title");
  });

  it("keeps the heuristic record even when the naming stream dies", async () => {
    const registration = registerFauxProvider({});
    registrations.push(registration);
    const model = registration.getModel();
    if (!model) throw new Error("no model");
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    const runtime = new PrimeRuntime({ journal, registry, approvalPolicy: allowAllForTests });
    registration.setResponses([fauxAssistantMessage("answer")]);
    // One transport serves both lanes (that's the prime pin); only the
    // naming request dies, never the turn that rides the same client.
    const brokenTransport = {
      id: "faux",
      stream(request: { systemPrompt?: string }) {
        if (request.systemPrompt === PRIME_CONVERSATION_NAMING_PROMPT) {
          throw new Error("naming stream dead");
        }
        return (async function* (): AsyncGenerator<never> {
          yield { type: "text-delta", text: "turn answer" } as never;
          yield { type: "completed", finishReason: "stop", receipt: { id: "turn-rcpt" } as unknown as ConversationReceipt } as never;
        })();
      },
    } as unknown as InferenceTransport;
    const session = await runtime.createSession({
      model,
      transport: brokenTransport,
      manifest: { systemPrompt: "p", providerId: "faux", model: model.id, workspaceId: "ws-naming" },
    });
    const result = await runtime.prompt(session.id, "keep the happy path");
    expect(result.outcome).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await journal.getSession(session.id))?.title).toBe("keep the happy path");
    const events = await journal.readEvents(session.id);
    expect(events.some((event) => event.type === "conversation.named")).toBe(false);
  });
});
