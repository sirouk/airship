import { describe, expect, it } from "vitest";
import { oauthOriginState } from "./access-view";

describe("OAuth origin readiness", () => {
  it("enables only the exactly registered origin", () => {
    expect(oauthOriginState("http://localhost:4173", "http://localhost:4173").available).toBe(true);
    const wrong = oauthOriginState("http://localhost:4173", "http://127.0.0.1:4173");
    expect(wrong.available).toBe(false);
    expect(wrong.reason).toContain("http://localhost:4173");
  });
  it("fails closed for a malformed registration", () => expect(oauthOriginState("not a url", "http://localhost:4173").available).toBe(false));
});
