import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  SESSION_STATUS_SHORT_MAX,
  sessionStatusName,
  sessionStatusShort,
  worstSessionFact,
  type SessionStatusFact,
} from "./session-status-chip";

function fact(over: Partial<SessionStatusFact> & Pick<SessionStatusFact, "id" | "state">): SessionStatusFact {
  return Object.freeze({
    label: "Label",
    detail: "Detail.",
    short: "Short",
    ...over,
  });
}

describe("sessionStatusShort", () => {
  it("keeps the leading clause when it fits the chip", () => {
    expect(sessionStatusShort("Saved locally · available after reload", "Saved")).toBe("Saved locally");
    expect(sessionStatusShort("Running · turn 4", "Running")).toBe("Running");
    expect(sessionStatusShort("Ready", "Ready")).toBe("Ready");
  });

  it("falls back instead of truncating the resting word", () => {
    expect(sessionStatusShort("Saved in browser storage", "Saved")).toBe("Saved");
    expect(sessionStatusShort("Turn in progress", "Working")).toBe("Working");
    expect(sessionStatusShort("Stopped by user", "Stopped")).toBe("Stopped");
  });

  it("never returns a string longer than the chip can render", () => {
    const labels = [
      "Saved in browser storage · available after reload",
      "Synced to vault",
      "Waiting for model",
      "Writing locally",
      "Turn in progress",
    ];
    for (const label of labels) {
      expect(sessionStatusShort(label, "Saved").length).toBeLessThanOrEqual(SESSION_STATUS_SHORT_MAX);
    }
  });

  it("falls back when the label starts with a separator", () => {
    expect(sessionStatusShort(" · turn 4", "Working")).toBe("Working");
  });
});

describe("worstSessionFact", () => {
  it("prefers a running lifecycle over durability", () => {
    const running = fact({ id: "lifecycle", state: "checking", label: "Turn running", short: "Running" });
    const pageOnly = fact({ id: "durability", state: "failed", label: "Page only", short: "Page only" });

    expect(worstSessionFact([pageOnly, running])).toBe(running);
  });

  it("prefers a failed lifecycle over durability", () => {
    const stopped = fact({ id: "lifecycle", state: "failed", label: "Turn failed", short: "Failed" });
    const saved = fact({ id: "durability", state: "attention", label: "Saved locally", short: "Saved" });

    expect(worstSessionFact([saved, stopped])).toBe(stopped);
  });

  it("falls back to durability when lifecycle is resting", () => {
    const ready = fact({ id: "lifecycle", state: "none", label: "Ready", short: "Ready" });
    const pageOnly = fact({
      id: "durability",
      state: "attention",
      label: "Page only",
      detail: "This session is kept only in page memory.",
      short: "Page only",
    });

    expect(worstSessionFact([ready, pageOnly])).toBe(pageOnly);
  });

  it("falls back to the remaining lifecycle row when durability is absent", () => {
    const ready = fact({ id: "lifecycle", state: "none", label: "Ready", short: "Ready" });

    expect(worstSessionFact([ready])).toBe(ready);
  });

  it("returns nothing for an empty list", () => {
    expect(worstSessionFact([])).toBeUndefined();
  });
});

describe("sessionStatusName", () => {
  it("starts with the durability text", () => {
    const name = sessionStatusName(
      [fact({ id: "lifecycle", state: "checking", label: "Turn running", detail: "Turn 7 in this session." })],
      "Ephemeral · this page only",
    );

    expect(name.startsWith("Session. Ephemeral · this page only.")).toBe(true);
  });

  it("does not repeat the durability text when durability is the visible status", () => {
    const name = sessionStatusName(
      [fact({
        id: "durability",
        state: "attention",
        label: "Ephemeral · this page only",
        detail: "This session is kept only in page memory.",
      })],
      "Ephemeral · this page only",
    );

    expect(name.startsWith("Session. Ephemeral · this page only. This session is kept only in page memory.")).toBe(true);
    expect(name.match(/Ephemeral · this page only/gu)).toHaveLength(1);
  });

  it("includes lifecycle text when lifecycle leads", () => {
    const name = sessionStatusName(
      [fact({ id: "lifecycle", state: "checking", label: "Turn running", detail: "Turn 7 in this session." })],
      "Saved locally",
    );

    expect(name).toContain("Turn running.");
    expect(name).toContain("Turn 7 in this session.");
  });

  it("uses details for the count", () => {
    const name = sessionStatusName(
      [fact({ id: "durability", state: "none" }), fact({ id: "lifecycle", state: "none" })],
      "Saved locally",
    );

    expect(name).toContain("2 details.");
  });
});

const statusChipSource = await readFile(new URL("./session-status-chip.tsx", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../chat.css", import.meta.url), "utf8");

describe("session status source", () => {
  it("keeps only durability and lifecycle ids", () => {
    expect(statusChipSource).toContain('export type SessionStatusFactId = "durability" | "lifecycle";');
  });

  it("uses neutral visible copy", () => {
    expect(statusChipSource).toContain('heading="Session status"');
    expect(statusChipSource).toContain('<span class="session-status-chip__unit">{facts.length === 1 ? "detail" : "details"}</span>');
  });
});

describe("the counted chip states its own unit", () => {
  it("renders the session count's unit as text beside the number", () => {
    expect(statusChipSource).toContain('<span class="session-status-chip__unit">{facts.length === 1 ? "detail" : "details"}</span>');
  });

  it("clips the unit with the other shed labels rather than dropping it from the markup", () => {
    const scrolled = chatStyles.match(/@media \(pointer: fine\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(scrolled).toContain('.chat-stage[data-scrolled="true"] .session-status-chip__unit');
    expect(scrolled).toContain("clip-path: inset(50%)");
  });
});
