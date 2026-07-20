import type { InferenceEvent } from "../../core/contracts";
import { ChutesTransportError } from "./errors";
import { OpenAiStreamAssembler } from "./openai";
import { BoundedSseParser, type SseMessage } from "./sse";

type Framing = "sse" | "json";

/**
 * Decodes plaintext only after the Rust/WASM context has authenticated it.
 *
 * Chutes encrypts arbitrary upstream iterator chunks. Standard OpenAI chutes
 * therefore produce an inner SSE byte stream, but the checked-in Chutes v1
 * reference client also permits one or more directly streamed JSON objects.
 * Detection is performed once from the authenticated prefix and never changes
 * mid-stream.
 */
export class AuthenticatedOpenAiStream {
  private framing?: Framing;
  private pending = "";
  private readonly sse: BoundedSseParser;

  constructor(
    private readonly assembler: OpenAiStreamAssembler,
    private readonly maxRecordChars: number,
  ) {
    this.sse = new BoundedSseParser(maxRecordChars);
  }

  push(plaintext: string): { events: InferenceEvent[]; done: boolean } {
    if (!this.framing) {
      this.pending += plaintext;
      this.assertBounded();
      const detected = detectFraming(this.pending);
      if (!detected) return { events: [], done: false };
      this.framing = detected;
      plaintext = this.pending;
      this.pending = "";
    }
    return this.framing === "sse"
      ? consumeSse(this.sse.push(plaintext), this.assembler)
      : this.consumeJson(plaintext);
  }

  finish(): { events: InferenceEvent[]; done: boolean } {
    if (!this.framing) {
      if (!this.pending.trim()) return { events: [], done: false };
      const detected = detectFraming(this.pending, true);
      if (!detected) this.invalidFraming();
      this.framing = detected;
      const pending = this.pending;
      this.pending = "";
      const consumed = this.push(pending);
      const final = this.finish();
      return { events: [...consumed.events, ...final.events], done: consumed.done || final.done };
    }
    if (this.framing === "sse") return consumeSse(this.sse.push("", true), this.assembler);
    if (this.pending.trim() === "[DONE]") {
      this.pending = "";
      return { events: [], done: true };
    }
    if (this.pending.trim()) {
      throw new ChutesTransportError(
        "STREAM_TRUNCATED",
        "Chutes authenticated JSON stream ended inside an incomplete object.",
      );
    }
    return { events: [], done: false };
  }

  private consumeJson(plaintext: string): { events: InferenceEvent[]; done: boolean } {
    this.pending += plaintext;
    this.assertBounded();
    const json = this.pending.trim();
    if (json === "[DONE]") {
      this.pending = "";
      return { events: [], done: true };
    }
    try {
      JSON.parse(json);
    } catch {
      // A provider iterator may split one JSON object across authenticated
      // records. Retain the bounded prefix until the object is complete.
      return { events: [], done: false };
    }
    this.pending = "";
    return { events: this.assembler.consume(json), done: false };
  }

  private assertBounded() {
    if (this.pending.length > this.maxRecordChars) {
      throw new ChutesTransportError(
        "SSE_LIMIT",
        `Authenticated stream record exceeds the configured ${this.maxRecordChars}-character limit.`,
      );
    }
  }

  private invalidFraming(): never {
    throw new ChutesTransportError(
      "INVALID_RESPONSE",
      "Chutes authenticated stream is neither SSE nor a JSON object stream.",
    );
  }
}

function detectFraming(value: string, final = false): Framing | undefined {
  const prefix = value.trimStart();
  if (!prefix) return undefined;
  if (prefix.startsWith("{")) return "json";
  if (prefix.startsWith("[DONE]")) return "json";
  if (prefix.startsWith(":")) return "sse";
  const colon = prefix.indexOf(":");
  const newline = prefix.search(/[\r\n]/u);
  if (colon >= 0 && (newline < 0 || colon < newline)) {
    const field = prefix.slice(0, colon);
    if (["data", "event", "id", "retry"].includes(field)) return "sse";
    throw new ChutesTransportError("INVALID_RESPONSE", "Chutes authenticated SSE has an unknown leading field.");
  }
  if (final || prefix.length > 16 || newline >= 0) {
    throw new ChutesTransportError("INVALID_RESPONSE", "Chutes authenticated stream framing is invalid.");
  }
  return undefined;
}

function consumeSse(
  messages: readonly SseMessage[],
  assembler: OpenAiStreamAssembler,
): { events: InferenceEvent[]; done: boolean } {
  const events: InferenceEvent[] = [];
  let done = false;
  for (const message of messages) {
    if (done) {
      throw new ChutesTransportError(
        "INVALID_RESPONSE",
        "Chutes sent authenticated stream content after the inner completion marker.",
      );
    }
    if (message.data.trim() === "[DONE]") done = true;
    else events.push(...assembler.consume(message.data));
  }
  return { events, done };
}
