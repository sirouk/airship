import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChutesAccountIssue, ChutesAccountSnapshot } from "../billing/client";
import {
  accountReadingLine,
  BILLING_PROVIDERS,
  billingProviderDatumLabel,
  chutesAccountAcceptance,
  chutesAccountChip,
  chutesAccountIdentityPresentation,
  resolveBillingProviderInventory,
  safeBillingProviderAccountLink,
  type BillingProviderInventoryEntry,
} from "./billing-view";

const source = readFileSync(new URL("./billing-view.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./billing-view.css", import.meta.url), "utf8");

describe("billing provider presentation", () => {
  it("keeps a fixed Chutes-first inventory and makes Chutes connection state authoritative", () => {
    const supplied: readonly BillingProviderInventoryEntry[] = [
      {
        providerId: "chutes",
        state: "unavailable",
        usage: { status: "observed", value: "$4.20" },
      },
      {
        providerId: "openai",
        state: "connected",
        quota: { status: "not-provided" },
      },
      { providerId: "xai", state: "not-connected" },
    ];

    expect(BILLING_PROVIDERS.map(({ id }) => id)).toEqual(["chutes", "openai", "anthropic", "xai"]);
    const resolved = resolveBillingProviderInventory(supplied, true);
    expect(resolved.map(({ providerId }) => providerId)).toEqual(["chutes", "openai", "anthropic", "xai"]);
    expect(resolved[0]).toMatchObject({ providerId: "chutes", state: "connected" });
    expect(resolved[1]).toMatchObject({ providerId: "openai", state: "connected" });
    expect(resolved[2]).toEqual({ providerId: "anthropic", state: "unavailable" });
    expect(resolved[3]).toMatchObject({ providerId: "xai", state: "not-connected" });
  });

  it("never turns an absent provider observation into a zero", () => {
    expect(billingProviderDatumLabel(undefined, "connected")).toBe("Not provided");
    expect(billingProviderDatumLabel(undefined, "not-connected")).toBe("Unavailable");
    expect(billingProviderDatumLabel(undefined, "unavailable")).toBe("Unavailable");
    expect(billingProviderDatumLabel({ status: "not-provided" }, "connected")).toBe("Not provided");
    expect(billingProviderDatumLabel({ status: "unavailable" }, "connected")).toBe("Unavailable");
    expect(billingProviderDatumLabel({ status: "observed", value: "0" }, "connected")).toBe("0");
  });

  it("renders only observed Chutes identity values and names every kind of absence", () => {
    expect(chutesAccountIdentityPresentation(snapshot({ username: "captain", userId: "user-17" }), false))
      .toEqual({ username: "captain", userId: "user-17" });
    expect(chutesAccountIdentityPresentation(snapshot({ username: "captain" }), false))
      .toEqual({ username: "captain", userId: "Not provided" });
    expect(chutesAccountIdentityPresentation(baseSnapshot(), false))
      .toEqual({ username: "Unavailable", userId: "Unavailable" });
    expect(chutesAccountIdentityPresentation(undefined, true))
      .toEqual({ username: "Loading…", userId: "Loading…" });
    expect(chutesAccountIdentityPresentation(snapshot({ username: "\u0000  ", userId: "" }), false))
      .toEqual({ username: "Not provided", userId: "Not provided" });
  });

  it("only exposes bounded HTTPS account-management links", () => {
    expect(safeBillingProviderAccountLink({
      status: "observed",
      href: "https://platform.openai.com/settings/organization/billing/overview",
      label: "Open billing",
    })).toEqual({
      href: "https://platform.openai.com/settings/organization/billing/overview",
      label: "Open billing",
    });
    expect(safeBillingProviderAccountLink({ status: "observed", href: "http://example.com" })).toBeUndefined();
    expect(safeBillingProviderAccountLink({ status: "observed", href: "javascript:alert(1)" })).toBeUndefined();
    expect(safeBillingProviderAccountLink({ status: "observed", href: "https://user:secret@example.com" })).toBeUndefined();
    expect(safeBillingProviderAccountLink({ status: "not-provided" })).toBeUndefined();
  });

  it("gives identity an observation slot so a provider tab can be silent on purpose", () => {
    const resolved = resolveBillingProviderInventory([
      { providerId: "openai", state: "connected", identity: { status: "observed", value: "acct-9" } },
      { providerId: "anthropic", state: "connected" },
    ], false);

    expect(resolved[1]).toMatchObject({ identity: { status: "observed", value: "acct-9" } });
    expect(resolved[2]).not.toHaveProperty("identity");
    // Absent identity is still stated, in the same grammar as every other row:
    // a connected provider simply did not provide one; an unavailable provider
    // could not be asked.
    expect(billingProviderDatumLabel(resolved[2]?.identity, "connected")).toBe("Not provided");
    expect(billingProviderDatumLabel(resolved[3]?.identity, "unavailable")).toBe("Unavailable");
    expect(billingProviderDatumLabel(resolved[1]?.identity, "connected")).toBe("acct-9");
    expect(source).toContain('<ProviderInventoryDatum label="Authenticated identity"');
  });

  /*
   * The `unavailable` default is written for "the host said nothing", and for
   * the whole life of this seam nothing ever said anything: App owned the
   * connection fact and routed it only to Connection, so a working OpenAI
   * connection rendered as an absent capability. These cases hold the producer
   * in place — including the part that stays silent until the fabric exists.
   */
  it("is produced by the shell from the same connection fact Connection reads", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    const inventory = app.match(/const billingProviderInventory = useMemo\([\s\S]*?\n  \);/u)?.[0] ?? "";
    expect(inventory).toContain("inferenceFabric.current");
    expect(inventory).toContain("connectedInferenceProviderIds.includes(providerId)");
    expect(inventory).toContain('"connected" as const');
    expect(inventory).toContain('"not-connected" as const');
    // Before the fabric resolves the prop is absent, so the view's honest
    // `unavailable` default still covers "not observed yet".
    expect(inventory).toContain(": undefined,");
    // Connection state only: nothing here has anything to say about money.
    expect(inventory).not.toMatch(/quota|usage|reset|identity|accountLink|observedAt/u);
    expect(app).toContain("providerInventory={billingProviderInventory}");
    // The shell restates the tab list rather than importing the Account route's
    // constant; drift between the two would silently drop a tab's producer.
    const restated = app.match(/const BILLING_INVENTORY_PROVIDER_IDS[\s\S]*?Object\.freeze\((\[[^\]]*\])\)/u)?.[1] ?? "";
    for (const { id } of BILLING_PROVIDERS) {
      expect(restated.includes(`"${id}"`)).toBe(id !== "chutes");
    }
  });

  it("keeps the optional inventory credential-free and does not claim provider sign-in", () => {
    expect(source).toContain("providerInventory?: readonly BillingProviderInventoryEntry[];");
    const inventoryType = source.match(/export type BillingProviderInventoryEntry = Readonly<\{([\s\S]*?)\}>;/u)?.[1] ?? "";
    expect(inventoryType).toContain("providerId: BillingProviderId");
    expect(inventoryType).not.toMatch(/credential|token|secret|rawHeader|endpoint/iu);
    expect(source).toContain("This view did not call the provider API.");
    expect(source).not.toMatch(/Connect (?:OpenAI|Anthropic|xAI)|Sign in (?:to|with) (?:OpenAI|Anthropic|xAI)/u);
  });
});

