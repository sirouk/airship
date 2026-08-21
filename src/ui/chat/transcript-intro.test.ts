import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TRANSCRIPT_INTRO_CAPABILITY_LINE,
  TRANSCRIPT_INTRO_DEMO_LINE,
  TRANSCRIPT_INTRO_WHAT_LINE,
  TRANSCRIPT_SEED_BODY,
  transcriptIntroNote,
} from "./transcript-intro";

const transcriptIntroSource = readFileSync(new URL("./transcript-intro.tsx", import.meta.url), "utf8");

describe("transcriptIntroNote", () => {
  it("keeps the per-conversation sentence a seed was prefixed with", () => {
    expect(transcriptIntroNote(
      `Resumed Research from the encrypted Vault. ${TRANSCRIPT_SEED_BODY}`,
      TRANSCRIPT_SEED_BODY,
    )).toBe("Resumed Research from the encrypted Vault.");
    expect(transcriptIntroNote(
      `General profile loaded in a new pinned session. ${TRANSCRIPT_SEED_BODY}`,
      TRANSCRIPT_SEED_BODY,
    )).toBe("General profile loaded in a new pinned session.");
  });

  it("returns nothing for a bare seed, so the intro does not render an empty line", () => {
    expect(transcriptIntroNote(TRANSCRIPT_SEED_BODY, TRANSCRIPT_SEED_BODY)).toBeUndefined();
    expect(transcriptIntroNote(`  ${TRANSCRIPT_SEED_BODY}  `, TRANSCRIPT_SEED_BODY)).toBeUndefined();
  });

  /*
   * A seed may also *replace* the body rather than prefix it — the approval
   * switch writes its whole sentence and nothing else. That claim has no other
   * carrier on screen, so it must survive verbatim.
   */
  it("keeps a seed that replaced the body outright", () => {
    const replaced = "Approval policy changed to Auto Approve in this new pinned conversation.";

    expect(transcriptIntroNote(replaced, TRANSCRIPT_SEED_BODY)).toBe(replaced);
  });

  it("returns nothing when there is nothing to say", () => {
    expect(transcriptIntroNote(undefined, TRANSCRIPT_SEED_BODY)).toBeUndefined();
    expect(transcriptIntroNote("", TRANSCRIPT_SEED_BODY)).toBeUndefined();
    expect(transcriptIntroNote("   ", TRANSCRIPT_SEED_BODY)).toBeUndefined();
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

describe("what the first screen says this is", () => {
  /*
   * Measured on a cold load of the built tree at 3114a9b, desktop and phone:
   * `document.body.innerText` matched neither /browser/i nor /no server/i. The
   * one paragraph that does explain the product is the seed body above, and it
   * is stripped from the transcript by `transcriptIntroNote` — so a person who
   * opened the link and read was told what would not be saved, and that the
   * composer is a demo, and never told what they had opened.
   */
  it("answers what this is in the words a newcomer already has", () => {
    expect(TRANSCRIPT_INTRO_WHAT_LINE).toContain("runs in your browser");
    expect(TRANSCRIPT_INTRO_WHAT_LINE).toContain("no Airship server");
    expect(TRANSCRIPT_INTRO_WHAT_LINE).toContain("no account");
    // It says what is true of the artifact, and claims nothing beyond it: the
    // Terminal fetches its runtime from a third party and a cloud provider is
    // a remote service, so no sentence here may promise that nothing leaves
    // the page.
    expect(TRANSCRIPT_INTRO_WHAT_LINE).not.toMatch(/nothing (?:ever )?leaves|never leaves|no network/iu);
  });

  /*
   * And it has to be on screen before anything is typed, at the density every
   * newcomer gets. `DEFAULT_PRESENTATION_DENSITY` is "minimal", which retires
   * the capability line, the runtime line and the tier chip — so a line placed
   * inside the `full` branch would be exactly as absent as the paragraph it
   * replaces. It hangs off the same two states the component already renders
   * unconditionally: nothing kept yet, or no provider yet.
   */
  it("renders outside the density gate, on the two states a newcomer is in", () => {
    expect(transcriptIntroSource)
      .toContain('{unsaved || demo ? <p class="transcript-intro__lead">{TRANSCRIPT_INTRO_WHAT_LINE}</p> : null}');
    const copy = transcriptIntroSource.slice(
      transcriptIntroSource.indexOf('<div class="transcript-intro__copy">'),
      transcriptIntroSource.indexOf("{full ? ("),
    );
    expect(copy).toContain("TRANSCRIPT_INTRO_WHAT_LINE");
  });
});


describe("TranscriptMarker", () => {
  it("keeps durable marker facts on screen with no extra action", () => {
    expect(transcriptIntroSource).toContain('aria-label={`Session record. ${marker.detail}`}');
    expect(transcriptIntroSource).toContain('class="transcript-marker__detail"');
    expect(transcriptIntroSource).toContain('Read the ${String(marker.carriedContext.length)} carried');
    expect(transcriptIntroSource).toContain('message.role === "user" ? "You" : message.role === "assistant" ? "Airship" : message.role');
    expect(transcriptIntroSource).toContain('Event ${String(marker.sequence)} · ${marker.kind} · ${marker.digest.slice(0, 15)}…');
    expect(transcriptIntroSource).toContain('data-presentable={marker.presentable ? "true" : "false"}');
    for (const retired of ["ConversationReceipt", ["onOpen", "P", "roof"].join(""), ["Open p", "roof"].join(""), ["transcript-marker__p", "roof"].join("")]) {
      expect(transcriptIntroSource).not.toContain(retired);
    }
  });
});
