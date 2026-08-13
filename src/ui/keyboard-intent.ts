/**
 * Whether the person is currently driving with a keyboard.
 *
 * `:focus-visible` answers this for controls the browser itself focuses, and
 * answers it wrongly for the one case this shell depends on: focus moved
 * *programmatically* to `<main>`. Enter on a rail row and "Skip to
 * conversation" both do that, and a sighted keyboard user needs to see where
 * their cursor landed — but the heuristic for programmatic focus differs
 * between engines, and on at least one of them a plain mouse click on a
 * conversation painted a 2px ring around the entire content pane. The owner
 * reported that box twice.
 *
 * So the shell tracks the modality itself rather than inferring it. One
 * attribute on the root element, set by a key that navigates and cleared by
 * any pointer press, and the ring is scoped to it in `shell.css`. Nothing
 * about ordinary `:focus-visible` changes: every real control keeps the ring
 * the browser gives it.
 */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
]);

export const KEYBOARD_INTENT_ATTRIBUTE = "data-keyboard-intent";

/**
 * Begin tracking. Returns a teardown so a test or a re-mount can stop it; the
 * shell calls this once and never tears it down.
 */
export function observeKeyboardIntent(root: Document = document): () => void {
  const element = root.documentElement;
  const engage = (event: KeyboardEvent) => {
    // Modifier-only presses are not navigation; a person holding Shift to
    // select text with a mouse has not switched modality.
    if (!NAVIGATION_KEYS.has(event.key)) return;
    element.setAttribute(KEYBOARD_INTENT_ATTRIBUTE, "true");
  };
  const release = () => {
    element.removeAttribute(KEYBOARD_INTENT_ATTRIBUTE);
  };
  // Capture, so a handler that stops propagation cannot strand the shell in
  // the wrong modality.
  root.addEventListener("keydown", engage, { capture: true });
  root.addEventListener("pointerdown", release, { capture: true });
  return () => {
    root.removeEventListener("keydown", engage, { capture: true });
    root.removeEventListener("pointerdown", release, { capture: true });
  };
}
