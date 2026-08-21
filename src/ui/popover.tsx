import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { trapFocus } from "./focus-trap";

/**
 * The single anchored-disclosure primitive.
 *
 * Airship had reached the point where a fact could be readable only on hover,
 * which on a phone means not at all. Every chip in the product expands into one
 * of these instead, so rung L1 of the disclosure ladder has exactly one
 * implementation: same open gesture, same dismissal, same focus containment,
 * same bottom-sheet fallback where there is no pointer to hover with.
 *
 * Hand-rolled on the existing focus trap on purpose — the runtime dependency
 * list is pinned at three packages, and a headless-UI dependency would spend
 * the startup budget on behaviour that is 120 lines.
 */

/** Pointer dwell before a fine-pointer hover counts as intent, not transit. */
export const POPOVER_HOVER_INTENT_MS = 150;
/** At or below this width there is no room to anchor; the panel becomes a sheet. */
export const POPOVER_SHEET_MAX_WIDTH = 640;
/**
 * The landscape arm of the same decision.
 *
 * A width test alone asks "is this a phone held upright", and the answer for a
 * phone held sideways is no: 932×430 is wider than any threshold a phone
 * breakpoint would set and shorter than every one of them. An anchored panel
 * needs *vertical* room, so a viewport that is wide and short is precisely the
 * shape the width test gets wrong — and it once got it wrong on a document route's
 * claim stack, which is that route's primary evidence surface. Measured on the
 * shipped build at 932×430: the trigger's bottom edge sits ~305px down a
 * `.main` pane that ends at 385px above the navigation band, so `popoverRoom`
 * returned its `POPOVER_MIN_ROOM` floor and the panel deliberately overhung —
 * leaving the header and about 10px of the first claim above the fold and the
 * entire list of eight claims underneath the band. The panel was never
 * mis-sized; there was no room to anchor it in, and the primitive had no way to
 * say so.
 *
 * The numbers are not new. `(max-width: 640px), (max-width: 950px) and
 * (max-height: 500px)` is how this product has spelt "compact shell" since
 * `tokens.css:471`, and `approval-dock`, `menu-select`, `model-picker`,
 * `platform-shell` and `shell` all take both arms. This primitive took only the
 * first one. Adopting the pair here is not a new breakpoint, it is the popover
 * finally reading the one already written.
 */
export const POPOVER_SHEET_LANDSCAPE_MAX_WIDTH = 950;
export const POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT = 500;
/** Minimum distance an anchored panel keeps from the viewport edge. */
export const POPOVER_EDGE_GUTTER = 12;
export const POPOVER_DEFAULT_WIDTH = 320;
/**
 * The landscape phone, named by the same bounds the type ramp already uses for
 * it (`tokens.css:471`), so the shape means one thing across this product.
 */
export const POPOVER_LANDSCAPE_MAX_WIDTH = 950;
export const POPOVER_LANDSCAPE_MAX_HEIGHT = 500;
/** What an anchored panel opens to on that shape. See `popoverWidth`. */
export const POPOVER_LANDSCAPE_WIDTH = 380;
/**
 * The shortest an anchored panel is allowed to be told it is.
 *
 * A chip sitting a few pixels above the fold would otherwise be handed a
 * two-line panel: a scroll viewport small enough that reading it is worse than
 * letting it overhang. Below this the measurement stops being useful and the
 * panel keeps its own height instead.
 */
export const POPOVER_MIN_ROOM = 180;

export type PopoverMode = "anchored" | "sheet";

/** Which way an anchored panel opens off its trigger. */
export type PopoverSide = "below" | "above";

/**
 * How an open was asked for.
 *
 * A hover is a glance — the reader's pointer is still travelling and the panel
 * goes away the moment it moves on. A click or an Enter is a commitment: the
 * panel stays until it is dismissed, and it is the one that has to say what it
 * is doing to the route underneath it. `popover.css` scrims only the second.
 */
export type PopoverIntent = "hover" | "commit";

export type PopoverPlacement = Readonly<{
  mode: PopoverMode;
  /** `end` is the right-edge flip: the panel hangs off the anchor's right. */
  align: "start" | "end";
}>;

