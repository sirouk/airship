import { describe, expect, it } from "vitest";
import {
  browserThreadViewportStorage,
  readThreadViewport,
  threadViewportStorageKey,
  writeThreadViewport,
} from "./thread-viewport";

describe("profile-scoped transcript viewport state", () => {
  it("restores A after B without allowing profile/session tuple collisions", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    writeThreadViewport("profile/a", "thread", { scrollTop: 318, pinnedToLatest: false }, storage);
    writeThreadViewport("profile", "a/thread", { scrollTop: 902, pinnedToLatest: true }, storage);

    expect(threadViewportStorageKey("profile/a", "thread"))
      .not.toBe(threadViewportStorageKey("profile", "a/thread"));
    expect(readThreadViewport("profile", "a/thread", storage)).toEqual({
      scrollTop: 902,
      pinnedToLatest: true,
    });
    expect(readThreadViewport("profile/a", "thread", storage)).toEqual({
      scrollTop: 318,
      pinnedToLatest: false,
    });
  });

  it("rejects malformed state and bounds hostile geometry", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const key = threadViewportStorageKey("alpha", "session-a");
    values.set(key, JSON.stringify({ scrollTop: "other profile", pinnedToLatest: false }));
    expect(readThreadViewport("alpha", "session-a", storage)).toBeUndefined();

    writeThreadViewport("alpha", "session-a", { scrollTop: Number.POSITIVE_INFINITY, pinnedToLatest: false }, storage);
    expect(readThreadViewport("alpha", "session-a", storage)?.scrollTop).toBe(0);
    writeThreadViewport("alpha", "session-a", { scrollTop: -50, pinnedToLatest: false }, storage);
    expect(readThreadViewport("alpha", "session-a", storage)?.scrollTop).toBe(0);
  });

  it("treats a throwing browser storage getter as unavailable", () => {
    expect(browserThreadViewportStorage(() => {
      throw new DOMException("denied", "SecurityError");
    })).toBeUndefined();
  });
});
