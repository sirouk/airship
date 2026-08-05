import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAIL_RECENT_LIMIT, railCurrentHint, railRowFor, railStandInFor, rovingKey } from "./rail";
import { CANONICAL_DESTINATIONS, destinationLabel, railTraversal, type NavigationView } from "./navigation-model";

/*
 * The returning person's most important object may not need a click to exist.
 *
 * Measured on every cold open: `button[aria-label="Expand recent conversations"]`
 * present on a profile that already held conversations, because the disclosure
 * was seeded `useState(false)` and the list arrives asynchronously — so mount
 * was always empty and the seed always said "closed".
 */
describe("the conversation disclosure's default", () => {
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");

  it("opens itself in the standard rail the first time the profile turns out to have conversations", () => {
    expect(source).toContain('if (state !== "standard" || recentsChoice.current !== undefined || visibleConversations.length === 0) return;');
    expect(source).toContain("setRecentsOpen(true);");
  });

  it("lets a stated choice outrank the default, and remembers it", () => {
    expect(source).toContain("const recentsChoice = useRef<boolean | undefined>(loadRecentsPreference());");
    expect(source).toContain("saveRecentsPreference(open);");
    expect(source).toContain("onClick={() => chooseRecentsOpen(!recentsOpen)}");
  });

  it("marks the conversation that will not reopen, in words and not only in colour", () => {
    expect(source).toContain("Needs review · could not be reopened");
    expect(source).toContain("— needs review; this conversation could not be reopened.");
  });
});

describe("the shortcut's size", () => {
  it("lists the same ten conversations the rail list did", () => {
    // The ledger is `All conversations`; this is the shortcut. A larger number
    // here would rebuild the 250px scroller that was the defect.
    expect(RAIL_RECENT_LIMIT).toBe(10);
  });
});

/**
 * The rail promises one tab stop, always. A composite widget with zero tab
 * stops is not a keyboard-reachable widget at all, and five of the fourteen
 * `NavigationView`s are not rail rows — so a deep link to any of them used to
 * seed the roving key with a row that does not exist.
 */
describe("the rail's single tab stop", () => {
  const closed = railTraversal({});
  const open = railTraversal({ workspace: true });
  const everyView: readonly NavigationView[] = [
    "chat", "sessions", "workspace", "editor", "terminal", "memory", "context",
    "profiles", "capabilities", "skills", "vault", "billing", "proof", "access",
  ];

  it("resolves to a row the rail actually renders, for every view", () => {
    for (const view of everyView) {
      expect(closed, `${view} seeds an existing row`).toContain(rovingKey(view, closed));
      expect(open, `${view} seeds an existing row with Workspace open`).toContain(rovingKey(view, open));
    }
  });

  it("lands on the row an off-rail destination is filed under", () => {
    // The five that are legal views and not rail rows. `sessions` is the last
    // entry of Chat's own disclosure; `context` is filed under Memory.
    expect(rovingKey("sessions", closed)).toBe("chat");
    expect(rovingKey("context", closed)).toBe("memory");
    // Profiles and its two subroutes are a rail *control*, not a rail row, so
    // there is no parent row to land on and the first row is the answer.
    for (const view of ["profiles", "skills", "capabilities"] as const) {
      expect(rovingKey(view, closed), view).toBe(closed[0]);
    }
  });

  it("keeps a rendered row as the stop and never returns a withdrawn one", () => {
    // A navigation to somewhere off-rail leaves the stop where the user put it.
    expect(rovingKey("profiles", closed, "vault")).toBe("vault");
    // ...but collapsing Workspace withdraws Terminal, and the stop has to move
    // rather than name a row that is no longer in the tree.
    expect(rovingKey("terminal", open, "terminal")).toBe("terminal");
    expect(rovingKey("terminal", closed, "terminal")).toBe("workspace");
    expect(closed).not.toContain("terminal");
  });

  it("agrees with the filing `railRowFor` reports", () => {
    expect(railRowFor("terminal")?.id).toBe("workspace");
    expect(railRowFor("sessions")).toBeUndefined();
  });
});

/**
 * Every view marks something on the desktop rail.
 *
 * Measured: `#context`, `#skills` and `#capabilities` are legal hashes with
 * routes of their own and no rail row, and the desktop rail showed no
 * current-page state at all on all three — while the phone's bottom bar marked
 * every one of them through `More`. The phone signal is untouched; this is the
 * rail growing the same one.
 */
