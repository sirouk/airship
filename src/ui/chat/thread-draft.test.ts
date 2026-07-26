import { describe, expect, it } from "vitest";
import { readThreadDraft, threadDraftKey, writeThreadDraft } from "./thread-draft";

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
});
