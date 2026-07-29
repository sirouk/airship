import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChutesAccountSnapshot } from "../billing/client";
import {
  BILLING_PROVIDERS,
  billingProviderDatumLabel,
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

  it("keeps the optional inventory credential-free and does not claim provider sign-in", () => {
    expect(source).toContain("providerInventory?: readonly BillingProviderInventoryEntry[];");
    const inventoryType = source.match(/export type BillingProviderInventoryEntry = Readonly<\{([\s\S]*?)\}>;/u)?.[1] ?? "";
    expect(inventoryType).toContain("providerId: BillingProviderId");
    expect(inventoryType).not.toMatch(/credential|token|secret|rawHeader|endpoint/iu);
    expect(source).toContain("This view did not call the provider API.");
    expect(source).not.toMatch(/Connect (?:OpenAI|Anthropic|xAI)|Sign in (?:to|with) (?:OpenAI|Anthropic|xAI)/u);
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

function baseSnapshot(): ChutesAccountSnapshot {
  return {
    fetchedAt: "2026-07-28T12:00:00.000Z",
    complete: true,
    issues: [],
  };
}
