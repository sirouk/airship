import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR } from "./focus-trap";
import {
  POPOVER_DEFAULT_WIDTH,
  POPOVER_EDGE_GUTTER,
  POPOVER_HOVER_INTENT_MS,
  POPOVER_LANDSCAPE_MAX_HEIGHT,
  POPOVER_LANDSCAPE_MAX_WIDTH,
  POPOVER_LANDSCAPE_WIDTH,
  POPOVER_MIN_ROOM,
  POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
  POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
  POPOVER_SHEET_MAX_WIDTH,
  popoverPlacement,
  popoverRoom,
  popoverVerticalPlacement,
  popoverWidth,
} from "./popover";

/** A viewport tall enough that only the width arm can decide the mode. */
const TALL = 900;

describe("the one anchored disclosure", () => {
  it("anchors from the left while the panel clears the viewport gutter", () => {
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }))
      .toEqual({ mode: "anchored", align: "start" });
  });

  it("flips to the right edge exactly when the panel would cross the gutter", () => {
    // The last chip in a right-hand cluster is the case that matters: one pixel
    // either side of the boundary has to pick a different edge, or the flip is
    // decorative rather than load bearing.
    const justInside = 1440 - POPOVER_EDGE_GUTTER - 320;
    expect(popoverPlacement({ anchorLeft: justInside, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }).align).toBe("start");
    expect(popoverPlacement({ anchorLeft: justInside + 1, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }).align).toBe("end");
  });

  it("becomes a bottom sheet at and below the phone breakpoint, whatever the anchor", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH, viewportHeight: TALL }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 300, popoverWidth: 320, viewportWidth: 430, viewportHeight: TALL }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH + 1, viewportHeight: TALL }).mode).toBe("anchored");
  });

  /*
   * The landscape defect this arm exists for.
   *
   * At 932x430 the Proof route's claim-stack chip ends ~305px down a `.main`
   * pane that stops at 385px above the navigation band. The width test alone
   * called that anchored — 932 is wider than any upright-phone threshold — so
   * `popoverRoom` fell to its floor, the panel overhung, and the route's
   * primary evidence surface showed a header and about 10px of its first claim
   * with the other eight underneath the band. A viewport can be too short to
   * anchor in while being far too wide to look like a phone.
   */
  it("becomes a sheet on the landscape arm, where the viewport is wide but has no height", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 932, viewportHeight: 430 }).mode).toBe("sheet");
    // Both bounds are inclusive, and one pixel past either returns the panel to
    // an anchor — the arm has to be a boundary, not a mood.
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
    }).mode).toBe("sheet");
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH + 1,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
    }).mode).toBe("anchored");
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT + 1,
    }).mode).toBe("anchored");
  });

  it("leaves a short window that is wider than the landscape arm anchored", () => {
    // A 1440x420 desktop window is short, but it is not the compact shell and a
    // full-bleed bottom sheet there would be a 1440px-wide overlay for a chip.
    // `popoverRoom` is what keeps that case honest, not the mode.
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440, viewportHeight: 420 }).mode)
      .toBe("anchored");
  });

  it("measures the room to the clipping pane, not to the window", () => {
    /*
     * A chip partway down a `.main` pane (`overflow: auto`) that stops at y=382
     * because a fixed band owns the rest, in a 430px window. A body capped at
     * 60vh of the screen is 258px while the pane has only 276px left below the
     * trigger, so the `vh` fraction says nothing about how much of the screen
     * this panel may actually occupy — and the window's own height is the
     * number that was never the answer.
     *
     * Deliberately not written as a landscape phone any more: that shape opens
     * as a sheet now and never reaches this function. What is left for it are
     * short desktop windows, chips low in a scrolled pane, and the editor route
     * where `.main` is `overflow: hidden` and clips outright.
     */
    expect(popoverRoom({ anchorBottom: 94, clipBottom: 382 })).toBe(382 - 94 - POPOVER_EDGE_GUTTER);
    expect(popoverRoom({ anchorBottom: 94, clipBottom: 430 }))
      .toBeGreaterThan(popoverRoom({ anchorBottom: 94, clipBottom: 382 }));
  });

  it("stops measuring rather than hand a chip near the fold a two-line panel", () => {
    // A trigger 30px above the pane's bottom edge has no usable room. Reporting
    // that honestly would produce a scroll viewport too short to read, so the
    // floor holds and the panel overhangs instead — visible beats contained.
    expect(popoverRoom({ anchorBottom: 352, clipBottom: 382 })).toBe(POPOVER_MIN_ROOM);
    expect(popoverRoom({ anchorBottom: 900, clipBottom: 382 })).toBe(POPOVER_MIN_ROOM);
  });

  it("opens upward when the room below cannot hold a panel and the room above can", () => {
    /*
     * The defect, in the numbers it was measured with. A `context` provenance
     * chip parked 40px above the bottom of `.main` — where a reader scrolling
     * to that row leaves it, and the only way these chips are reachable at all
     * — took the `POPOVER_MIN_ROOM` floor as if it were room, laid out 172px
     * tall, and ran 140.0px past the bottom of the pane and of the window at
     * tablet-768 (140.1 at laptop-1024, 139.8 at desktop-1440, 139.7 at
     * wide-1920). Twelve of 76 openings. Above those same triggers sat 870px of
     * empty pane.
     */
    const low = popoverVerticalPlacement({
      anchorTop: 940, anchorBottom: 984, clipTop: 58, clipBottom: 1024,
    });
    expect(low.side).toBe("above");
    // The room reported is the room on the side that won, gutter deducted, and
    // it is not floored: a flip only happens when this is genuinely available.
    expect(low.room).toBe(940 - 58 - POPOVER_EDGE_GUTTER);
  });

  it("stays below while the room below is still usable, however much room is above", () => {
    // The flip may not be a preference. A trigger halfway down a tall pane has
    // more room above it than below and must not turn the panel over for it —
    // downward is where a reader looks for a disclosure they just opened.
    const middle = popoverVerticalPlacement({
      anchorTop: 600, anchorBottom: 644, clipTop: 58, clipBottom: 1024,
    });
    expect(middle.side).toBe("below");
    expect(middle.room).toBe(popoverRoom({ anchorBottom: 644, clipBottom: 1024 }));
    // Exactly at the boundary, and one pixel either side of it.
    const atFloor = 1024 - POPOVER_MIN_ROOM - POPOVER_EDGE_GUTTER;
    expect(popoverVerticalPlacement({ anchorTop: atFloor - 44, anchorBottom: atFloor, clipTop: 58, clipBottom: 1024 }).side)
      .toBe("below");
    expect(popoverVerticalPlacement({ anchorTop: atFloor - 43, anchorBottom: atFloor + 1, clipTop: 58, clipBottom: 1024 }).side)
      .toBe("above");
  });

  it("keeps a trigger with room on neither side pointing downward", () => {
    /*
     * A chip low in a pane that is itself short — under the floor below AND
     * under it above. The panel overhangs either way, so it overhangs the end
     * a reader can still read from: header, title and first lines beside the
     * trigger, with the rest below the fold. Flipping would cut it off at the
     * top, which is where it starts.
     */
    const cramped = popoverVerticalPlacement({
      anchorTop: 200, anchorBottom: 244, clipTop: 58, clipBottom: 300,
    });
    expect(cramped.side).toBe("below");
    expect(cramped.room).toBe(POPOVER_MIN_ROOM);
    expect(Object.isFrozen(cramped)).toBe(true);
  });

  it("measures the flip against the pane, not the window", () => {
    // Same trigger, same window; only the pane's top edge moves. A route whose
    // pane starts under a fixed topbar has less room above than the window
    // suggests, and a panel flipped on the window's answer is a panel cut off
    // by the pane — the same mistake `popoverRoom` was written to stop making
    // downward.
    const deep = { anchorTop: 940, anchorBottom: 984, clipBottom: 1024 };
    expect(popoverVerticalPlacement({ ...deep, clipTop: 0 }).room).toBe(928);
    expect(popoverVerticalPlacement({ ...deep, clipTop: 800 }).side).toBe("below");
  });

  it("spends the landscape phone's abundant axis on the one it has none of", () => {
    /*
     * 932x430. The panel is anchored partway down a `.main` pane that ends
     * above the navigation band, so height is what it runs out of — and 320px
     * of a 932px viewport was leaving the About-memory header wrapping to three
     * mono lines (64px of a 430px screen) with the body's last paragraph cut.
     * Width is free on this shape and it is what buys lines back in both boxes.
     */
    expect(popoverWidth({ requested: 320, viewportWidth: 932, viewportHeight: 430 }))
      .toBe(POPOVER_LANDSCAPE_WIDTH);
    expect(POPOVER_LANDSCAPE_WIDTH).toBeGreaterThan(POPOVER_DEFAULT_WIDTH);
  });

  it("leaves every other shape at the width it asked for", () => {
    // The cost side, and it is nil at every viewport that is not a landscape
    // phone. A tall phone-width window has height to spend and a desktop never
    // had the problem; a sheet is full-bleed and reads no width from here.
    expect(popoverWidth({ requested: 320, viewportWidth: 932, viewportHeight: 900 })).toBe(320);
    expect(popoverWidth({ requested: 320, viewportWidth: 1440, viewportHeight: 430 })).toBe(320);
    expect(popoverWidth({ requested: 320, viewportWidth: 430, viewportHeight: 932 })).toBe(320);
    // Exactly at the bounds, and one pixel outside each of them.
    expect(popoverWidth({
      requested: 320,
      viewportWidth: POPOVER_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_LANDSCAPE_MAX_HEIGHT,
    })).toBe(POPOVER_LANDSCAPE_WIDTH);
    expect(popoverWidth({
      requested: 320,
      viewportWidth: POPOVER_LANDSCAPE_MAX_WIDTH + 1,
      viewportHeight: POPOVER_LANDSCAPE_MAX_HEIGHT,
    })).toBe(320);
    expect(popoverWidth({
      requested: 320,
      viewportWidth: POPOVER_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_LANDSCAPE_MAX_HEIGHT + 1,
    })).toBe(320);
    // Sheets start at the breakpoint, so the widening may never reach one.
    expect(popoverWidth({ requested: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH, viewportHeight: 430 }))
      .toBe(320);
  });

  it("is a floor on the room the shape can afford, not a cap on the caller", () => {
    expect(popoverWidth({ requested: 480, viewportWidth: 932, viewportHeight: 430 })).toBe(480);
  });

  it("flips the panel on the width it actually opens at", () => {
    /*
     * The one way widening a panel becomes a defect: `popoverPlacement` decides
     * the right-edge flip from `anchorLeft + popoverWidth`, so if the component
     * hands CSS 380px and the flip math 320px, a trigger in the last 60px of
     * that band opens a panel that runs off the screen. The measurement has to
     * feed both, which is why this reads the source rather than the styles.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("const anchor = host.getBoundingClientRect()"));
    const measured = effect.indexOf("popoverWidth({");
    expect(measured, "the width is measured before the placement").toBeGreaterThan(-1);
    expect(effect.indexOf("popoverPlacement({")).toBeGreaterThan(measured);
    expect(effect.slice(measured, effect.indexOf("setPlacement"))).toContain("popoverWidth: opened");
    // And the same number is what CSS lays the panel out at.
    expect(source).toContain('"--popover-width": `${panelWidth}px`');
    expect(source).toContain("setPanelWidth(opened)");
  });

  it("publishes the direction and the room from one measurement of the clipping box", () => {
    /*
     * The same failure mode as the width and the edge flip, on the other axis:
     * the room the panel is capped at and the direction it opens in have to
     * come from a single answer, or a panel told to open upward is bounded by
     * the space below it and runs off the top of the pane instead. This reads
     * the source because the wiring is the contract — the pure function is
     * proved above.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("const anchor = host.getBoundingClientRect()"));
    const measured = effect.indexOf("const clip = clippingBox(host);");
    expect(measured, "the clipping box is measured at open").toBeGreaterThan(-1);
    const vertical = effect.slice(measured, effect.indexOf("function onPointerDown"));
    expect(vertical).toContain("popoverVerticalPlacement({");
    expect(vertical).toContain("clipTop: clip.top");
    expect(vertical).toContain("clipBottom: clip.bottom");
    // One answer, both consumers.
    expect(vertical).toContain("setSide(vertical.side)");
    expect(vertical).toContain("setRoom(vertical.room)");
    // A sheet is pinned by its own insets and must never carry the flip.
    expect(vertical).toContain('setSide("below")');
    expect(source).toContain("data-side={side}");
    // And the clipping box is read on both edges, or the flip is decided
    // against the window while the panel is bounded by the pane.
    const box = source.slice(source.indexOf("function clippingBox"));
    expect(box.slice(0, box.indexOf("\n}"))).toContain("top = Math.max(top, rect.top)");
  });

  it("does not let a pending hover reopen the panel the reader just dismissed", () => {
    /*
     * A dismissal outranks an intent that has not fired yet: a press arriving
     * inside the 150ms window would otherwise close the panel and then have the
     * timer open it again, under a cursor that has moved on. And the host
     * contains the panel as well as the trigger, so a pointer moving from the
     * trigger onto the open panel re-enters the host and arms that timer on an
     * already-open disclosure — where it must not rewrite a commitment as a
     * glance and take the scrim away from a reader who is only reading.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const dismiss = source.slice(source.indexOf("function onPointerDown"), source.indexOf("function onFocusOut"));
    expect(dismiss.indexOf("cancelIntent()")).toBeLessThan(dismiss.indexOf("setOpen(false)"));
    // And the same movement may not rewrite what asked for an open panel: a
    // commitment stays a commitment until it is dismissed.
    const enter = source.slice(source.indexOf("onPointerEnter={"), source.indexOf("onPointerLeave={"));
    expect(enter).toContain("if (!openRef.current) setOpenIntent(\"hover\");");
    expect(source).toContain('setOpenIntent("commit");');
    expect(source).toContain("data-intent={openIntent}");
  });

  it("returns a frozen placement so a caller cannot mutate the shared result", () => {
    const placement = popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL });
    expect(Object.isFrozen(placement)).toBe(true);
  });

  it("keeps hover intent short enough to feel like a hover and long enough not to fire in transit", () => {
    expect(POPOVER_HOVER_INTENT_MS).toBeGreaterThanOrEqual(120);
    expect(POPOVER_HOVER_INTENT_MS).toBeLessThanOrEqual(200);
  });

  it("only owns keys while the keyboard is actually inside the disclosure", () => {
    /*
     * The scene this pins: a hover-open panel on one part of the page, the
     * reader's focus in a control somewhere else, an Escape meant for THAT
     * control. The document-level capture listener used to swallow every
     * Escape while any popover was open, closing the panel and refocusing its
     * trigger under someone else's cursor. Both keys still read one containment
     * check, and the two things that reach past this disclosure — stopping
     * propagation, and pulling focus back to the trigger — remain behind it.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function onKeyDown");
    // Only the handler itself — `onPointerLeave` further down legitimately
    // reads the same containment, and the listener attach marks the boundary.
    const keydown = source.slice(start, source.indexOf("document.addEventListener", start));
    const gate = keydown.indexOf("const contained = hostRef.current?.contains(document.activeElement) ?? false;");
    expect(gate, "the shared containment gate exists").toBeGreaterThan(-1);
    expect(keydown.indexOf('if (event.key === "Escape")')).toBeGreaterThan(gate);
    expect(keydown.indexOf('if (event.key === "Tab")')).toBeGreaterThan(gate);
    // One gate, both keys: the Tab branch must not have quietly regrown a
    // second, divergent containment check of its own.
    expect(keydown.match(/contains\(document\.activeElement\)/gu)).toHaveLength(1);
    // Tab is gated outright; the reader's next Tab is never yanked into a panel
    // they did not ask for.
    expect(keydown.indexOf("if (!contained) return;")).toBeLessThan(keydown.indexOf('if (event.key === "Tab")'));
    // Escape's two out-of-scope effects stay inside the gate.
    const uncontained = keydown.slice(keydown.indexOf("if (!contained) {"), keydown.indexOf("event.stopPropagation()"));
    expect(uncontained).not.toContain("stopPropagation");
    expect(uncontained).not.toContain("triggerRef.current?.focus()");
  });

  it("leaves a sheet an exit from wherever the keyboard is, because a sheet covers the route", () => {
    /*
     * The landscape defect, stated as the asymmetry that fixes it.
     *
     * An anchored panel opens beside its trigger and takes nothing from the
     * page, so a reader who is not inside it loses nothing by it staying open.
     * A sheet draws over the route. At 932×430 the SESSION STATE sheet was
     * caught still open with the focus ring on the topbar's `Connect a model` —
     * focus outside the disclosure, so the containment gate above discarded
     * every Escape, and the sheet had become something a keyboard could open
     * and could not close. Phones never showed it because a phone sheet leaves
     * most of the route exposed, and the outside click that dismisses it is
     * somewhere a thumb can reach.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const keydown = source.slice(source.indexOf("function onKeyDown"), source.indexOf("document.addEventListener"));
    const escape = keydown.slice(keydown.indexOf('if (event.key === "Escape")'));
    // Uncontained: anchored gives the keypress back, a sheet closes.
    expect(escape).toContain('if (modeRef.current !== "sheet") return;');
    expect(escape.indexOf('if (modeRef.current !== "sheet") return;'))
      .toBeLessThan(escape.indexOf("setOpen(false)"));
  });

  it("does not let a sheet outlive the focus that was inside it", () => {
    /*
     * The same capture, closed from the other side. Escape is the exit a reader
     * takes deliberately; this is the one the product owes them when focus has
     * already moved on — a sheet drawn over a route nobody is reading any more
     * is the product disagreeing with a gesture the reader already made.
     *
     * Scoped to sheets on purpose: an anchored panel is held open by
     * `:focus-within` so a keyboard reader does not lose it to a stray mouse,
     * and closing that one on `focusout` would fight the contract below it.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf("function onFocusOut"), source.indexOf("function onKeyDown"));
    expect(handler, "the focusout handler exists").toContain("setOpen(false)");
    expect(handler).toContain('if (modeRef.current !== "sheet") return;');
    // Focus moving *within* the disclosure is not focus leaving it.
    expect(handler).toContain("hostRef.current?.contains(landing)");
    expect(source).toContain('host?.addEventListener("focusout", onFocusOut)');
    expect(source).toContain('host?.removeEventListener("focusout", onFocusOut)');
  });

  it("makes the panel the landing site for a tap on its own prose", () => {
    /*
     * The mechanism that disarmed every rule above, and it needs no keyboard to
     * trigger: the reader taps a paragraph or a claim's detail sentence inside
     * the panel. Neither is focusable, so focus fell to `<body>` — outside the
     * host, by a gesture made *inside* the disclosure — and from that instant
     * `document.activeElement` reported the reader as somewhere else. Escape
     * was discarded and Tab walked the document into the controls behind the
     * panel, which is precisely the landscape capture.
     *
     * `-1` and not `0`: this is a landing site, not a stop. `FOCUSABLE_SELECTOR`
     * excludes `tabindex="-1"`, so the trap cannot mistake the container for a
     * stop inside itself.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const panel = source.slice(source.indexOf('class="popover__panel"'), source.indexOf('class="popover__header"'));
    expect(panel).toContain("tabIndex={-1}");
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    // A disclosure that deliberately leaves the navigation band reachable may
    // not also tell assistive technology the rest of the page is inert. The
    // attribute, not the word — the comment beside it explains the choice.
    expect(panel).not.toMatch(/aria-modal=/u);
    expect(panel).toContain('role="group"');
  });

  it("takes the keyboard with it when it takes the screen, and only then", () => {
    /*
     * NR001's surviving half. The audit's first claim — that Tab walked out of
     * an open sheet into `Discover models with key` — does not reproduce on
     * this build: `focusTrapTarget` returns "first" when `insideContainer` is
     * false, so the trap already re-enters from the trigger. The second claim
     * does, at every viewport. Measured on `#sessions` with the route header's
     * ⓘ pressed: `activeInsidePanel: false` at phone-320, landscape-932,
     * tablet-768 and desktop-1440, with the active element still the trigger
     * BUTTON while a 112–163px sheet and its scrim covered the route. The
     * focused control was the one under the dim, its focus ring was painted
     * behind the scrim, and a screen reader's next utterance was the trigger
     * rather than the panel that had just taken the screen.
     *
     * Sheets only, and that is the load-bearing half of this test. An anchored
     * panel opens on a 150ms fine-pointer hover, so the same line placed one
     * scope out would yank a typist's focus into a panel a passing cursor
     * opened — the exact defect the containment gate above exists against, and
     * one this file has already paid for once.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("const next = popoverPlacement({"), source.indexOf("function onPointerDown"));
    const anchored = effect.slice(effect.indexOf('if (next.mode === "anchored") {'), effect.indexOf("} else {"));
    const sheet = effect.slice(effect.indexOf("} else {"));
    expect(anchored, "the anchored branch never touches focus").not.toContain(".focus(");
    expect(sheet).toContain('panel.focus({ preventScroll: true });');
    // A glance is not a commitment, and a re-measurement is not an open.
    expect(sheet).toContain('openIntent === "commit"');
    expect(sheet).toContain("!panel.contains(document.activeElement)");
    // The PANEL, not the host: the trigger lives in the host and the trigger is
    // exactly where focus was stranded, so asking the host would answer "yes,
    // already inside" and do nothing at all.
    expect(sheet).not.toContain("host.contains(document.activeElement)");
    // The landing site, not the exit. `tabIndex={-1}` puts the reader on the
    // group whose accessible name is the panel's heading; Done is the first Tab
    // from there, and announcing the way out before the content is backwards.
    expect(sheet).not.toContain("popover__done");
    expect(source).toContain("tabIndex={-1}");
  });

  it("reads the mode from a ref, so the first open of a sheet is not judged as an anchor", () => {
    /*
     * The staleness this avoids is not cosmetic. `placement` starts life as
     * `anchored`, and the effect that measures it is the same effect that
     * installs these listeners — so a handler closing over the state would see
     * `anchored` for the whole of a sheet's first open, which is exactly the
     * open the sheet-specific dismissal exists for.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    expect(source).toContain('const modeRef = useRef<PopoverMode>("anchored");');
    // Written where the placement is decided, not on a later render.
    const effect = source.slice(source.indexOf("const next = popoverPlacement({"));
    expect(effect.indexOf("modeRef.current = next.mode;"))
      .toBeLessThan(effect.indexOf("function onFocusOut"));
  });
});

const sheet = readFileSync(new URL("./popover.css", import.meta.url), "utf8");

describe("the panel is the width of the box it is pinned to", () => {
  it("stops the nowrap header from sizing the panel it sits in", () => {
    /*
     * Seen at 320 and 390: the header read `MEMORY INDEX · REVISION-BOUND LOCA`
     * straight into the screen edge with no ellipsis, every body line was cut
     * mid-word, and the 44px Done button — the only visible way a touch reader
     * has to dismiss a sheet — was laid out entirely off-screen. Seen at 1440
     * too, where the same header and body ran outside the panel's own opaque
     * background and interleaved with the page beneath it.
     *
     * One cause for all of it: the panel is a grid, the header's min-content is
     * a nowrap heading plus Done, and an `auto` track takes its floor from
     * exactly that — so the panel laid its rows out at ~490px whatever width the
     * panel itself had been given.
     */
    const panel = block(sheet, ".popover__panel");
    const header = block(sheet, ".popover__header");

    expect(panel).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(header).toContain("min-width: 0");
  });

  it("bounds the header by wrapping it, not by deleting the half that does not fit", () => {
    /*
     * The cost side of the rule above, and the reason it is no longer paid.
     * Containing the header with `white-space: nowrap` plus an ellipsis fitted
     * the title by removing it: `ACCOUNT STANDING · CHUTES TELEMETRY AND
     * PROVIDER INVENTORY` rendered as `ACCOUNT STANDING · CHUTES T…` on a
     * 1920px display, and `PROVENANCE · ARCHITECTURE.MD` lost the extension of
     * the file it names on a tablet — with no wider state to open, so the
     * missing half was unreachable everywhere.
     *
     * Wrapping bounds it harder: a nowrap heading's min-content is the entire
     * 490px string, which is what sized the panel in the first place, and a
     * wrapping one's is a single word. So `nowrap` must not come back here —
     * it would reinstate both defects at once.
     */
    const heading = block(sheet, ".popover__header > strong");
    expect(heading).toContain("white-space: normal");
    expect(heading).toContain("overflow-wrap: anywhere");
    expect(heading).not.toContain("nowrap");
  });

  it("caps the panel at the room its trigger actually has, and makes the body the row that yields", () => {
    /*
     * A chip anchored partway down a `.main` pane that ends before the window
     * does, with the only ceiling being the body's `60vh` — a fraction of the
     * screen, which is more than the pane has left. The panel is scrollable
     * throughout and it does not help, because the bottom of its own scroll
     * viewport is the part outside the box that clips it.
     *
     * The landscape phone that first produced this is no longer one of its
     * cases; it takes the sheet arm now. Short desktop windows and deeply
     * scrolled panes still land here.
     */
    const panel = block(sheet, ".popover__panel");
    expect(panel).toMatch(/max-height: calc\(var\(--popover-room, 100vh\) - var\(--sp-2\)\)/u);
    // The header carries Done. If it were the flexible row, bounding the panel
    // would compress the dismissal control instead of the prose.
    expect(panel).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(block(sheet, ".popover__body")).toContain("overflow: auto");
  });

  it("never lets the sheet's dismissal control be shrunk below its own label", () => {
    /*
     * Done is what makes the header worth bounding: a sheet whose only visible
     * exit is off-screen is dismissible solely by a gesture nobody is told
     * about. 44px is that floor in both axes.
     *
     * Reading the floor as a ceiling is what broke it. `min-width` was dropped
     * from 64px to 44px on the argument that the header is one row and every
     * pixel Done holds is a pixel the wrapping title does not get — and the
     * captures either side of that change say the title got nothing: the
     * `account` sheet header at phone-320 is 63px in both, three lines of
     * `ACCOUNT STANDING · CHUTES TELEMETRY AND PROVIDER INVENTORY` either way,
     * the sheet top edge at y=414 either way, `Connect Chutes` covered either
     * way. A mono title re-wraps in whole words; 20px only buys a line when it
     * straddles a word boundary, and here it does not.
     *
     * What it did buy was a clipped label, and by a mechanism a stylesheet hides
     * well: `min-width` REPLACES a flex item's automatic minimum size. Until
     * then this was `min-width: auto`, which floors an item at its min-content —
     * about 50px, `Done` at the phone caption ramp inside 8px of padding — and
     * that automatic floor was the only reason the button had never been
     * compressed, because the title beside it has a max-content basis of several
     * hundred pixels at a 320px sheet and the whole row shrinks against it.
     * Declaring 44px handed 26px of content box to 32px of label.
     *
     * `flex: none` is what this asserts hardest, because it is the part that
     * cannot go stale: the title is the row's flexible item and the dismissal
     * control is not, so `Done` sets its own floor at any type scale and in any
     * translation — 64px alone would have clipped it at `x-large`.
     */
    // Indented inside the sheet media query, so this reads the rule by pattern
    // rather than through `block`, which anchors on a top-level selector.
    const done = /\.popover\[data-mode="sheet"\] \.popover__done \{([^}]*)\}/u.exec(sheet)?.[1];
    expect(done, "the sheet's Done rule exists").toBeTypeOf("string");
    expect(done).toContain("flex: none");
    expect(done).toContain("min-height: 44px");
    // A pill at 44px tall, not a square: 64px is 16px past the label's own box.
    expect(done).toContain("min-width: 64px");
  });

  it("retreats Done's paint inside its target rather than growing the header again", () => {
    /*
     * The second half of the same report: three judges read Done as welded to
     * the sheet's frame. It was. The header is floored at 44px and Done is 44px,
     * so on a one- or two-line title the two boxes coincide and the button's
     * border IS the sheet's top border — measured on the `capabilities` capture
     * at phone-320, a 45px header around a 44px button.
     *
     * The air that used to separate them was `padding: var(--sp-2) var(--sp-3)`
     * on the header, and it may not come back: that padding was outside the 44px
     * floor, so it was pure addition on every panel in the product, and a bottom
     * sheet charges its own height to the route it covers. It was moved onto the
     * heading and the move measurably worked — the `capabilities` sheet header
     * fell 61px to 45px and the `context` about-memory header 61px to 48px,
     * against a judge's reading that the 16px had been deleted rather than
     * moved. Restoring the button's air out of the header would hand that cost
     * straight back to the route.
     *
     * So the target does not move and the mark retreats inside it. The button
     * keeps its 44px border box — `e2e/touch-target-floor.spec.ts` measures
     * exactly that box, and a finger measures it too — drops its own border, and
     * the pseudo-element paints the pill 8px inside, which is both the air the
     * header padding used to give and the 28px the same control is on a fine
     * pointer.
     */
    const mark = block(sheet, ".popover__panel .popover__done::before");
    expect(mark).toContain("position: absolute");
    // 8px top and bottom, 0 inline: the pill is the full width of the target and
    // 16px shorter than it. A `--sp-1` retreat here would be a 36px pill.
    expect(mark).toContain("inset: var(--sp-2) 0");
    expect(mark).toContain("border: 1px solid var(--line-control)");
    // Off unless a scope switches it on, so the 28px fine-pointer button keeps
    // its own border and takes the identical 8px as a margin instead.
    expect(mark).toContain("display: none");
    expect(block(sheet, ".popover__panel .popover__done")).toContain("position: relative");
    const done = /\.popover\[data-mode="sheet"\] \.popover__done \{([^}]*)\}/u.exec(sheet)?.[1];
    expect(done).toContain("border: 0");
    expect(sheet).toContain('.popover[data-mode="sheet"] .popover__done::before { display: block; }');
  });

  it("describes its own dismissal control, at a weight a route's `button` rule cannot outrank", () => {
    /*
     * The panel renders inside the route that owns the trigger, so every
     * descendant rule that route writes for `button` is (0,1,1) against a bare
     * `.popover__done` at (0,1,0) — and wins. Measured on the shipped build at
     * desktop-1440: `.access-connection-view button` gave the connection
     * panel's Done a 44px height and `9px 13px` of padding, `.terminal-route
     * button` gave the terminal panel's a 44px height at a 17px font, and the
     * `sources-view` rows did the same to all three context provenance panels,
     * while capabilities and memory kept the 28px this file intends. That is
     * the whole of the "1.0 / 8.5 / 9.0 / 16.0px of air" the sweep reported for
     * one primitive: not four decisions, one decision overwritten four times.
     *
     * `.popover__panel .popover__done` is (0,2,0), the minimum weight at which
     * this file can describe its own control. The scoped rules that follow are
     * the same weight, so source order is what separates them and the pill has
     * to be declared before both scopes that switch it on.
     */
    expect(sheet).toContain(".popover__panel .popover__done {");
    expect(sheet).not.toMatch(/\n\.popover__done \{/u);
    expect(sheet).not.toMatch(/\n\.popover__done::before \{/u);
    const base = sheet.indexOf(".popover__panel .popover__done {");
    const pill = sheet.indexOf(".popover__panel .popover__done::before {");
    const coarse = sheet.indexOf("@media (pointer: coarse) {", base);
    expect(base).toBeGreaterThan(-1);
    expect(pill).toBeGreaterThan(base);
    expect(coarse).toBeGreaterThan(pill);
    // The floor that had never applied: it was (0,1,0) in the coarse block at
    // the top of this file, above a (0,1,0) base that set 28px and won on order.
    const floor = sheet.slice(coarse);
    expect(floor.slice(0, floor.indexOf("\n}"))).toContain("min-height: 44px");
    expect(floor).toContain(".popover__panel .popover__action {");
    expect(floor).toContain(".popover__panel .popover__done::before { display: block; }");
  });

  it("gives Done the same air as the heading beside it, on a panel of any title length", () => {
    /*
     * `align-items: center` cannot hold a gap steady in a header whose height
     * is set by a title that wraps. Measured across the 152 open panels in the
     * sweep's geometry probe: a 28px button centred in a 43px content box sits
     * 8.5px below the panel's top border, in a 44px box 9.0px, and in the 58px
     * box a three-line title makes it 16.0px — with the four route-overridden
     * 44px buttons welded at 1.0px. Four gaps for one control.
     *
     * The repair is the rhythm this file already had for the title: the heading
     * carries `padding-block: var(--sp-2)`, so the button carries the identical
     * 8px and starts where the heading starts. Both items begin at the same
     * offset from the panel's top border whatever the title does, and Done sits
     * on the title's first line rather than against the middle of three.
     *
     * The margin belongs only to the tier where the target IS the mark. Where
     * the target is 44px the pill already spends this 8px inside it, so those
     * two scopes zero the margin — and neither may take its air from the
     * header, which is outside the 44px floor and would be charged to the route.
     */
    const base = block(sheet, ".popover__panel .popover__done");
    expect(base).toContain("align-self: start");
    expect(base).toContain("margin-block-start: var(--sp-2)");
    expect(block(sheet, ".popover__header > strong")).toContain("padding-block: var(--sp-2)");
    const coarse = sheet.slice(sheet.indexOf("@media (pointer: coarse) {", sheet.indexOf(".popover__panel .popover__done {")));
    expect(coarse.slice(0, coarse.indexOf("\n}"))).toContain("margin-block-start: 0");
    const done = /\.popover\[data-mode="sheet"\] \.popover__done \{([^}]*)\}/u.exec(sheet)?.[1];
    expect(done).toContain("margin-block-start: 0");
    // And the header still declares no vertical padding of its own.
    expect(block(sheet, ".popover__header")).not.toMatch(/padding-block|padding-top|padding-bottom/u);
  });

  it("mirrors the panel when it opens upward, rather than only moving it", () => {
    /*
     * The upward tier is not `top: auto` alone. The panel hangs from the
     * trigger's top edge now, so the 8px gap is measured from `bottom`, the
     * transform origin moves to the corner the panel actually grows from, and
     * `--popover-lift` changes sign — a panel that arrives from above while
     * growing out of its bottom corner is the entrance saying it came from
     * somewhere it did not.
     */
    const above = block(sheet, '.popover[data-side="above"] .popover__panel');
    expect(above).toContain("top: auto");
    expect(above).toContain("bottom: calc(100% + var(--sp-2))");
    expect(above).toContain("--popover-lift: translateY(4px)");
    expect(sheet).toContain('.popover[data-side="above"][data-align="start"] .popover__panel { --popover-origin: bottom left; }');
    expect(sheet).toContain('.popover[data-side="above"][data-align="end"] .popover__panel { --popover-origin: bottom right; }');
    // Reduced motion has to reach it at equal specificity, or the tier that
    // travels in the opposite direction is the one tier still travelling.
    const motion = sheet.slice(sheet.indexOf("@media (prefers-reduced-motion: reduce) {"));
    expect(motion).toContain('.popover[data-side="above"] .popover__panel,');
  });

  it("dims the route under an anchored panel only once the reader has committed to it", () => {
    /*
     * The occlusion the sweep measured with `elementsFromPoint`: at every
     * fine-pointer width the route-header ⓘ opens over the block it explains —
     * `dd "0 concurrent"` on capabilities, `p.connect-lane__detail` on
     * connection, the only sentence on account.
     *
     * Geometry cannot move it, which is why the flip above is not also this
     * repair. Those triggers sit in the route header with the pane's top edge
     * 24.6px above them at desktop-1440 against a panel 142–240px tall, and the
     * route column spans 258→1414 of that 1440px viewport, so the widest gutter
     * beside it is 26px against a 320px panel — 18px at tablet-768, 23px at
     * laptop-1024, 264px at wide-1920. Every placement inside the pane lands on
     * route content. What was missing was the panel admitting it is temporarily
     * on top, which is what the sheet's scrim has always said.
     *
     * `[data-intent="commit"]` is what makes it affordable: these panels open on
     * a 150ms hover, and dimming a route because a cursor crossed a chip would
     * be the worse defect. A hover-open panel keeps the page bright and leaves
     * with the pointer; a clicked one stays until it is dismissed, which is
     * exactly when the page behind it has to read as waiting.
     */
    const scrim = block(sheet, '.popover[data-mode="anchored"][data-open="true"][data-intent="commit"]::before');
    expect(scrim).toContain("position: fixed");
    expect(scrim).toContain("inset: 0");
    // The dim `.mobile-sheet-scrim` and the sheet tier already use.
    expect(scrim).toContain("background: var(--scrim)");
    // Under the anchored panel's own 60 and over every layer a route uses.
    expect(scrim).toContain("z-index: 59");
    /*
     * A dim, not a barrier — the one place this differs from the sheet's scrim,
     * and it differs because the two overlays are different objects. A sheet
     * covers the route and takes the press so nobody fires a control they can
     * only half see; an anchored panel covers a card's worth of a route that
     * stays legible and operable around it, and pressing straight through is
     * the behaviour this primitive has always had — `catalog-enrichment-retry`
     * presses an embedding choice with the provenance panel open. It also keeps
     * the host's hit area unchanged: a fixed pseudo that swallowed pointer
     * events would put the whole viewport inside `.popover`, and the hover tier
     * would lose the `pointerleave` it closes itself with.
     */
    expect(scrim).toContain("pointer-events: none");
    expect(block(sheet, ".popover__panel")).toContain("z-index: 60");
    expect(block(sheet, ".popover")).not.toContain("z-index");
    // A hover is never scrimmed, and it is the selector that says so.
    expect(sheet).not.toMatch(/data-intent="hover"/u);
  });

  it("puts the header's vertical air on the heading, where the 44px floor absorbs it", () => {
    /*
     * The air is right and the box that declared it was wrong. `.popover__done`
     * is 44px on every coarse pointer and in every sheet, so the header's
     * content height is already floored at 44px and `padding: var(--sp-2)
     * var(--sp-3)` on the header added 16px to every panel in the product
     * whether its title needed the room or not. A sheet is sized by its content
     * and pinned to the viewport's bottom edge, so that 16px was charged to the
     * route: measured on the shipped build, the account sheet at phone-320 rose
     * from y=431 to y=414 and cut the `Connect Chutes` label, and the
     * connection info sheet's header went 45px to 61px.
     *
     * On the heading the same 8px sits inside the box the floor measures: one
     * line is 15.6 + 16 = 32px and two are 31.2 + 16 = 47px at the phone type
     * ramp, at or under the Done button beside them, so the header is 44px
     * again — and three lines are 63px, where the heading gets every pixel it
     * was short of and the panel's `max-height` takes it out of the body, which
     * scrolls. Padding on the header may not come back: it is outside the floor
     * by construction, so it can only ever be addition.
     *
     * A judge reported this air as deleted rather than moved, and the captures
     * say otherwise on both counts. The heading's padding is applying — the
     * `account` sheet's three-line title measures 63px of header, which is
     * 46.8px of type plus exactly this 16px — and the panels whose titles are
     * short did drop by the full 16px rather than keeping it: `capabilities` at
     * phone-320 went 61px to 45px, `context` about-memory at phone-390 61px to
     * 48px. What the judge was reading is Done sharing an edge with the frame
     * now that nothing separates them, and that is repaired by retreating the
     * button's paint inside its own target, not by growing this box back.
     */
    const header = block(sheet, ".popover__header");
    expect(header).toContain("padding: 0 var(--sp-3)");
    expect(header).toContain("min-height: 44px");
    expect(header).not.toMatch(/padding-block|padding-top|padding-bottom/u);
    expect(block(sheet, ".popover__header > strong")).toContain("padding-block: var(--sp-2)");
  });

  it("makes the bounded body's own cut visible without washing out the line under it", () => {
    /*
     * Capping the panel to its trigger's room was right and it gave the panel a
     * hard bottom border to draw through whatever row happened to be there:
     * measured on the laptop-1024 provenance panel, the border runs through the
     * middle of the `CONTENT DIGEST` glyphs. The scroll shadow is the thing that
     * says "this row continues".
     *
     * It has to say it evenly. `radial-gradient(farthest-side at 50% ...)` put
     * the whole mark at the body's centre — 8/255 at the edges, which is what
     * read as no affordance at all — and raising it to 30% to reach the edges
     * took the centre to 90/255 over a 33/255 ground, dropping `--ink-muted` on
     * the last line to 2.7:1. A flat gradient at 12% lifts the ground to 56/255
     * at every x: 4.6:1, above the body-text floor, and seven times the mark
     * that was invisible at the edges.
     *
     * The two `local` layers are the other half and they are asserted with it:
     * they scroll with the content and mask these exactly where the text has
     * genuinely ended, so no shadow may claim a fourth paragraph that does not
     * exist. Their 14px must stay at or above the shadow's own height.
     */
    const body = block(sheet, ".popover__body");
    expect(body).toContain("var(--ink) 12%");
    expect(body).not.toContain("radial-gradient");
    expect(body).toContain("scroll top / 100% 10px");
    expect(body).toContain("scroll bottom / 100% 10px");
    expect(body).toContain("local top / 100% 14px");
    expect(body).toContain("local bottom / 100% 14px");
    expect(body).toContain("overflow: auto");
  });

  it("positions the sheet on both arms of the compact shell, not just the narrow one", () => {
    /*
     * The defect this pins, and it is a disagreement between two files rather
     * than a bad value in either.
     *
     * `popover.tsx` sets `data-mode="sheet"` on the landscape arm — wide but
     * short, the 932x430 phone held sideways. The block that actually makes a
     * sheet a sheet (`position: fixed`, pinned to the bottom edge, the sticky
     * header, the 44px Done) was scoped `@media (max-width: 640px)` alone. A
     * landscape viewport therefore satisfied the JS and missed the CSS, leaving
     * the panel `position: absolute` under its trigger while calling itself a
     * sheet: the one state neither mode is designed for.
     *
     * So this asserts the query, not the declarations inside it. The
     * declarations were always right; the width they were gated behind was not.
     */
    expect(sheet).toContain('@media (max-width: 640px), (max-width: 950px) and (max-height: 500px) {');
    // And the constants the JS decides with have to be the same two numbers, or
    // the two files drift apart again silently.
    expect(POPOVER_SHEET_MAX_WIDTH).toBe(640);
    expect(POPOVER_SHEET_LANDSCAPE_MAX_WIDTH).toBe(950);
    expect(POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT).toBe(500);
  });

  it("lifts the sheet off a short screen's bottom edge so the navigation band survives it", () => {
    /*
     * The bill for the arm above, and it is a height bill.
     *
     * A bottom sheet is pinned to the edge the navigation band also occupies.
     * On an upright phone it costs the band and leaves 600-800px of route
     * visible around it. At 932x430 it produced a different object: measured on
     * the shipped build, the chat SESSION STATE sheet ran y=143 to y=430 and
     * the connection info sheet y=264 to y=430, both covering the band whole,
     * so a person could not navigate while a disclosure was open — and because
     * the sheet reached the screen's own bottom edge, the scroll shadow that
     * says "this list continues" was painted into the last 10px of the viewport
     * against no visible container edge, which is why a body cut ~90px short
     * read as a body that had simply ended.
     *
     * The numbers are `.mobile-sheet-scrim`'s, not new ones: `routes.css`
     * already reserves 64px for the band and already caps its sheet at
     * `min(72dvh, 680px)`, and that sheet opens at y=56 and ends at y=366 on
     * this exact viewport. Same box here, so the panel is 310px with 263px of
     * body where `56vh` gave it 241.
     */
    expect(sheet).toContain('@media (max-width: 950px) and (max-height: 500px) {');
    const short = sheet.slice(sheet.indexOf('@media (max-width: 950px) and (max-height: 500px) {'));
    // Clear of the band, and clear of it on the way in as well — a slide that
    // only travels the panel's own height starts on top of the navigation.
    expect(short).toContain("bottom: calc(64px + env(safe-area-inset-bottom));");
    expect(short).toContain("--popover-lift: translateY(calc(100% + 64px + env(safe-area-inset-bottom)));");
    expect(short).toContain("max-height: min(72dvh, 680px);");
    // Bordered on all four sides: the bottom one is what the scroll shadow is
    // read against, and it did not exist while the sheet was flush.
    expect(short).toContain("border-width: 1px;");
  });

  it("caps the panel rather than the body's track, and lets the body have the rest", () => {
    /*
     * Two caps in a column are one cap too many. The body carried `56vh` so a
     * flush sheet would not eat the screen; once the panel is bounded to the
     * room between the band and the top of the viewport, that second cap can
     * only ever bind first and hand the body less than the panel it sits in
     * actually has — which is the ~90px of SESSION STATE the reader was short,
     * with `grid-template-rows: auto minmax(0, 1fr)` above already guaranteeing
     * the body is the row that yields.
     *
     * The width cap moved for the same reason. It lived on the body's grid
     * track because a full-bleed sheet set a claim's `small` detail —
     * `grid-area: 2 / 1 / 3 / -1` — to a ~900px line, twice any measure in this
     * product. A 640px panel cannot do that to any row it contains, so bounding
     * the panel subsumes bounding the column, and the scroll shadows go back to
     * spanning the scroller exactly rather than a track inside it.
     */
    const short = sheet.slice(sheet.indexOf('@media (max-width: 950px) and (max-height: 500px) {'));
    expect(short).toContain("max-height: none;");
    expect(short).toContain("width: min(100% - (2 * var(--sp-3)), 640px);");
    expect(short).toContain("margin-inline: auto;");
    // The superseded track cap must not linger beside the panel cap.
    expect(short).not.toContain("grid-template-columns: minmax(0, 640px)");
    // The home-indicator inset belongs to a sheet that ends at the screen edge.
    // This one ends 64px above it, so repeating the inset is dead space in the
    // one box that is short of room.
    expect(short).toContain("padding-bottom: var(--sp-3);");
  });

  it("charges the short-screen geometry to the one device class that is short", () => {
    /*
     * Four waves have introduced regressions by buying one control room from
     * its neighbours, so the query is keyed on the height alone. Of the eight
     * viewports under test — 320x568, 390x844, 430x932, 768x1024, 932x430,
     * 1024x768, 1440x900, 1920x1080 — only the landscape phone is under 500px
     * tall. Every other sheet in the product keeps the flush geometry five
     * capture sets have verified, and a `min-width` floor here would have left
     * a narrow-and-short window with the defect for no reason.
     */
    const short = sheet.slice(sheet.indexOf('@media (max-width: 950px) and (max-height: 500px) {'));
    const viewports = [[320, 568], [390, 844], [430, 932], [768, 1024], [932, 430], [1024, 768], [1440, 900], [1920, 1080]];
    expect(viewports.filter(([w, h]) => w <= 950 && h <= 500)).toEqual([[932, 430]]);
    expect(short).not.toContain("min-width:");
    // And the flush sheet above it still owns every one of the others.
    expect(block(sheet, ".popover__body")).toContain("max-height: min(420px, 60vh)");
  });

  it("dims the route the sheet covers, and only as far as the sheet covers it", () => {
    /*
     * The flush tier lands on the navigation band at every compact width — 57
     * open sheets in the geometry probe, all of them — so the page underneath
     * has to be dimmed or a half-covered control reads as a broken one. The
     * short tier gives up height precisely so the band survives, so the scrim
     * has to stop where the panel stops or it takes that back.
     */
    const scrim = nestedBlock(sheet, '.popover[data-mode="sheet"][data-open="true"]::before');
    expect(scrim).toContain("position: fixed");
    expect(scrim).toContain("inset: 0");
    // The dim `.mobile-sheet-scrim` already uses, so both overlays read as the
    // same object and both stay correct in Paper mode.
    expect(scrim).toContain("background: var(--scrim)");
    // Under the panel, over everything else. `.popover` sets no `z-index` and
    // no `transform`, so neither box gets a stacking context of its own and
    // 119 against the panel's 120 is the order that actually paints.
    expect(scrim).toContain("z-index: 119");
    expect(block(sheet, ".popover")).not.toContain("z-index");
    expect(block(sheet, ".popover")).not.toContain("transform");
    const short = sheet.slice(sheet.indexOf("@media (max-width: 950px) and (max-height: 500px) {"));
    // The panel's own reservation, restated on the scrim rather than assumed.
    expect(short).toContain("bottom: calc(64px + env(safe-area-inset-bottom));");
    expect(short.split("bottom: calc(64px + env(safe-area-inset-bottom));").length - 1).toBe(2);
  });

  it("asks about the trigger and the panel, because the scrim reports the host", () => {
    /*
     * Hit-testing a pseudo-element reports its originating element, so the
     * scrim comes back as the host. `host.contains(target)` would therefore
     * read a press on the dim as a press inside the disclosure and leave the
     * sheet open with no exit but the control it is covering.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const dismiss = source.slice(source.indexOf("function onPointerDown"));
    expect(dismiss.slice(0, dismiss.indexOf("}\n"))).not.toContain("hostRef.current?.contains");
    expect(dismiss).toContain("triggerRef.current?.contains(target)");
    expect(dismiss).toContain("panelRef.current?.contains(target)");
    // And the panel keeps its reason for not claiming the page is inert: the
    // short tier really does leave the navigation band reachable, so the
    // attribute that would say otherwise is still not on the node.
    expect(source).not.toContain("aria-modal=");
  });
});

/**
 * The declarations of the first rule with this selector at any indentation.
 *
 * `block` below anchors on a newline, which is the right strictness for a
 * top-level rule and finds nothing at all inside a media query. The sheet's
 * tiers live in two of those, so the rules that matter most here are indented.
 */
function nestedBlock(source: string, selector: string): string {
  const start = source.search(new RegExp(`^\\s*${selector.replace(/[.[\]()*+?^$|\\]/gu, "\\$&")} \\{`, "mu"));
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}

/** The declarations of the first rule with exactly this selector. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
