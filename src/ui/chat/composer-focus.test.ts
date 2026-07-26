import { describe, expect, it } from "vitest";
import {
  COMPOSER_AUTOFOCUS_MAX_WIDTH_QUERY,
  shouldClaimComposerFocus,
  type ComposerFocusContext,
} from "./composer-focus";

const idle: ComposerFocusContext = Object.freeze({
  chatView: true,
  overlayOpen: false,
  narrowViewport: false,
  focusAtDocumentRoot: true,
});

describe("shouldClaimComposerFocus", () => {
  it("claims focus on a freshly loaded desktop chat view", () => {
    expect(shouldClaimComposerFocus(idle)).toBe(true);
  });

  it("never claims focus on a route that has no composer", () => {
    expect(shouldClaimComposerFocus({ ...idle, chatView: false })).toBe(false);
  });

  it("never steals focus from an open modal surface", () => {
    expect(shouldClaimComposerFocus({ ...idle, overlayOpen: true })).toBe(false);
  });

  it("never raises the soft keyboard on a phone-class viewport", () => {
    expect(shouldClaimComposerFocus({ ...idle, narrowViewport: true })).toBe(false);
  });

  it("leaves focus alone once the user has reached any control", () => {
    expect(shouldClaimComposerFocus({ ...idle, focusAtDocumentRoot: false })).toBe(false);
  });

  it("uses the same phone breakpoint the mobile shell is built on", () => {
    expect(COMPOSER_AUTOFOCUS_MAX_WIDTH_QUERY).toBe("(max-width: 640px)");
  });
});
