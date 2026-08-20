import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  composerAttachmentNeedsText,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_NARROW,
  COMPOSER_VIEWPORT_SHARE,
  composerAttachmentNotice,
  composerGrowthCap,
  composerKeyhints,
  composerPlaceholder,
} from "./composer";
import { COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";

const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");

describe("composer placeholder", () => {
  it("shortens below 480px and never restates the slash menu at either width", () => {
    expect(composerPlaceholder(false)).toBe(COMPOSER_PLACEHOLDER);
    expect(composerPlaceholder(true)).toBe(COMPOSER_PLACEHOLDER_NARROW);
    // The measured defect was a 396px string in a 175px box. Both forms have to
    // fit the narrowest content box the design direction measures (382px on a
    // 430px phone), at the 16px iOS-zoom-guard size where ~0.55em per character
    // is a conservative estimate.
    for (const value of [COMPOSER_PLACEHOLDER, COMPOSER_PLACEHOLDER_NARROW]) {
      expect(value.length * 16 * 0.55).toBeLessThan(382);
    }
  });
});

describe("composer growth cap", () => {
  it("leaves a tall viewport at the declared 180px ceiling", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, 900, 44)).toBe(COMPOSER_MAX_HEIGHT);
  });

  it("keeps the composer under half of a keyboard-shrunk visual viewport", () => {
    const keyboardOpen = 404;
    const cap = composerGrowthCap(COMPOSER_MAX_HEIGHT, keyboardOpen, 44);
    expect(cap).toBe(Math.round(keyboardOpen * COMPOSER_VIEWPORT_SHARE));
    // 44px footer + 2px border on top of the textarea cap, against the 0.46
    // share the amended e2e assertion holds the whole region to.
    expect((cap + 46) / keyboardOpen).toBeLessThan(0.46);
  });

  it("never caps below the resting height, however short the viewport claims to be", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, 60, 44)).toBe(44);
  });

  it("falls back to the declared ceiling when no viewport height is reported", () => {
    expect(composerGrowthCap(COMPOSER_MAX_HEIGHT, Number.NaN, 44)).toBe(COMPOSER_MAX_HEIGHT);
    expect(composerGrowthCap(Number.NaN, 900, 44)).toBe(COMPOSER_MAX_HEIGHT);
  });
});

describe("composer keyhint", () => {
  it("states send at rest and queue while a turn is running", () => {
    expect(composerKeyhints(false).map((hint) => hint.action)).toEqual(["send", "newline"]);
    expect(composerKeyhints(true).map((hint) => hint.action)).toEqual(["queue", "newline"]);
  });

  it("uses the same modifier glyph in both states so only the verb moves", () => {
    expect(composerKeyhints(false)[1]).toEqual(composerKeyhints(true)[1]);
  });
});

describe("composer attachment admission", () => {
  it("names the cap and the files it refused, not just the ones it took", () => {
    const notice = composerAttachmentNotice({ added: 2, rejected: 0, overflow: 2, capability: "supported" });
    expect(notice).toContain(String(COMPOSER_ATTACHMENT_LIMIT));
    expect(notice).toContain("2 images were not added");
    expect(notice).toContain("2 images are ready");
  });

  it("keeps transport copy generic when an image is admitted", () => {
    expect(composerAttachmentNotice({ added: 1, rejected: 0, overflow: 0, capability: "supported" }))
      .toBe("1 image is ready for inline vision inference.");
  });

  it("never phrases a fully refused add as a success", () => {
    const notice = composerAttachmentNotice({ added: 0, rejected: 0, overflow: 1, capability: "supported" });
    expect(notice).not.toContain("0 image");
    expect(notice).not.toContain("ready");
    expect(notice).toContain(`at most ${COMPOSER_ATTACHMENT_LIMIT} attachments`);
  });

  it("states both refusals when a drop mixes non-images with overflow", () => {
    const notice = composerAttachmentNotice({ added: 0, rejected: 1, overflow: 3, capability: "supported" });
    expect(notice).toContain("1 non-image attachment was not added");
    expect(notice).toContain("3 images were not added");
  });

  it("keeps the capability sentence for an admitted image on a model without vision", () => {
    expect(composerAttachmentNotice({ added: 1, rejected: 0, overflow: 0, capability: "model-lacks-vision" }))
      .toContain("explicitly includes image input");
    expect(composerAttachmentNotice({ added: 1, rejected: 0, overflow: 0, capability: "disconnected" }))
      .toContain("Connect a vision-capable inference model");
  });

  it("says nothing when nothing was offered", () => {
    expect(composerAttachmentNotice({ added: 0, rejected: 0, overflow: 0, capability: "supported" })).toBeUndefined();
  });
});

describe("an attachment with no prompt refuses out loud", () => {
  it("keeps the reason generic and transport-factual", () => {
    expect(composerAttachmentNeedsText())
      .toBe("Add a message to send with this attachment. The image travels inside the request beside your prompt, so a turn needs both.");
    expect(composerAttachmentNeedsText()).toContain("the request");
    expect(app).toContain("setComposerNotice(composerAttachmentNeedsText())");
    expect(app).toContain("? composerAttachmentNeedsText()");
    expect(app).toContain("const attachmentsAwaitText = attachments.length > 0 && !input.trim();");
  });
});
