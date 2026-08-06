import { describe, expect, it } from "vitest";
import { hasApiProvider, registeredApis, resolveApiProvider, stream } from "../index";
import type { Context, Model } from "../types";
import { collectEvents, sseJson, sseResponse, stubFetch } from "./test-helpers";

/**
 * register-builtins wiring: the three ported providers are lazy-loaded
 * through the registry on first use, and stream() drives the resolved
 * provider end to end.
 */

describe("builtin provider registration", () => {
  it("advertises the three ported APIs without eager provider state", () => {
    expect(hasApiProvider("anthropic-messages")).toBe(true);
    expect(hasApiProvider("openai-completions")).toBe(true);
    expect(hasApiProvider("openai-responses")).toBe(true);
    expect(registeredApis()).toEqual(
      expect.arrayContaining(["anthropic-messages", "openai-completions", "openai-responses"]),
    );
  });

  it("resolves each lazy loader to a provider with a matching api id", async () => {
    for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
      const provider = await resolveApiProvider(api);
      expect(provider?.api).toBe(api);
      expect(typeof provider?.stream).toBe("function");
      expect(typeof provider?.streamSimple).toBe("function");
    }
  });

  it("drives the anthropic provider through stream() with lazy loading", async () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    };
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    const stub = stubFetch(() =>
      sseResponse([
        sseJson("message_start", {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        }),
        sseJson("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sseJson("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lazy" } }),
        sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseJson("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
        sseJson("message_stop", { type: "message_stop" }),
      ]),
    );
    try {
      const events = await collectEvents(stream(model, context, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "done") throw new Error("expected done");
      expect(terminal.message.content).toEqual([{ type: "text", text: "lazy" }]);
      // request went through the ported header/payload path
      expect(stub.requests[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(stub.requests[0].headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      stub.restore();
    }
  });
});
