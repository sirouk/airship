import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../types";
import { getApiProvider } from "../registry";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "./faux.test-support";
import { collectEvents, expectEventProtocolConformance } from "./provider.test-support";

/** Faux provider: deterministic scripted streaming for harness tests. */

let registration: FauxProviderRegistration | undefined;
afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

describe("registerFauxProvider", () => {
  it("registers a resolvable api provider and unregisters by source id", () => {
    registration = registerFauxProvider({ api: "faux-test-reg" });
    expect(getApiProvider("faux-test-reg")).toBeDefined();
    expect(registration.models).toHaveLength(1);
    expect(registration.getModel()).toBe(registration.models[0]);
    expect(registration.getModel("does-not-exist")).toBeUndefined();
    registration.unregister();
    expect(getApiProvider("faux-test-reg")).toBeUndefined();
  });

  it("streams scripted text with the full event lattice and deterministic result", async () => {
    registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("Hello there")]);
    const model = registration.getModel();

    const events = await collectEvents(getApiProvider(registration.api)!.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }));
    expectEventProtocolConformance(events);
    const done = events[events.length - 1];
    if (done.type !== "done") throw new Error("expected done");
    expect(done.message.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(done.message.usage.output).toBeGreaterThan(0);
    expect(registration.state.callCount).toBe(1);
    expect(registration.getPendingResponseCount()).toBe(0);
  });

  it("streams thinking and tool call blocks", async () => {
    registration = registerFauxProvider();
    const call = fauxToolCall("read", { path: "a.ts" }, { id: "c1" });
    registration.setResponses([
      {
        role: "assistant",
        content: [fauxThinking("hmm"), call],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 0,
      },
    ]);
    const events = await collectEvents(
      getApiProvider(registration.api)!.stream(registration.getModel(), { messages: [{ role: "user", content: "go", timestamp: 1 }] }),
    );
    expectEventProtocolConformance(events);
    const done = events[events.length - 1];
    if (done.type !== "done") throw new Error("expected done");
    expect(done.message.stopReason).toBe("toolUse");
    const toolCall = done.message.content.find((b) => b.type === "toolCall") as ToolCall;
    expect(toolCall.arguments).toEqual({ path: "a.ts" });
  });

  it("serves a queued sequence in order and reports queue state", async () => {
    registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("one")]);
    registration.appendResponses([fauxAssistantMessage("two")]);
    expect(registration.getPendingResponseCount()).toBe(2);

    const model = registration.getModel();
    const provider = getApiProvider(registration.api)!;
    const first = await provider.stream(model, { messages: [{ role: "user", content: "a", timestamp: 1 }] }).result();
    const second = await provider.stream(model, { messages: [{ role: "user", content: "b", timestamp: 2 }] }).result();
    expect(first.content).toEqual([{ type: "text", text: "one" }]);
    expect(second.content).toEqual([{ type: "text", text: "two" }]);
    expect(registration.getPendingResponseCount()).toBe(0);
  });

  it("fails with an error event when the queue is exhausted", async () => {
    registration = registerFauxProvider();
    const events = await collectEvents(
      getApiProvider(registration.api)!.stream(registration.getModel(), { messages: [{ role: "user", content: "a", timestamp: 1 }] }),
    );
    const terminal = events[events.length - 1];
    if (terminal.type !== "error") throw new Error("expected error event");
    expect(terminal.error.errorMessage).toBe("No more faux responses queued");
    expect(terminal.error.stopReason).toBe("error");
  });

  it("estimates cache usage across calls within a session", async () => {
    registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const model = registration.getModel();
    const provider = getApiProvider(registration.api)!;
    const context = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "same prefix please", timestamp: 1 }] };

    const first = await provider.stream(model, context, { sessionId: "s1" }).result();
    expect(first.usage.cacheWrite).toBeGreaterThan(0);
    expect(first.usage.cacheRead).toBe(0);

    const second = await provider.stream(model, context, { sessionId: "s1" }).result();
    expect(second.usage.cacheRead).toBeGreaterThan(0);

    // cacheRetention none disables the accounting entirely
    registration.setResponses([fauxAssistantMessage("three")]);
    const third = await provider.stream(model, context, { sessionId: "s1", cacheRetention: "none" }).result();
    expect(third.usage.cacheRead).toBe(0);
    expect(third.usage.cacheWrite).toBe(0);
  });

  it("surfaces factory errors as error events and supports async factories receiving state", async () => {
    registration = registerFauxProvider();
    registration.setResponses([
      async (_context, _options, state) => {
        if (state.callCount !== 1) throw new Error("expected callCount 1");
        throw new Error("factory blew up");
      },
    ]);
    const terminal = (await collectEvents(
      getApiProvider(registration.api)!.stream(registration.getModel(), { messages: [{ role: "user", content: "a", timestamp: 1 }] }),
    )).at(-1);
    if (terminal?.type !== "error") throw new Error("expected error event");
    expect(terminal.error.errorMessage).toBe("factory blew up");
  });

  it("aborts with stopReason aborted when the signal fires mid-stream", { timeout: 20_000 }, async () => {
    registration = registerFauxProvider({ tokensPerSecond: 1 });
    registration.setResponses([fauxAssistantMessage("a long answer that takes many slow chunks")]);
    const controller = new AbortController();
    const eventsPromise = collectEvents(
      getApiProvider(registration.api)!.stream(registration.getModel(), { messages: [{ role: "user", content: "a", timestamp: 1 }] }, {
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 50);
    const events = await eventsPromise;
    const terminal = events[events.length - 1];
    if (terminal.type !== "error") throw new Error("expected error event");
    expect(terminal.reason).toBe("aborted");
    expect(terminal.error.errorMessage).toBe("Request was aborted");
  });
});
