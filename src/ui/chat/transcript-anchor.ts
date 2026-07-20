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
