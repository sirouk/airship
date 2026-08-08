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
  it("opens local provider settings without passing the click event as a provider id", () => {
    // The local panel has no provider argument. Passing the handler directly
    // let Preact supply the MouseEvent as `provider`, so focusDirectProviders
    // looked for `provider-setup-[object PointerEvent]` and silently did
    // nothing. Keep the zero-argument wrapper explicit at this boundary.
    expect(source).toContain('onClick={() => onOpenDirectProviders()}');
    expect(source).not.toContain('onClick={onOpenDirectProviders}>Open the local model server settings');
  });

  it("keeps the status sentence at every width", () => {
    // The phone override deleted `.connect-lane__detail`, so a phone read a
    // lane's state and never its reason.
    expect(declarations).not.toMatch(/\.connect-lane__detail \{\s*display: none/u);
    expect(source).toContain('<p class="connect-lane__detail">{lane.status.detail}</p>');
  });

  it("keeps local checks catalog-only until a person chooses a model", () => {
    expect(source).toContain("keeps every model returned by its live catalog");
    expect(source).toContain("only that model is checked before a conversation starts");
    expect(source).not.toContain("If exactly one text model is evidenced");
  });

  it("aligns an open lane's copy under its own title", () => {
    expect(styles).toContain("--lane-gutter: 32px");
    expect(styles).toContain("padding: 0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + var(--lane-gutter));");
  });

  it("keeps the phone status seal intrinsic on its own row", () => {
    const phone = declarations.slice(declarations.indexOf("@media (max-width: 640px)"));
    expect(source).toContain('<span class="connect-lane__seal-row">');
    expect(declarations).toMatch(/\.connect-lane__seal-row \.seal\s*\{[^}]*flex:\s*0 0 auto;/u);
    expect(phone).toMatch(/\.connect-lane__seal-row\s*\{[^}]*order:\s*4;[^}]*flex:\s*0 0 100%;/u);
    expect(phone).not.toMatch(/\.connect-lane__header \.seal\s*\{[^}]*flex:\s*0 0 100%;/u);
  });

  it("renders every lane at once, so connecting one cannot close the others", () => {
    /*
     * The regression this guards was shipped once: an early `return null` after
     * the first connected lane left a connected person with no way to add a
     * second provider, and called a hook after an early return. The list is
     * built from the whole resolved model with one open lane, so the guard is
     * that nothing filters the array and nothing exits before it is mapped.
     */
    expect(source).toContain("{lanes.map((lane) => (");
    expect(source).not.toMatch(/lanes\s*\.\s*filter\([^)]*\)\s*\.\s*map/u);
    expect(source).not.toMatch(/if \([^)]*connected[^)]*\) return null/u);
    // Openness is a per-card prop, never a reason not to render a card.
    expect(source).toContain("open={openLane === lane.id}");
  });

  /*
   * "The first lane that is not connected" reads as helpfulness and behaves as
   * an interrogation. Connect Chutes and the surface unfolded OpenAI at you;
   * close that and it unfolded Anthropic. Each of those panels is a vendor
   * asking for a credential nobody went looking for.
   */
  it("lets only the lane a new arrival needs open itself", () => {
    expect(source).toContain('const chutesLane = lanes.find((entry) => entry.id === "chutes");');
    expect(source).toContain('const leadLane = chutesLane && chutesLane.status.kind !== "connected" ? chutesLane.id : undefined;');
    // Nothing selects a default by position, which is how every other vendor
    // inherited the open state the moment the one before it connected.
    expect(source).not.toContain('lanes.find((entry) => entry.status.kind !== "connected")');
    expect(source).not.toContain("lanes[0]?.id");
  });

  it("lets a lane that opened itself be closed and stay closed", () => {
    // `undefined` means "nobody has chosen", so closing the default lane by
    // writing `undefined` handed it straight back to the default — a
    // disclosure that reopened itself on the press that closed it.
    expect(source).toContain('const [chosenLane, setChosenLane] = useState<ConnectLaneId | "none" | undefined>(() => reconnectIntent?.lane);');
    expect(source).toContain('setChosenLane(openLane === lane.id ? "none" : lane.id)');
  });

  it("brings a newly opened lane into view", () => {
    expect(source).toContain("lane.scrollIntoView({ behavior: reduced ? \"auto\" : \"smooth\", block: \"start\" });");
    expect(source).toContain("const laneList = useRef<HTMLUListElement>(null);");
    expect(styles).toContain("scroll-margin-block-start: var(--sp-3);");
  });
});

