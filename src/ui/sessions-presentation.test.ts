import { describe, expect, it } from "vitest";
import {
  SESSION_SEARCH_SCOPE_NOTE,
  forkTitleFor,
  relativeSessionTime,
  sessionEmptyStateBody,
  sessionEventCount,
  sessionIntegrityRow,
  sessionLineage,
  shortSessionId,
  type SessionIntegrityInput,
} from "./sessions-presentation";

const NOW = new Date("2026-07-27T15:00:00.000Z");

function integrityInput(overrides: Partial<SessionIntegrityInput> = {}): SessionIntegrityInput {
  return {
    history: { status: "consistent", label: "Journal structure passed", checkedEvents: 4, totalEvents: 4, turnCount: 2 },
    receiptCount: 0,
    lifecycle: { state: "idle", label: "Ready" },
    compatibility: { action: "resume", label: "Ready to resume" },
    ...overrides,
  };
}

describe("relativeSessionTime", () => {
  it("says just now inside the first three-quarters of a minute", () => {
    expect(relativeSessionTime("2026-07-27T14:59:30.000Z", NOW)).toBe("just now");
  });

  it("counts minutes, then hours, inside the same calendar day", () => {
    expect(relativeSessionTime("2026-07-27T14:48:00.000Z", NOW)).toBe("12m");
    expect(relativeSessionTime("2026-07-27T12:00:00.000Z", NOW)).toBe("3h");
  });

  it("never renders a zero-minute reading between 45s and 60s", () => {
    expect(relativeSessionTime("2026-07-27T14:59:10.000Z", NOW)).toBe("1m");
  });

  it("names yesterday and the weekday inside a week, with a clock reading", () => {
    expect(relativeSessionTime("2026-07-26T09:05:00.000Z", NOW)).toMatch(/^Yesterday \d{1,2}[:.]\d{2}/u);
    expect(relativeSessionTime("2026-07-23T09:05:00.000Z", NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}[:.]\d{2}/u);
  });

  it("falls back to a date beyond a week and adds the year beyond one", () => {
    expect(relativeSessionTime("2026-07-12T09:05:00.000Z", NOW)).toMatch(/12/u);
    expect(relativeSessionTime("2026-07-12T09:05:00.000Z", NOW)).not.toMatch(/2026/u);
    expect(relativeSessionTime("2025-07-12T09:05:00.000Z", NOW)).toMatch(/2025/u);
  });

  it("refuses to guess at an unparseable timestamp", () => {
    expect(relativeSessionTime("not-a-time", NOW)).toBe("Unknown time");
  });
});

describe("sessionEventCount", () => {
  it("agrees with itself in the singular, which the two call sites did not", () => {
    expect(sessionEventCount(1)).toBe("1 event");
    expect(sessionEventCount(0)).toBe("0 events");
    expect(sessionEventCount(12)).toBe("12 events");
  });
});

describe("sessionIntegrityRow", () => {
  it("collapses only while every verdict agrees", () => {
    const row = sessionIntegrityRow(integrityInput());
    expect(row.state).toBe("verified");
    expect(row.autoExpanded).toBe(false);
    expect(row.pills.map((pill) => pill.label)).toEqual(["Structure passed", "Ready to resume", "0 receipts"]);
  });

  it("fails open on a structural problem and carries the source label verbatim", () => {
    const row = sessionIntegrityRow(integrityInput({
      history: { status: "incomplete", label: "Journal is incomplete", checkedEvents: 2, totalEvents: 9, turnCount: 1 },
    }));
    expect(row.autoExpanded).toBe(true);
    expect(row.state).toBe("attention");
    expect(row.pills[0]?.label).toBe("Journal is incomplete");
    expect(row.pills[0]?.detail).toBe("2 of 9 events inspected · 1 turn");
  });

  it("fails open on a blocked resume and ranks it above a healthy structure", () => {
    const row = sessionIntegrityRow(integrityInput({
      compatibility: { action: "blocked", label: "Cannot resume in this runtime" },
    }));
    expect(row.state).toBe("failed");
    expect(row.autoExpanded).toBe(true);
  });

  it("does not colour a receipt count as a verdict", () => {
    const row = sessionIntegrityRow(integrityInput({ receiptCount: 3 }));
    expect(row.pills[2]).toMatchObject({ state: "none", label: "3 receipts" });
    expect(row.state).toBe("verified");
  });

  it("states what the expansion contains in its own accessible name", () => {
    const row = sessionIntegrityRow(integrityInput());
    expect(row.label).toContain("Structure passed");
    expect(row.label).toContain("runtime decision");
    expect(row.label).toContain("proof scope");
  });

  it("does not claim a runtime decision when no runtime was supplied", () => {
    const row = sessionIntegrityRow(integrityInput({ compatibility: undefined }));
    expect(row.pills[1]).toMatchObject({ state: "none", label: "No active runtime" });
    expect(row.autoExpanded).toBe(true);
  });
});

describe("forkTitleFor", () => {
  it("names the derivative rather than suffixing the original", () => {
    expect(forkTitleFor("Research conversation")).toBe("Fork of Research conversation");
  });

  it("respects the journal's own title cap", () => {
    expect(forkTitleFor("x".repeat(400))).toHaveLength(240);
  });
});

describe("sessionLineage", () => {
  it("is absent for a conversation that was not forked", () => {
    expect(sessionLineage(undefined, new Map())).toBeUndefined();
  });

  it("prefers the parent title and marks it navigable when the parent is loaded", () => {
    expect(sessionLineage("6e8fd534aaaa3d5b", new Map([["6e8fd534aaaa3d5b", "Research conversation"]])))
      .toEqual({ label: "Research conversation", navigable: true, parentId: "6e8fd534aaaa3d5b" });
  });

  it("still renders the lineage when the parent is outside the current filter", () => {
    const lineage = sessionLineage("6e8fd534aaaa3d5b", new Map());
    expect(lineage).toEqual({ label: "6e8fd534…3d5b", navigable: false, parentId: "6e8fd534aaaa3d5b" });
  });
});

describe("shortSessionId", () => {
  it("leaves a short id alone and elides a long one at both ends", () => {
    expect(shortSessionId("abc")).toBe("abc");
    expect(shortSessionId("0123456789abcdef")).toBe("01234567…cdef");
  });
});

describe("sessionEmptyStateBody", () => {
  it("names the unindexed surface only when a search actually ran", () => {
    expect(sessionEmptyStateBody({ filtered: true, searched: true })).toContain(SESSION_SEARCH_SCOPE_NOTE);
    expect(sessionEmptyStateBody({ filtered: true, searched: false })).not.toContain(SESSION_SEARCH_SCOPE_NOTE);
    expect(sessionEmptyStateBody({ filtered: false, searched: false })).toEqual([
      "A conversation appears here after the journal creates it.",
    ]);
  });
});
