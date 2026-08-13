import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "../core/contracts";
import { createLocalReceipt, type ConversationReceipt } from "../receipts/types";
import { resolveProofReceipt } from "./proof-route";
import {
  conversationTitleFromModel,
  isAppMintedConversationTitle,
  proofResolvableReceipts,
  usableConversationTitle,
} from "./app";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

/*
 * A truncated first prompt is the message restated, not a name. The recording
 * asked for the model to name the conversation, which means accepting an answer
 * from a model — so the interesting half is what gets *rejected*. Anything that
 * slips through becomes a durable, journaled session title.
 */
describe("model-proposed conversation titles", () => {
  it("accepts a short title and normalizes the packaging models add", () => {
    expect(usableConversationTitle("Browser workspace boundaries")).toBe("Browser workspace boundaries");
    expect(usableConversationTitle('  "Browser workspace boundaries."  ')).toBe("Browser workspace boundaries");
    expect(usableConversationTitle("“Mapping the workspace”")).toBe("Mapping the workspace");
    expect(usableConversationTitle("Vault durability ladder;")).toBe("Vault durability ladder");
    expect(usableConversationTitle("Line\nbreaks\tcollapse")).toBe("Line breaks collapse");
  });

  it("rejects an answer that is not a title", () => {
    // A model that explains itself, refuses, or writes prose has not named
    // anything, and the local heuristic is better than any of these.
    expect(usableConversationTitle("")).toBeUndefined();
    expect(usableConversationTitle("   ")).toBeUndefined();
    expect(usableConversationTitle("Sure! Here is a concise title for your conversation: Workspace"))
      .toBeUndefined();
    expect(usableConversationTitle("I'm sorry, but I can't help with that request."))
      .toBeUndefined();
    expect(usableConversationTitle("a".repeat(65))).toBeUndefined();
  });

  it("journals the naming request against this conversation, in the shape the audit admits", () => {
    // It used to invent `naming-<uuid>` as the session id, so the receipt the
    // transport returned bound the request to a session that never existed and
    // the usage event was discarded: one whole provider request per
    // conversation that no surface could account for.
    expect(source).not.toContain("sessionId: `naming-${randomUuid()}`");
    expect(source).toContain("{ sessionId: turnSessionId, turnId: namingTurnId, operationId: namingOperationId }");
    expect(source).toContain("type: CONVERSATION_NAMED_EVENT_TYPE");
    expect(source).toContain('source: "conversation-naming"');
    expect(source).toContain("answer: named.answer,");
    // Same-thread model changes leave the Profile default on `runtime.model`;
    // naming must use the conversation's current journal-derived route or its
    // receipt makes this otherwise valid history suspect on the next open.
    expect(source).toContain("const turnModel = effectiveSessionModel(activeSessionRecord);");
    expect(source).toContain("{ transport: turnRuntime.transport, model: turnModel }");
    expect(source).toContain("model: turnModel,");
    // The record is written before the "am I still here" check, because
    // leaving the thread cannot be what decides whether a charge is recorded.
    const start = source.indexOf(".then(async (named) => {");
    const appendAt = source.indexOf("await turnRuntime.journal.append(turnSessionId, [", start);
    expect(start).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(start);
    expect(source.slice(start, appendAt)).not.toContain("activeSessionIdentity.current !== turnSessionId");
    // The rename, unlike the record, is still gated on it.
    expect(source.slice(appendAt, source.indexOf("await applyTitle(named.title);", appendAt)))
      .toContain("if (activeSessionIdentity.current !== turnSessionId) return;");
  });

  it("never returns a title a journal would refuse to store", () => {
    for (const answer of [
      "Browser workspace boundaries",
      '"Quoted"',
      "Trailing punctuation.",
      "a".repeat(64),
    ]) {
      const title = usableConversationTitle(answer);
      if (!title) continue;
      // `EventJournal.renameSession` bounds titles at 1-240 printable characters.
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(240);
      expect(/[\u0000-\u001f\u007f]/u.test(title)).toBe(false);
      expect(title).toBe(title.trim());
    }
  });
});

