export type ScrollBehaviorPreference = "auto" | "smooth";

export function lastRealCardScrollTop(
  currentScrollTop: number,
  containerBottom: number,
  cardBottom: number,
): number {
  return Math.max(0, currentScrollTop + cardBottom - containerBottom);
}

export function lastRealCardEntryScrollTop(
  currentScrollTop: number,
  containerTop: number,
  containerBottom: number,
  cardTop: number,
  cardBottom: number,
): number {
  if (cardBottom - cardTop > containerBottom - containerTop) {
    return Math.max(0, currentScrollTop + cardTop - containerTop);
  }
  return lastRealCardScrollTop(currentScrollTop, containerBottom, cardBottom);
}

/** Anchors to measured card geometry and never virtual scrollHeight. */
export function scrollToLastRealCard(
  container: HTMLElement,
  behavior: ScrollBehaviorPreference = "auto",
  alignment: "end" | "start-if-oversized" = "end",
): boolean {
  const cards = container.querySelectorAll<HTMLElement>("[data-transcript-card]");
  const card = cards.item(cards.length - 1);
  if (!card) return false;
  const containerBox = container.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  container.scrollTo({
    top: alignment === "start-if-oversized"
      ? lastRealCardEntryScrollTop(container.scrollTop, containerBox.top, containerBox.bottom, cardBox.top, cardBox.bottom)
      : lastRealCardScrollTop(container.scrollTop, containerBox.bottom, cardBox.bottom),
    behavior,
  });
  return true;
}

export function isNearLastRealCard(container: HTMLElement, threshold = 64): boolean {
  const cards = container.querySelectorAll<HTMLElement>("[data-transcript-card]");
  const card = cards.item(cards.length - 1);
  if (!card) return true;
  return card.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom <= threshold;
}

export function preferredJumpBehavior(reducedMotion: boolean, streaming: boolean): ScrollBehaviorPreference {
  return reducedMotion || streaming ? "auto" : "smooth";
}

/*
 * Back from Proof to the message Proof is about.
 *
 * Measured (J050): "Inspect evidence →" produced
 * `#proof?session=…&receipt=…&turn=1c52c6d1…`, and every enabled control on
 * that page led further into evidence. The address already carried the turn;
 * nothing spent it. This is the return half, and it lives beside the other
 * transcript anchoring rather than in a module of its own.
 */

/**
 * Brings the card carrying `turnId` into view and marks it, or reports that
 * the transcript does not hold it.
 *
 * "not-rendered" is a real outcome, not an unhandled case: a local command
 * mints no receipt and the card's turn identity comes from the receipt, so
 * those rows cannot be targeted. The caller says so, because a control that
 * says "Return to this turn" and leaves the screen unchanged is the defect.
 */
export function focusTranscriptTurn(
  turnId: string,
  root: ParentNode = document,
): "landed" | "not-rendered" {
  // Scanned rather than selected: a turn id reaches this from a URL, and
  // building an attribute selector out of it would need escaping the entry
  // chunk does not otherwise carry. Comparing `dataset` is smaller and cannot
  // be broken by a quote.
  let card: HTMLElement | undefined;
  for (const candidate of root.querySelectorAll<HTMLElement>("[data-turn-id]")) {
    // Clears the previous landing on the way past it: a second return would
    // otherwise leave two cards marked as "the one you asked for".
    delete candidate.dataset.returnFocus;
    if (candidate.dataset.turnId === turnId) card = candidate;
  }
  if (!card) return "not-rendered";
  card.scrollIntoView({ block: "center", behavior: "auto" });
  card.dataset.returnFocus = "true";
  // Focus, not only scroll: a keyboard reader arriving from another route needs
  // the caret where the eye is. `tabIndex` is set here rather than on every
  // card so an ordinary transcript row never enters the tab order.
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
  return "landed";
}