describe("a rejected credential is not a fresh reading", () => {
  it("separates acceptance from snapshot age", () => {
    // Every source refused: nothing was read, so nothing may be called
    // Connected, however recently the attempt was stamped.
    expect(chutesAccountAcceptance(baseSnapshot({
      issues: [httpIssue("account", 401), httpIssue("quotas", 401), httpIssue("subscription", 401), httpIssue("usage", 401)],
    }))).toBe("rejected");
    // One refusal beside three readings is a partial snapshot: a source
    // returned a value, so the credential was accepted somewhere.
    expect(chutesAccountAcceptance({
      ...baseSnapshot({ issues: [httpIssue("quotas", 401)] }),
      account: { username: "captain" },
    })).toBe("accepted");
    // A total transient failure is a refused read, not a credential problem…
    expect(chutesAccountAcceptance(baseSnapshot({
      issues: [httpIssue("account", 503), httpIssue("quotas", 503), httpIssue("subscription", 503), httpIssue("usage", 503)],
    }))).toBe("refused");
    // …and neither is a single one.
    expect(chutesAccountAcceptance({
      ...baseSnapshot({ issues: [httpIssue("quotas", 503)] }),
      account: { username: "captain" },
    })).toBe("accepted");
  });

  it("keeps the chip's stale split age-driven only for readings that returned something", () => {
    expect(chutesAccountChip("accepted", false)).toMatchObject({ state: "verified", label: "Connected" });
    expect(chutesAccountChip("accepted", true)).toMatchObject({ state: "stale", label: "Stale reading" });
    expect(chutesAccountChip(undefined, false)).toMatchObject({ state: "verified", label: "Connected" });
    for (const stale of [false, true]) {
      expect(chutesAccountChip("rejected", stale)).toEqual({
        state: "none",
        label: "Credential not accepted",
        headline: "Chutes refused this credential",
      });
      expect(chutesAccountChip("refused", stale)).toMatchObject({ state: "none", label: "No account data read" });
    }
  });

  it("stops the popover body from calling a refused reading Verified", () => {
    expect(accountReadingLine("accepted", "Verified · Jul 28, 12:00")).toBe("Verified · Jul 28, 12:00");
    expect(accountReadingLine(undefined, "Verified · Jul 28, 12:00")).toBe("Verified · Jul 28, 12:00");
    expect(accountReadingLine("rejected", "Verified · Jul 28, 12:00")).toBe("Attempted · Jul 28, 12:00");
    expect(accountReadingLine("refused", "Observed · Jul 28, 12:00")).toBe("Attempted · Jul 28, 12:00");
    expect(accountReadingLine("refused", undefined)).toBeUndefined();
    // Both surfaces that print the freshness line go through it.
    expect(source.match(/accountReadingLine\(acceptance, observed\?\.label\)/gu)).toHaveLength(2);
  });

  it("renders the refusal as an alert with a route back to Connection", () => {
    // "Partial" is reserved for the state it describes; the refusal rung is an
    // alert, names the credential, and carries the Connection action.
    expect(source).toContain('acceptance === "accepted" ? (');
    expect(source).toContain('<div class="billing-alert error" role="alert">');
    expect(source).toContain("<strong>Account read refused</strong>");
    expect(source).toContain("Chutes did not accept this credential: every account source refused it as unauthorized.");
    expect(source).toContain('<button class="small-button" type="button" onClick={onOpenAccess}>Review connection</button>');
    expect(source.match(/Partial account snapshot/gu)).toHaveLength(1);
  });

  it("states the credential contract without promising a method this build may not run", () => {
    expect(source).toContain("Connect a Chutes credential to read account telemetry. The credential remains held only in page memory.");
    expect(source).not.toContain("Connect with scoped Chutes sign-in or a direct API-key session.");
    // The rendered sentence, not the file: which credential methods a build can
    // run is Connection's fact, and Account may not restate it.
    const sentence = source.match(/<p>Connect a Chutes credential[^<]*<\/p>/u)?.[0] ?? "";
    expect(sentence).toContain("The credential remains held only in page memory.");
    expect(sentence).not.toMatch(/sign-in|OAuth|API.key/iu);
    expect(source).toContain("onClick={onOpenAccess}>Connect Chutes<");
  });
});

