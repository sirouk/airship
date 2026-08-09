import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const [app, styles, sessions, proofSource, proofStyles, terminalSource, featureStyles] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
  readFile(new URL("./proof-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./proof-view.css", import.meta.url), "utf8"),
  readFile(new URL("./terminal-view.tsx", import.meta.url), "utf8"),
  Promise.all([
    ["access-connection-view", "./access-view.css"],
    ["attestations-view", "./attestations-view.css"],
    ["capabilities-view", "./capabilities-view.css"],
    ["client-context-view", "./context-view.css"],
    ["git-sources", "./sources-view.css"],
    ["vault-view", "./vault-view.css"],
  ] as const).then(async (entries) => Promise.all(entries.map(async ([selector, file]) => ({
    selector,
    source: await readFile(new URL(file, import.meta.url), "utf8"),
  })))),
]);

describe("route layout contract", () => {
  it("assigns every non-chat destination to the shell-owned route layout", () => {
    expect(app).toContain('? "main chat-layout"');
    expect(app).toContain(': "main route-layout"');
    expect(app).not.toContain("TrustHubTabs");
  });

  it("owns one outer gutter family and keeps feature roots padding-free", () => {
    const routeRule = cssRule(styles, ".route-layout");
    expect(routeRule).toContain("--route-gutter-block:");
    expect(routeRule).toContain("--route-gutter-inline-start:");
    expect(routeRule).toContain("--route-gutter-inline-end:");
    expect(routeRule).toContain("padding:");

    expect(cssRule(styles, ".work-view")).toMatch(/padding:\s*0;/u);
    expect(cssRule(sessions, ".session-library-view")).toMatch(/padding:\s*0;/u);
    for (const { selector, source } of featureStyles) {
      expect(cssRule(source, `.${selector}`), selector).not.toMatch(/(?:^|;)\s*padding(?:-|:)/u);
    }
  });

  it("applies safe-area-aware mobile insets once at the route shell", () => {
    expect(styles).toContain("--route-gutter-inline-start: max(13px, env(safe-area-inset-left));");
    expect(styles).toContain("--route-gutter-inline-end: max(13px, env(safe-area-inset-right));");
    expect(styles).not.toMatch(/\.work-view\s*\{[^}]*safe-area-inset/su);
    expect(sessions).not.toMatch(/\.session-library-view\s*\{[^}]*safe-area-inset/su);
  });

  it("keeps the Vault route centered while dense workbenches stay full width", () => {
    const vault = cssRule(styles, ".route-layout > .vault-route");
    expect(vault).toContain("width: min(1160px, 100%)");
    expect(vault).toContain("margin-inline: auto");
    const wide = cssRule(styles, '.route-layout > [data-route-measure="wide"]');
    expect(wide).toContain("width: 100%");
    expect(wide).toContain("max-width: none");
  });

  /*
   * VIS-02: dense surfaces expand, prose stays bounded.
   *
   * The mechanism is one attribute, and it only works from a route *root* —
   * `.route-layout > [data-route-measure="wide"]` is a child combinator, so the
   * same attribute on a panel two levels down is silently inert and the route
   * quietly keeps the 1160px prose cap. That is the failure this pins: the
   * opt-out has to be on the element `app.tsx` mounts directly in `<main>`, and
   * a route that is half grid and half prose has to re-enter the measure from
   * the inside rather than leave the cap on and squeeze its grid.
   */
  it("lets a dense route escape the prose measure only from its own root", () => {
    const wide = cssRule(styles, '.route-layout > [data-route-measure="wide"]');
    expect(wide).toContain("width: 100%");
    expect(wide).toContain("max-width: none");
    // The rule has to outrank the default measure, which it can only do on
    // source order: both selectors weigh (0,2,0).
    expect(styles.indexOf('.route-layout > [data-route-measure="wide"]'))
      .toBeGreaterThan(styles.indexOf(".route-layout > *"));

    // On the opening tag of each route root, not on something inside it.
    expect(terminalSource).toMatch(/<section\s+class=\{`terminal-route[^>]*?data-route-measure="wide"/su);
    expect(proofSource).toMatch(/<section\s+class="work-view proof-view"[^>]*?data-route-measure="wide"/su);
    // …and each of those roots is what `app.tsx` renders straight into `<main>`.
    expect(app).toMatch(/<main\b[\s\S]*<ProofScreen\b/u);

    // The attestation ledger is the grid that wanted the width; the receipt
    // panel is prose and re-enters the same measure one level down.
    expect(cssRule(proofStyles, ".proof-surface-panel--prose")).toContain("width: min(1160px, 100%)");
    /*
     * …and re-entering it means re-centring it. Measured at wide-1920 before
     * this line existed: the route ran x=258..1894 (the 1636px it opted into)
     * and this panel ran x=258..1418 — the cap held and the panel sat hard
     * against the route's left edge with 476px of empty ground beside it. A cap
     * without an alignment is left-aligning with extra steps.
     */
    expect(cssRule(proofStyles, ".proof-surface-panel--prose"), "a re-entered measure is centred, not parked at the route's start edge")
      .toContain("margin-inline: auto");
    expect(proofSource).toContain('class="proof-surface-panel proof-surface-panel--prose"');
    expect(proofSource, "the evidence ledger keeps the width the route opted into")
      .toContain('id="proof-panel-attestations" class="proof-surface-panel"');
  });

  it("holds the hub's own tab strip against the scroll that used to take it away", () => {
    /*
     * NR027. Profiles, Skills and Capabilities are one hub reachable only
     * through this strip, and it is the first child of `main.route-layout` —
     * the pane that scrolls — so it was the first thing off the top of any
     * scroll. Measured on the shipped build on `#skills` with the new-skill
     * editor open, which scrolls the pane by itself: the strip sat at y=-466 at
     * phone-320, -459 at landscape-932, y=6..58 against a pane starting at 58
     * at tablet-768, and bottom=-3 at desktop-1440. Four viewports out of four,
     * with nothing on screen saying which of the three pages was open.
     */
    // The strip is written as several rules across this sheet and its media
    // queries, so the block is found by what it declares rather than by its
    // position among them.
    const sticky = [...styles.matchAll(/\.profile-hub-tabs \{([^}]*)\}/gu)]
      .map((match) => match[1])
      .find((body) => body.includes("position: sticky")) ?? "";
    expect(sticky, "the strip declares itself sticky").not.toBe("");
    expect(sticky).toContain("top: 0");
    // Against the route's own content only. `.menu-select-popover` is z-index
    // 320 and the Skills scope dropdown sits directly beneath this strip, so an
    // upward-opening menu still paints over it rather than under it.
    expect(sticky).toContain("z-index: 2");
    /*
     * The band, and why it is not optional. A sticky box is held at the
     * scrollport's PADDING edge, and `.route-layout` carries
     * `--route-gutter-block` of top padding — so content scrolling up through
     * that gutter passes over the clear above the held strip. The two inline
     * gutter variables are cancelled so the band reaches the pane's own edges
     * at every width rather than only as far as the centred strip does.
     */
    const band = cssRule(styles, ".profile-hub-tabs::before");
    expect(band).toContain("var(--route-gutter-inline-start)");
    expect(band).toContain("var(--route-gutter-inline-end)");
    expect(band).toContain("var(--route-gutter-block)");
    expect(band).toContain("background: var(--ground)");
    // Strictly above the strip: a pseudo-element paints after its own parent's
    // background, so an overlapping band would be page ground drawn across the
    // top of the pill rather than hidden behind it.
    expect(band).toContain("bottom: 100%");
  });

  it("keeps profile navigation inside the route-owned gutter without nesting another inset", () => {
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("width: min(1160px, 100%)");
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("margin: 0 auto");
    expect(cssRule(styles, ".profile-scope-contract")).toContain("width: min(1160px, 100%)");
    expect(styles).not.toMatch(/\\.profile-(?:hub-tabs|scope-contract)[^{]*\{[^}]*width:\s*calc\(100%\s*-\s*(?:28|36)px\)/su);
  });

  /*
   * One measure, written once, spelled the same everywhere it is re-entered.
   *
   * The wide-viewport judgements arrived as six separate route complaints —
   * "wastes the width it asked for" (Account), "the tab strip does not share
   * the route's measure" (Profiles), "a quarter of the screen empty" (Proof) —
   * and they were one fact: the product held three measures at once. Measured
   * at wide-1920 before this test existed, in the same frame class and behind
   * the same 232px rail: Account ran x=446..1706 (1260px), the Profiles tab
   * strip ran x=416..1736 (1320px), and Vault and Sessions ran x=496..1656
   * (1160px). At desktop-1440 every one of them collapsed onto 1156px, which is
   * why four waves of screenshots at ≤1440 showed nothing wrong.
   *
   * So the literal is pinned, not the intent. `min(1160px, 100%)` is the whole
   * convention: it is what `.route-layout > *` writes, what `.vault-route`
   * repeats for the one route that needs its own root, and what
   * `.proof-surface-panel--prose` re-enters one level down inside a route that
   * opted out. A second number appearing anywhere in this family is the defect,
   * and `min(…, 100%)` hides it from every viewport under about 1400px.
   */
  it("writes exactly one prose measure across the route family", () => {
    const measures = new Set<string>();
    for (const selector of [".route-layout > *", ".route-layout > .vault-route", ".profile-hub-tabs", ".profile-scope-contract", ".billing-view"]) {
      const rule = cssRule(styles, selector);
      const width = /width:\s*min\((\d+)px,\s*100%\)/u.exec(rule);
      expect(width, `${selector} states the shared measure`).not.toBeNull();
      measures.add(width![1]);
    }
    measures.add(/width:\s*min\((\d+)px,\s*100%\)/u.exec(cssRule(proofStyles, ".proof-surface-panel--prose"))![1]);
    expect([...measures], "one measure, not three").toEqual(["1160"]);
  });

  /*
   * A label and the state it names are a pair, not a pair of edges.
   *
   * Vault's attached-prerequisites list is `justify-content: space-between`,
   * which is right on a phone row and an index without leaders on a desktop
   * one. Measured at desktop-1440: each `li` was 1084px and the gap between
   * label and value was 981.9px (`Endpoint` → `None`), 912.5px
   * (`Credential authority` → `None`) and 941.9px (`Workspace key` → `None`);
   * at wide-1920, 1088px rows with 985.9 / 916.5 / 945.9px of gap. The fix is
   * a fixed value column above 1100px, and it must stay a fixed *font-relative*
   * column — a px track cannot follow the type scale, and the longest label in
   * `attachedRows` is `Encrypted object store`.
   */
  it("binds Vault's attached facts to their labels instead of to the row's far edge", () => {
    const vault = featureStyles.find(({ selector }) => selector === "vault-view")!.source;
    expect(cssRule(vault, ".vault-view__attached li"), "the narrow tier keeps space-between")
      .toContain("justify-content: space-between");
    const wide = vault.slice(vault.indexOf("@media (min-width: 1101px)"));
    expect(wide).toContain(".vault-view__attached li { justify-content: flex-start; }");
    expect(wide).toMatch(/\.vault-view__attached li > span \{ flex: 0 0 \d+rem; \}/u);
    expect(wide, "the value reads from the start of its own column").toContain("text-align: start");
  });

  /*
   * The advanced source-controls panel may not cap its own primary action.
   *
   * `.git-rails` carried `max-height: 200px; overflow-y: auto` above 1100px,
   * and it is the grid row that holds `.git-commit-box`. Measured at
   * desktop-1440 with one path genuinely staged: the rails scroller was 199px
   * of client box over 495px of content and `Commit locally` ran
   * y=846.1..890.1 against a bottom edge at y=858 — 11.9px of a 44px button,
   * with overlay scrollbars painting no affordance over the missing 32px. The
   * cap moves onto the two `<details>`, which are the columns that are actually
   * tall and which a reader can close; the commit box takes its natural height.
   */
  it("caps the source-controls disclosures rather than the row holding Commit", () => {
    const sources = featureStyles.find(({ selector }) => selector === "git-sources")!.source;
    const desktop = sources.slice(sources.indexOf("@media (min-width: 1101px)"), sources.indexOf("@media (max-width: 1100px)"));
    expect(desktop, "the row no longer clips its own primary action").not.toMatch(/\.git-rails\s*\{[^}]*max-height/su);
    expect(desktop).toContain(".git-repository-controls,\n  .git-remote-boundary { max-height: 200px; overflow-y: auto; }");
    expect(sources, "the commit box is not a disclosure and takes the height it needs")
      .not.toMatch(/\.git-commit-box\s*\{[^}]*max-height/su);
  });

  /*
   * A shut drawer draws as a shut drawer. `.capability-policy-row` is a grid,
   * and grid items stretch: the collapsed `Browser primitives` disclosure was
   * sized by the policy stack beside it and measured 345.9 x 129.5px at
   * wide-1920 (344.7 x 129.5 at desktop-1440) around a 15px summary — 114.5px
   * of bordered nothing that reads as a panel that failed to load.
   */
  it("lets a closed capabilities disclosure keep its own height", () => {
    const capabilities = featureStyles.find(({ selector }) => selector === "capabilities-view")!.source;
    expect(cssRule(capabilities, ".capability-policy-row > details:not([open])")).toContain("align-self: start");
  });

  it("wraps the Attestations actions to their own line instead of crushing the lede beside them", () => {
    /*
     * `.attestations-heading-actions` is `flex: 0 0 auto`, so it never gives up
     * a pixel and the prose beside it paid for every shortfall on its own.
     * Measured off the shipped Attestation-evidence frames, the actions took an
     * identical 713px at 1440, 1024 and 932, and the lede was left 419px,
     * 175px and 168px respectively — meaning the section's own title and
     * description were laid out narrower on a laptop than on a 320px phone,
     * where the ≤860px band stacks them and hands them the whole column. At
     * landscape-932 the 13-line paragraph that produced pushed both action
     * buttons off a 430px viewport altogether.
     *
     * What is pinned is that the header may wrap and that the lede has a
     * flex-basis to wrap against. Either alone is inert: without `flex-wrap`
     * the basis is just another thing to shrink out of, and without a basis
     * larger than the crushed width there is nothing for the wrap to trigger
     * on. The basis has to stay font-relative — a px threshold cannot see that
     * viewport 1024 yields 920px of content behind a collapsed rail while
     * viewport 1440 yields 1156px behind an expanded one, which is the reason
     * this is not a media query.
     */
    const attestations = featureStyles.find(({ selector }) => selector === "attestations-view")!.source;
    const heading = cssRule(attestations, ".attestations-heading");
    expect(heading).toMatch(/flex-wrap:\s*wrap/u);
    const lede = cssRule(attestations, ".attestations-heading-lede");
    expect(lede).toMatch(/flex:\s*1 1 \d+ch/u);
    // The actions keep their max-content width first and the lede grows into
    // what is left, which is what makes the wide layout byte-identical to the
    // one this replaces rather than a second renegotiation of it.
    expect(cssRule(attestations, ".attestations-heading-actions")).toMatch(/flex:\s*0 0 auto/u);
    // On a wrapped line the actions are the only item, and `space-between`
    // would seat them at its start rather than against the right edge.
    expect(heading).toMatch(/justify-content:\s*flex-end/u);
    // The phone band turns this header into a grid, where that `flex-end` would
    // push the single column off to the right; it has to restate its own
    // alignment or the fix above reaches a width it was never measured at.
    expect(attestations).toMatch(
      /@media \(max-width: 860px\) \{[\s\S]*?\.attestations-heading \{[^}]*justify-content:\s*start/u,
    );
  });

  it("keeps both Proof tabs whole by letting their labels wrap instead of picking one to cut", () => {
    /*
     * Two defects, one rule. First, `1fr 1fr` was written on `.tabs` — whose two
     * children are the scrolling strip and the `⌄ n` overflow control. So at
     * 320px the strip got half the screen, both labels still laid out at their
     * nowrap widths inside it, and `Receipt & journal` rendered as an 8px sliver
     * of glyph beside a permanent overflow badge: a two-item switcher reading as
     * a rendering fault on the one route whose content depends on knowing which
     * view you are in.
     *
     * Moving the halving onto the strip fixed 320px and then charged every width
     * up to 760 for it. Two equal tracks are two equal tracks whether or not the
     * labels need cutting, so at 430px — where both had always fitted whole —
     * `Attestation evidence` was cut to `Attestation evide…` while `Receipt &
     * journal` sat in a half it did not fill.
     *
     * `flex: 1 1 auto` was written next to say both things at once, and it said
     * neither: measured on the shipped build the active tab came out at exactly
     * half the strip at every phone width — 141 of 286 at 320, 176 of 356 at
     * 390, 196 of 396 at 430 — so 430 kept the cut the rule was added to remove.
     * A tab that grows into slack starts from its label; one that lands on a
     * pixel-exact half started from zero.
     *
     * Scoping that growth to ≤400px fixed 430 and charged 390 instead, which is
     * where this test's subject comes from. The strip is 356px at 390 for a pair
     * wanting 386, and every rule tried so far has taken the 30px shortfall out
     * of both tabs — so `Receipt & journal` rendered `Receipt & jou…` while it
     * was the selected tab, and `Attestation evidence` did the same at 320 and
     * 390 whenever it was the selected one. That is the one truncation a user
     * cannot undo: every other clipped label is one tap from being read, and
     * this one is clipped *because* you already tapped it.
     *
     * The answer written next was "the selected tab pays nothing, the other
     * absorbs all of it", and it overshot because it was costed in only one
     * direction. Its own note recorded 320 as leaving the other tab 107px —
     * the remainder after `Receipt & journal`'s 175. Select the other tab and
     * the arithmetic changes: `Attestation evidence` needs 207, so the
     * remainder is 286 - 207 - 4 = 75px and the strip rendered `Rec…`. Three
     * characters is a stub, not a label a reader can recognise and choose.
     *
     * So the split is withdrawn rather than re-balanced, because its premise —
     * that someone must absorb an unavoidable cut — is false. The pair only
     * wants 386px of *line* because the button forbids a second one. Letting
     * the label wrap lets both tabs shrink normally and stay whole: 129px and
     * 153px at 320, 161px and 191px at 390, and no shrink at all at 430, where
     * the pair already fits and the band must stay byte-identical.
     *
     * What is pinned here is therefore the wrap, the restated leading it needs
     * (the base rule sets `font: … /1 …`, and two lines set solid collide), the
     * declared vertical air that keeps a ~40.5px two-line label off the walls
     * of its 44px box, and — most importantly — the *absence* of every
     * mechanism that manufactured a cut: the equal splits, and the `min-width:
     * 0` overrides that let a tab shrink below its own longest word. Restoring
     * the flex default is what makes "wrap" mean "wrap" rather than "wrap, then
     * clip".
     */
    // This sheet has more than one band at any given width, so the block is
    // selected by what it contains rather than by which one comes first.
    const band = (width: number, selector: string) =>
      [...styles.matchAll(new RegExp(`@media \\(max-width: ${width}px\\) \\{(?:[^{}]|\\{[^{}]*\\})*\\}`, "gu"))]
        .map((match) => match[0])
        .find((block) => block.includes(selector)) ?? "";
    const phoneBand = band(760, ".proof-surface-tabs");
    expect(phoneBand, "the phone rules for this strip live in one band").not.toBe("");
    // The wrap, and the two declarations that make it habitable.
    expect(phoneBand).toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*white-space: normal/u);
    expect(phoneBand).toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*line-height: 1\.2/u);
    expect(phoneBand).toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*padding-block: var\(--sp-1\)/u);
    // The touch floor is untouched by all of it: the button still holds 44px,
    // and the wrap grows it past that rather than borrowing from it.
    expect(phoneBand).toMatch(/\.proof-surface-tabs button \{[^}]*min-height: var\(--touch-target\)/u);

    // No band may hand the tabs equal shares again, at any width. `flex: 1 1
    // auto` on the tab is the 176-of-356 halving this replaces; it belongs to
    // `.tabs__strip`, which is a different box, so the selector is exact.
    expect(styles).not.toMatch(/\.proof-surface-tabs \.tabs__tab(?:-button)? \{[^}]*flex: 1 1 auto/u);
    expect(styles).not.toMatch(/\.proof-surface-tabs[^{]*\{[^}]*grid-template-columns/u);
    // Nor may the selected tab go back to refusing to shrink: that refusal is
    // what pushed the whole 100px deficit onto one neighbour and produced
    // `Rec…`. With both tabs shrinking normally there is no shortfall to charge.
    expect(styles).not.toMatch(/\.proof-surface-tabs \.tabs__tab\[data-active="true"\] \{[^}]*flex-shrink: 0/u);
    // And the min-content floor stays restored. `min-width: 0` here is what
    // lets a tab be squeezed below its own longest word, which turns the wrap
    // back into a clip — the exact defect this replaced.
    expect(styles).not.toMatch(/\.proof-surface-tabs \.tabs__tab \{[^}]*min-width: 0/u);
    expect(styles).not.toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*min-width: 0/u);
  });

  it("lets the Agent-configuration tabs share the narrowest row instead of each taking a third", () => {
    /*
     * The same defect as the Proof switcher above, one route over and one tab
     * wider. `repeat(3, minmax(0, 1fr))` is an equal share, and at 320px an
     * equal share is a 93px cell — into which "Capabilities" lays out 86px of
     * ink. Measured off the shipped frame: seven pixels of air to the word's
     * left, one to its right, its trailing "s" standing on the pill's rounded
     * border, while "Skills" held 38px of ink in an identical cell. There is no
     * width for the label to be given, because the strip is not short of room —
     * it is dividing the room it has by a rule that cannot see the labels.
     *
     * `minmax(0, auto)` is the rule that says both things at once: take at most
     * your own content, and let the grid's default stretch hand out the surplus
     * evenly so the strip still fills the row. This strip is not short of room
     * at 320, so it needs no version of the Proof switcher's rule above — there
     * is no shortfall here for a selected tab to be spared from, only a surplus
     * that was being handed out without looking at the labels. The `0` floor is
     * load-bearing on its own — it is what the enclosing block's note is about,
     * and without it a track can insist on a width a 320px phone does not have
     * and scroll the whole route sideways.
     *
     * Pinned at 360px and not at 640: 390px already affords 117px a tab, and
     * the frames at 390, 430 and landscape-932 were passed by the sweep with
     * equal thirds. A repair that reshaped them would be taking width from
     * things that had nothing wrong with them.
     */
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[^}]*\.profile-hub-tabs \{[^}]*grid-template-columns: repeat\(3, minmax\(0, auto\)\)/u);
    // Stated, not inherited from the user agent's button default: "zero inline
    // padding" was only ever true because no rule here had said otherwise.
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[\s\S]*?\.profile-hub-tabs > button \{[^}]*padding-inline:/u);
    // Above that width the thirds are still thirds, so nothing the sweep passed
    // is reshaped by this.
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("repeat(3, minmax(100px, 1fr))");
  });

  /*
   * The route scroller ends its content on a hard line, and a hard line lands
   * in the middle of letterforms.
   *
   * `.route-layout` is `.main`, bounded above by the topbar and below by the
   * navigation band, so at a short viewport every resting scroll position cuts
   * whatever row is crossing the edge. Measured at landscape-932 on
   * #capabilities with all boundaries open, 11 of 13 resting stops cut at least
   * one text leaf, and at scrollTop 0 — the state a reader arrives in — both
   * "Live page-memory probe" and the amber performance-schedule pill were
   * sliced through their midline. #skills with the editor open was 8 of 12.
   *
   * This is `.primary-nav`'s `data-scroll-edges` recipe applied to the shell's
   * only other scroller, and it is measured rather than assumed in the same
   * way: the attribute comes from live overflow, so a route that fits keeps a
   * hard edge and the fade never claims content that is not there.
   */
  it("fades the route scroller's edges only on the side genuinely hiding content", () => {
    for (const [edges, gradient] of [
      ["start", "linear-gradient(to bottom, transparent 0, #000 26px)"],
      ["end", "linear-gradient(to bottom, #000 calc(100% - 26px), transparent 100%)"],
    ] as const) {
      expect(styles).toContain(`.route-layout[data-scroll-edges="${edges}"] { --route-scroll-fade: ${gradient}; }`);
    }
    expect(styles).toContain('.route-layout[data-scroll-edges="both"] { --route-scroll-fade:');

    // `none` is a state, not an absence: an always-on fade would assert "there
    // is more below" on a route that fits.
    expect(styles).toMatch(/\.route-layout\[data-scroll-edges\]:not\(\[data-scroll-edges="none"\]\)/u);

    // The shell writes the reading; the sheet only paints it.
    expect(app).toContain("useScrollEdges(mainRegion,");

    // A fade carries no forced-colors equivalent, so it stands down there and
    // lets the scrollbar carry the affordance — the same escape hatch the rail
    // takes, for the same reason.
    expect(styles).toMatch(/@media \(forced-colors: active\) \{[\s\S]*?\.route-layout\[data-scroll-edges\][\s\S]*?mask-image: none/u);
  });

  /*
   * The guard is the difference between this scroller and the rail, and it is
   * the reason the recipe could not simply be copied.
   *
   * A mask is a group effect: it applies to the element's whole painted
   * subtree, `position: fixed` descendants included — which is precisely the
   * capture `.main { position: relative }` was chosen to avoid. Popovers open
   * inside `main` and in sheet mode are fixed against the viewport. Measured at
   * phone-320, the proof claim-stack sheet is `main`'s descendant and its box
   * runs to y=568 while `main`'s own bottom is y=512, so an unguarded mask
   * would not soften that sheet's last line — it would erase it.
   */
  it("stands the fade down while a sheet is open inside the scroller it would mask", () => {
    const masked = /\.route-layout\[data-scroll-edges\]:not\(\[data-scroll-edges="none"\]\)([^{]*)\{([^}]+)\}/u.exec(styles);
    expect(masked?.[1], "the masking rule must carry the open-popover guard").toContain(':not(:has(.popover[data-open="true"]))');
    expect(masked?.[2]).toContain("mask-image: var(--route-scroll-fade)");
  });
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
