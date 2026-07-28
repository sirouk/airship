import { describe, expect, it } from "vitest";
import {
  claimThreadDraftHydration,
  readThreadDraft,
  threadDraftKey,
  writeThreadDraft,
} from "./thread-draft";

describe("thread drafts", () => {
  it("isolates drafts by opaque conversation identity", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    writeThreadDraft("session-a", "alpha", storage);
    writeThreadDraft("session-b", "bravo", storage);
    expect(readThreadDraft("session-a", storage)).toBe("alpha");
    expect(readThreadDraft("session-b", storage)).toBe("bravo");
    expect(threadDraftKey("session-a")).not.toBe(threadDraftKey("session-b"));
  });

  it("fails closed on malformed optional storage", () => {
    expect(readThreadDraft("session-a", { getItem: () => "not-json" })).toBe("");
    const values = new Map([["seed", "value"]]);
    writeThreadDraft("session-a", "", {
      setItem: () => undefined,
      removeItem: (key) => { values.set(key, "removed"); },
    });
    expect([...values.values()]).toContain("removed");
  });

  it("hydrates each effective identity once while route state normalizes", () => {
    const fence: { current: string | undefined } = { current: undefined };

    expect(claimThreadDraftHydration(fence, "session-b")).toBe("hydrate");
    // The route request cleared after session-b became active. The effective
    // identity did not change, so this must not hydrate an empty draft again.
    expect(claimThreadDraftHydration(fence, "session-b")).toBe("unchanged");

    expect(claimThreadDraftHydration(fence, "session-a")).toBe("hydrate");
    expect(claimThreadDraftHydration(fence, "session-b")).toBe("hydrate");
  });

  it("protects a fork prefill through the same-identity normalization pass", () => {
    const fence: { current: string | undefined } = { current: "source-session" };

    expect(claimThreadDraftHydration(fence, "fork-session", "fork-session")).toBe("preserve");
    expect(claimThreadDraftHydration(fence, "fork-session")).toBe("unchanged");
  });
});