describe("a usage total names the bound it was read over", () => {
  it("suffixes both UTC-month captions only when the page saturated", () => {
    expect(source).toContain("function boundedUsageSuffix(usage: ChutesUsageSummary): string {");
    expect(source).toContain('return usage.truncated ? ` · ${USAGE_BOUNDED_READ_NOTE}` : "";');
    expect(source.match(/\$\{boundedUsageSuffix\(usageState\.value\)\}/gu)).toHaveLength(2);
  });
});

describe("no state is carried only by an aria-label ARIA discards", () => {
  it("marks the decorative runway bar hidden instead of naming a generic span", () => {
    expect(source).toContain('<span class="runway-track" aria-hidden="true">');
    expect(source).not.toContain('<span class="runway-track" aria-label');
    // The figures the bar redraws stay in text, above and below it.
    expect(source).toContain('<div class="runway-value">');
    expect(source).toContain("covered`}</span></div>");
  });
});

describe("billing provider responsive contract", () => {
  it("shows four desktop tabs and keeps the provider strip reachable on narrow screens", () => {
    expect(styles).toMatch(/\.billing-provider-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/u);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.billing-provider-tabs\s*\{[\s\S]*?repeat\(4, minmax\(136px, 1fr\)\)/u);
    expect(styles).toContain("scroll-snap-type: x proximity");
    expect(styles).not.toMatch(/\.billing-provider-(?:tabs|tab)\s*\{[^}]*display:\s*none/gu);
  });

  it("collapses identity and provider observations to one column on phones", () => {
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.billing-account-identity dl,[\s\S]*?\.billing-provider-data\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
    expect(styles).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.billing-provider-tab,[\s\S]*?min-height:\s*44px/u);
  });
});

function snapshot(account: NonNullable<ChutesAccountSnapshot["account"]>): ChutesAccountSnapshot {
  return { ...baseSnapshot(), account };
}

function baseSnapshot(overrides: Partial<ChutesAccountSnapshot> = {}): ChutesAccountSnapshot {
  const issues = overrides.issues ?? [];
  return {
    fetchedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
    issues,
    complete: issues.length === 0,
  };
}

function httpIssue(origin: ChutesAccountIssue["source"], status: number): ChutesAccountIssue {
  return {
    source: origin,
    code: "http",
    message: `${origin} telemetry returned HTTP ${String(status)}.`,
    status,
    retryable: status >= 500,
  };
}