describe("names Airship gives a conversation before its content does", () => {
  /*
   * Measured (J091): the rail row for the thread whose first message was
   * "Draft the Q3 pricing memo intro paragraph." read "General · encrypted
   * vault", and `#sessions` showed five separate rows all called that. The
   * titler's gate compared the current title against `"<Profile> conversation"`
   * only, so a conversation minted by vault adoption — which mints a different
   * default — never qualified and never took a name from its content. Tuesday's
   * memo was unfindable by title because the storage backend had named it.
   */
  it("recognises every default the app mints, not just the new-conversation one", () => {
    expect(isAppMintedConversationTitle("General conversation", "General")).toBe(true);
    expect(isAppMintedConversationTitle("General · encrypted vault", "General")).toBe(true);
    expect(isAppMintedConversationTitle("General · ephemeral", "General")).toBe(true);
    expect(isAppMintedConversationTitle("Research · encrypted vault", "Research")).toBe(true);
  });

  it("never treats a name a person or a fork produced as replaceable", () => {
    // The titler overwrites whatever this returns true for, so a false positive
    // silently renames somebody's work.
    expect(isAppMintedConversationTitle("Draft the Q3 pricing memo intro paragraph.", "General")).toBe(false);
    expect(isAppMintedConversationTitle("Fork of General · encrypted vault", "General")).toBe(false);
    expect(isAppMintedConversationTitle("General · encrypted vault · edit", "General")).toBe(false);
    expect(isAppMintedConversationTitle("General conversation", "Research")).toBe(false);
  });

  it("is the same table the minting call sites use", () => {
    // Three code paths write these strings and a fourth reads them; the drift
    // between the writer and the reader is exactly what J091 measured.
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain('appMintedConversationTitle(profile.name, "vault")');
    expect(app).toContain('appMintedConversationTitle(profile.name, "ephemeral")');
    expect(app).toContain("isAppMintedConversationTitle(activeSessionRecord.title, activeProfile.name)");
    expect(app).not.toContain("`${profile.name} · encrypted vault`");
  });
});

/*
 * Everything below is about the boundary between the two outcomes that look
 * alike from the call site and are not alike at all: "no request happened" and
 * "a request happened and produced no usable name". Collapsing the second into
 * the first is what left a completed, billed, attested call recorded nowhere.
 */
describe("conversationTitleFromModel", () => {
  const identity = { sessionId: "session-1", turnId: "naming-1", operationId: "naming-request-1" };
  const prompt = "Map the browser workspace boundary rules for me";

  it("returns the title, the verbatim answer, the usage and a receipt bound to the conversation", async () => {
    const transport = scriptedTransport([
      { type: "text-delta", text: "Workspace boundaries" },
      { type: "usage", inputTokens: 96, outputTokens: 4 },
      { type: "completed", finishReason: "stop", receipt: providerReceipt() },
    ]);

    const named = await conversationTitleFromModel(
      { transport, model: "airship/test-model" },
      prompt,
      identity,
      new AbortController().signal,
    );

    expect(named?.title).toBe("Workspace boundaries");
    expect(named?.answer).toBe("Workspace boundaries");
    expect(named?.usage).toEqual({ inputTokens: 96, outputTokens: 4 });
    // The one thing a receipt exists to do: name the conversation that paid.
    expect(named?.receipt?.sessionId).toBe("session-1");
    expect(named?.receipt?.turnId).toBe("naming-1");
    // Finalized exactly as a turn receipt is, so the provider named is the
    // pinned transport rather than whatever string the provider sent.
    expect(named?.receipt?.provider).toBe(transport.id);
    expect(named?.receipt?.bindings.responseDigest).toMatch(/^sha256:/u);
    expect(transport.requests[0]?.sessionId).toBe("session-1");
    expect(transport.requests[0]?.idempotencyKey).toBe("naming-request-1");
  });

  it("still reports a completed request whose answer is no title at all", async () => {
    const refusal = "I'm sorry, but I can't help with naming this conversation.";
    const transport = scriptedTransport([
      { type: "text-delta", text: refusal },
      { type: "usage", inputTokens: 88, outputTokens: 14 },
      { type: "completed", finishReason: "stop", receipt: providerReceipt() },
    ]);

    const named = await conversationTitleFromModel(
      { transport, model: "airship/test-model" },
      prompt,
      identity,
      new AbortController().signal,
    );

    // Skipping the rename is the whole visible effect. The cost and the
    // evidence are still handed back for the caller to journal.
    expect(usableConversationTitle(refusal)).toBeUndefined();
    expect(named).toBeDefined();
    expect(named?.title).toBeUndefined();
    expect(named?.answer).toBe(refusal);
    expect(named?.usage).toEqual({ inputTokens: 88, outputTokens: 14 });
    expect(named?.receipt?.sessionId).toBe("session-1");
  });

  it("reports an over-long answer it cut short, because the tokens were spent before the cut", async () => {
    const transport = scriptedTransport([
      // One unbounded delta: the record has to stay inside the audit's 4 KiB
      // answer bound however much the provider decided to send in one chunk.
      { type: "text-delta", text: "Here is a thorough explanation. ".repeat(2_000) },
      { type: "usage", inputTokens: 96, outputTokens: 240 },
      { type: "completed", finishReason: "stop", receipt: providerReceipt() },
    ]);

    const named = await conversationTitleFromModel(
      { transport, model: "airship/test-model" },
      prompt,
      identity,
      new AbortController().signal,
    );

    expect(named?.title).toBeUndefined();
    expect(named?.answer.length).toBeGreaterThan(240);
    // A record the audit would refuse is a record that does not exist, so the
    // answer is clamped as it accumulates rather than after.
    expect(named?.answer.length).toBeLessThanOrEqual(4_096);
    // The stream is abandoned at the cut, so usage and receipt never arrive;
    // the answer alone is enough to record that a request was made and paid.
    expect(named?.usage).toBeUndefined();
    expect(named?.receipt).toBeUndefined();
  });

  it("returns nothing when the request failed, was aborted, or produced no event at all", async () => {
    const model = "airship/test-model";
    expect(await conversationTitleFromModel(
      { model, transport: failingTransport() },
      prompt,
      identity,
      new AbortController().signal,
    )).toBeUndefined();

    const aborted = new AbortController();
    aborted.abort();
    expect(await conversationTitleFromModel(
      { model, transport: scriptedTransport([{ type: "text-delta", text: "Ignored" }]) },
      prompt,
      identity,
      aborted.signal,
    )).toBeUndefined();

    // An empty stream is not a request anyone can account for: there is
    // nothing to attest to, so nothing is recorded.
    expect(await conversationTitleFromModel(
      { model, transport: scriptedTransport([]) },
      prompt,
      identity,
      new AbortController().signal,
    )).toBeUndefined();
  });
});

