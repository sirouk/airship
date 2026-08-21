import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAIL_RECENT_LIMIT, railCurrentHint, railRowFor, railStandInFor, rovingKey } from "./rail";
import { CANONICAL_DESTINATIONS, destinationLabel, railTraversal, type NavigationView } from "./navigation-model";
import { defaultRailState } from "./rail-state";

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
    // `autoOpened` is what keeps this to once per page. It used to be
    // `recentsChoice.current = true` doing that job, which stopped the effect by
    // forging the person's remembered answer.
    expect(source).toContain('if (state !== "standard" || autoOpened.current || recentsChoice.current !== undefined || visibleConversations.length === 0) return;');
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
    "profiles", "capabilities", "skills", "vault", "access",
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
    "profiles", "capabilities", "skills", "vault", "access",
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
    // Providers is a rail row in its own right, not a sub-page of Vault.
    expect(railStandInFor("access")).toBe("access");
    expect(railStandInFor("vault")).toBe("vault");
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
    for (const view of ["chat", "workspace", "profiles", "access"] as const) {
      expect(railCurrentHint(view), view).toBeUndefined();
    }
  });

  it("names Editor and Terminal exactly while the Workspace row is not drawing them", () => {
    /*
     * A nested row only exists on screen while its parent is expanded, and the
     * rail seeds Workspace closed from anywhere else — so arriving at `#editor`
     * by deep link or by the command palette marked nothing with `aria-current`
     * and said nothing to a screen reader, leaving one colour step on
     * `.nav-item.has-active-child` as the entire "you are here". The phone band
     * has always named both routes under its Workspace control.
     */
    for (const view of ["editor", "terminal"] as const) {
      expect(railCurrentHint(view), view).toBe(destinationLabel(view));
      // Expanded, the row itself is drawn and carries `aria-current="page"`;
      // a hint beside it would be a second answer to the same question.
      expect(railCurrentHint(view, { workspace: true }), view).toBeUndefined();
    }
    // The parent standing on its own route never needs one either way.
    expect(railCurrentHint("workspace", { workspace: false })).toBeUndefined();
    expect(railCurrentHint("workspace", { workspace: true })).toBeUndefined();
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
    // The hint is only correct if it is asked with the expansion record the
    // rail is actually rendering from; asked without it, a drawn Editor row and
    // the sr-only line would both claim the page.
    expect(source).toContain("railCurrentHint(view, expanded)");
  });
});

/*
 * The self-opening conversation list is the rail's decision, never a signature
 * on the person's behalf.
 *
 * `loadRecentsPreference` documents `undefined` as "nobody has chosen", which is
 * a different state from having chosen "closed". The auto-open used to stamp
 * `true` into that slot without persisting it, which both invented a choice and
 * jammed the height gate: once the gate closed the list, the same window at the
 * same height showed it after a reload and not after a resize down and back up.
 */
describe("the rail's recents disclosure", () => {
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");

  it("lets only the persisting path write the remembered choice", () => {
    expect(source.match(/recentsChoice\.current = /gu)?.length).toBe(1);
    expect(source).toContain("recentsChoice.current = open;");
    expect(source).toContain("saveRecentsPreference(open);");
  });

  it("gives the room back in both directions for as long as the rail owns the state", () => {
    // A one-way gate is the defect: the measure must answer the height, not
    // only ever close, and it must stay subscribed while `autoOpened` holds.
    expect(source).toContain('if (!autoOpened.current || state !== "standard") return;');
    expect(source).toContain("if (room > 0) setRecentsOpen(room >= RAIL_RECENTS_AUTO_OPEN_MIN_HEIGHT);");
    expect(source).toContain("}, [navRef, recentsOpen, state]);");
  });

  it("restores what the rail was showing rather than a fabricated closed choice", () => {
    expect(source).toContain('setRecentsOpen(state === "standard" ? recentsChoice.current ?? autoOpened.current : false);');
  });
});

