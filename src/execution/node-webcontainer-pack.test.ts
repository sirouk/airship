import { describe, expect, it, vi } from "vitest";
import { awaitBoundedWebContainerBoot } from "./node-webcontainer-pack";

describe("bounded WebContainer boot", () => {
  it("rejects a provider boot that never settles", async () => {
    vi.useFakeTimers();
    const result = awaitBoundedWebContainerBoot(new Promise<never>(() => undefined), 1_000, new AbortController().signal);
    const rejection = expect(result).rejects.toThrow("activation exceeded 1000 ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    vi.useRealTimers();
  });

  it("honors cancellation before a provider result arrives", async () => {
    const controller = new AbortController();
    const result = awaitBoundedWebContainerBoot(new Promise<never>(() => undefined), 30_000, controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