/*
 * The naming receipt rides no transcript row until a reload replays its record
 * as a marker, and Proof addresses receipts only through this list. Everything
 * upstream — minting, finalizing, journaling — is worth nothing if the receipt
 * is unreachable, which is the state it shipped in.
 */
describe("proofResolvableReceipts", () => {
  const turnReceipt = { ...providerReceipt(), receiptId: "urn:turn", turnId: "turn-1" };
  const namingReceipt = { ...providerReceipt(), receiptId: "urn:naming" };
  const otherConversation = { ...providerReceipt(), receiptId: "urn:elsewhere", sessionId: "session-2" };

  it("lists a naming receipt for this conversation, and never one from another", () => {
    const listed = proofResolvableReceipts(
      [namingReceipt, otherConversation],
      [{ receipt: turnReceipt }, {}],
      "session-1",
    );

    expect(listed.map((receipt) => receipt.receiptId)).toEqual(["urn:naming", "urn:turn"]);
    // Addressable by the exact identity a Proof deep link carries.
    expect(resolveProofReceipt(listed, {
      sessionId: "session-1",
      receiptId: namingReceipt.receiptId,
      turnId: namingReceipt.turnId,
    })?.receiptId).toBe("urn:naming");
    expect(resolveProofReceipt(listed, {
      sessionId: "session-1",
      receiptId: otherConversation.receiptId,
      turnId: otherConversation.turnId,
    })).toBeUndefined();
  });

  it("leaves the conversation's most recent turn as the receipt Proof opens by default", () => {
    // Ordering is the whole guard: `resolveProofReceipt` walks backwards for a
    // selection that names no receipt, so a naming receipt appended at the end
    // would quietly demote the turn a person came to Proof to read.
    const listed = proofResolvableReceipts([namingReceipt], [{ receipt: turnReceipt }], "session-1");

    expect(resolveProofReceipt(listed, { sessionId: "session-1" })?.receiptId).toBe("urn:turn");
  });
});

type RecordingTransport = InferenceTransport & { readonly requests: InferenceRequest[] };

function scriptedTransport(events: readonly InferenceEvent[]): RecordingTransport {
  const requests: InferenceRequest[] = [];
  return {
    id: "transport://naming-test",
    posture: "local",
    requests,
    stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
      requests.push(request);
      return (async function* () {
        for (const event of events) {
          signal.throwIfAborted();
          yield event;
        }
      })();
    },
  };
}

function failingTransport(): InferenceTransport {
  return {
    id: "transport://naming-test",
    posture: "local",
    stream(): AsyncIterable<InferenceEvent> {
      return (async function* (): AsyncGenerator<InferenceEvent> {
        throw new Error("The provider closed the connection.");
      })();
    },
  };
}

function providerReceipt(): ConversationReceipt {
  return createLocalReceipt({
    sessionId: "session-1",
    turnId: "naming-1",
    // Deliberately not the transport ID: finalization has to overwrite it.
    provider: "whatever-the-provider-said",
    model: "airship/test-model",
    now: "2026-07-18T00:01:00.000Z",
  });
}
