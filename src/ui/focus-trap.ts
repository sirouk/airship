/**
 * Shared modal focus containment. Every `aria-modal` surface in the shell uses
 * this one implementation so a dialog cannot claim the background is inert
 * while Tab still walks out of it.
 */

/**
 * `summary` and `textarea` are deliberately included: the approval dialog puts
 * a `<details><summary>Arguments shown to the approval policy</summary>` above
 * its footer, and a selector that omits it would wrap Allow straight back to
 * Deny — making the arguments unreachable by keyboard in exactly the dialog
 * where reading them matters.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** A dialog with more focus stops than this is a bug, not a design; stop walking. */
export const FOCUSABLE_LIMIT = 256;

export type FocusTrapTarget = "first" | "last" | "container";

/**
 * Decides where a Tab press must be redirected, or `undefined` to let the
 * browser move focus naturally. Kept free of the DOM so the wrap boundaries are
 * directly testable.
 *
 * `activeIndex` is the position of the focused element inside the container's
 * focusable list, or -1 when focus is on the container itself or outside it.
 */
export function focusTrapTarget(state: Readonly<{
  focusableCount: number;
  activeIndex: number;
  insideContainer: boolean;
  shiftKey: boolean;
}>): FocusTrapTarget | undefined {
  if (state.focusableCount <= 0) return "container";
  // Focus already escaped (a background click, or the dialog opened over a
  // detached node), so the next Tab has to re-enter rather than walk away.
  if (!state.insideContainer) return state.shiftKey ? "last" : "first";
  if (state.shiftKey && state.activeIndex <= 0) return "last";
  if (!state.shiftKey && state.activeIndex === state.focusableCount - 1) return "first";
  return undefined;
}

/**
 * Whether a candidate matched by `FOCUSABLE_SELECTOR` is a real stop. Kept free
 * of the DOM for the same reason as `focusTrapTarget`: these exclusions decide
 * whether Tab can strand focus on something the user cannot see, and each one
 * has to be assertable on its own.
 */
export function focusStopIncluded(candidate: Readonly<{
  hidden: boolean;
  ariaHidden: boolean;
  /** The candidate lies inside a `<details>` that is not open. */
  insideCollapsedDetails: boolean;
  /** The candidate *is* that collapsed disclosure's own `<summary>`. */
  ownSummaryOfCollapsedDetails: boolean;
}>): boolean {
  if (candidate.hidden || candidate.ariaHidden) return false;
  // The summary of a collapsed disclosure is the control that opens it, so it
  // stays reachable; everything the disclosure hides does not.
  return !candidate.insideCollapsedDetails || candidate.ownSummaryOfCollapsedDetails;
}

/**
 * The focusable stops inside `container`, in document order. Descendants of a
 * collapsed `<details>` are excluded because they are not rendered, so wrapping
 * onto one would strand focus on an invisible control.
 */
export function focusableWithin(container: HTMLElement): readonly HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const candidate of container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (found.length >= FOCUSABLE_LIMIT) break;
    const collapsed = candidate.closest("details:not([open])");
    if (!focusStopIncluded({
      hidden: candidate.hasAttribute("hidden"),
      ariaHidden: candidate.getAttribute("aria-hidden") === "true",
      insideCollapsedDetails: collapsed !== null,
      ownSummaryOfCollapsedDetails: candidate.tagName === "SUMMARY" && collapsed === candidate.parentElement,
    })) continue;
    found.push(candidate);
  }
  return found;
}

/** Contains Tab within `container`; a null container leaves the event alone. */
export function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const focusable = focusableWithin(container);
  const active = document.activeElement;
  const target = focusTrapTarget({
    focusableCount: focusable.length,
    activeIndex: active instanceof HTMLElement ? focusable.indexOf(active) : -1,
    insideContainer: active instanceof Node && container.contains(active),
    shiftKey: event.shiftKey,
  });
  if (!target) return;
  event.preventDefault();
  const destination = target === "container" ? container : target === "first" ? focusable[0] : focusable.at(-1);
  destination?.focus({ preventScroll: true });
}
