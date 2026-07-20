import { describe, expect, it } from "vitest";
import { applyLocalDevelopmentPolicy } from "./vite.config";

describe("local development CSP", () => {
  it("adds only the reviewed loopback S3 origins and development style exception", () => {
    const source = "style-src 'self'; connect-src 'self' https://api.chutes.ai;";
    const transformed = applyLocalDevelopmentPolicy(source);
    expect(transformed).toBe(
      "style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:9900 http://127.0.0.1:9900 https://api.chutes.ai;",
    );
  });

  it("does not widen unrelated or already-missing directives", () => {
    expect(applyLocalDevelopmentPolicy("default-src 'self';")).toBe("default-src 'self';");
  });
});
