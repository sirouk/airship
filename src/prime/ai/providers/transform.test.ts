import { describe, expect, it } from "vitest";
import type { AssistantMessage, ImageContent, Message, Model, ToolResultMessage } from "../types";
import { transformMessages } from "./transform";

/**
 * transformMessages conformance: cross-model replay policy, tool-call id
 * normalization with result rewriting, non-vision image downgrade, and
 * orphan tool-call healing.
 */

const USAGE_ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(overrides: Partial<Model<"test-api">> = {}): Model<"test-api"> {
  return {
    id: "m1",
    name: "m1",
    api: "test-api" as "test-api" & string,
    provider: "test-provider",
    baseUrl: "https://example.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
    ...overrides,
  } as Model<"test-api">;
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "m1",
    usage: { ...USAGE_ZERO, cost: { ...USAGE_ZERO.cost } },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

const user = (content: string | ({ type: "text"; text: string } | ImageContent)[]): Message =>
  ({ role: "user", content, timestamp: 0 }) as Message;

describe("transformMessages", () => {
  it("keeps thinking blocks with signatures for the exact same model triple", () => {
    const model = createModel();
    const thinking = { type: "thinking" as const, thinking: "reasoned", thinkingSignature: "sig" };
    const out = transformMessages([user("q"), assistant([thinking])], model);
    expect((out[1] as AssistantMessage).content[0]).toEqual(thinking);
  });

  it("downgrades cross-model thinking to plain text and drops redacted/empty thinking", () => {
    const model = createModel({ id: "m2" });
    const out = transformMessages(
      [
        user("q"),
        assistant([
          { type: "thinking", thinking: "reasoned", thinkingSignature: "sig" },
          { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "enc", redacted: true },
          { type: "thinking", thinking: "", thinkingSignature: "sig" },
          { type: "text", text: "answer", textSignature: "textsig" },
          { type: "toolCall", id: "c1", name: "read", arguments: {}, thoughtSignature: "ts" },
        ]),
      ],
      model,
    );
    const content = (out[1] as AssistantMessage).content;
    expect(content[0]).toEqual({ type: "text", text: "reasoned" });
    expect(content[1]).toEqual({ type: "text", text: "answer" });
    expect(content).toHaveLength(3);
    const call = content[2];
    expect(call.type).toBe("toolCall");
    expect("thoughtSignature" in call).toBe(false);
  });

  it("normalizes tool call ids through the map and rewrites matching tool results", () => {
    const model = createModel({ provider: "other-provider" }); // different provider -> cross-provider ids normalized
    const messages: Message[] = [
      user("q"),
      assistant([{ type: "toolCall", id: "call/odd+chars==", name: "read", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "call/odd+chars==",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 2,
      } satisfies ToolResultMessage,
    ];
    const normalize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const out = transformMessages(messages, model, normalize);
    const call = (out[1] as AssistantMessage).content[0];
    expect((call as { id: string }).id).toBe("call_odd_chars__");
    expect((out[2] as ToolResultMessage).toolCallId).toBe("call_odd_chars__");
  });

  it("does not rewrite ids for same-model tool calls", () => {
    const model = createModel();
    const messages: Message[] = [
      user("q"),
      assistant([{ type: "toolCall", id: "toolu_fine", name: "read", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "toolu_fine",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 2,
      } satisfies ToolResultMessage,
    ];
    const out = transformMessages(messages, model, (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64));
    expect((out[2] as ToolResultMessage).toolCallId).toBe("toolu_fine");
  });

  it("replaces images with placeholders when the model lacks image input, deduping runs", () => {
    const model = createModel({ input: ["text"] });
    const image = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
    const out = transformMessages(
      [user([{ type: "text", text: "look" }, image("A"), image("B"), { type: "text", text: "again" }])],
      model,
    );
    expect(out[0].role).toBe("user");
    const content = (out[0] as { content: unknown }).content;
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "(image omitted: model does not support images)" },
      { type: "text", text: "again" },
    ]);
  });

  it("drops errored and aborted assistant messages from replay", () => {
    const model = createModel();
    const out = transformMessages(
      [
        user("q"),
        assistant([{ type: "text", text: "kept" }]),
        assistant([{ type: "text", text: "dropped-error" }], { stopReason: "error", errorMessage: "x" }),
        assistant([{ type: "text", text: "dropped-abort" }], { stopReason: "aborted" }),
        user("next"),
      ],
      model,
    );
    const texts = out
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m as AssistantMessage).content)
      .map((b) => (b.type === "text" ? b.text : b.type));
    expect(texts).toEqual(["kept"]);
  });

  it("heals orphan tool calls with synthetic error results at the next boundary and at end", () => {
    const model = createModel();
    const toolAssistant = assistant([
      { type: "toolCall", id: "resolved", name: "read", arguments: {} },
      { type: "toolCall", id: "orphan", name: "grep", arguments: {} },
    ]);
    const messages: Message[] = [
      user("q"),
      toolAssistant,
      {
        role: "toolResult",
        toolCallId: "resolved",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 2,
      } satisfies ToolResultMessage,
      user("interruption"),
      assistant([{ type: "toolCall", id: "tail-orphan", name: "bash", arguments: {} }]),
    ];
    const out = transformMessages(messages, model);

    // boundary healing between the resolved result and the user message
    const healIdx = out.findIndex((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "orphan");
    expect(healIdx).toBeGreaterThan(-1);
    const healed = out[healIdx] as ToolResultMessage;
    expect(healed).toMatchObject({ toolName: "grep", isError: true });
    expect(healed.content).toEqual([{ type: "text", text: "No result provided" }]);
    // healed result lands before the interruption user message
    expect(out[healIdx + 1].role).toBe("user");

    // conversation-end healing for the tail orphan
    const tail = out[out.length - 1] as ToolResultMessage;
    expect(tail.role).toBe("toolResult");
    expect(tail).toMatchObject({ toolCallId: "tail-orphan", isError: true });
  });
});
