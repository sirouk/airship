import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../chat.css", import.meta.url), "utf8");

/**
 * Measured: with 21 items queued the backlog panel took 210px of the composer
 * and left the transcript at 483px of a 900px desktop viewport (54%) and 348px
 * of 844px on a phone (41%) — the conversation the backlog belongs to lost half
 * its reading area to it, silently, while it drained. Opening the disclosure
 * was worse: the list took the transcript to 14% and 4%.
 */
describe("the backlog does not take the conversation's reading area", () => {
  it("renders one row about itself when collapsed, not the stack", () => {
    expect(app).toContain("const queueVisibleItems = queueExpanded || messageQueue.length === 1 ? messageQueue : [];");
    // The rows come from the visible slice, so a collapsed queue cannot grow.
    expect(app).toContain("{queueVisibleItems.map((item, index) => (");
    expect(app).not.toContain("{messageQueue.map((item, index) => (");
    // And the one row names what is about to be sent, not only how many.
    expect(app).toContain("`Next: ${messageQueue[0]!.prompt}");
  });

  it("keeps every queued item one named control away", () => {
    // The disclosure is the way to the rest; it appears as soon as there is a
    // rest to reach, rather than at an arbitrary count.
    expect(app).toContain("{messageQueue.length > 1 ? (");
    expect(app).toContain('class="composer-queue__expand"');
    expect(app).toContain("aria-expanded={queueExpanded}");
    expect(app).toContain("`Show all ${messageQueue.length}`");
  });

  it("opens over the conversation instead of pushing it", () => {
    const expanded = chatStyles.slice(chatStyles.indexOf('.composer-queue[data-expanded="true"]'));
    const rule = expanded.slice(0, expanded.indexOf("}"));
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("bottom: calc(100% + 4px)");
    // Still bounded by the viewport rather than by the list length.
    expect(rule).toMatch(/max-height: min\(60dvh, 620px\)/u);
    expect(chatStyles).toContain(".composer { position: relative; }");
  });
});

/**
 * `role=alert` nodes on the page: [] while two messages carried the visible
 * badges FAILED TURN and EXCLUDED FROM PROVIDER CONTEXT, both named "Airship
 * message" — the same accessible name as a successful reply.
 */
describe("a failed turn is a failure in the accessibility tree", () => {
  it("carries the disposition in the accessible name", () => {
    expect(app).toContain('aria-label={`${message.role === "user" ? "Your" : "Airship"} message${message.error ? " — failed turn" : ""}`}');
    expect(app).toContain('{...(message.error ? { "data-turn-failed": "true" } : {})}');
  });

  it("does not make a transcript row an alert, which would re-announce history", () => {
    // Comments first: this repo's prose names the attribute it rules out, and
    // the explanation must not become the violation.
    const card = app
      .slice(app.indexOf("function MessageCard("))
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
    const articleStart = card.indexOf("<article");
    const articleOpeningTag = card.slice(articleStart, card.indexOf(">", articleStart) + 1);
    expect(articleOpeningTag).not.toContain('role="alert"');
    // A Copy refusal appears only after a direct action, beside that message;
    // announcing that new recovery text must not weaken the row-level rule.
    expect(card).toContain('class="message-copy-failure" role="alert"');
  });
});
