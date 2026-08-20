import { useEffect, useState } from "preact/hooks";
import { MOBILE_SHELL_MEDIA_QUERY } from "./chat/composer-focus";

/**
 * Whether the shell is currently drawing its phone layout.
 *
 * Some document routes, including Memory, need a *default* that differs by width
 * rather than a style that does: which disclosures start open, and how much of
 * a ledger is above the fold. Neither is expressible in CSS, because `open` on
 * a `<details>` is DOM state and a stylesheet cannot set it.
 *
 * The query is `MOBILE_SHELL_MEDIA_QUERY` rather than a literal of this file's
 * own, because "is this the phone" already has one answer in this product and a
 * second one would drift: the shell's own breakpoint is what decides whether
 * `.sidebar` is `display: none` and the tab band renders, and a route whose
 * defaults disagreed with that would open a graph disclosure on the layout that
 * has no room for it. It deliberately includes the short-landscape clause, so
 * rotating a phone to 850×430 keeps the phone defaults.
 *
 * Subscribed rather than sampled: device emulation, a rotation and a resized
 * window all change the answer while the page is open, and a value read once at
 * mount is a value that is wrong for the rest of the visit.
 *
 * Seeded from `matchMedia` in the initializer rather than from `false`, because
 * the callers use it to choose a `useState` default: a value that only becomes
 * true in an effect is a value that is false on the render where the default is
 * decided, so every phone would have opened the desktop arrangement and then
 * been stuck with it.
 */
export function useShellIsPhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY).matches),
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(MOBILE_SHELL_MEDIA_QUERY);
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return phone;
}
