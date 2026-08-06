/**
 * Test doubles for the subagent orchestration suite.
 *
 * The doubles deliberately use the REAL ported Agent (from ../agent) with a
 * scripted stream: the registry's settlement logic keys off agent_end and
 * last-assistant state, so a fake "runtime" that fabricates those signals by
 * hand would assert nothing about the real contract. Scripted streams keep
 * every run deterministic: text/failure is pushed on a microtask (or behind
 * an explicit gate promise the test controls).
 */

import { Agent } from "../agent";
import type { AgentMessage } from "../agent";
import { createModel } from "../agent/test-utils/fixtures";
import type { StreamFn } from "../agent/types";
import { AssistantMessageEventStream } from "../ai/event-stream";
import type { Api, AssistantMessage, Usage } from "../ai/types";
import type { PrimeKernelHost } from "../kernel/kernel-host";
import type { KernelJobResult, KernelJobSpec } from "../kernel/kernel-contract";
import type { PrimeAgentRuntime, PrimeSubagentHandle } from "../runtime/types-prime";
import type {
  PrimeAgentMessage,
  PrimeAgentMessageSink,
  PrimeAgentNodeAttachment,
  PrimeAgentRecorder,
  PrimeAgentRuntimeBundle,
  PrimeAgentRuntimeFactory,
  PrimeSubagentSpawnInput,
} from "./types";

