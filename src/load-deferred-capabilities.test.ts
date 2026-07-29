import { describe, expect, it, vi } from "vitest";
import { createRetryableDeferredLoader } from "./load-deferred-capabilities";

describe("retryable deferred capability loading", () => {
  it("shares an in-flight generation and clears only a rejected generation", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("transient chunk read"))
      .mockResolvedValueOnce({ generation: 2 });
    const deferred = createRetryableDeferredLoader(load);

    const first = deferred();
    expect(deferred()).toBe(first);
    await expect(first).rejects.toThrow("transient chunk read");

    const retry = deferred();
    await expect(retry).resolves.toEqual({ generation: 2 });
    expect(deferred()).toBe(retry);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
