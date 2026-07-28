import { describe, expect, it } from "vitest";
import { chatHash, chatSessionIdFromHash, isAddressedChatHash } from "./chat-route";

describe("addressable conversation routes", () => {
  it("round-trips an opaque journal session ID", () => {
    const id = "018f40e0-7c62-7c70-9db7-6d5de37ae52c";
    expect(chatHash(id)).toBe(`#chat/${id}`);
    expect(chatSessionIdFromHash(chatHash(id))).toBe(id);
    expect(isAddressedChatHash(chatHash(id))).toBe(true);
  });

  it("keeps the empty new-chat route distinct until a session exists", () => {
    expect(chatHash()).toBe("#chat");
    expect(chatSessionIdFromHash("#chat")).toBeUndefined();
    expect(isAddressedChatHash("#chat")).toBe(false);
  });

  it("rejects malformed, path-like, and oversized identifiers", () => {
    expect(chatSessionIdFromHash("#chat/%E0%A4%A")).toBeUndefined();
    expect(chatSessionIdFromHash("#chat/..%2Fsecret")).toBeUndefined();
    expect(chatSessionIdFromHash("#chat/id%3Fproof")).toBeUndefined();
    expect(chatSessionIdFromHash(`#chat/${"a".repeat(513)}`)).toBeUndefined();
    expect(() => chatHash(" ../escape")).toThrow(TypeError);
  });
});
