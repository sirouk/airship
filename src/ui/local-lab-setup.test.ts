import { describe, expect, it } from "vitest";
import { LOCAL_LAB_DEFAULT_ENDPOINT } from "./local-lab-setup";

describe("mounted local lab defaults", () => {
  it("uses the same loopback endpoint as the full-system lab", () => {
    expect(LOCAL_LAB_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:9900");
    expect(new URL(LOCAL_LAB_DEFAULT_ENDPOINT).hostname).toBe("127.0.0.1");
  });
});