/**
 * Where a panel of `popoverWidth` opened at `anchorLeft` has to render, and
 * whether it may be anchored at all.
 *
 * Kept free of the DOM because both answers are correctness questions rather
 * than rendering details: a panel that overflows the viewport is a fact the
 * user cannot read, and so is a panel anchored into a viewport with no room
 * below the trigger to open it. Both have to be assertable without a browser.
 */
export function popoverPlacement(input: Readonly<{
  anchorLeft: number;
  popoverWidth: number;
  viewportWidth: number;
  /**
   * Required rather than optional on purpose. A default would have to guess a
   * tall viewport, and every caller that forgot to pass this would silently get
   * the width-only answer back — which is the bug this parameter exists to fix.
   */
  viewportHeight: number;
}>): PopoverPlacement {
  const tooNarrowToAnchor = input.viewportWidth <= POPOVER_SHEET_MAX_WIDTH;
  const tooShortToAnchor = input.viewportWidth <= POPOVER_SHEET_LANDSCAPE_MAX_WIDTH
    && input.viewportHeight <= POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT;
  if (tooNarrowToAnchor || tooShortToAnchor) return Object.freeze({ mode: "sheet", align: "start" });
  const projectedRight = input.anchorLeft + input.popoverWidth;
  return Object.freeze({
    mode: "anchored",
    align: projectedRight > input.viewportWidth - POPOVER_EDGE_GUTTER ? "end" : "start",
  });
}

/**
 * How wide an anchored panel opens.
 *
 * 320px is a portrait-phone measure and it is the wrong one on a landscape
 * phone, which is the shape this product was never designed against. At 932x430
 * the scarce axis is height: the panel hangs partway down a `.main` pane that
 * ends above a fixed navigation band, so every line it spends is a line of the
 * claim the reader does not get. Width is the abundant axis on exactly that
 * shape — 932px of it, of which 320 was being used — and width is what buys
 * lines back, in the header and in the body at the same time.
 *
 * Measured on the shipped build at 932x430, with the About-memory panel whose
 * header still wrapped to three lines: `MEMORY INDEX · REVISION-BOUND LOCAL
 * MATERIALIZATION` sets three mono lines in the 234px heading box a 320px panel
 * leaves and two in the 294px box a 380px panel leaves, so the header falls
 * from 64px to 48px of a 430px-tall viewport; and the body's paragraphs wrap at
 * roughly 51 characters instead of 42, which is a better measure rather than a
 * worse one. Nothing gives up width for it: the panel is `position: absolute`
 * over `.main`, so no sibling reflows, and `max-width: calc(100vw - 2 *
 * var(--sp-3))` still bounds it — 617px at the narrowest viewport that reaches
 * here. Sheets never reach here at all; they take their width from
 * `popover.css`, full-bleed on an upright phone and a bounded card on the short
 * shape where full-bleed would swallow the screen.
 *
 * Kept free of the DOM alongside `popoverPlacement`, and for a harder reason
 * than symmetry: the right-edge flip is computed from the panel's width, so a
 * width the placement math does not know about is a panel that runs off the
 * screen. One function answers both, and the flip now turns 60px earlier on
 * this shape because the panel is 60px wider — which is the flip working.
 */
export function popoverWidth(input: Readonly<{
  /** What the caller asked for; `POPOVER_DEFAULT_WIDTH` for every panel today. */
  requested: number;
  viewportWidth: number;
  viewportHeight: number;
}>): number {
  const landscapePhone = input.viewportWidth > POPOVER_SHEET_MAX_WIDTH
    && input.viewportWidth <= POPOVER_LANDSCAPE_MAX_WIDTH
    && input.viewportHeight <= POPOVER_LANDSCAPE_MAX_HEIGHT;
  // `max`, not a replacement: a caller that has asked for more has a reason,
  // and this is a floor on the room the shape can afford, not a cap.
  return landscapePhone ? Math.max(input.requested, POPOVER_LANDSCAPE_WIDTH) : input.requested;
}

