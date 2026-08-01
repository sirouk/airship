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
  composerPosture,
  type ComposerPostureKind,
} from "./composer";
import { COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";
import { OFFLINE_INLINE_REASON } from "../connectivity";

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

describe("composer credential posture", () => {
  const base = { online: true, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: false } as const;

  it("names the demo, the local endpoint and the in-memory key distinctly", () => {
    expect(composerPosture(base).label).toBe("Local demo");
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "local-none" }).label)
      .toBe("Local endpoint");
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "oauth-pkce" }).label)
      .toBe("Key in memory");
  });

  it("carries the offline reason verbatim and outranks every connected posture", () => {
    const offline = composerPosture({ ...base, online: false, inferenceConnected: true, authMethod: "api-key" });
    expect(offline.label).toBe("Offline");
    expect(offline.detail).toBe(OFFLINE_INLINE_REASON);
    expect(offline.state).toBe("attention");
  });

  it("states page memory in plain words wherever a credential is held", () => {
    expect(composerPosture({ ...base, inferenceConnected: true, authMethod: "api-key" }).detail)
      .toContain("page memory");
    /*
     * And nowhere a credential is not.
     *
     * The local-demo arm held no credential and still ended "…and this
     * conversation's journal is page memory only" — a durability claim this
     * function has no input for. The Atlas measured it contradicting the chip
     * 40px away: with the Local Device Vault adopted, the session chip read
     * "Session. Encrypted · this device." while this one still said page
     * memory. Durability comes from `describeSessionDurability`; this states
     * what holds the credential.
     */
    expect(composerPosture(base).detail).not.toContain("page memory");
    expect(composerPosture(base).detail).not.toContain("journal");
  });

  it("keeps every resting label short enough that the chip cannot truncate it", () => {
    for (const authMethod of [undefined, "local-none", "api-key"]) {
      expect(composerPosture({ ...base, inferenceConnected: true, authMethod }).label.length)
        .toBeLessThanOrEqual(16);
    }
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

/*
 * The two footer facts, and the mount point they spent a wave without.
 *
 * `ComposerPostureChip` and `ComposerKeyhintLegend` landed as a module plus
 * CSS plus the tests above, and the call site in `app.tsx` was never switched
 * over — so the credential posture kept rendering as the caption that is
 * `display: none` on a phone, and the Enter contract rendered nowhere at all,
 * while a green suite reported both as done. A pure function nothing mounts is
 * not a shipped fact, so the mount is asserted here beside the behaviour.
 */
const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
const composerSource = await readFile(new URL("./composer.tsx", import.meta.url), "utf8");
const routeStyles = await readFile(new URL("../routes.css", import.meta.url), "utf8");

describe("the composer footer's stated facts are mounted", () => {
  it("renders the credential posture as the chip rather than the phone-hidden caption", () => {
    expect(app).toContain("<ComposerPostureChip");
    expect(app).toContain("authMethod: activeInferenceBinding?.authMethod,");
    // The caption this replaces, in the exact words it shipped with.
    expect(app).not.toContain('"local demo · page memory"');
  });

  it("renders the Enter contract in the footer", () => {
    expect(app).toContain("<ComposerKeyhintLegend busy={busy} />");
  });

  it("builds the chip's accessible name from both halves of every posture claim", () => {
    expect(composerSource).toContain("label={`Credential posture. ${claim.label}. ${claim.detail}`}");
    const kinds: readonly ComposerPostureKind[] = ["local-demo", "local-endpoint", "key-in-memory", "offline"];
    const claims = [
      composerPosture({ online: true, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: false }),
      composerPosture({ online: true, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: true, authMethod: "local-none" }),
      composerPosture({ online: true, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: true, authMethod: "api-key" }),
      composerPosture({ online: false, offlineReason: OFFLINE_INLINE_REASON, inferenceConnected: true, authMethod: "api-key" }),
    ];
    expect(claims.map((claim) => claim.kind)).toEqual(kinds);
    // Four kinds, four sentences: an empty detail would give the chip an
    // accessible name that stops at its own one-word label.
    for (const claim of claims) expect(claim.detail.length).toBeGreaterThan(0);
  });

  it("keeps the chip a 44px touch target at the phone breakpoint", () => {
    const phone = routeStyles.match(/\.composer-posture \{[^}]*min-height: var\(--touch-target\);[^}]*\}/u);
    expect(phone, "routes.css must give .composer-posture a 44px phone minimum").not.toBeNull();
  });
});

describe("composer attachment admission", () => {
  it("names the cap and the files it refused, not just the ones it took", () => {
    const notice = composerAttachmentNotice({ added: 2, rejected: 0, overflow: 2, capability: "supported", encryptedRequest: false });
    expect(notice).toContain(String(COMPOSER_ATTACHMENT_LIMIT));
    expect(notice).toContain("2 images were not added");
    expect(notice).toContain("2 images are ready");
  });

  it("never phrases a fully refused add as a success", () => {
    const notice = composerAttachmentNotice({ added: 0, rejected: 0, overflow: 1, capability: "supported", encryptedRequest: false });
    expect(notice).not.toContain("0 image");
    expect(notice).not.toContain("ready");
    expect(notice).toContain(`at most ${COMPOSER_ATTACHMENT_LIMIT} attachments`);
  });

  it("states both refusals when a drop mixes non-images with overflow", () => {
    const notice = composerAttachmentNotice({ added: 0, rejected: 1, overflow: 3, capability: "supported", encryptedRequest: false });
    expect(notice).toContain("1 non-image attachment was not added");
    expect(notice).toContain("3 images were not added");
  });

  it("keeps the capability sentence for an admitted image on a model without vision", () => {
    expect(composerAttachmentNotice({ added: 1, rejected: 0, overflow: 0, capability: "model-lacks-vision", encryptedRequest: false }))
      .toContain("explicitly includes image input");
    expect(composerAttachmentNotice({ added: 1, rejected: 0, overflow: 0, capability: "disconnected", encryptedRequest: false }))
      .toContain("Connect a vision-capable inference model");
  });

  it("says nothing when nothing was offered", () => {
    expect(composerAttachmentNotice({ added: 0, rejected: 0, overflow: 0, capability: "supported", encryptedRequest: false })).toBeUndefined();
  });
});

describe("an attachment with no prompt refuses out loud", () => {
  it("names the reason on the disabled control and in the imperative guard", () => {
    // The sentence became a function of the transport: it only claims the image
    // travels "inside the encrypted request" when the request actually is one.
    expect(composerAttachmentNeedsText(false)).toContain("travels inside the request");
    expect(composerAttachmentNeedsText(true)).toContain("inside the encrypted request");
    expect(composerAttachmentNeedsText(false)).not.toContain("encrypted");
    // Both admission paths speak the same sentence: the silent `return` that
    // shipped made an attachment-only Enter indistinguishable from a dead key.
    expect(app).toContain("setComposerNotice(composerAttachmentNeedsText(composerRequestEncrypted))");
    expect(app).toContain("? composerAttachmentNeedsText(composerRequestEncrypted)");
    expect(app).toContain("const attachmentsAwaitText = attachments.length > 0 && !input.trim();");
  });
});