/*
 * One rail, one left-edge language.
 *
 * The owner's reading of this rail found three at once. The destination rows —
 * Chat, Workspace, Memory, Profiles, Vault, and Providers — carry the inset
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

  it("keeps profile configuration inside the profile hub", () => {
    expect(source).not.toContain("profile-scoped-routes");
    expect(source).not.toContain("PROFILE_SCOPED_ROUTES");
    expect(readFileSync(new URL("./app.tsx", import.meta.url), "utf8"))
      .toContain('class="profile-hub-tabs"');
  });

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
    expect(source).toContain("data-scope={row.scope}");
    expect(source).toContain("data-scope={nested.scope}");
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

  /*
   * The handle is centred on the seam, so half of whatever it *paints* lands
   * inside the rail — and this rule has now been wrong in four directions.
   *
   * Painted 44px in an 84px rail, that half was 22px of a `z-index: 1` control
   * lying across the nav column: measured at 768 it washed out the final `n` of
   * `Connection` — in a rail whose 84px is itself measured to hold exactly that
   * word — and the right end of that row collapsed the rail instead of opening
   * the destination. Narrowing the paint to 24px left a 44×24 control: WCAG
   * 2.5.8's floor, but under this product's own, which tokens.css states on both
   * axes because "a target's smaller dimension is the one a finger has to find".
   * Widening the rail by half a touch target to hold a 44px paint kept both and
   * charged every route 22px of content column, the seam moving x=83 → x=105
   * with the icons still centred on x=41.
   *
   * The fourth split the paint from the target, which was right and is kept —
   * but it left the body at 24px, the number from when the body *was* the
   * target. Centred on the seam that still reached 12px inward, and measured at
   * tablet-768 the paint ran x=71..95 against `Connection`'s ink ending at
   * x=72: the handle drawn over the word's last letter, reported by five route
   * audits as the grip sitting flush against, colliding with, or re-overlapping
   * that label. The original defect, at 1px instead of 22px.
   *
   * So the floor is met entirely by a transparent extension, and the paint is
   * never widened *inward* again. It is widened outward, once: at 13×46 and
   * `opacity: .5` the grip was reported invisible by eight route audits, and on
   * a coarse pointer there is no hover to lift the fade, so that rest state is
   * the only one a finger ever sees. The coarse block therefore takes the body
   * to 24px and the opacity to 1 while pulling the box out of the rail by half
   * the growth, so the painted left edge stays at seam − 6.5px — the reach the
   * 13px body has always had — and the extra 11px land in the overhang the
   * extension already owns.
   *
   * These tests pin that: that the growth is spent outward and only outward,
   * that the extension's four terms still sum to `--touch-target` once
   * `border-box` sizing is paid for and land on the identical box at either
   * body width, that the paint clears the label inward and the routes' controls
   * outward, and that no rail width anywhere adds anything for the seam.
   */
  const coarseGripBlock = css.slice(css.lastIndexOf("@media (pointer: coarse)", css.indexOf(".rail-collapse::after")));
  const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  /** A `--name: <n>px` declaration, read as a number. */
  const tokenPx = (sheet: string, name: string): number => {
    const hit = new RegExp(`${name}:\\s*(-?[\\d.]+)px`, "u").exec(sheet);
    expect(hit, `${name} should be declared once, in px`).not.toBeNull();
    return Number(hit![1]);
  };

  it("paints the grip from one design body, and spends any growth outward", () => {
    // One design number, named once in the base rule and read by everything
    // that grows from it.
    const [paint] = rulesDeclaring("--grip-design-body: 13px", "width: var(--grip-body)");
    expect(paint).toEqual([".rail-collapse"]);

    // The coarse block may take the paint — the finger has no hover to lift the
    // fade with, so the sliver at 0.5 was the only grip it ever got — but the
    // shape it takes is not free. This `right` is the whole safety: it is
    // negative by exactly half the growth, so the box slides *out* of the rail
    // as it widens and the inward edge never moves. Centring 24px on the seam
    // instead is how the handle came to be drawn over `Connection`'s last
    // letter, twice.
    const coarsePaint = coarseGripBlock.match(/\.rail-collapse \{([^}]+)\}/u)?.[1] ?? "";
    expect(coarsePaint).toContain("--grip-body: 24px");
    expect(coarsePaint).toContain("right: calc((var(--grip-design-body) - var(--grip-body)) / 2)");
    expect(coarsePaint).toContain("opacity: 1");
    // The seam is still the position; nothing about the finger re-anchors it.
    expect(coarseGripBlock).not.toContain("translate:");
    expect(coarsePaint).not.toContain("width:");

    // The arithmetic that `right` encodes, done in numbers: with `translate:
    // 50%` the box spans [seam − right − body/2, seam − right + body/2], so a
    // right of (design − body)/2 pins the inward edge at seam − design/2 for
    // any body at all. Measured at tablet-768, seam x=83: the paint starts at
    // x=76.5 whether it is 13px or 24px wide, and `Connection`'s ink ends at
    // x=73.1.
    const design = tokenPx(css, "--grip-design-body");
    const body = tokenPx(css, "--grip-body");
    expect(body).toBeGreaterThanOrEqual(24);
    const seam = 83;
    const right = (design - body) / 2;
    expect(seam - right - body / 2).toBe(seam - design / 2);
    expect(seam - right - body / 2).toBeGreaterThan(73.1);
  });

  it("meets the touch floor in overhang, and pays for its own borders", () => {
    const extension = coarseGripBlock.match(/\.rail-collapse::after \{([^}]+)\}/u)?.[1] ?? "";

    // Derived terms only. `--grip-edge` appears because `box-sizing` is
    // `border-box` product-wide: `width` is the outer box, these offsets
    // resolve against the padding box inside it, and the version that ignored
    // that summed to 42px while every comment about it claimed 44.
    expect(extension).toContain("inset-block: calc(-1 * var(--grip-edge))");
    expect(extension).toContain("left: calc(-1 * (var(--sp-1) + var(--grip-edge)))");
    expect(extension).toContain("right: calc(var(--sp-1) + var(--grip-body) - var(--touch-target) - var(--grip-edge))");
    expect(extension).not.toContain("right: 0");
    // Room, not a shape. Anything painted here would be the 44px body again.
    for (const paint of ["background", "opacity"]) expect(extension).not.toContain(paint);

    // The law those terms encode: beyond the paint the box reaches one `--sp-1`
    // inward — the gutter the collapsed rail insets `.primary-nav` by — and the
    // whole remainder outward, and the whole box is `--touch-target` wide once
    // the two borders `width` swallowed are handed back.
    const design = tokenPx(css, "--grip-design-body");
    const body = tokenPx(css, "--grip-body");
    const target = tokenPx(tokens, "--touch-target");
    const edge = tokenPx(css, "--grip-edge");
    const inward = tokenPx(tokens, "--sp-1");

    /* The extension's two page-space edges, for a body of any width. Measured
       at tablet-768, the only viewport with both a rail and a coarse pointer,
       the seam is x=83. The paint hangs at `right: (design − body) / 2` with
       `translate: 50%`, so its border box is [seam − design/2, seam − design/2
       + body]; the insets above resolve against the padding box one
       `--grip-edge` inside that. Both expressions cancel `body` entirely, which
       is the property being asserted: widening the paint outward cannot move
       the room a finger is given. */
    const seam = 83;
    const room = (paint: number) => [
      seam - design / 2 + edge - (inward + edge),
      seam - design / 2 + paint - edge - (inward + paint - target - edge),
    ] as const;
    const [roomLeft, roomRight] = room(body);

    expect(roomRight - roomLeft).toBe(target);
    expect(room(body)).toEqual(room(design));

    // `Connection`'s ink ends at x=73.1 — the room stops inside that row's own
    // padding and never under a glyph a tap could be aimed at — and the nearest
    // control in any of the fourteen route captures is the `profiles` avatar
    // whose left edge is x=121. Both edges are pinned because this control has
    // been over one of them or the other in three of its four lives, and there
    // is no viewport where it can have room from both.
    expect(roomLeft).toBe(72.5);
    expect(roomRight).toBe(116.5);
    expect(roomLeft).toBeGreaterThan(72);
    expect(roomRight).toBeLessThan(121);
    // And the paint — which is what the audits actually saw — clears that ink
    // at either body width, because only its outer edge ever grew, and it never
    // reaches past the room it is drawn inside.
    expect(seam - design / 2).toBeGreaterThan(73.1);
    expect(seam - design / 2 + body).toBeLessThan(roomRight);
  });

  it("charges no rail width, in any state, for the grip on its seam", () => {
    // The regression this replaces: half a touch target added to every painted
    // rail state moved the seam 22px right on a coarse pointer, and with it
    // every route's content column and the topbar track the posture chip lives
    // in — 34 reported regressions on thirteen routes, from one control's
    // 22px. A grip that hangs off an edge does not widen the column behind it.
    for (const sheet of [css, tokens]) expect(sheet).not.toContain("--rail-seam-reserve");
    expect(css).toContain(':root[data-rail="rail"] { --rail-width: 84px; }');
    expect(tokens).toContain(':root[data-rail="rail"] { --rail-width: 60px; }');
    expect(tokens).toContain(':root[data-rail="standard"] { --rail-width: var(--density-sidebar); }');
    // `.rail`'s own box is the seam. Padding here is the same 22px charged one
    // level down, and it would move the icons off the mark drawn above them.
    for (const selectors of rulesDeclaring("padding-right")) expect(selectors).not.toContain(".rail");
  });

  it("never shows a finger less rail than it shows a mouse", () => {
    /*
     * The sweep filed those two numbers as an inversion — "1024 shows less rail
     * than 768 does" — because 84px is declared for a narrower viewport than
     * the one that reads 60px. They are not two widths, they are two
     * renderings: at 60px the labels are clipped and answered by `title`, a
     * hover affordance, and the block above un-clips them and pays the 24px
     * they need for the pointer that has no hover to ask with.
     *
     * What a person can actually cross is the width band, and along that axis
     * neither sequence ever narrows: coarse reads 84 → 84 → 232 → 232 at 768,
     * 860, 1024 and 1180, because `defaultRailState` hands a touch tablet the
     * standard rail from `RAIL_TOUCH_STANDARD_MIN_WIDTH` up; fine reads
     * 60 → 60 → 60 → 232 → 232 at 1024, 1280, 1361, 1440 and 1920. All five
     * widths measured on the built app. The invariant worth pinning is the
     * comparison at equal width, which is the one that would actually be a
     * defect if it inverted.
     */
    const standard = tokenPx(tokens, "--density-sidebar");
    /** The width `.rail` paints at, for a pointer that has a hover or has not. */
    const railAt = (width: number, hoverCapable: boolean) =>
      defaultRailState({ width, hoverCapable }) === "standard" ? standard
        : hoverCapable ? tokenPx(tokens, "--rail-width") : tokenPx(css, "--rail-width");
    for (const width of [640, 768, 860, 861, 1024, 1280, 1361, 1440, 1920]) {
      expect(railAt(width, false), `coarse rail at ${width}`).toBeGreaterThanOrEqual(railAt(width, true));
    }
    // Neither sequence narrows as the device gets wider, either.
    for (const hoverCapable of [true, false]) {
      const widths = [640, 768, 860, 861, 1024, 1280, 1361, 1440, 1920].map((width) => railAt(width, hoverCapable));
      expect(widths, `${hoverCapable ? "fine" : "coarse"} widths`).toEqual([...widths].sort((a, b) => a - b));
    }
    // And the two literals those readings come from, so a change to either has
    // to come back through this test.
    expect(tokenPx(css, "--rail-width")).toBe(84);
    expect(tokenPx(tokens, "--rail-width")).toBe(60);
  });

  it("keeps the topbar's mark over the rail's contents and not over its track", () => {
    // `.topbar` shares `--rail-width` with `.app-shell` so the brand tracks the
    // rail exactly. With nothing held back at the seam the track *is* the
    // contents, so centring in it centres over the icon column; the inset this
    // rule briefly carried existed only to undo the reserve.
    expect(css).toContain(':root[data-rail="rail"] .brand { justify-content: center; padding: 0; }');
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
