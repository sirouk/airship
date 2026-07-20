import { describe, expect, it, vi } from "vitest";
import { TranscriptStreamStore } from "./streaming-slot";

describe("isolated transcript stream slots", () => {
  it("notifies only the in-flight message subscriber", () => {
    const store = new TranscriptStreamStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("first", first);
    store.subscribe("second", second);
    store.append("second", "token");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(store.read("second")).toBe("token");
  });

  it("atomically drains partial output for terminal recovery", () => {
    const store = new TranscriptStreamStore();
    store.append("turn", "partial");
    expect(store.take("turn")).toBe("partial");
    expect(store.read("turn")).toBe("");
  });
});