/**
 * How tall an anchored panel may grow before its body has to start scrolling.
 *
 * `60vh` was standing in for this and is not the same number. An anchored panel
 * does not start at the top of the viewport and the viewport is not where it
 * ends: a chip partway down a `.main` pane that itself stops short of the
 * window has far less room beneath it than any `vh` fraction believes, and a
 * body capped at a fraction of the *screen* lays its last paragraph out below
 * the pane that clips it. The panel is scrollable the whole time and it does
 * not matter — the bottom of its own scroll viewport, where the scrollbar and
 * the remaining text live, is the part that is out of reach.
 *
 * The case that first produced this measurement was the landscape phone, and
 * that case no longer arrives here: 932×430 satisfies the landscape arm of
 * `popoverPlacement` above and opens as a sheet, which is sized from the
 * navigation band upwards by `popover.css` and never asks this function
 * anything. What is left for this to answer is every anchored panel that
 * remains — a short desktop window, a chip low in a scrolled pane, the editor
 * route where `.main` is `overflow: hidden` and clips outright. Those are still
 * real, which is why measuring the clipping box rather than the window is still
 * the rule.
 *
 * Kept free of the DOM for the same reason `popoverPlacement` is: whether a
 * panel is allowed to overhang the box that clips it is a correctness question,
 * not a rendering detail.
 */
export function popoverRoom(input: Readonly<{
  /** Viewport-relative bottom edge of the trigger the panel hangs from. */
  anchorBottom: number;
  /** Viewport-relative bottom edge of the nearest box that clips the panel. */
  clipBottom: number;
}>): number {
  return Math.max(POPOVER_MIN_ROOM, input.clipBottom - input.anchorBottom - POPOVER_EDGE_GUTTER);
}

export type PopoverVerticalPlacement = Readonly<{
  side: PopoverSide;
  /** What `--popover-room` is published as, measured on the side that won. */
  room: number;
}>;

/**
 * Which way the panel opens, and how much room that direction actually has.
 *
 * The horizontal axis learnt this long ago: `popoverPlacement` flips a panel to
 * the anchor's right edge rather than letting it run off the screen. The
 * vertical axis never did — every panel opened downward and the only defence
 * was `popoverRoom`, which clamps the panel's HEIGHT to what is left below the
 * trigger and floors that at `POPOVER_MIN_ROOM`. A floor is not a placement.
 * Below the floor the clamp deliberately stops helping, so a chip a reader has
 * scrolled near the foot of a pane opens a panel that simply overhangs.
 *
 * Measured on the shipped build with the `context` route's provenance chips
 * parked 40px above the bottom of `.main` — the position a reader reaches by
 * scrolling to the row they want, which is the only way to reach these chips at
 * all: the panel opened at the floor's 180px of assumed room, laid out 172px
 * tall, and ran 140.0px past the bottom of both the pane and the window at
 * tablet-768, laptop-1024 (140.1), desktop-1440 (139.8) and wide-1920 (139.7).
 * The room ABOVE those same triggers was 870px of empty pane.
 *
 * So the rule is the narrow one that fact supports: flip only when below cannot
 * hold a readable panel and above can. Both bounds are the same
 * `POPOVER_MIN_ROOM` the floor already uses, which keeps one number answering
 * one question — "is there enough room here to be worth opening into" — and
 * makes the flip impossible to trigger while the downward panel is still fine.
 * When neither side clears the floor the panel stays below, because a panel
 * that overhangs the foot of a pane still shows its header and its first lines
 * next to the trigger, while one that overhangs the top of a pane is cut off at
 * exactly the end the reader is meant to start from.
 *
 * Kept free of the DOM alongside the other two, and for the same reason as the
 * width: the direction and the height have to be decided from one measurement
 * or they contradict each other — a panel told to open upward with the room
 * below is a panel that runs off the top instead.
 */
