import { describe, expect, it } from "vitest";
import { randomUuid } from "./id";

describe("randomUuid", () => {
  it("falls back to RFC 4122 UUIDv4 when randomUUID is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      const value = randomUuid();
      expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    }
  });
});
