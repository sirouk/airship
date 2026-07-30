import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { completedTurnLabel, evidenceRecordLabel } from "./mobile-navigation";

const source = readFileSync(new URL("./mobile-navigation.tsx", import.meta.url), "utf8");

describe("mobile navigation badges", () => {
  it("labels completed work as completed and routes evidence to Trust", () => {
    expect(completedTurnLabel(1)).toBe("1 completed turn");
    expect(completedTurnLabel(5)).toBe("5 completed turns");
    expect(evidenceRecordLabel(1)).toBe("1 evidence record");
    expect(evidenceRecordLabel(5)).toBe("5 evidence records");
    expect(source).not.toContain("pendingLabel(");
    expect(source).not.toContain('control.id === "more"\n              ? attestationNoticeCount');
  });

  it("uses a neutral Proof-presence dot when no evidence record count exists", () => {
    expect(source).toContain("proofPresence");
    expect(source).toContain("mobile-nav__badge--presence");
    expect(source).toContain("Proof available");
  });
});
