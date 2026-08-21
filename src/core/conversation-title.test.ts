import { describe, expect, it } from "vitest";
import { conversationTitleFromPrompt } from "./conversation-title";

describe("conversationTitleFromPrompt", () => {
  it("normalizes a first prompt without a provider request", () => {
    expect(conversationTitleFromPrompt("  draft the\nQ3   pricing memo  ")).toBe("draft the Q3 pricing memo");
    expect(conversationTitleFromPrompt("\u0001\u007f")).toBe("");
  });

  it("bounds a title to 64 printable characters", () => {
    const title = conversationTitleFromPrompt("a".repeat(200));
    expect(title).toHaveLength(64);
    expect(title.endsWith("…")).toBe(true);
  });
});