export function createUsage(totalTokens = 0): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Injected clock so the token-bucket tests advance refill time deterministically. */
export function createFakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Deterministic randomId so child ids and message ids are stable across assertions. */
export function createFakeIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return String(counter).padStart(8, "0");
  };
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the task/microtask queue deterministically (no real timers involved in the registry). */
export async function flush(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** An intake queue that records everything; pending backlog is scriptable for the capacity tests. */
export class RecordingSink implements PrimeAgentMessageSink {
  readonly accepted: PrimeAgentMessage[] = [];
  private pending = 0;
  mode: "delivered" | "queued" = "delivered";
  onAccept?: (message: PrimeAgentMessage) => void;

  async accept(message: PrimeAgentMessage): Promise<"delivered" | "queued"> {
    this.accepted.push(message);
    this.onAccept?.(message);
    if (this.mode === "queued") {
      this.pending += 1;
      return "queued";
    }
    return "delivered";
  }

  pendingCount(): number {
    return this.pending;
  }

  setPending(count: number): void {
    this.pending = count;
  }
}

/**
 * Recorder that returns whatever was stored, unclipped on purpose: the
 * maxChars bound is the registry's job to enforce, so tests can prove the
 * registry clips even when a backing store is sloppy.
 */
export class RecordingRecorder implements PrimeAgentRecorder {
  messages: PrimeAgentMessage[] = [];

  recentMessages(limit: number, _maxChars: number): PrimeAgentMessage[] {
    return this.messages.slice(-limit);
  }
}

export interface FakeChildScript {
  /** Assistant text the child finishes with (default: "done"). */
  text?: string | ((input: PrimeSubagentSpawnInput) => string);
  /** When set, the child's final assistant message is stopReason "error" with this errorMessage. */
  fail?: string;
  /** Optional gate: the assistant result is not streamed until this resolves (keeps runs open across assertions). */
  respondAfter?: Promise<unknown>;
  /** Fixed usage reported by runtime.usage(). */
  usage?: Usage;
  /** When true the spawn task is accepted into the sink but the run never starts. */
  neverStart?: boolean;
}

export interface FakeFactoryHarness {
  factory: PrimeAgentRuntimeFactory;
  created: PrimeSubagentSpawnInput[];
  byChildId: (childId: string) => { agent: Agent; sink: RecordingSink; runtime: PrimeAgentRuntime; usage: Usage };
  /** Make ONE next create() call wait on the returned deferred before resolving. */
  deferNextCreate: () => { promise: Promise<PrimeAgentRuntimeBundle>; resolve: (value: PrimeAgentRuntimeBundle) => void; reject: (error: unknown) => void };
  /** Make ONE next create() call reject with this error. */
  failNextCreateWith: (error: Error) => void;
}

function assistantMessage(script: FakeChildScript, input: PrimeSubagentSpawnInput): AssistantMessage {
  const text = typeof script.text === "function" ? script.text(input) : (script.text ?? "done");
  const failing = script.fail !== undefined;
  return {
    role: "assistant",
    content: failing ? [] : [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "mock",
    usage: createUsage(0),
    stopReason: failing ? "error" : "stop",
    ...(failing ? { errorMessage: script.fail } : {}),
    timestamp: Date.now(),
  };
}

function createScriptedStream(script: FakeChildScript, input: PrimeSubagentSpawnInput): StreamFn {
  return (_model, _context) => {
    const stream = new AssistantMessageEventStream();
    const emit = () => {
      const message = assistantMessage(script, input);
      if (script.fail !== undefined) {
        stream.push({ type: "error", reason: "error", error: message });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
    };
    const gate = script.respondAfter;
    if (gate) {
      void gate.then(emit);
    } else {
      queueMicrotask(emit);
    }
    return stream;
  };
}

/**
 * The fake child runtime: a real Agent whose run starts when the scripted
 * spawn task arrives in the sink. stop(reason) aborts the loop and records
 * the reason so settlement assertions can see who stopped whom.
 */
export function createFakeFactory(scripts: { default?: FakeChildScript } = {}): FakeFactoryHarness {
  const created: PrimeSubagentSpawnInput[] = [];
  const bundles = new Map<string, { agent: Agent; sink: RecordingSink; runtime: PrimeAgentRuntime; usage: Usage }>();
  const deferredCreates: { promise: Promise<PrimeAgentRuntimeBundle>; resolve: (value: PrimeAgentRuntimeBundle) => void; reject: (error: unknown) => void }[] = [];
  const failures: Error[] = [];

  const buildBundle = (input: PrimeSubagentSpawnInput): PrimeAgentRuntimeBundle => {
    const script = scripts.default ?? {};
    const usage = script.usage ?? createUsage(0);
    const agent = new Agent({ streamFn: createScriptedStream(script, input) });
    const sink = new RecordingSink();
    const handle: PrimeSubagentHandle = Object.freeze({
      id: input.childId,
      name: input.name,
      role: "subagent",
      parentId: input.fromId,
      depth: input.depth,
      model: input.model,
      sessionPath: input.sessionPath,
      status: "running",
    });
    const runtime: PrimeAgentRuntime = Object.freeze({
      handle,
      agent,
      kernel: {} as unknown as PrimeKernelHost,
      execKernel: (_spec: KernelJobSpec): Promise<KernelJobResult> =>
        Promise.reject(new Error("test double does not execute kernel jobs")),
      usage: () => usage,
      stop: async (_reason: string): Promise<void> => {
        agent.abort();
      },
    });
    if (!script.neverStart) {
      sink.onAccept = (message) => {
        if (message.id.startsWith("spawn:")) {
          void agent.prompt(message.content).catch(() => undefined);
        }
      };
    }
    const value = { agent, sink, runtime, usage };
    bundles.set(input.childId, value);
    return { runtime, sink };
  };

  const factory: PrimeAgentRuntimeFactory = {
    create: (input) => {
      created.push(input);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure);
      const gate = deferredCreates.shift();
      if (gate) return gate.promise;
      return Promise.resolve(buildBundle(input));
    },
  };

  return {
    factory,
    created,
    byChildId: (childId) => {
      const hit = bundles.get(childId);
      if (!hit) throw new Error(`fake factory never created ${childId}`);
      return hit;
    },
    deferNextCreate: () => {
      const gate = createDeferred<PrimeAgentRuntimeBundle>();
      deferredCreates.push({ promise: gate.promise, resolve: gate.resolve, reject: gate.reject });
      // The deferred bundle must still be constructed lazily; handing the raw
      // factory bundle through makes stops-after-admission land on the same agent.
      return {
        promise: gate.promise,
        resolve: (value: PrimeAgentRuntimeBundle) => gate.resolve(value),
        reject: (error: unknown) => gate.reject(error),
      };
    },
    failNextCreateWith: (error: Error) => {
      failures.push(error);
    },
  };
}

/** Owner node for the registry under test, with its recording sink attached. */
export function createOwner(overrides: Partial<PrimeAgentNodeAttachment> = {}): {
  node: PrimeAgentNodeAttachment;
  sink: RecordingSink;
  recorder: RecordingRecorder;
} {
  const sink = new RecordingSink();
  const recorder = new RecordingRecorder();
  const node: PrimeAgentNodeAttachment = {
    id: "owner",
    name: "owner0",
    role: "root",
    depth: 0,
    model: createModel(),
    sessionPath: "/sessions/owner",
    sink,
    recorder,
    ...overrides,
  };
  return { node, sink, recorder };
}

/** One more attached catalog node (parent, sibling root, uncle, grandchild...). */
export function createAttached(overrides: Partial<PrimeAgentNodeAttachment> & { id: string }): {
  node: PrimeAgentNodeAttachment;
  sink: RecordingSink;
  recorder: RecordingRecorder;
} {
  const sink = new RecordingSink();
  const recorder = new RecordingRecorder();
  const node: PrimeAgentNodeAttachment = {
    name: overrides.id,
    role: "root",
    depth: 0,
    model: createModel(),
    sessionPath: `/sessions/${overrides.id}`,
    sink,
    recorder,
    ...overrides,
  };
  return { node, sink, recorder };
}

export function makeMessage(overrides: Partial<PrimeAgentMessage> & { id: string }): PrimeAgentMessage {
  return Object.freeze({
    fromId: "a",
    fromName: "a",
    toId: "b",
    toName: "b",
    content: "note",
    timestamp: Date.now(),
    ...overrides,
  });
}

export type { AgentMessage };
