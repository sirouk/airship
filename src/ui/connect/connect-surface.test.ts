import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialConnectMethod } from "./connect-surface";
import type { ConnectLaneStatus } from "./connect-lanes";

const source = readFileSync(new URL("./connect-surface.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./connect-surface.css", import.meta.url), "utf8");
/** Declarations only: a rule quoted in a comment is prose, not a rule. */
const declarations = styles.replace(/\/\*[\s\S]*?\*\//gu, "");

function status(kind: ConnectLaneStatus["kind"]): ConnectLaneStatus {
  return { kind, label: kind, detail: `${kind} detail` } as ConnectLaneStatus;
}

describe("which method a lane opens on", () => {
  it("opens on OAuth only where OAuth can be used", () => {
    expect(initialConnectMethod(status("ready"))).toBe("oauth");
    expect(initialConnectMethod(status("connected"))).toBe("oauth");
  });

  it("opens on the key tab whenever the sign-in leg cannot work", () => {
    // Three of five lanes used to open onto a hardcoded OAuth tab whose own
    // sub-label said the route was impossible.
    for (const kind of ["unavailable", "needs-extension", "extension-unavailable", "offline", "checking"] as const) {
      expect(initialConnectMethod(status(kind)), kind).toBe("api-key");
    }
  });

  it("keeps the OAuth tab present and selectable in every state", () => {
    // It is where the honest reason lives; it simply stops being the default.
    expect(source).toContain('aria-selected={method === "oauth"}');
    expect(source).toContain("METHOD_SUBLABELS[oauthStatus.kind]");
  });
});

describe("a method panel never renders a heading with nothing under it", () => {
  it("renders the reason and a route to the key tab when there is no control", () => {
    expect(source).toContain("const oauthActionable = rendered !== null");
    expect(source).toContain('<div class="connect-method__blocked">');
    expect(source).toContain("{oauthStatus.detail}");
    expect(source).toContain("<button type=\"button\" onClick={useApiKey}>Use an API key</button>");
    // The heading is conditional on there being a panel below it.
    expect(source).toContain('{oauthActionable ? <p class="connect-method__title">{oauthLabel}</p> : null}');
  });

  it("gives every method sub-label a short form that cannot truncate", () => {
    for (const label of ["Primary", "Connected", "Checking", "Needs the extension", "Not in this browser", "Not available here", "Offline"]) {
      expect(source).toContain(`"${label}"`);
    }
    expect(declarations).not.toMatch(/\.connect-method__switch small \{[^}]*text-overflow:\s*ellipsis/u);
  });
});

describe("the selected method is perceivable without a screen reader", () => {
  it("gives the selected tab a colour, a border and a weight the unselected one does not have", () => {
    // Selected and unselected reported byte-identical background and border,
    // so a sighted user could not tell which credential path was active while
    // `aria-selected` told a screen reader the truth — WCAG 1.4.1.
    const selected = styles.slice(styles.indexOf('.connect-method__switch > button[aria-selected="true"] {'));
    expect(selected).toContain("--accent-bright");
    expect(selected).toContain("inset 0 -2px 0 var(--accent-bright)");
    expect(styles).toContain('.connect-method__switch > button[aria-selected="true"] span {\n  font-weight: 700;');
  });
});

describe("the Companion keeps every word it carried as a card", () => {
  it("renders the three readings, the host sentence and the install link in the lane body", () => {
    expect(source).toContain('<dl class="connect-companion__facts">');
    expect(source).toContain("companionFacts(observation).map");
    expect(source).toContain("This browser can load the Airship Companion.");
    expect(source).toContain("Get the extension ↗");
    expect(source).toContain("Downloads & setup ↗");
  });

  it("drops the bespoke dot for the app's one seal family", () => {
    expect(source).not.toContain("companion-overview__dot");
    expect(declarations).not.toContain(".companion-overview");
  });
});

describe("lane rows", () => {
  it("keeps the status sentence at every width", () => {
    // The phone override deleted `.connect-lane__detail`, so a phone read a
    // lane's state and never its reason.
    expect(declarations).not.toMatch(/\.connect-lane__detail \{\s*display: none/u);
    expect(source).toContain('<p class="connect-lane__detail">{lane.status.detail}</p>');
  });

  it("aligns an open lane's copy under its own title", () => {
    expect(styles).toContain("--lane-gutter: 32px");
    expect(styles).toContain("padding: 0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + var(--lane-gutter));");
  });
});