describe("the rail's you-are-here state", () => {
  const everyView: readonly NavigationView[] = [
    "chat", "sessions", "workspace", "editor", "terminal", "memory", "context",
    "profiles", "capabilities", "skills", "vault", "billing", "proof", "access",
  ];
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");
  const railKeys = new Set<string>([...railTraversal({ workspace: true }), "profiles"]);

  it("marks a control for every one of the fourteen views", () => {
    for (const view of everyView) {
      expect(railKeys, `${view} marks a rail control`).toContain(railStandInFor(view));
    }
  });

  it("keeps a nested row marking its parent, and never re-parents a row of its own", () => {
    expect(railStandInFor("editor")).toBe("workspace");
    expect(railStandInFor("terminal")).toBe("workspace");
    // Account is a rail row in its own right, not a sub-page of a connection
    // method. Standing on it must not light Connection up.
    expect(railStandInFor("billing")).toBe("billing");
    expect(railStandInFor("access")).toBe("access");
  });

  it("stands Memory in for its index and Profiles in for its two subroutes", () => {
    expect(railStandInFor("context")).toBe("memory");
    expect(railStandInFor("skills")).toBe("profiles");
    expect(railStandInFor("capabilities")).toBe("profiles");
    expect(railStandInFor("sessions")).toBe("chat");
  });

  it("names the live route wherever the stand-in's own label does not", () => {
    // The same test the phone band makes before describing its current control.
    for (const view of ["skills", "capabilities", "sessions"] as const) {
      expect(railCurrentHint(view), view).toBe(destinationLabel(view));
    }
    for (const view of ["chat", "workspace", "editor", "profiles", "billing"] as const) {
      expect(railCurrentHint(view), view).toBeUndefined();
    }
  });

  it("answers #context exactly as it answers #memory, because it renders that route", () => {
    /*
     * `#context` opens the Memory route at its Index tab — same component, same
     * `<h1>Memory</h1>`. The rail row it marks is Memory's, and it marks it as
     * the page rather than as the page's container: a row reading one rung
     * weaker than the heading beside it is a third answer to one question. No
     * hint either, because "Current page: Context" would name a word the screen
     * does not contain — the defect this whole batch exists to remove.
     */
    expect(railStandInFor("context")).toBe(railStandInFor("memory"));
    expect(railCurrentHint("context")).toBeUndefined();
    expect(source).toContain("const active = view === row.id || (railStandInFor(view) === row.id && !rendersOwnRoute(view));");
  });

  it("does not pay for the desktop signal by removing the phone's", () => {
    // "Hide it on a phone" is never the fix, and neither is its inverse.
    expect(readFileSync(new URL("./mobile-navigation.tsx", import.meta.url), "utf8"))
      .toContain('aria-current={current ? "page" : undefined}');
    expect(source).toContain('aria-describedby={childActive && currentHint ? CURRENT_HINT_ID : undefined}');
  });
});

/*
 * One rail, one left-edge language.
 *
 * The owner's reading of this rail found three at once. The destination rows —
 * Chat, Workspace, Memory, Proof, Vault, Connection, Account — carry the inset
 * tab mark `.nav-item[data-scope]::after` draws, and he named those as the
 * reference. `Skills` and `Capabilities` carried a full-height hairline
 * instead, because `.nav-item--nested` draws one and neither row had a
 * `data-scope` to draw a mark from. `All conversations` carried that hairline
 * plus a `border-top` and squared corners, which is a third thing again: a
 * bordered button sitting in a list of rows.
 *
 * The mark is drawn from the destination table, so these assertions are about
 * the two attributes that decide which language a row speaks, not about the
 * pixels — the stylesheet is free to restyle the mark, and this still holds.
 */
