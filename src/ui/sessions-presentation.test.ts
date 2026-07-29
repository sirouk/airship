import { describe, expect, it } from "vitest";
import {
  SESSION_SEARCH_SCOPE_NOTE,
  forkRequirement,
  historyIncompleteMessage,
  forkTitleFor,
  relativeSessionTime,
  sessionEmptyState,
  sessionEventCount,
  sessionIntegrityRow,
  sessionLineage,
  shortSessionId,
  titleMatchSegments,
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

  /*
   * The compatibility verdict answers a different question from the one this
   * pill appears to answer.
   *
   * A conversation whose transcript the runtime just refused to replay still
   * has matching manifest pins, so `compatibility.action` stays `resume` — and
   * the row went on printing a green "Ready to resume" beside a disabled resume
   * control. Both halves of the truth have to survive: the chain really did
   * pass its audit, so the structure pill stays `verified`, and `attention`
   * rather than `failed` is deliberate, because "failed" here would tell a user
   * their conversation is damaged when every byte of it is recoverable.
   */
  it("never says a conversation is ready to resume after its transcript failed to replay", () => {
    const row = sessionIntegrityRow(integrityInput({ transcriptReplayFailed: true }));

    expect(row.pills.map((pill) => pill.label)).not.toContain("Ready to resume");
    expect(row.pills[1]?.label).toBe("Transcript cannot be replayed");
    expect(row.pills[1]?.state).toBe("attention");
    expect(row.pills[1]?.state).not.toBe("failed");
    // The audit's own verdict is not withdrawn by the replay failure.
    expect(row.pills[0]?.label).toBe("Structure passed");
    expect(row.pills[1]?.detail).toContain("History verified");
    // …and the explanation cannot be hidden behind a collapsed control.
    expect(row.autoExpanded).toBe(true);
    expect(row.label).toContain("Transcript cannot be replayed");
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

describe("sessionEmptyState", () => {
  it("names the unindexed surface only when a search actually ran", () => {
    expect(sessionEmptyState({ filtered: true, query: "plan.md" }).lines).toContain(SESSION_SEARCH_SCOPE_NOTE);
    expect(sessionEmptyState({ filtered: true, query: "" }).lines).not.toContain(SESSION_SEARCH_SCOPE_NOTE);
    expect(sessionEmptyState({ filtered: false, query: "" }).lines).toEqual([
      "A conversation appears here after the journal creates it.",
    ]);
  });

  it("quotes the term that failed and names the fields that were compared", () => {
    const state = sessionEmptyState({ filtered: true, query: "  plan.md  " });
    expect(state.heading).toBe("No conversation matches “plan.md”");
    // The route always passes `profileId` to `library.list`, so a sentence that
    // claimed the whole journal told a person their conversation does not
    // exist anywhere when it exists under another profile.
    expect(state.lines[0]).toBe("Searched this profile's conversations by title, model, profile and fork source.");
    expect(state.lines[0]).not.toContain("every conversation in this journal");
    expect(state.offersClear).toBe(true);
  });

  it("states the searched size only as of the read that produced it, and never invents one", () => {
    expect(sessionEmptyState({ filtered: true, query: "x", loadedTotal: 25 }).lines)
      .toContain("25 conversations at the last unfiltered read.");
    expect(sessionEmptyState({ filtered: true, query: "x", loadedTotal: 1 }).lines)
      .toContain("1 conversation at the last unfiltered read.");
    expect(sessionEmptyState({ filtered: true, query: "x" }).lines.some((line) => /unfiltered read/u.test(line))).toBe(false);
  });

  it("offers no verb when nothing has been filtered, because there is nothing to undo", () => {
    const state = sessionEmptyState({ filtered: false, query: "" });
    expect(state.heading).toBe("No conversations yet");
    expect(state.offersClear).toBe(false);
  });

  it("says the filters failed when no term was typed at all", () => {
    expect(sessionEmptyState({ filtered: true, query: "" }).heading).toBe("No conversation matches these filters");
  });
});

describe("titleMatchSegments", () => {
  it("reassembles the title character for character around every match", () => {
    const segments = titleMatchSegments("Refactor the retrieval index", "the");
    expect(segments.map((segment) => segment.text).join("")).toBe("Refactor the retrieval index");
    expect(segments.filter((segment) => segment.matched).map((segment) => segment.text)).toEqual(["the"]);
  });

  it("marks every occurrence, case-insensitively, without altering the rendered case", () => {
    const segments = titleMatchSegments("Vault probe, vault reset", "VAULT");
    expect(segments.filter((segment) => segment.matched).map((segment) => segment.text)).toEqual(["Vault", "vault"]);
    expect(segments.map((segment) => segment.text).join("")).toBe("Vault probe, vault reset");
  });

  it("marks nothing for an empty or absent term", () => {
    expect(titleMatchSegments("General conversation", "   ")).toEqual([{ text: "General conversation", matched: false }]);
    expect(titleMatchSegments("General conversation", "zzz")).toEqual([{ text: "General conversation", matched: false }]);
  });
});

describe("forkRequirement", () => {
  const reasons = [
    { code: "POSTURE_OBSERVED_ONLY", severity: "info", message: "Observed only." },
    { code: "MODEL_MISMATCH", severity: "warning", message: "Pinned model differs." },
    { code: "POSTURE_AMBIGUOUS", severity: "error", message: "No coherent posture." },
  ];

  it("ranks the reasons worst first and keeps every message verbatim", () => {
    const requirement = forkRequirement({ action: "blocked", label: "Resume blocked", reasons });
    expect(requirement.required).toBe(true);
    expect(requirement.reasons.map((reason) => reason.code)).toEqual([
      "POSTURE_AMBIGUOUS",
      "MODEL_MISMATCH",
      "POSTURE_OBSERVED_ONLY",
    ]);
    expect(requirement.reasons.map((reason) => reason.message)).toEqual(reasons.map((reason) => reason.message).reverse());
  });

  it("narrows the fixed HISTORY_INCOMPLETE disjunction to the disjunct that holds", () => {
    const incomplete = [{ code: "HISTORY_INCOMPLETE", severity: "warning", message: "The session ended mid-turn or was only partially inspected; fork before continuing." }];
    const message = (history: Parameters<typeof historyIncompleteMessage>[0]) =>
      forkRequirement({ action: "fork-required", label: "Fork required", reasons: incomplete }, history).reasons[0]!.message;

    // Neither disjunct holds: 8 of 8 inspected, no unterminated turn.
    expect(message({ checkedEvents: 8, totalEvents: 8, issues: [{ code: "SESSION_UPDATE_TIME_MISMATCH" }] }))
      .toBe("1 structural observation on a fully inspected history; fork before continuing.");
    expect(message({ checkedEvents: 6, totalEvents: 8, issues: [{ code: "SESSION_UPDATE_TIME_MISMATCH" }] }))
      .toBe("Only 6 of 8 events were inspected; fork before continuing.");
    expect(message({ checkedEvents: 8, totalEvents: 8, issues: [{ code: "TURN_INCOMPLETE" }] }))
      .toBe("The most recent turn has no durable terminal event; fork before continuing.");
  });

  it("leaves every other reason's message byte-identical", () => {
    const reasons = [{ code: "MODEL_MISMATCH", severity: "warning", message: "Pinned model a differs from active model b." }];
    const scoped = forkRequirement({ action: "fork-required", label: "Fork required", reasons }, { checkedEvents: 1, totalEvents: 1, issues: [] });
    expect(scoped.reasons[0]!.message).toBe("Pinned model a differs from active model b.");
  });

  it("does not claim a fork is required when the runtime says the session resumes", () => {
    expect(forkRequirement({ action: "resume", label: "Ready to resume", reasons: [] }).required).toBe(false);
    expect(forkRequirement(undefined).required).toBe(false);
    expect(forkRequirement(undefined).label).toBe("No active runtime supplied");
  });
});
