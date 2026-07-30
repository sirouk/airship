import { describe, expect, it } from "vitest";

import { readAuthorizationCode } from "./authorization-code-paste";

/*
 * Pass 3 — adversarial load for the paste box every OAuth credential journeys
 * through. The parser is the authority for what may be submitted to a token
 * endpoint, which makes it also the authority for what may *not* be: a paste
 * of ten megabytes, a javascript: address, or a code assembled from invisible
 * characters must all be refused here, plainly, without a downstream fetch.
 */
describe("adversarial authorization-code pastes", () => {
  it("refuses inputs past the size bound, regardless of content", () => {
    const oversized = "a".repeat(8_200);
    const reading = readAuthorizationCode(oversized);
    expect(reading.kind).toBe("rejected");
    if (reading.kind === "rejected") expect(reading.reason).toBe("input-too-long");
  });

  it("refuses non-HTTP schemes and script sinks", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "vbscript:x",
    ]) {
      const reading = readAuthorizationCode(hostile);
      expect(reading.kind, hostile).toBe("rejected");
    }
  });

  it("refuses invisible characters before they can corrupt the exchange", () => {
    for (const hostile of ["ac_e2e\0x", "ac_e2e\nx", "ac_e2e​x", "ac_e2e\tx"]) {
      const reading = readAuthorizationCode(hostile);
      expect(reading.kind, JSON.stringify(hostile)).toBe("rejected");
    }
  });

  it("never emits a code longer than the exchange's bound", () => {
    const withLongQuery = `http://localhost:1456/cb?code=${"c".repeat(10_000)}`;
    const reading = readAuthorizationCode(withLongQuery);
    if (reading.kind === "accepted") {
      expect(reading.code.length).toBeLessThanOrEqual(4_096);
    } else {
      expect(reading.kind).toBe("rejected");
    }
  });

  it("still accepts a code through an ordinary loopback failure address", () => {
    const reading = readAuthorizationCode("http://localhost:1455/auth/callback?code=ac_e2e_1a2b3c&state=st_e2e");
    expect(reading.kind).toBe("accepted");
    if (reading.kind === "accepted") expect(reading.code).toBe("ac_e2e_1a2b3c");
  });
});
