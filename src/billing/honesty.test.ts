import { describe, expect, it } from "vitest";
import type { ChutesAccountIssue, ChutesAccountSnapshot } from "./client";
import {
  balanceDatum,
  billingDatumLabel,
  quotaDatum,
  subscriptionDatum,
  usageDatum,
} from "./honesty";

describe("billing source honesty", () => {
  it("renders an omitted or failed balance as neutral Unknown or Unavailable", () => {
    const partial = snapshot({ account: { username: "balance-partial" } });
    const failed = snapshot({ issues: [issue("account")] });

    expect(balanceDatum(partial, false)).toMatchObject({ status: "unknown", tone: "neutral" });
    expect(balanceDatum(partial, false).value).toBeUndefined();
    expect(billingDatumLabel(balanceDatum(partial, false).status)).toBe("Unknown");
    expect(balanceDatum(failed, false)).toMatchObject({ status: "unavailable", tone: "neutral" });
    expect(balanceDatum(failed, false).value).toBeUndefined();
    expect(billingDatumLabel(balanceDatum(failed, false).status)).toBe("Unavailable");
  });

  it("renders an omitted or failed subscription as neutral and never infers PAYG", () => {
    const partial = snapshot({ account: { username: "subscription-partial", balance: 5 } });
    const failed = snapshot({ issues: [issue("subscription")] });
    const explicitlyInactive = snapshot({ subscription: { active: false } });

    expect(subscriptionDatum(partial, false)).toMatchObject({ status: "unknown", tone: "neutral" });
    expect(subscriptionDatum(partial, false).value).toBeUndefined();
    expect(billingDatumLabel(subscriptionDatum(partial, false).status)).toBe("Unknown");
    expect(subscriptionDatum(failed, false)).toMatchObject({ status: "unavailable", tone: "neutral" });
    expect(subscriptionDatum(failed, false).value).toBeUndefined();
    expect(billingDatumLabel(subscriptionDatum(failed, false).status)).toBe("Unavailable");
    expect(subscriptionDatum(explicitlyInactive, false)).toMatchObject({
      status: "verified",
      tone: "neutral",
      value: { active: false },
    });
    expect(subscriptionDatum(explicitlyInactive, false).detail).toContain("payment mode is not inferred");
  });

  it("renders omitted or failed usage as neutral instead of a zero-usage claim", () => {
    const partial = snapshot({ account: { username: "usage-partial", balance: 5 } });
    const failed = snapshot({ issues: [issue("usage")] });
    const explicitRows = snapshot({
      usage: {
        entries: [],
        totalCost: 0,
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        rangeStart: "2026-07-01T00:00:00",
        rangeEnd: "2026-07-18T00:00:00",
      },
    });

    expect(usageDatum(partial, false)).toMatchObject({ status: "unknown", tone: "neutral" });
    expect(usageDatum(partial, false).value).toBeUndefined();
    expect(billingDatumLabel(usageDatum(partial, false).status)).toBe("Unknown");
    expect(usageDatum(failed, false)).toMatchObject({ status: "unavailable", tone: "neutral" });
    expect(usageDatum(failed, false).value).toBeUndefined();
    expect(billingDatumLabel(usageDatum(failed, false).status)).toBe("Unavailable");
    expect(usageDatum(explicitRows, false)).toMatchObject({ status: "verified", value: { totalCost: 0 } });
  });

  it("renders omitted, failed, or empty quotas neutrally and requires explicit unlimited data", () => {
    const partial = snapshot({ account: { username: "quota-partial", balance: 5 } });
    const failed = snapshot({ issues: [issue("quotas")] });
    const empty = snapshot({ quotas: { entries: [], rawCount: 0, unlimited: false } });
    const explicitUnlimited = snapshot({
      quotas: { entries: [{ chuteId: "chute-1", quota: "unlimited" }], rawCount: 1, unlimited: true },
    });

    expect(quotaDatum(partial, false)).toMatchObject({ status: "unknown", tone: "neutral" });
    expect(quotaDatum(partial, false).value).toBeUndefined();
    expect(quotaDatum(failed, false)).toMatchObject({ status: "unavailable", tone: "neutral" });
    expect(quotaDatum(failed, false).value).toBeUndefined();
    expect(quotaDatum(empty, false)).toMatchObject({ status: "unknown", tone: "neutral", value: { unlimited: false } });
    expect(quotaDatum(empty, false).detail).toContain("not treated as unlimited");
    expect(quotaDatum(explicitUnlimited, false)).toMatchObject({ status: "verified", value: { unlimited: true } });
  });
});

function snapshot(overrides: Partial<ChutesAccountSnapshot>): ChutesAccountSnapshot {
  const issues = overrides.issues ?? [];
  return {
    fetchedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
    issues,
    complete: issues.length === 0,
  };
}

function issue(source: ChutesAccountIssue["source"]): ChutesAccountIssue {
  return {
    source,
    code: "network",
    message: `${source} telemetry fixture failed.`,
    retryable: true,
  };
}
