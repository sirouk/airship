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
 * shape the width test gets wrong — and it got it wrong on the Proof route's
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

/**
 * The bottom edge of the box that will actually clip this panel.
 *
 * `.main` is `overflow: auto`, so it — not the window — is what an anchored
 * panel is really allowed to occupy, and on the editor route it is
 * `overflow: hidden` and clips outright. Any ancestor whose `overflow-y` has
 * computed to something other than `visible` is such a box; the nearest one
 * wins, which is what taking the running minimum means here.
 */
function clippingBottom(host: HTMLElement): number {
  let bottom = document.documentElement.clientHeight;
  for (let node = host.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== "visible") {
      bottom = Math.min(bottom, node.getBoundingClientRect().bottom);
    }
  }
  return bottom;
}

export type PopoverProps = Readonly<{
  /** Accessible name of the disclosure control. */
  label: string;
  /** Sticky panel heading, and the bottom sheet's header title. */
  heading: string;
  /** Resting content of the trigger — normally a `<Seal density="chip">`. */
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
  /** `null` until the panel has been measured, and for sheets, which size themselves. */
  const [room, setRoom] = useState<number | null>(null);
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

  function cancelIntent() {
    if (intent.current !== undefined) window.clearTimeout(intent.current);
    intent.current = undefined;
  }

  useEffect(() => cancelIntent, []);

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
      // has to be told where that pane ends.
      // Measured once at open, like the width and the edge flip beside it: all
      // three are answers about where the trigger was when it was pressed.
      setRoom(next.mode === "anchored"
        ? popoverRoom({ anchorBottom: anchor.bottom, clipBottom: clippingBottom(host) })
        : null);
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
      if (!insideTrigger && !insidePanel) setOpen(false);
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
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelIntent();
        intent.current = window.setTimeout(() => setOpen(true), POPOVER_HOVER_INTENT_MS);
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
        <div class="popover__body">{children}</div>
      </div>
    </div>
  );
}