describe("the rail's rows all speak the same language", () => {
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");

  it("leaves the nested hairline to genuine nesting, and to nothing else", () => {
    // Editor and Terminal are pages *inside* the row above them, which is what
    // the indent and the 1px rule say. Skills, Capabilities and the conversation
    // ledger are rows in a block that already says whose they are, and giving
    // them the same treatment said it twice in a dialect nothing else uses.
    expect(source.split("nav-item--nested").length - 1).toBe(2);
    expect(source).toContain('class={active ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"}');
  });

  it("gives every rail row a scope to draw its mark from", () => {
    expect(source).toContain("data-scope={ALL_CONVERSATIONS_SCOPE}");
    expect(source).toContain("data-scope={route.scope}");
  });

  it("reads each scope out of the destination table rather than restating it", () => {
    // A literal here is a second place to change when a route is re-scoped, and
    // the rail would go on drawing the old answer with nothing to catch it.
    expect(source).not.toMatch(/data-scope="[a-z]+"/u);
  });

  it("finds the ledger row a scope in the table it reads from", () => {
    // The lookup fails silently: a missing entry renders `data-scope` off the
    // element entirely and the mark disappears with no error anywhere. This is
    // the condition that would cause it.
    expect(CANONICAL_DESTINATIONS.flatMap((destination) => destination.nested).map((nested) => nested.id))
      .toContain("sessions");
  });

  it("keeps the profile control's name after dropping the word it printed", () => {
    // `Profiles` beside a person glyph, on a 232px row already spending its
    // width on a monogram, a name and a caret: measured at the compact density,
    // `Research` needed 63.7px and the name's box was 56.6px, so it printed
    // `Resear…`. Without the word the box is 90px. The word survives in three
    // places that were always the ones a reader uses.
    expect(source).toContain('aria-label="Manage profiles"');
    expect(source).toContain('title="Manage profiles · profile scope"');
    expect(source).not.toContain("profile-manage-link__label");
  });
});

/*
 * The collapse affordance, and the one gesture that must not move the rail.
 *
 * Asserted against the stylesheet because that is where both behaviours live —
 * the handle's placement and the withdrawn hover-peek are declarations, not
 * script, and a source-grep for a class name would have passed the whole time
 * the peek was firing on every trip to the composer.
 */
describe("the rail's collapse control", () => {
  /** Comment-free, so a rule's text cannot be matched inside prose about it. */
  const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  /** Every rule in the sheet, split into what it selects and what it declares. */
  const rules = css.split("}").filter((rule) => rule.includes("{")).map((rule) => {
    const [head, ...body] = rule.split("{");
    return { selectors: head!.split(",").map((selector) => selector.trim()).filter(Boolean), body: body.join("{") };
  });
  /** The selector lists of the rules whose declarations carry every mark. */
  const rulesDeclaring = (...marks: readonly string[]): readonly (readonly string[])[] =>
    rules.filter((rule) => marks.every((mark) => rule.body.includes(mark))).map((rule) => rule.selectors);

  it("hangs the handle on the seam instead of pinning it to a corner", () => {
    // `.rail` is the box whose width changes, so its right edge *is* the seam in
    // all three rail states — which is why the handle is positioned against it
    // and not against `.sidebar`, the grid column that never moves.
    const [handle] = rulesDeclaring("position: absolute", "top: 50%", "right: 0", "translate: 50% -50%");
    expect(handle).toEqual([".rail-collapse"]);
  });

  it("never widens the rail because a pointer crossed it", () => {
    // "That's clunky and jumps around": the rail sits on the path to the
    // composer, and it treated every crossing as a request to open.
    const peeks = rulesDeclaring("width: 268px");
    expect(peeks).not.toHaveLength(0);
    for (const selectors of peeks) for (const selector of selectors) expect(selector).not.toContain(":hover");
  });

  it("keeps the keyboard's way to the labels", () => {
    const [peek] = rulesDeclaring("width: 268px");
    expect(peek!.every((selector) => selector.includes(":has(:focus-visible)"))).toBe(true);
  });

  it("brings back for the keyboard exactly what the collapsed rail hides", () => {
    /*
     * These two lists drifted: `.profile-manage-link__label` was clipped by the
     * first and restored by the second, and when the label was deleted the
     * restoring copy was the one that stayed — a selector matching nothing,
     * sitting in the block a reader would trust to say what comes back.
     * A collapsed rail that hides a name it cannot restore is the worse half of
     * the same drift, which is why this is a set comparison in both directions.
     */
    const last = (selectors: readonly string[]) => [...selectors.map((selector) => selector.split(" ").at(-1)!)].sort();
    /** The one rule every selector of which carries `guard`, declaring `mark`. */
    const guardedRule = (guard: string, mark: string) => {
      const matches = rules.filter((rule) => rule.body.includes(mark)
        && rule.selectors.every((selector) => selector.includes(guard)));
      expect(matches, `one ${guard} rule declares ${mark}`).toHaveLength(1);
      return matches[0]!.selectors;
    };
    const hidden = guardedRule('[data-rail-state="rail"] ', "clip-path: inset(50%)");
    const restored = guardedRule(":has(:focus-visible)", "clip-path: none");
    expect(last(restored)).toEqual(last(hidden));
  });
});
