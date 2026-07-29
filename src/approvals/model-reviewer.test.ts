import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport, ToolContext, ToolDefinition } from "../core/contracts";
import { reviewToolActionWithModel, withholdPrivatePayloads } from "./model-reviewer";

const tool: ToolDefinition = { name: "network_send", description: "Send data", effect: "network", inputSchema: {} };
const context: ToolContext = { sessionId: "session", turnId: "turn", operationId: "operation", signal: new AbortController().signal };

class FixtureTransport implements InferenceTransport {
  readonly id = "fixture";
  readonly posture = "local" as const;
  request?: InferenceRequest;

  constructor(private readonly events: readonly InferenceEvent[]) {}

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.request = request;
    for (const event of this.events) yield event;
  }
}

describe("model approval reviewer", () => {
  it("uses a separate tool-free inference and accepts strict structured output", async () => {
    const transport = new FixtureTransport([
      { type: "text-delta", text: '{"verdict":"safe","reason":"bounded write"}' },
      { type: "completed", finishReason: "stop" },
    ]);
    const result = await reviewToolActionWithModel({
      transport,
      model: "review-model",
      tool,
      argumentsValue: { apiKey: "must-not-leave", destination: "approved.invalid", content: "private workspace bytes" },
      context,
    });
    expect(result).toMatchObject({ verdict: "safe", reason: "bounded write", model: "review-model" });
    expect(transport.request?.tools).toEqual([]);
    expect(transport.request?.turnId).toContain("approval-review");
    expect(transport.request?.messages[0]?.content).not.toContain("must-not-leave");
    expect(transport.request?.messages[0]?.content).not.toContain("private workspace bytes");
    expect(transport.request?.messages[0]?.content).toContain("[redacted]");
    expect(transport.request?.messages[0]?.content).toContain("[withheld string:");
  });

  it("returns what the review itself cost, so an unseen provider request stays recordable", async () => {
    const transport = new FixtureTransport([
      { type: "text-delta", text: '{"verdict":"safe","reason":"bounded write"}' },
      { type: "usage", inputTokens: 412, outputTokens: 19 },
      { type: "completed", finishReason: "stop" },
    ]);
    await expect(reviewToolActionWithModel({ transport, model: "review-model", tool, argumentsValue: {}, context }))
      .resolves.toMatchObject({ verdict: "safe", inputTokens: 412, outputTokens: 19 });

    // A transport that reports nothing must not be turned into a zero: an
    // unreported cost is unknown, not free.
    const silent = new FixtureTransport([
      { type: "text-delta", text: '{"verdict":"safe","reason":"bounded write"}' },
      { type: "completed", finishReason: "stop" },
    ]);
    const unreported = await reviewToolActionWithModel({ transport: silent, model: "m", tool, argumentsValue: {}, context });
    expect(unreported.inputTokens).toBeUndefined();
    expect(unreported.outputTokens).toBeUndefined();
  });

  it("withholds file-content payloads and deliberately keeps the action body", async () => {
    // The reviewer cannot judge an action it cannot see. This pins the real
    // boundary so the user-facing copy has something to be measured against:
    // "only bounded metadata" was never true of a script, command or URL.
    const shown = withholdPrivatePayloads({
      script: "rm -rf /workspace/notes",
      url: "https://example.invalid/collect",
      command: "sh",
      content: "private workspace bytes",
    });

    expect(shown).toMatchObject({
      script: "rm -rf /workspace/notes",
      url: "https://example.invalid/collect",
      command: "sh",
    });
    expect((shown as Record<string, string>).content).toContain("[withheld string:");
  });

  it("rejects recursive tool calls and malformed or incomplete output", async () => {
    const recursive = new FixtureTransport([
      { type: "tool-call", call: { id: "nested", name: "write_file", arguments: {} } },
      { type: "completed", finishReason: "tool-calls" },
    ]);
    await expect(reviewToolActionWithModel({ transport: recursive, model: "m", tool, argumentsValue: {}, context }))
      .resolves.toMatchObject({ verdict: "indeterminate", reason: expect.stringContaining("recursive") });

    const malformed = new FixtureTransport([
      { type: "text-delta", text: "SAFE" },
      { type: "completed", finishReason: "stop" },
    ]);
    await expect(reviewToolActionWithModel({ transport: malformed, model: "m", tool, argumentsValue: {}, context }))
      .resolves.toMatchObject({ verdict: "indeterminate", reason: expect.stringContaining("malformed") });
  });
});
