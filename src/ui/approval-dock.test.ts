import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../approvals/broker";
import { approvalDerivationInput } from "../approvals/consequence";
import { writeApprovalFacts } from "./approval-presentation";
import {
  approvalConsequenceSummary,
  approvalDeadlineSentence,
  approvalDeadlineWarning,
  approvalDeferralNotice,
  approvalSettlementAnnouncement,
  reviewLabel,
} from "./approval-dock";

function request(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return Object.freeze({
    id: "session:turn:operation",
    toolName: "write_file",
    description: "Create or replace one UTF-8 file in the private virtual workspace.",
    effect: "write",
    risk: "change",
    sessionId: "session",
    turnId: "turn",
    operationId: "operation",
    requestedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: "2026-07-31T12:05:00.000Z",
    displayArguments: { path: "notes/hello.md", content: "hello there" },
    ...overrides,
  } as PendingApproval);
}

function facts(value: PendingApproval) {
  const input = approvalDerivationInput(value.toolName, value.displayArguments);
  return writeApprovalFacts(input.toolName, input.argumentsValue);
}

describe("the dialog's accessible description", () => {
  /**
   * Measured: `aria-describedby` resolved to the generic capability sentence
   * alone, while Target / Change / New size sat in a section the description
   * never reached — so a screen-reader user approved a write without hearing
   * what it writes.
   */
  it("names the target path and the size the request declares", () => {
    const summary = approvalConsequenceSummary(facts(request()));
    expect(summary).toContain("notes/hello.md");
    expect(summary).toContain("11 bytes");
    expect(summary).toContain("Create or overwrite");
  });

  it("carries the size delta a replacement declares", () => {
    const summary = approvalConsequenceSummary(facts(request({
      toolName: "replace_text",
      displayArguments: { path: "notes/hello.md", oldText: "hi", newText: "hello there" },
    })));
    expect(summary).toContain("Size delta +9 bytes");
  });

  it("names the staged file for a Git approval instead of an adapter", () => {
    const summary = approvalConsequenceSummary(facts(request({
      toolName: "git_stage",
      displayArguments: { repositoryId: "airship-workspace", worktreeId: "main", paths: ["README.md"], expectedWorktreeVersion: "v1", force: false },
    })));
    expect(summary).toContain("README.md");
    expect(summary).toContain("Git stage in the browser-owned worktree");
    expect(summary).not.toContain("not derivable");
  });

  it("says so plainly when nothing is derivable rather than implying no consequence", () => {
    expect(approvalConsequenceSummary(facts(request({ toolName: "unmapped_tool", displayArguments: {} }))))
      .toContain("no derivable consequence");
  });
});

describe("the spoken outcome of a security decision", () => {
  /**
   * Before: denial announced `Airship’s turn ended.` and allow announced
   * `Local command complete; no model request made` — a claim about the model
   * containing neither the path nor the byte count, and nothing at all about
   * which of the two had happened.
   */
  it("names the path and the byte count on allow", () => {
    const value = request();
    const spoken = approvalSettlementAnnouncement({ request: value, outcome: "allow" }, facts(value));
    expect(spoken).toContain("Allowed once");
    expect(spoken).toContain("notes/hello.md");
    expect(spoken).toContain("11 bytes");
  });

  it("says denied, and says nothing changed", () => {
    const value = request();
    const spoken = approvalSettlementAnnouncement({ request: value, outcome: "deny" }, facts(value));
    expect(spoken).toMatch(/denied/iu);
    expect(spoken).toMatch(/nothing/iu);
    expect(spoken).toContain("write_file");
  });

  it("distinguishes an expiry from a refusal out loud", () => {
    const value = request();
    const expired = approvalSettlementAnnouncement({ request: value, outcome: "expired" }, facts(value));
    const denied = approvalSettlementAnnouncement({ request: value, outcome: "deny" }, facts(value));
    expect(expired).toMatch(/expired/iu);
    expect(expired).not.toMatch(/denied/iu);
    expect(expired).not.toBe(denied);
  });

  /** Permission is decided here; execution is observed elsewhere. */
  it("never claims the effect completed", () => {
    const value = request();
    const spoken = approvalSettlementAnnouncement({ request: value, outcome: "allow" }, facts(value));
    expect(spoken).toContain("may now run");
    expect(spoken).not.toMatch(/wrote|completed|finished/iu);
  });
});

