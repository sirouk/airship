import { useEffect } from "preact/hooks";

/**
 * Which edges of a scroll container still hide content. `none` means nothing is
 * hidden, so no affordance may be painted — an always-on fade would assert
 * "there is more below" when there is not.
 */
export type ScrollEdges = "none" | "start" | "end" | "both";

export type ScrollMetrics = Readonly<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}>;

/**
 * Sub-pixel layout and fractional device pixel ratios leave `scrollTop` a
 * fraction short of the true extremes, so a bare `> 0` test paints a fade at a
 * resting scroll position. One CSS pixel is the smallest slack that survives
 * that without hiding a real overflow.
 */
export const SCROLL_EDGE_EPSILON = 1;

export function scrollEdges(metrics: ScrollMetrics): ScrollEdges {
  const overflow = metrics.scrollHeight - metrics.clientHeight;
  if (!Number.isFinite(overflow) || overflow <= SCROLL_EDGE_EPSILON) return "none";
  const top = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0;
  const atStart = top <= SCROLL_EDGE_EPSILON;
  const atEnd = top >= overflow - SCROLL_EDGE_EPSILON;
  if (atStart && atEnd) return "none";
  if (atStart) return "end";
  if (atEnd) return "start";
  return "both";
}

/** The scroll container surface this module reads; kept minimal so it is injectable. */
export type ScrollAffordanceElement = ScrollMetrics & Readonly<{
  children: ArrayLike<Element>;
  addEventListener(type: "scroll", listener: () => void, options?: Readonly<{ passive: boolean }>): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}>;

/** The view that reports viewport resizes and supplies the box observer, if any. */
export type ScrollAffordanceView = Readonly<{
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
  ResizeObserver?: typeof ResizeObserver;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  cancelAnimationFrame?(handle: number): void;
}>;

/**
 * Reports the live overflow state of an element and every distinct transition.
 * The caller owns the element lifetime; this returns the disconnect handle.
 */
export function observeScrollEdges(
  element: ScrollAffordanceElement,
  apply: (edges: ScrollEdges) => void,
  view: ScrollAffordanceView | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  let last: ScrollEdges | undefined;
  const reconcile = () => {
    const next = scrollEdges(element);
    if (next === last) return;
    last = next;
    apply(next);
  };
  element.addEventListener("scroll", reconcile, { passive: true });
  // Content growth (an expanded conversation list) changes overflow without a
  // scroll or resize event, so the box and its groups have to be observed too.
  let resizeFrame: number | undefined;
  const reconcileAfterResize = () => {
    if (!view?.requestAnimationFrame) {
      reconcile();
      return;
    }
    if (resizeFrame !== undefined) return;
    resizeFrame = view.requestAnimationFrame(() => {
      resizeFrame = undefined;
      reconcile();
    });
  };
  const Observer = view?.ResizeObserver;
  const observer = Observer ? new Observer(reconcileAfterResize) : undefined;
  if (observer) {
    observer.observe(element as unknown as Element);
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child) observer.observe(child);
    }
  }
  view?.addEventListener("resize", reconcile);
  reconcile();
  return () => {
    element.removeEventListener("scroll", reconcile);
    view?.removeEventListener("resize", reconcile);
    observer?.disconnect();
    if (resizeFrame !== undefined) view?.cancelAnimationFrame?.(resizeFrame);
  };
}

/**
 * Mirrors the live overflow state onto `data-scroll-edges` so a stylesheet can
 * paint an edge fade only while content is genuinely hidden. Re-binds when
 * `revision` changes so a collapsed group cannot leave a stale fade painted.
 */
export function useScrollEdges(
  target: Readonly<{ current: HTMLElement | null }>,
  revision: unknown,
): void {
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    return observeScrollEdges(element, (edges) => { element.dataset.scrollEdges = edges; });
  }, [target, revision]);
}
