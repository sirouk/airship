import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport, ToolContext, ToolDefinition } from "../core/contracts";
import { reviewToolActionWithModel } from "./model-reviewer";

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
