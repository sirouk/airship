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
 * `popoverPlacement` above and opens as a sheet, which sizes itself from the
 * screen's own bottom edge and never asks this function anything. What is left
 * for this to answer is every anchored panel that remains — a short desktop
 * window, a chip low in a scrolled pane, the editor route where `.main` is
 * `overflow: hidden` and clips outright. Those are still real, which is why
 * measuring the clipping box rather than the window is still the rule.
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
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const intent = useRef<number>();

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
      const next = popoverPlacement({
        anchorLeft: anchor.left,
        popoverWidth: width,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPlacement(next);
      // A sheet is pinned to the viewport's own bottom edge by its insets and
      // sizes itself from there; only the anchored panel hangs off a chip
      // partway down a scrolling pane and has to be told where that pane ends.
      // Measured once at open, like the edge flip beside it: both are answers
      // about where the trigger was when it was pressed.
      setRoom(next.mode === "anchored"
        ? popoverRoom({ anchorBottom: anchor.bottom, clipBottom: clippingBottom(host) })
        : null);
    }

    function onPointerDown(event: PointerEvent) {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
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
      // for. One containment check now gates both keys identically.
      if (!hostRef.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        trapFocus(event, panelRef.current);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
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
          "--popover-width": `${width}px`,
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