describe("one name per fact inside a lane", () => {
  it("does not re-render the provider and the method the tab above already names", () => {
    /*
     * `Use a {provider} API key` was a fourth rendering, inside one 120px block,
     * of two words already carried by the lane header 60px above and by the tab
     * the person had just pressed. It is not deleted: it is the tabpanel's
     * accessible name, so a screen reader still hears the region named.
     */
    expect(source).toContain("aria-label={`Use a ${providerLabel} API key`}");
    expect(source).not.toContain("<strong>Use a {providerLabel} API key</strong>");
    // The sentence that is not a duplicate stays exactly where it was.
    expect(source).toContain("The key is held only in this page’s memory and is released when the connection is cleared or the page closes.");
  });
});

describe("the method tab's sub-label", () => {
  /*
   * The strip is shared: `access-view.tsx` builds its own `.connect-method__switch`
   * for the Chutes lane and puts "Unavailable in this build" in the `small`,
   * which is longer than anything in `METHOD_SUBLABELS`. `overflow-wrap: anywhere`
   * split it down the middle — "Unavai/lable in" at 320px — and a word broken
   * mid-syllable reads as a rendering fault rather than as a status.
   */
  it("breaks a sub-label between words, not through one", () => {
    const rule = /\.connect-method__switch small\s*\{([^}]+)\}/u.exec(declarations)?.[1] ?? "";
    expect(rule).toContain("overflow-wrap: break-word");
    // `anywhere` is what split the word; an ellipsis is what `anywhere` was
    // chosen over. Neither may come back.
    expect(rule).not.toContain("overflow-wrap: anywhere");
    expect(rule).not.toContain("text-overflow: ellipsis");
  });

  it("gives the sub-label the whole tab below the label once the row is too narrow to share", () => {
    /*
     * At 320px the `auto 1fr` split leaves the status ~60px — about nine mono
     * characters at `--fs-micro`, which "Unavailable" alone overruns, so no
     * wrap mode can rescue it and the column has to change instead. Stacking
     * costs height, not width: both tabs stay `1fr` inside a strip that is
     * already `max-width: none` here, so nothing beside it is squeezed.
     */
    const narrow = declarations.slice(declarations.indexOf("@media (max-width: 640px)"));
    const button = /\.connect-method__switch > button\s*\{([^}]+)\}/u.exec(narrow)?.[1] ?? "";
    expect(button).toContain("grid-template-columns: minmax(0, 1fr)");
    // Right-aligned text under a full-width column would ragged-edge against
    // the label above it — which is only true because the button below now
    // states the same edge for the label; on its own this rule produced the two
    // axes the next test is written against.
    expect(/\.connect-method__switch small\s*\{([^}]+)\}/u.exec(narrow)?.[1] ?? "").toContain("text-align: left");
    // The touch floor the header already holds is not spent to buy the stack.
    expect(narrow).toContain("min-height: 44px");
  });

  it("stacks the two rows down one edge rather than one centred and one flush left", () => {
    /*
     * The stack landed without saying what it stacks against, and the browser
     * answered: a `<span>` in a `<button>` inherits the UA's `text-align:
     * center`, so on the Connect Chutes sheet at 320, 390 and 430 a centred
     * "OAuth" sat over an "Unavailable in this build" flush to the tab's inner
     * edge — two lines of one control on two axes, which reads as a collision
     * rather than as a label and its status.
     *
     * The button declares the axis so the `small` above is restating it, not
     * carrying it alone. Left rather than centre, because the sub-label is mono
     * and wraps to two and three lines here and a centred ragged block gives the
     * eye no edge to return to.
     */
    const narrow = declarations.slice(declarations.indexOf("@media (max-width: 640px)"));
    const button = /\.connect-method__switch > button\s*\{([^}]+)\}/u.exec(narrow)?.[1] ?? "";
    expect(button).toContain("text-align: left");
  });

  it("keeps the wide layout sharing one row, which is the only width that has room to", () => {
    const wide = declarations.slice(0, declarations.indexOf("@media (max-width: 640px)"));
    const base = /\.connect-method__switch > button\s*\{([^}]+)\}/u.exec(wide)?.[1] ?? "";
    expect(base).toContain("grid-template-columns: auto 1fr");
    expect(/\.connect-method__switch small\s*\{([^}]+)\}/u.exec(wide)?.[1] ?? "").toContain("text-align: right");
  });
});
