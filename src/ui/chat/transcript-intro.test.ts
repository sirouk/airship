import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_INTRO_CAPABILITY_LINE,
  TRANSCRIPT_INTRO_DEMO_LINE,
  TRANSCRIPT_SEED_BODY,
  transcriptIntroNote,
} from "./transcript-intro";

describe("transcriptIntroNote", () => {
  it("keeps the per-conversation sentence a seed was prefixed with", () => {
    expect(transcriptIntroNote(`Resumed Research from the encrypted Vault. ${TRANSCRIPT_SEED_BODY}`))
      .toBe("Resumed Research from the encrypted Vault.");
    expect(transcriptIntroNote(`General profile loaded in a new pinned session. ${TRANSCRIPT_SEED_BODY}`))
      .toBe("General profile loaded in a new pinned session.");
  });

  it("returns nothing for a bare seed, so the intro does not render an empty line", () => {
    expect(transcriptIntroNote(TRANSCRIPT_SEED_BODY)).toBeUndefined();
  });

  /*
   * A seed may also *replace* the body rather than prefix it — the approval
   * switch writes its whole sentence and nothing else. That claim has no other
   * carrier on screen, so it must survive verbatim.
   */
  it("keeps a seed that replaced the body outright", () => {
    const replaced = "Approval policy changed to Auto Approve in this new pinned conversation.";

    expect(transcriptIntroNote(replaced)).toBe(replaced);
  });

  it("returns nothing when there is nothing to say", () => {
    expect(transcriptIntroNote(undefined)).toBeUndefined();
    expect(transcriptIntroNote("")).toBeUndefined();
    expect(transcriptIntroNote("   ")).toBeUndefined();
  });
});

describe("the guidance band's copy", () => {
  /*
   * §3.1 of the design direction records these two sentences as REMOVED as a
   * band and surviving verbatim here. A paraphrase is a lost claim, so the
   * words are pinned rather than the fact that some words exist.
   */
  it("survives verbatim, so deleting the band did not delete what it said", () => {
    expect(TRANSCRIPT_INTRO_CAPABILITY_LINE).toBe("Workspace, editor, terminal and Git work right now.");
    expect(TRANSCRIPT_INTRO_DEMO_LINE)
      .toBe("Chat needs a model provider; this composer is a deterministic demo.");
  });

  it("keeps the seed body's own claims, so the welcome card's text is accounted for", () => {
    expect(TRANSCRIPT_SEED_BODY).toContain("workspace, editor, terminal and browser-owned Git");
    expect(TRANSCRIPT_SEED_BODY).toContain("no account");
    expect(TRANSCRIPT_SEED_BODY).toContain("deterministic local demo");
  });
});
