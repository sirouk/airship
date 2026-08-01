import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  SecurityPosture,
} from "../../core/contracts";
import { buildOpenAiPayload, OpenAiStreamAssembler } from "../chutes/openai";
import { BoundedSseParser, type SseMessage } from "../chutes/sse";
import type { MemoryCredential } from "./contracts";
import {
  LocalProviderError,
  directFetchDiagnostic,
  providerDiagnostic,
  resolveLocalEndpoint,
} from "./endpoint-policy";
import {
  boundedInteger,
  resolveCredential,
  timeoutSignal,
} from "./http";

export type LocalOpenAiTransportOptions = Readonly<{
  id: string;
  endpoint: URL;
  credential?: MemoryCredential;
  fetch?: typeof fetch;
  totalTimeoutMs?: number;
  maxRequestBytes?: number;
  maxStreamBytes?: number;
  maxSseEventChars?: number;
  maxToolCalls?: number;
  maxToolArgumentsChars?: number;
}>;

/**
 * Direct browser-to-loopback OpenAI-compatible streaming transport.
 *
 * The provider credential is resolved immediately before each request and is
 * not copied to storage, logs, receipts, discovery records, or error text.
 */
export class LocalOpenAiTransport implements InferenceTransport {
  readonly id: string;
  readonly posture: SecurityPosture;
  private readonly endpoint: URL;
  private readonly credential?: MemoryCredential;
  private readonly fetchImpl: typeof fetch;
  private readonly totalTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxStreamBytes: number;
  private readonly maxSseEventChars: number;
  private readonly maxToolCalls: number;
  private readonly maxToolArgumentsChars: number;

