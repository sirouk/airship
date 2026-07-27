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
/** Minimum distance an anchored panel keeps from the viewport edge. */
export const POPOVER_EDGE_GUTTER = 12;
export const POPOVER_DEFAULT_WIDTH = 320;

export type PopoverMode = "anchored" | "sheet";

export type PopoverPlacement = Readonly<{
  mode: PopoverMode;
  /** `end` is the right-edge flip: the panel hangs off the anchor's right. */
  align: "start" | "end";
}>;

/**
 * Where a panel of `popoverWidth` opened at `anchorLeft` has to render.
 *
 * Kept free of the DOM because the flip boundary is the whole correctness
 * question: a panel that overflows the viewport is a fact the user cannot read,
 * and that has to be assertable without a browser.
 */
export function popoverPlacement(input: Readonly<{
  anchorLeft: number;
  popoverWidth: number;
  viewportWidth: number;
}>): PopoverPlacement {
  if (input.viewportWidth <= POPOVER_SHEET_MAX_WIDTH) return Object.freeze({ mode: "sheet", align: "start" });
  const projectedRight = input.anchorLeft + input.popoverWidth;
  return Object.freeze({
    mode: "anchored",
    align: projectedRight > input.viewportWidth - POPOVER_EDGE_GUTTER ? "end" : "start",
  });
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
      setPlacement(popoverPlacement({
        anchorLeft: host.getBoundingClientRect().left,
        popoverWidth: width,
        viewportWidth: window.innerWidth,
      }));
    }

    function onPointerDown(event: PointerEvent) {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      // Containment applies only once the keyboard is actually inside the
      // disclosure. A fine-pointer hover can open this panel while the user is
      // typing somewhere else entirely, and yanking their next Tab into a panel
      // they never asked for would be worse than the tooltip this replaces.
      if (event.key === "Tab" && hostRef.current?.contains(document.activeElement)) {
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
        hidden={!open}
        style={{ "--popover-width": `${width}px` }}
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
