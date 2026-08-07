import { describe, expect, it } from "vitest";
import type { InferenceRequest } from "../../core/contracts";
import { buildOpenAiPayload, OpenAiStreamAssembler } from "./openai";

describe("buildOpenAiPayload multimodal serialization", () => {
  it("serializes canonical user images as OpenAI image_url content parts", () => {
    const payload = buildOpenAiPayload(requestWithImages());

    expect(payload.messages).toEqual([
      { role: "system", content: "You are Airship." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ],
      },
    ]);
    expect(JSON.stringify(payload)).toContain("data:image/png;base64,AQID");
  });

  it("rejects image inputs on non-user messages", () => {
    const request = requestWithImages();
    request.messages = [{ ...request.messages[0]!, role: "assistant" }];

    expect(() => buildOpenAiPayload(request)).toThrow("only valid on user messages");
  });
});

describe("OpenAiStreamAssembler private reasoning boundary", () => {
  it("reports the phase once and carries every provider-exposed chunk as reasoning, never as answer text", () => {
    const assembler = new OpenAiStreamAssembler({ maxToolCalls: 8, maxToolArgumentsChars: 8_192 });
    const first = assembler.consume(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "plan one" }, finish_reason: null }] }));
    const second = assembler.consume(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "plan two", content: "Visible" }, finish_reason: "stop" }] }));

    expect(first).toEqual([
      { type: "progress", phase: "reasoning" },
      { type: "reasoning-delta", text: "plan one" },
    ]);
    // The phase signal fires exactly once; the text keeps arriving as reasoning.
    expect(second).toEqual([
      { type: "reasoning-delta", text: "plan two" },
      { type: "text-delta", text: "Visible" },
    ]);
    // What the provider exposed rides its own event type; the answer stays clean.
    expect(second.some((event) => event.type === "text-delta" && "text" in event && event.text.includes("plan"))).toBe(false);
    expect(assembler.finalize()).toMatchObject({ finishReason: "stop", toolCalls: [] });
  });

  it("fails closed when a model completes with private reasoning but no visible result", () => {
    const assembler = new OpenAiStreamAssembler({ maxToolCalls: 8, maxToolArgumentsChars: 8_192 });
    assembler.consume(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "hidden" }, finish_reason: "stop" }] }));

    expect(() => assembler.finalize()).toThrow("without a user-visible response or tool call");
  });
});

function requestWithImages(): InferenceRequest {
  return {
    requestId: "request",
    sessionId: "session",
    turnId: "turn",
    model: "vision-model",
    systemPrompt: "You are Airship.",
    messages: [{
      role: "user",
      content: "Inspect this image.",
      images: [{
        type: "image",
        name: "image.png",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,AQID",
        sizeBytes: 3,
      }],
    }],
    tools: [],
    idempotencyKey: "idempotency",
  };
}
