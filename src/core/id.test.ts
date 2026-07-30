import { describe, expect, it } from "vitest";
import { randomUuid, UUID_V4_PATTERN } from "./id";

describe("randomUuid", () => {
  it("falls back to RFC 4122 UUIDv4 when randomUUID is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const value = randomUuid();
      expect(value).toMatch(UUID_V4_PATTERN);
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    }
  });
});
