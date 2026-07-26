/**
 * Whether the shell may move focus into the message composer without being
 * asked. The composer is the highest-frequency control in the product, but
 * claiming focus is only correct when nothing else already owns it.
 */
export type ComposerFocusContext = Readonly<{
  /** The composer only exists on the chat view. */
  chatView: boolean;
  /** Any modal surface owns focus while open; taking it would break the trap. */
  overlayOpen: boolean;
  /** Phone-class widths: focusing the composer raises the soft keyboard. */
  narrowViewport: boolean;
  /** A control the user reached first keeps focus; only <body> is a free seat. */
  focusAtDocumentRoot: boolean;
}>;

export function shouldClaimComposerFocus(context: ComposerFocusContext): boolean {
  if (!context.chatView) return false;
  if (context.overlayOpen) return false;
  if (context.narrowViewport) return false;
  return context.focusAtDocumentRoot;
}

/** The width below which the composer must not pull up the soft keyboard. */
export const COMPOSER_AUTOFOCUS_MAX_WIDTH_QUERY = "(max-width: 640px)";
