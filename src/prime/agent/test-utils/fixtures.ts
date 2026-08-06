import { EventStream } from "../../ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message, Model, UserMessage } from "../../ai/types";
import type { AgentMessage } from "../types";

/**
 * Shared test doubles for the agent-loop ports. Mirrors the helpers that
 * upstream packages/agent/test defines inline per file: a push-driven
 * AssistantMessage stream plus message/model factories. Kept in one place so
 * the two test files cannot drift apart on stream semantics.
 */

/** Mock stream for testing - mimics AssistantMessageEventStream. */
export class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      },
    );
  }
}

export class DelayedResultStream extends MockAssistantStream {
  constructor(private readonly getDelayedResult: () => Promise<AssistantMessage>) {
    super();
  }

  override result(): Promise<AssistantMessage> {
    return this.getDelayedResult();
  }
}

export class ThrowingResultStream extends MockAssistantStream {
  constructor(
    private readonly onResult: () => void,
    private readonly error: Error,
  ) {
    super();
  }

  override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return {
      next: async () => ({ done: true, value: undefined as never }),
    };
  }

  override result(): Promise<AssistantMessage> {
    this.onResult();
    throw this.error;
  }
}

export function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Upstream pulls catalog models via getModel(); the ported ai layer ships no
 * generated catalog, so tests construct an equivalent model literal. The
 * provider is never invoked for these ids in any test below.
 */
export function createModel(): Model<"openai-responses"> {
  return {
    id: "mock",
    name: "mock",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

export function createAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "mock",
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

export function createUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

/** Simple identity converter for tests - just passes through standard messages. */
export function identityConverter(messages: AgentMessage[]): Message[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

export function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
