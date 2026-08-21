/*
 * Wire/protocol gate for the three direct cloud vendors.
 *
 * SCOPE OF THE CLAIM. This runs on Node/undici, which sends no `Origin`
 * header, issues no preflight, and enforces no CORS. Passing here proves that
 * Airship's catalog route, request payload, and stream assembler match what the
 * vendor actually accepts and returns — it proves NOTHING about whether a
 * browser page may reach that endpoint. Browser reachability needs a separate
 * gate driving the built artifact from a real cross-origin page, and until that
 * exists the provider fabric must keep saying so.
 *
 * Each vendor is skipped unless its key is supplied through the environment;
 * the credential is never written to a file, fixture, or assertion message.
 */
import { ANTHROPIC_PROVIDER, OPENAI_PROVIDER, XAI_PROVIDER } from "./official-providers";
import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, ToolDefinition } from "../../core/contracts";
import {
  AnthropicBrowserTransport,
  ResponsesBrowserTransport,
} from "./browser-cloud";

const OPENAI_KEY = process.env.AIRSHIP_OPENAI_API_KEY?.trim();
const ANTHROPIC_KEY = process.env.AIRSHIP_ANTHROPIC_API_KEY?.trim();
const XAI_KEY = process.env.AIRSHIP_XAI_API_KEY?.trim();

const OPENAI_MODEL = process.env.AIRSHIP_OPENAI_MODEL?.trim() || "gpt-4.1-mini";
const ANTHROPIC_MODEL = process.env.AIRSHIP_ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
const XAI_MODEL = process.env.AIRSHIP_XAI_MODEL?.trim() || "grok-4-fast";

const describeOpenAi = OPENAI_KEY ? describe : describe.skip;
const describeAnthropic = ANTHROPIC_KEY ? describe : describe.skip;
const describeXai = XAI_KEY ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

describeOpenAi("live OpenAI Responses wire contract", () => {
  it("enumerates its declared catalog route", async () => {
    const models = await openAi().listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.source.sourceUrl).toBe("https://api.openai.com/v1/models");
  }, TIMEOUT_MS);

  it("completes the toolless toolless request payload", async () => {
    expect(await finishReasonOf(openAi(), probeRequest(OPENAI_MODEL))).toBeDefined();
  }, TIMEOUT_MS);

  it("returns a real streamed function call", async () => {
    expect(await toolCallNameOf(openAi(), toolRequest(OPENAI_MODEL))).toBe("report_status");
  }, TIMEOUT_MS);
});

describeAnthropic("live Anthropic Messages wire contract", () => {
  it("enumerates its declared catalog route", async () => {
    const models = await anthropic().listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.source.sourceUrl).toBe("https://api.anthropic.com/v1/models");
  }, TIMEOUT_MS);

  it("completes the toolless toolless request payload", async () => {
    expect(await finishReasonOf(anthropic(), probeRequest(ANTHROPIC_MODEL))).toBeDefined();
  }, TIMEOUT_MS);

  it("accepts the unconfigured max_tokens default on every listed model", async () => {
    // The default has to fit the smallest ceiling Anthropic publishes, so this
    // asserts the default itself rather than a per-model declaration.
    expect(await finishReasonOf(anthropic(), probeRequest(ANTHROPIC_MODEL))).toBeDefined();
  }, TIMEOUT_MS);

  it("returns a real streamed tool_use block", async () => {
    expect(await toolCallNameOf(anthropic(), toolRequest(ANTHROPIC_MODEL))).toBe("report_status");
  }, TIMEOUT_MS);
});

describeXai("live xAI wire contract", () => {
  /*
   * The split this settles: Airship declares xAI's catalog at
   * /v1/language-models but streams inference at /v1/responses. Only a live
   * call can confirm both halves belong to the same live API surface.
   */
  it("enumerates the xAI-specific language-models route", async () => {
    const models = await xai().listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.source.sourceUrl).toBe("https://api.x.ai/v1/language-models");
  }, TIMEOUT_MS);

  it("completes the toolless toolless request payload against /v1/responses", async () => {
    expect(await finishReasonOf(xai(), probeRequest(XAI_MODEL))).toBeDefined();
  }, TIMEOUT_MS);

  it("returns a real streamed function call", async () => {
    expect(await toolCallNameOf(xai(), toolRequest(XAI_MODEL))).toBe("report_status");
  }, TIMEOUT_MS);
});

function openAi(): ResponsesBrowserTransport {
  return new ResponsesBrowserTransport(OPENAI_PROVIDER, {
    connectionId: "openai-live-gate",
    connectionGeneration: 1,
    getApiKey: () => OPENAI_KEY!,
  });
}

function anthropic(): AnthropicBrowserTransport {
  return new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
    connectionId: "anthropic-live-gate",
    connectionGeneration: 1,
    getApiKey: () => ANTHROPIC_KEY!,
  });
}

function xai(): ResponsesBrowserTransport {
  return new ResponsesBrowserTransport(XAI_PROVIDER, {
    connectionId: "xai-live-gate",
    connectionGeneration: 1,
    getApiKey: () => XAI_KEY!,
  });
}

const REPORT_STATUS: ToolDefinition = {
  name: "report_status",
  description: "Report a one-word status. Call this tool instead of answering in prose.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
  },
  effect: "read",
};

/** Byte-for-byte the shape the provider transport contract sends: no tools at all. */
function probeRequest(model: string): InferenceRequest {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    sessionId: `live-gate-${requestId}`,
    turnId: `turn-${requestId}`,
    model,
    systemPrompt: "This is a bounded Airship connection check. Reply only with OK.",
    messages: [{ role: "user", content: "Reply with OK." }],
    tools: [],
    idempotencyKey: `airship-connection-probe-${requestId}`,
  };
}

function toolRequest(model: string): InferenceRequest {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    sessionId: `live-gate-${requestId}`,
    turnId: `turn-${requestId}`,
    model,
    systemPrompt: "Always answer by calling the report_status tool.",
    messages: [{ role: "user", content: "Report the status as ok." }],
    tools: [REPORT_STATUS],
    idempotencyKey: `airship-tool-probe-${requestId}`,
  };
}

async function collect(
  transport: { stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> },
  request: InferenceRequest,
): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of transport.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

async function finishReasonOf(
  transport: { stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> },
  request: InferenceRequest,
): Promise<string | undefined> {
  const events = await collect(transport, request);
  const completed = events.find((event) => event.type === "completed");
  return completed?.type === "completed" ? completed.finishReason : undefined;
}

async function toolCallNameOf(
  transport: { stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> },
  request: InferenceRequest,
): Promise<string | undefined> {
  const events = await collect(transport, request);
  const call = events.find((event) => event.type === "tool-call");
  return call?.type === "tool-call" ? call.call.name : undefined;
}
