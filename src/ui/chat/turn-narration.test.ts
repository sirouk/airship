import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  arrivalAnnouncement,
  failureAnnouncement,
  localCommandAnnouncement,
  spokenCommandName,
  stoppedAnnouncement,
  workingAnnouncement,
} from "./turn-narration";

/**
 * The measured silence this module exists to end, pinned as assertions.
 *
 * A whole turn on the default demo provider spoke: "Persisting turn intent",
 * 1.5 s of nothing, then "Local kernel ready" and "Airship’s turn ended." in the
 * same animation frame. `/help` wrote a full command listing and announced
 * nothing; `/nonsense-command` was rejected and announced nothing.
 */
describe("what a turn says", () => {
  it("quotes the settled body, which is the one the demo path actually has", () => {
    expect(arrivalAnnouncement("The three files are listed below."))
      .toBe("Airship’s turn ended. The three files are listed below.");
    expect(arrivalAnnouncement("")).toBe("Airship’s turn ended.");
    expect(arrivalAnnouncement("   \n  ")).toBe("Airship’s turn ended.");
    // Markdown is punctuation to a synthesiser: a heading hash or a fence gets
    // read out loud or swallows the word after it.
    expect(arrivalAnnouncement("## Result\n\n`ok` and **done**"))
      .toBe("Airship’s turn ended. Result ok and done");
    expect(arrivalAnnouncement("```ts\nconst x = 1;\n```"))
      .toBe("Airship’s turn ended. const x = 1;");
  });

  it("truncates a long reply at a word boundary instead of speaking the whole answer", () => {
    const spoken = arrivalAnnouncement(`${"alpha ".repeat(60)}omega`);
    expect(spoken.endsWith("…")).toBe(true);
    expect(spoken).not.toContain("omega");
    const excerpt = spoken.replace("Airship’s turn ended. ", "").replace("…", "");
    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt.endsWith("alpha")).toBe(true);
  });

  it("names the model working and the way out, and only names the way out when it exists", () => {
    expect(workingAnnouncement(true)).toBe("Airship is answering. Stop turn is in the composer.");
    expect(workingAnnouncement(false)).toBe("Airship is answering.");
    // The old in-flight channel said "Persisting turn intent" — a storage
    // operation — and nothing else for the rest of the turn.
    expect(workingAnnouncement(true)).not.toMatch(/persist/iu);
  });

  it("distinguishes a failure from a stop, and carries the reason on screen", () => {
    expect(failureAnnouncement("The local inference stream ended before a completion marker."))
      .toBe("Turn failed. The local inference stream ended before a completion marker.");
    expect(failureAnnouncement("")).toBe("Turn failed.");
    expect(stoppedAnnouncement()).toContain("Turn stopped.");
  });

  it("tells a completed command from a rejected one, which the lane could not do at all", () => {
    expect(localCommandAnnouncement("help", "completed", "/ls — List workspace files"))
      .toBe("Command /help completed. /ls — List workspace files");
    expect(localCommandAnnouncement("nonsense-command", "failed", "Unknown slash command: /nonsense-command."))
      .toBe("Command /nonsense-command failed. Unknown slash command: /nonsense-command.");
    expect(localCommandAnnouncement("write-file", "denied", "No tool effect ran, and nothing was sent to the model."))
      .toBe("Command /write-file was denied. No tool effect ran, and nothing was sent to the model.");
    expect(localCommandAnnouncement("ls", "stopped", "")).toBe("Command /ls was stopped.");
  });

  it("names the command without replaying its arguments", () => {
    expect(spokenCommandName("/write notes/x.md a long body that is already in the transcript")).toBe("write");
    expect(spokenCommandName("  /help  ")).toBe("help");
  });
});

describe("the channel", () => {
  const source = async () => readFile(new URL("./turn-narration.ts", import.meta.url), "utf8");

  it("holds a dwell floor, because two utterances in one frame is one utterance", async () => {
    const code = await source();
    expect(code).toMatch(/TURN_NARRATION_DWELL_MS = \d+/u);
    expect(code).toContain("const waited = Date.now() - spokenAt.current;");
    expect(code).toContain("window.setTimeout(publish, dwellMs - waited)");
  });

  it("lets the shell's ambient runtime line stand down while it speaks", async () => {
    const code = await source();
    expect(code).toContain("holdsChannel");
    const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
    // The topbar line keeps painting; only its polite mirror defers.
    expect(app).toContain("if (turnNarration.holdsChannel()) return;");
    expect(app).toContain('<span class="sr-only" role="status" aria-live="polite">{runtimeAnnouncement}</span>');
  });
});