describe("the deadline, which was inaudible", () => {
  it("states what is left, in the words the expiry outcome uses", () => {
    expect(approvalDeadlineSentence(request(), Date.parse("2026-07-31T12:00:00.000Z"))).toBe(
      "You have 5 minutes left to decide. If the clock runs out, nothing runs and no decision is recorded.",
    );
  });

  it("does not restate the original budget to someone returning from a defer", () => {
    /*
     * Escape puts the request down without deciding it and the broker keeps the
     * original `requestedAt`/`expiresAt`, so a sentence computed as
     * `expiresAt - requestedAt` announced "5 minutes" to a listener re-entering
     * the dialog four minutes later — while the countdown beside it read 01:00
     * and the assertive warning was about to fire.
     */
    const resumed = approvalDeadlineSentence(request(), Date.parse("2026-07-31T12:04:00.000Z"));
    expect(resumed).toContain("60 seconds left to decide");
    expect(resumed).not.toContain("5 minutes");
    // An elapsed request has no window left to offer; it must not read as one.
    expect(approvalDeadlineSentence(request(), Date.parse("2026-07-31T12:06:00.000Z")))
      .toContain("1 second left to decide");
  });

  it("reads the sentence at open rather than churning it once a second", () => {
    // The dialog's `aria-describedby` points at this span, and the design is
    // explicit that the deadline is announced on open and assertively as it
    // runs out — never as per-second text. `clock` ticks; the open does not.
    const source = readFileSync(new URL("./approval-dock.tsx", import.meta.url), "utf8");
    expect(source).toContain("const openedAt = useMemo(() => Date.now(), [current?.id]);");
    expect(source).toContain("{approvalDeadlineSentence(current, openedAt)}");
  });

  it("warns assertively and names what expiry costs", () => {
    const warning = approvalDeadlineWarning(request());
    expect(warning).toContain("30 seconds");
    expect(warning).toContain("write_file");
    expect(warning).toContain("nothing runs");
  });

  it("tells a person who pressed Escape that nothing was decided, and where it went", () => {
    const notice = approvalDeferralNotice(request(), Date.parse("2026-07-31T12:00:02.000Z"));
    expect(notice).toContain("Not decided");
    expect(notice).toContain("04:58");
    expect(notice).toContain("Review write_file");
    expect(notice).not.toMatch(/denied/iu);
  });

});

/*
 * One broker serves every conversation, and turns run in parallel.
 *
 * The dialog is the shell's only self-inflicted inert state, so which requests
 * may raise it is a product decision, not a queue order. A request from the
 * thread on screen is the interruption it has always been; a request from a
 * thread answering in the background is not allowed to stop the work a person
 * is looking at, and the broker files it as waiting instead.
 */
describe("the deferred bar names the conversation that is asking", () => {
  const here = request({ id: "here:turn:op", sessionId: "here" });

  it("puts the conversation on the button and in the sentence about it", () => {
    expect(reviewLabel(here, "Alpha")).toBe("Review write_file in Alpha");
    expect(approvalDeferralNotice(here, Date.parse(here.requestedAt), "Alpha"))
      .toContain("\u201cReview write_file in Alpha\u201d");
  });

  it("still reads correctly for a host that names no conversation", () => {
    expect(reviewLabel(here)).toBe("Review write_file");
    expect(approvalDeferralNotice(here, Date.parse(here.requestedAt))).toContain("\u201cReview write_file\u201d");
  });
});
