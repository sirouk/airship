import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mergePendingToolOutput, type PendingToolOutputUpdate } from "./app";

/**
 * The `tool-output` signal fires per stream write. Applying each chunk to
 * `setMessages` rebuilt the whole messages array and re-rendered every
 * visible transcript card per chunk, while the sibling text-delta path is
 * rAF-batched. These tests pin the buffer's merge semantics and the source
 * contract that live tool output now shares that batching cadence.
 */
describe("mergePendingToolOutput", () => {
  const chunk = (stream: PendingToolOutputUpdate["stream"], text: string) => ({ stream, text });

  it("accumulates chunks per operation in arrival order, keeping the latest stream", () => {
    const updates = new Map<string, PendingToolOutputUpdate>();
    mergePendingToolOutput(updates, "op-1", chunk("stdout", "hello "));
    mergePendingToolOutput(updates, "op-1", chunk("stderr", "world"));
    expect(updates.get("op-1")).toEqual({ operationId: "op-1", stream: "stderr", text: "hello world" });
    expect(updates.size).toBe(1);
  });

  it("buffers the latest update per operationId without dropping other operations", () => {
    const updates = new Map<string, PendingToolOutputUpdate>();
    mergePendingToolOutput(updates, "op-1", chunk("stdout", "a"));
    mergePendingToolOutput(updates, "op-2", chunk("combined", "b"));
    mergePendingToolOutput(updates, "op-1", chunk("stdout", "c"));
    // Insertion order is arrival order, so the flush applies operations in
    // the order they first reported, exactly as unbatched writes would land.
    expect([...updates.keys()]).toEqual(["op-1", "op-2"]);
    expect(updates.get("op-1")?.text).toBe("ac");
    expect(updates.get("op-2")?.text).toBe("b");
  });

  it("keeps only the tail the live panel renders", () => {
    const updates = new Map<string, PendingToolOutputUpdate>();
    mergePendingToolOutput(updates, "op-1", chunk("stdout", "x".repeat(40_000)));
    mergePendingToolOutput(updates, "op-1", chunk("stdout", "tail"));
    const buffered = updates.get("op-1");
    expect(buffered?.text.length).toBe(32_768);
    expect(buffered?.text.endsWith("tail")).toBe(true);
  });
});

const appSource = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

describe("tool-output batching source contract", () => {
  it("the tool-output signal branch buffers instead of touching messages directly", () => {
    const start = appSource.indexOf('signal.type === "tool-output"');
    expect(start, "the tool-output signal branch must exist").toBeGreaterThan(-1);
    const branch = appSource.slice(start, start + 400);
    expect(branch).toContain("queueToolOutput(assistantId, signal)");
    expect(branch, "no per-chunk transcript rebuild").not.toContain("setMessages(");
  });

  it("all buffered updates land in ONE setMessages from the frame flush", () => {
    const queueStart = appSource.indexOf("function queueToolOutput");
    const flushStart = appSource.indexOf("function flushPendingToolOutput");
    expect(queueStart).toBeGreaterThan(-1);
    expect(flushStart).toBeGreaterThan(queueStart);
    const queueBody = appSource.slice(queueStart, flushStart);
    expect(queueBody, "queueing must not rebuild messages itself").not.toContain("setMessages(");
    expect(queueBody, "buffered updates flush on an animation frame").toContain("requestAnimationFrame(flushPendingToolOutput)");
    const flushBody = appSource.slice(flushStart, flushStart + 1_500);
    expect(flushBody).toContain("setMessages(");
  });

  it("turn completion and failure paths flush synchronously so nothing is lost", () => {
    expect(appSource).toContain("clearPendingDelta(assistantId);\n      // Flush before the terminal stamp");
    expect(appSource).toContain('pendingDelta.current.text : ""}`;\n      clearPendingDelta(assistantId);\n      flushPendingToolOutput();');
  });

  it("cancels a pending frame on unmount", () => {
    const cleanup = appSource.slice(
      appSource.indexOf("abortAllTurns();"),
      appSource.indexOf("abortAllTurns();") + 400,
    );
    expect(cleanup).toContain("cancelAnimationFrame(pendingToolOutputFrame.current)");
  });
});