  constructor(options: LocalOpenAiTransportOptions) {
    if (!options.id.trim()) throw new TypeError("Local transport id cannot be empty.");
    if (
      (options.endpoint.protocol !== "http:" && options.endpoint.protocol !== "https:")
      || options.endpoint.username
      || options.endpoint.password
      || options.endpoint.search
      || options.endpoint.hash
      || (options.endpoint.pathname !== "/" && options.endpoint.pathname !== "")
    ) {
      throw new TypeError("Local transport endpoint must be an exact HTTP(S) origin.");
    }
    resolveLocalEndpoint(options.endpoint.origin);
    this.id = options.id;
    this.posture = "local";
    this.endpoint = new URL(options.endpoint.origin);
    this.credential = options.credential;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.totalTimeoutMs = boundedInteger(options.totalTimeoutMs, 120_000, 1_000, 900_000);
    this.maxRequestBytes = boundedInteger(options.maxRequestBytes, 16 * 1024 * 1024, 1_024, 64 * 1024 * 1024);
    this.maxStreamBytes = boundedInteger(options.maxStreamBytes, 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024);
    this.maxSseEventChars = boundedInteger(options.maxSseEventChars, 2 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
    this.maxToolCalls = boundedInteger(options.maxToolCalls, 32, 1, 256);
    this.maxToolArgumentsChars = boundedInteger(options.maxToolArgumentsChars, 1024 * 1024, 128, 16 * 1024 * 1024);
  }

  async *stream(
    request: InferenceRequest,
    externalSignal: AbortSignal,
  ): AsyncGenerator<InferenceEvent> {
    const lifetime = timeoutSignal(
      externalSignal,
      this.totalTimeoutMs,
      `The local model did not finish this answer within its ${describeBudget(this.totalTimeoutMs)} limit.`
      + " Anything already shown is what arrived; nothing was cancelled by you.",
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseStarted = false;
    try {
      const serialized = JSON.stringify(buildOpenAiPayload(request));
      if (new TextEncoder().encode(serialized).byteLength > this.maxRequestBytes) {
        throw new LocalProviderError(providerDiagnostic(
          "response-too-large",
          `The local inference request exceeded the ${this.maxRequestBytes}-byte safety limit.`,
        ));
      }
      const headers = new Headers({
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      });
      const credential = await resolveCredential(this.credential, lifetime.signal);
      if (credential) headers.set("Authorization", `Bearer ${credential}`);
      const url = new URL("v1/chat/completions", this.endpoint);
      if (url.origin !== this.endpoint.origin) {
        throw new LocalProviderError(providerDiagnostic(
          "endpoint-not-local",
          "The inference request attempted to leave its approved local-model origin.",
        ));
      }

      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: serialized,
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: lifetime.signal,
      });
      if (!response.ok) {
        throw new LocalProviderError(providerDiagnostic(
          "http",
          `The local inference endpoint returned HTTP ${response.status}.`,
          { status: response.status },
        ));
      }
      responseStarted = true;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("text/event-stream")) {
        throw new LocalProviderError(providerDiagnostic(
          "invalid-content-type",
          "The local inference endpoint did not return an SSE stream.",
        ));
      }
      if (!response.body) {
        throw invalidStream("The local inference response had no stream body.");
      }

      const assembler = new OpenAiStreamAssembler({
        maxToolCalls: this.maxToolCalls,
        maxToolArgumentsChars: this.maxToolArgumentsChars,
      });
      const parser = new BoundedSseParser(this.maxSseEventChars);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const streamReader = response.body.getReader();
      reader = streamReader;
      let totalBytes = 0;
      let sawDone = false;

      for (;;) {
        if (lifetime.signal.aborted) throw lifetime.signal.reason;
        const { value, done } = await readChunk(streamReader);
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxStreamBytes) {
          throw new LocalProviderError(providerDiagnostic(
            "response-too-large",
            `The local inference stream exceeded the ${this.maxStreamBytes}-byte safety limit.`,
          ));
        }
        for (const event of consumeSse(
          parser.push(decoder.decode(value, { stream: true })),
          assembler,
          sawDone,
        )) {
          if (event === DONE) sawDone = true;
          else yield event;
        }
      }
      for (const event of consumeSse(
        parser.push(decoder.decode(), true),
        assembler,
        sawDone,
      )) {
        if (event === DONE) sawDone = true;
        else yield event;
      }
      if (!sawDone && !assembler.hasFinishReason) {
        throw invalidStream("The local inference stream ended before a completion marker.");
      }
      const final = assembler.finalize();
      for (const call of final.toolCalls) yield { type: "tool-call", call };
      yield { type: "completed", finishReason: final.finishReason };
    } catch (error) {
      if (externalSignal.aborted) {
        throw externalSignal.reason ?? new DOMException("Cancelled.", "AbortError");
      }
      if (error instanceof LocalProviderError) throw error;
      if (isChutesParserError(error)) {
        const code = error.code === "SSE_LIMIT" ? "response-too-large" : "invalid-payload";
        throw new LocalProviderError(providerDiagnostic(
          code,
          code === "response-too-large"
            ? "The local inference event exceeded its configured safety limit."
            : "The local inference endpoint returned an invalid OpenAI-compatible stream.",
        ), { cause: error });
      }
      if (responseStarted && (error instanceof TypeError || error instanceof RangeError)) {
        throw new LocalProviderError(providerDiagnostic(
          "invalid-payload",
          "The local inference endpoint returned malformed UTF-8 or stream framing.",
        ), { cause: error });
      }
      throw new LocalProviderError(directFetchDiagnostic(error), { cause: error });
    } finally {
      await reader?.cancel().catch(() => undefined);
      lifetime.dispose();
    }
  }
}

const DONE = Symbol("local-openai-done");

/** Minutes where the budget is minutes, so the sentence reads as a limit. */
function describeBudget(totalTimeoutMs: number): string {
  const minutes = Math.round(totalTimeoutMs / 60_000);
  return minutes >= 1
    ? `${minutes}-minute`
    : `${Math.max(1, Math.round(totalTimeoutMs / 1_000))}-second`;
}

