import type { AssistantMessageEventStream } from "../event-stream";
import type { AssistantMessageEvent } from "../types";

/**
 * Test plumbing for provider conformance tests: a globalThis.fetch stub that
 * captures requests as structured data and answers with in-test SSE bodies.
 * Providers are browser-native (they call globalThis.fetch), so stubbing the
 * platform function exercises the real code path — no SDK seam required.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Redirect, credential and referrer policy, which are credential boundaries. */
  redirect: RequestRedirect | undefined;
  credentials: RequestCredentials | undefined;
  referrerPolicy: ReferrerPolicy | undefined;
  /** Parsed JSON body when it parses, otherwise the raw string. */
  body: unknown;
  rawBody: string;
  signal: AbortSignal | undefined;
}

export type FetchHandler = (request: CapturedRequest) => Response | Promise<Response>;

export interface FetchStub {
  readonly requests: CapturedRequest[];
  restore(): void;
}

export function stubFetch(handler: FetchHandler): FetchStub {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
      credentials: init?.credentials,
      referrerPolicy: init?.referrerPolicy,
      body,
      rawBody,
      signal: init?.signal ?? undefined,
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export interface SseRecordInput {
  event?: string;
  data: string;
}

/** Serialize SSE records the way providers emit them: blank line between records. */
export function sseBody(records: SseRecordInput[]): string {
  return records.map((record) => `${record.event ? `event: ${record.event}\n` : ""}data: ${record.data}\n`).join("\n");
}

export function sseResponse(records: SseRecordInput[], init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(sseBody(records), {
    status: init?.status ?? 200,
    headers: { "content-type": "text/event-stream", ...init?.headers },
  });
}

/** Shorthand: { event, data: JSON.stringify(payload) }. */
export function sseJson(event: string, payload: unknown): SseRecordInput {
  return { event, data: JSON.stringify(payload) };
}

export function jsonResponse(
  payload: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

/** Drain a provider stream into an ordered event list. */
export async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Assert the stream protocol's structural invariants on an event list. */
export function expectEventProtocolConformance(events: AssistantMessageEvent[]): void {
  if (events.length === 0) throw new Error("expected at least one event");
  if (events[0].type !== "start") throw new Error(`first event must be start, got ${events[0].type}`);
  const terminal = events[events.length - 1];
  if (terminal.type !== "done" && terminal.type !== "error") {
    throw new Error(`last event must be done or error, got ${terminal.type}`);
  }
  const terminalCount = events.filter((e) => e.type === "done" || e.type === "error").length;
  if (terminalCount !== 1) throw new Error(`expected exactly one terminal event, got ${terminalCount}`);
  // Per-block ordering: *_start precedes its deltas and *_end, contentIndex consistent.
  const openBlocks = new Map<number, string>();
  for (const event of events) {
    if (event.type === "start" || event.type === "done" || event.type === "error") continue;
    const contentIndex = (event as { contentIndex: number }).contentIndex;
    if (event.type.endsWith("_start")) {
      if (openBlocks.has(contentIndex)) {
        throw new Error(`block ${contentIndex} started twice (${event.type})`);
      }
      openBlocks.set(contentIndex, event.type);
    } else if (event.type.endsWith("_end")) {
      const started = openBlocks.get(contentIndex);
      if (!started) throw new Error(`block ${contentIndex} ended without start (${event.type})`);
      if (started.replace("_start", "") !== event.type.replace("_end", "")) {
        throw new Error(`block ${contentIndex} start/end mismatch: ${started} vs ${event.type}`);
      }
      openBlocks.delete(contentIndex);
    } else if (event.type.endsWith("_delta")) {
      if (!openBlocks.has(contentIndex)) {
        throw new Error(`delta for block ${contentIndex} without an open block (${event.type})`);
      }
    }
  }
  if (openBlocks.size !== 0 && terminal.type === "done") {
    throw new Error(`done with unclosed blocks: ${[...openBlocks.keys()].join(",")}`);
  }
}
