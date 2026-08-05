import { useEffect, useState } from "preact/hooks";

/**
 * How much of the bottom edge is already spoken for.
 *
 * Two persistent notices live in the bottom-right corner and outlive the route
 * they were raised on: the capability dock's "waiting for a decision" bar and
 * the runtime-update banner. Both sit above the composer, and the composer
 * grows as it is typed into — so a constant offset covers the send button, and
 * a banner that covers the send button is a banner that eats the click.
 *
 * The dock worked this out and measured it. The update banner did not, and was
 * caught doing exactly what the dock's comment predicted: J152, "the update
 * banner intercepts pointer events over the composer", evidenced by Playwright
 * refusing a Send click for 58 retries because a `role="status"` div was on top
 * of it. Both now read the same measurement, so the next thing anchored to that
 * corner inherits the fix instead of rediscovering the bug.
 */
export const BOTTOM_BAR_BLOCKERS: readonly string[] = Object.freeze([".composer", ".mobile-nav"]);

export function blockerHeight(selector: string): number {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect && rect.height > 0 ? Math.max(0, window.innerHeight - rect.top) : 0;
}

/**
 * Live height of the bottom furniture, in pixels, while `active`.
 *
 * Observed rather than sampled: the composer changes height as it is typed
 * into, and a value read once at mount is wrong by the second line.
 */
export function useBottomFloor(active: boolean): number {
  const [floor, setFloor] = useState(0);
  useEffect(() => {
    if (!active) return;
    const measure = () => setFloor(Math.max(0, ...BOTTOM_BAR_BLOCKERS.map(blockerHeight)));
    let resizeFrame: number | undefined;
    const scheduleMeasure = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        measure();
      });
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    for (const selector of BOTTOM_BAR_BLOCKERS) {
      const element = document.querySelector(selector);
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    };
  }, [active]);
  return active ? floor : 0;
}