/**
 * Read one chunk, and keep a transport failure from being reported as a payload
 * verdict.
 *
 * Measured: a connection dropped mid-body raises `net::ERR_INCOMPLETE_CHUNKED_
 * ENCODING` in the console and rejects this read with a bare `TypeError`. That
 * landed in the `responseStarted && error instanceof TypeError` branch below,
 * whose sentence — "returned malformed UTF-8 or stream framing" — accuses the
 * provider of sending corrupt data and sends the person to debug the model
 * server instead of the connection. That branch is still the right answer for
 * the fatal `TextDecoder`, which is the other thing that raises `TypeError`
 * here; the two are separated by *where* the throw happened, because the error
 * itself carries nothing that tells them apart.
 *
 * `DOMException` passes straight through: an abort — the caller's Stop, or this
 * transport's own total-timeout — already has a truthful verdict downstream, and
 * naming it a dropped connection would be the same class of mistake in reverse.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (caught) {
    if (caught instanceof DOMException) throw caught;
    throw new LocalProviderError(providerDiagnostic(
      "stream-interrupted",
      "The connection to the local inference endpoint dropped before the reply finished. The endpoint answered and started streaming; the stream stopped mid-response. Anything already shown is what arrived.",
    ), { cause: caught });
  }
}

function consumeSse(
  messages: readonly SseMessage[],
  assembler: OpenAiStreamAssembler,
  alreadyDone: boolean,
): Array<InferenceEvent | typeof DONE> {
  const events: Array<InferenceEvent | typeof DONE> = [];
  let done = alreadyDone;
  for (const message of messages) {
    if (done) throw invalidStream("The local inference endpoint sent data after its completion marker.");
    const reported = providerReportedFailure(message);
    if (reported) throw new LocalProviderError(providerDiagnostic("provider-reported", reported));
    if (message.data.trim() === "[DONE]") {
      done = true;
      events.push(DONE);
    } else {
      events.push(...assembler.consume(message.data));
    }
  }
  return events;
}

/**
 * The provider's own diagnosis, which was arriving and being thrown away.
 *
 * Measured against LM Studio: HTTP 200, then one frame reading `event: error` /
 * `data: {"error":{"message":"Engine protocol predict request returned 400: …
 * Failed to initialize samplers: failed to parse grammar"}}`, and the stream
 * ends. `consumeSse` only ever read `message.data` and only ever compared it to
 * `[DONE]`, so the frame fell through the assembler and the turn died on "The
 * local inference stream ended before a completion marker." — a complaint about
 * framing, in front of a person whose model server had just said exactly what
 * was wrong. The parser has carried `event` since it was written
 * (`chutes/sse.ts`); nothing inspected it.
 *
 * The text is untrusted: it is another program's output being placed in this
 * person's transcript, so control characters go and the length is bounded, the
 * same discipline every other passed-through provider string gets here.
 */
function providerReportedFailure(message: SseMessage): string | undefined {
  const payload = message.data.trim();
  if (payload === "[DONE]" || !payload.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON: the assembler owns the verdict on it.
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  const raw = typeof error === "string"
    ? error
    : typeof (error as { message?: unknown } | undefined)?.message === "string"
      ? (error as { message: string }).message
      : undefined;
  // An `event: error` frame with no readable message still has to stop the
  // turn: it is the endpoint saying it failed, and continuing would end on the
  // framing complaint this exists to replace.
  if (raw === undefined) {
    return message.event === "error"
      ? "The local inference endpoint reported an error and gave no reason."
      : undefined;
  }
  const clean = raw.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return "The local inference endpoint reported an error and gave no reason.";
  const bounded = clean.length > 400 ? `${clean.slice(0, 397)}…` : clean;
  return `The local model server reported: ${bounded}`;
}

function invalidStream(message: string): LocalProviderError {
  return new LocalProviderError(providerDiagnostic("invalid-payload", message));
}

function isChutesParserError(value: unknown): value is { code: string } {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && typeof (value as { code?: unknown }).code === "string";
}