export function popoverVerticalPlacement(input: Readonly<{
  /** Viewport-relative top edge of the trigger the panel hangs from. */
  anchorTop: number;
  anchorBottom: number;
  /** Viewport-relative edges of the nearest box that clips the panel. */
  clipTop: number;
  clipBottom: number;
}>): PopoverVerticalPlacement {
  const below = input.clipBottom - input.anchorBottom - POPOVER_EDGE_GUTTER;
  const above = input.anchorTop - input.clipTop - POPOVER_EDGE_GUTTER;
  if (below < POPOVER_MIN_ROOM && above >= POPOVER_MIN_ROOM) {
    return Object.freeze({ side: "above", room: above });
  }
  return Object.freeze({
    side: "below",
    room: popoverRoom({ anchorBottom: input.anchorBottom, clipBottom: input.clipBottom }),
  });
}

/**
 * The edges of the box that will actually clip this panel.
 *
 * `.main` is `overflow: auto`, so it — not the window — is what an anchored
 * panel is really allowed to occupy, and on the editor route it is
 * `overflow: hidden` and clips outright. Any ancestor whose `overflow-y` has
 * computed to something other than `visible` is such a box; the nearest one
 * wins on each edge, which is what the running minimum and maximum mean here.
 *
 * The top edge is read for the same reason the bottom one is: a panel that
 * flips upward is bounded by the pane it opens into, not by the window above
 * it, and on every route in this product the pane starts below a fixed topbar.
 */
function clippingBox(host: HTMLElement): Readonly<{ top: number; bottom: number }> {
  let bottom = document.documentElement.clientHeight;
  let top = 0;
  for (let node = host.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") {
      const rect = node.getBoundingClientRect();
      bottom = Math.min(bottom, rect.bottom);
      top = Math.max(top, rect.top);
    }
  }
  return { top, bottom };
}

export type PopoverProps = Readonly<{
  /** Accessible name of the disclosure control. */
  label: string;
  /** Sticky panel heading, and the bottom sheet's header title. */
  heading: string;
  /** Resting content of the trigger — normally a `<StatusMark density="chip">`. */
  trigger: ComponentChildren;
  children: ComponentChildren;
  triggerClass?: string;
  class?: string;
  width?: number;
}>;

