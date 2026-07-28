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

/**
 * The responsive shell treats short phone-landscape viewports as mobile even
 * when their CSS width is tablet-like. Autofocus must follow that same contract
 * or rotating a phone can raise the keyboard before the user asks for it.
 */
export const MOBILE_SHELL_MEDIA_QUERY =
  "(max-width: 640px), (max-width: 950px) and (max-height: 500px)";