export function Popover({
  label,
  heading,
  trigger,
  children,
  triggerClass,
  class: className,
  width = POPOVER_DEFAULT_WIDTH,
}: PopoverProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement>(() =>
    Object.freeze({ mode: "anchored", align: "start" } as const));
  /** Which way the anchored panel opens. Sheets are pinned and never flip. */
  const [side, setSide] = useState<PopoverSide>("below");
  /** `null` until the panel has been measured, and for sheets, which size themselves. */
  const [room, setRoom] = useState<number | null>(null);
  /**
   * Whether this open was a glance or a commitment. See `PopoverIntent`: the
   * scrim is the difference, and dimming a route because a pointer crossed a
   * chip would be the worse defect of the two.
   */
  const [openIntent, setOpenIntent] = useState<PopoverIntent>("commit");
  /**
   * The width the panel actually opens at. Held in state beside the placement
   * and set from the same measurement, because the two have to agree: the flip
   * boundary is `anchorLeft + panelWidth`, and a CSS width the flip has not
   * seen is a panel hanging off the right edge of the screen.
   */
  const [panelWidth, setPanelWidth] = useState(width);
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const intent = useRef<number>();
  /**
   * The mode the document-level handlers below read, held in a ref rather than
   * taken from `placement`.
   *
   * Those handlers are installed by the same effect that performs the
   * measurement, so a closure over the `placement` state would see the value
   * from *before* this open resolved — "anchored" on the very first open of a
   * sheet, which is the one case the sheet-specific dismissal exists for.
   * Adding the mode to the effect's dependencies would fix the staleness by
   * re-measuring and re-installing the listeners a second time on every open.
   * A ref written at the moment of measurement is read correctly by a keypress
   * that has not happened yet, and costs neither.
   */
  const modeRef = useRef<PopoverMode>("anchored");
  /**
   * Whether the panel is open, readable by a timer that has not fired yet.
   *
   * The host contains the panel as well as the trigger, so a pointer that
   * leaves the trigger and lands on the open panel enters the host again and
   * arms the 150ms hover intent. Without this the timer would fire on an
   * already-open panel and rewrite a commitment as a glance — taking the scrim
   * out from under a reader who is doing nothing but reading.
   */
  const openRef = useRef(false);

  function cancelIntent() {
    if (intent.current !== undefined) window.clearTimeout(intent.current);
    intent.current = undefined;
  }

  useEffect(() => cancelIntent, []);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (host) {
      const anchor = host.getBoundingClientRect();
      const opened = popoverWidth({
        requested: width,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      const next = popoverPlacement({
        anchorLeft: anchor.left,
        popoverWidth: opened,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPanelWidth(opened);
      setPlacement(next);
      modeRef.current = next.mode;
      // A sheet is pinned by its own insets — to the viewport's bottom edge on
      // an upright phone, to the top of the navigation band on a screen too
      // short to give one away — and sizes itself from there either way. Only
      // the anchored panel hangs off a chip partway down a scrolling pane and
      // has to be told where that pane ends, and which end of it to open into.
      // Measured once at open, like the width and the edge flip beside it: all
      // four are answers about where the trigger was when it was pressed.
      if (next.mode === "anchored") {
        const clip = clippingBox(host);
        const vertical = popoverVerticalPlacement({
          anchorTop: anchor.top,
          anchorBottom: anchor.bottom,
          clipTop: clip.top,
          clipBottom: clip.bottom,
        });
        setSide(vertical.side);
        setRoom(vertical.room);
      } else {
        setSide("below");
        setRoom(null);
        /*
         * A sheet takes the keyboard with it, because a sheet takes the screen.
         *
         * Every other rule in this file assumed the reader's focus would find
         * its own way inside. It does not: measured on the shipped build at
         * phone-320, landscape-932, tablet-768 and desktop-1440, pressing the
         * route header's ⓘ left `document.activeElement` on the TRIGGER at all
         * four — `activeInsidePanel: false` — while a 112–163px sheet and its
         * scrim were drawn over the route. So the focused control was the one
         * underneath the dim, the focus ring was painted behind the scrim, and
         * a screen reader's next utterance was the trigger it had just left
         * rather than the panel that had just covered everything.
         *
         * The trap is not what was missing. `trapFocus` re-enters from outside
         * the panel already (`focusTrapTarget` returns "first" when
         * `insideContainer` is false), so Tab did land on Done — the audit's
         * second claim, that six Tabs walked out to `Discover models with key`,
         * no longer reproduces on this build. What was missing is that the
         * reader should not have to spend a Tab to be where the product has
         * just put the whole screen.
         *
         * SHEETS ONLY, and the reason is a defect this file already paid for
         * once. An anchored panel opens on a 150ms fine-pointer hover — see
         * `POPOVER_HOVER_INTENT_MS` — so a pointer merely crossing a chip while
         * someone types elsewhere would have its focus yanked into a panel it
         * never asked for. That is the exact harm the containment gate in
         * `onKeyDown` was written against, and it is why this lives in the
         * `sheet` branch of the measurement rather than beside it.
         *
         * Guarded twice more inside that branch. `openIntent` must be a
         * commitment: the sheet breakpoints are reachable with a mouse (a 932×430
         * window on a desktop is a sheet), so a hover-opened sheet is possible
         * and must behave like the anchored panel it is standing in for. It is
         * read from the render in which `open` became true — the click handler
         * and the intent timer each set both pieces of state in one batch — so
         * the closure is the gesture, not a later one. And focus that is
         * already inside the PANEL is left exactly where it is, so a
         * re-measurement — this effect also runs when `width` changes — cannot
         * pull a reader off the Done button they had tabbed to. The host is the
         * wrong box to ask about here: the trigger lives in it, and the trigger
         * is precisely where focus is stranded.
         *
         * The panel and not its Done button: `tabIndex={-1}` makes the panel a
         * landing site rather than a stop, so the reader arrives on the group
         * whose `aria-label` is the panel's own heading, and the first Tab from
         * there is Done. Landing on Done would announce the exit before the
         * content. `preventScroll` because the sheet is pinned by its own
         * insets and has nothing to be scrolled into view of; the same call
         * `trapFocus` makes, for the same reason.
         */
        const panel = panelRef.current;
        if (openIntent === "commit" && panel && !panel.contains(document.activeElement)) {
          panel.focus({ preventScroll: true });
        }
      }
    }

    /**
     * Dismissal asks about the two boxes a reader can actually press, rather
     * than about the host.
     *
     * `host.contains(target)` was the same question for as long as the host
     * held nothing but the trigger and the panel. The sheet's scrim is a
     * `::before` on that host, and hit-testing a pseudo-element reports its
     * originating element — so a press on the dim would have come back as
     * "inside the host" and left the sheet open with no way out but the one
     * control the dim is covering.
     *
     * Naming the trigger and the panel is also the stricter test of the two:
     * anything else the host ever grows is outside the disclosure until it
     * says otherwise, which is the safer default for a control whose whole job
     * is knowing when the reader has left.
     */
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const insideTrigger = triggerRef.current?.contains(target) ?? false;
      const insidePanel = panelRef.current?.contains(target) ?? false;
      if (insideTrigger || insidePanel) return;
      // A dismissal outranks an intent that has not fired yet. `pointerleave`
      // normally cancels it first, but a press that arrives inside the 150ms —
      // or from a pointer that never left, on a trigger the press missed —
      // would otherwise reopen the panel the reader just dismissed.
      cancelIntent();
      setOpen(false);
    }
    /**
     * A sheet may not outlive the focus that was inside it.
     *
     * Captured at 932×430: the SESSION STATE sheet still open in the next
     * screenshot with the focus ring on the topbar's `Connect a model` — a
     * control outside the sheet, while the sheet occluded the route. A
     * disclosure that has lost the keyboard has already been dismissed by the
     * only gesture the reader made; leaving it drawn over the page is the
     * product disagreeing with them.
     *
     * Only sheets. An anchored panel sits beside its trigger and takes no room
     * from the route, so closing it the instant focus moves would fight the
     * `:focus-within` contract `onPointerLeave` relies on below.
     */
    function onFocusOut(event: FocusEvent) {
      if (modeRef.current !== "sheet") return;
      const landing = event.relatedTarget;
      if (landing instanceof Node && hostRef.current?.contains(landing)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Containment applies only once the keyboard is actually inside the
      // disclosure. A fine-pointer hover can open this panel while the user is
      // typing somewhere else entirely, and yanking their next Tab into a panel
      // they never asked for would be worse than the tooltip this replaces.
      // The Tab branch already honoured that boundary; the Escape branch did
      // not — it swallowed EVERY Escape at the document while a hover-open
      // panel sat elsewhere on the page, refocusing a trigger the typist had
      // never touched and eating the keypress their own control was waiting
      // for. One containment check still gates both keys.
      const contained = hostRef.current?.contains(document.activeElement) ?? false;
      if (event.key === "Escape") {
        /*
         * The one asymmetry, and the defect it is written against.
         *
         * A sheet draws over the route; an anchored panel draws beside its
         * trigger. So a sheet has to be dismissible from wherever the keyboard
         * happens to be, or a reader whose focus is not inside it has no exit
         * at all — which is how the landscape sheet became something you could
         * open and not close. The containment gate stays for everything the
         * asymmetry does not cover: propagation is only stopped, and the
         * trigger only refocused, when the keypress really did come from
         * inside this disclosure, so the typist's own Escape is still theirs.
         */
        if (!contained) {
          if (modeRef.current !== "sheet") return;
          setOpen(false);
          return;
        }
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!contained) return;
      if (event.key === "Tab") {
        trapFocus(event, panelRef.current);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    host?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      host?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, width]);

  return (
    <div
      class={["popover", className].filter(Boolean).join(" ")}
      ref={hostRef}
      data-open={open ? "true" : "false"}
      data-mode={placement.mode}
      data-align={placement.align}
      data-side={side}
      data-intent={openIntent}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelIntent();
        intent.current = window.setTimeout(() => {
          // Only an open that was still closed is a glance. Re-entering the
          // host of an already-open panel — which, once it is scrimmed, is any
          // movement over the route — must not rewrite what asked for it.
          if (!openRef.current) setOpenIntent("hover");
          setOpen(true);
        }, POPOVER_HOVER_INTENT_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelIntent();
        // `:focus-within` pins the panel open: a keyboard user reading it must
        // not lose it because the mouse happened to move.
        if (!hostRef.current?.contains(document.activeElement)) setOpen(false);
      }}
    >
      <button
        class={["popover__trigger", triggerClass].filter(Boolean).join(" ")}
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={() => {
          cancelIntent();
          // A press — or an Enter, which arrives here as a click — is the
          // commitment. It is the gesture the scrim answers.
          setOpenIntent("commit");
          setOpen((current) => !current);
        }}
      >
        {trigger}
      </button>
      <div
        class="popover__panel"
        ref={panelRef}
        id={panelId}
        role="group"
        aria-label={heading}
        /*
         * The panel is its own focus landing site, and this is what disarmed
         * the keyboard.
         *
         * Every rule above turns on `document.activeElement` being inside the
         * host. A tap or click on the panel's own prose — a paragraph, a claim
         * row's detail sentence, the space between rows — is not on a focusable
         * element, so focus fell to `<body>`: outside the host, by a gesture
         * the reader made *inside* the disclosure. From that moment Escape was
         * ignored and Tab walked the document into the controls behind the
         * panel, which is exactly the state the landscape capture caught.
         *
         * `-1` makes the panel the nearest focusable ancestor of its own
         * content, so that gesture keeps focus where the reader put it. It adds
         * no tab stop: `FOCUSABLE_SELECTOR` excludes `tabindex="-1"`, so the
         * trap does not treat the container as a stop inside itself.
         *
         * Deliberately not `role="dialog"` with `aria-modal`, and the reason
         * survived the scrim rather than being removed by it. `aria-modal`
         * tells assistive technology that everything outside this node is
         * unreachable, and on the short shape that is false by design: the
         * panel and its scrim both stop above the navigation band, which stays
         * readable and pressable while the disclosure is open. A promise that
         * holds at one of two sheet tiers is not a promise.
         */
        tabIndex={-1}
        /*
         * `data-open` rather than `hidden`, because the sheet needs a closed
         * *state* it can transition out of — `hidden` is a box that does not
         * exist, and nothing transitions out of not existing. The panel is
         * still `display: none` at rest; `popover.css` only defers the flip to
         * the end of the exit so the fade has somewhere to run.
         *
         * `inert` covers exactly that deferral. For the ~90ms the closing panel
         * is still displayed it must not be reachable by Tab or readable by a
         * screen reader, or dismissing a disclosure would leave a live control
         * behind it. Outside that window `display: none` already guarantees it.
         */
        data-open={open ? "true" : "false"}
        inert={!open}
        style={{
          "--popover-width": `${panelWidth}px`,
          // Absent rather than a guess when the panel is a sheet or has not
          // been measured yet; `popover.css` falls back to the viewport, which
          // is the only honest answer before the trigger has a rectangle.
          ...(room === null ? null : { "--popover-room": `${room}px` }),
        }}
      >
        <div class="popover__header">
          <strong>{heading}</strong>
          <button
            class="popover__done"
            type="button"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            Done
          </button>
        </div>
        {/*
          * A scroll container that is not a tab stop is content a keyboard
          * cannot reach: `.popover__body` is `overflow-y: auto`, and on the Run
          * details receipt it holds 572px of panel in a 235px box, so Request
          * digest, Response digest and Receipt format existed only for a mouse
          * wheel. The focus trap parked Tab on Done forever, and ArrowDown,
          * PageDown and End all left scrollTop at 0. `tabIndex={0}` makes the
          * region focusable, which is what gives those keys a scroller to act
          * on; `FOCUSABLE_SELECTOR` then includes it in the trap.
          */}
        <div class="popover__body" tabIndex={0}>{children}</div>
      </div>
    </div>
  );
}
