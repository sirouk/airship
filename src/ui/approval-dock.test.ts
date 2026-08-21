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
  deferredArrivalNotice,
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

/*
 * P3. A write approval is the last thing a person reads before an effect
 * reaches their own disk, and it was telling them something it could not know.
 *
 * Measured in Chromium: `/write p3/notes.txt` over a file that already held
 * `first-content-abcdef` rendered "Size delta: Not supplied" and a two-sided
 * preview whose old side was "∅". `write_file` carries the new content and
 * nothing about what it replaces, so neither claim was derived from anything;
 * ∅ is a statement that the file is empty, and it was wrong.
 */
describe("the write preview claims only what the arguments carry", () => {
  const overwrite = facts(request());
  const replacement = facts(request({
    toolName: "replace_text",
    displayArguments: { path: "notes/hello.md", oldText: "hi", newText: "hello there" },
  }));
  const source = readFileSync(new URL("./approval-dock.tsx", import.meta.url), "utf8");

  it("has no previous content to show for a create-or-overwrite", () => {
    // The facts themselves are unchanged: this is what the panel is given.
    expect(overwrite.after).toBe("hello there");
    expect(overwrite.before).toBeUndefined();
    expect(overwrite.byteDelta).toBeUndefined();
    expect(replacement.before).toBe("hi");
    expect(replacement.after).toBe("hello there");
    expect(replacement.byteDelta).toBe(9);
  });

  it("renders two sides only when there are two, and never invents an empty one", () => {
    // Nowhere but the comment that records why it left.
    expect(source.split("\u2205")).toHaveLength(2);
    expect(source).not.toContain("{facts.before || \"\u2205\"}");
    expect(source).not.toContain("{facts.after || \"\u2205\"}");
    // One side is drawn only when the arguments carry it, and the single value
    // is labelled as what it is rather than as half of a comparison.
    expect(source).toContain("facts.before === undefined ? null : <del>{facts.before}");
    expect(source).toContain("New content, bounded. What it replaces is not read here.");
    // The old two-sided-or-nothing condition is gone.
    expect(source).not.toContain("facts.before !== undefined || facts.after !== undefined");
  });

  it("drops the size delta rather than reporting it as a missing argument", () => {
    expect(source).not.toContain('<small>Size delta</small><strong>{facts.byteDelta === undefined ? "Not supplied"');
    expect(source).toContain("{facts.byteDelta === undefined ? null : <div><small>Size delta</small>");
    // The spoken description already omitted it; the two now agree.
    expect(approvalConsequenceSummary(overwrite)).not.toContain("Size delta");
    expect(approvalConsequenceSummary(replacement)).toContain("Size delta +9 bytes");
  });
});

/*
 * P5. "2 decisions waiting" rendered one name, one expiry and one button.
 *
 * Measured in Chromium with two conversations each holding an unanswered
 * `/write`: the bar's whole body was
 * `write_file · General conversation · expires in 05:00` and a single
 * `Review write_file in General conversation`. The second request had no name
 * a person could read and no control at all until the first was answered,
 * while its own five minutes ran out.
 */
describe("every waiting decision is named and reachable", () => {
  const source = readFileSync(new URL("./approval-dock.tsx", import.meta.url), "utf8");

  it("renders a row per deferred request rather than only the first", () => {
    expect(source).toContain("{snapshot.deferred.map((request) => {");
    expect(source).toContain("broker.resume(request.id)");
    expect(source).toContain("{reviewLabel(request, named)}");
    // `deferred[0]` survives only as "is the bar on screen at all".
    expect(source).not.toContain("broker.resume(waiting.id)");
    expect(source).not.toContain("{waiting.toolName}");
  });

  it("keeps the count and the rows reading from the same list", () => {
    expect(source).toContain('snapshot.deferred.length === 1 ? "1 decision waiting" : `${snapshot.deferred.length} decisions waiting`');
  });
});

/*
 * P6. The bar was a `role="group"` with no live region.
 *
 * Measured in Chromium: with a decision waiting, the only live regions carrying
 * text were the transcript's — "Reviewing local /write-file", then "Command
 * /write-file completed." — and the bar itself announced nothing. The one path
 * that ever spoke was the Escape handler, which only fires for a request the
 * person had just put down themselves.
 */
describe("a decision that arrives without being asked for says so, once", () => {
  const source = readFileSync(new URL("./approval-dock.tsx", import.meta.url), "utf8");
  const elsewhere = request({ id: "there:turn:op", sessionId: "there" });
  const names = (sessionId: string) => sessionId === "there" ? "Alpha" : "Bravo";

  it("names the tool, the conversation and the button that answers it", () => {
    const spoken = deferredArrivalNotice([elsewhere], names);
    expect(spoken).toContain("write_file is waiting for a decision in Alpha");
    expect(spoken).toContain("\u201cReview write_file in Alpha\u201d");
    // Honest about what did not happen: nothing was interrupted, nothing ran.
    expect(spoken).toContain("Nothing was interrupted; nothing runs");
    expect(spoken).toContain("until you answer");
    expect(spoken).not.toMatch(/denied|approved|allowed/iu);
  });

  it("counts the rest instead of reading a list out loud", () => {
    const spoken = deferredArrivalNotice(
      [elsewhere, request({ id: "here:turn:op", sessionId: "here" })],
      names,
    );
    expect(spoken).toContain("in Alpha, and 1 more with it");
    expect(deferredArrivalNotice([], names)).toBe("");
  });

  it("speaks from its own region, not the outcome channel or the transcript's", () => {
    // Three regions: settled outcomes, the assertive deadline, and this one.
    expect(source.match(/class="sr-only" role="status" aria-live="polite" aria-atomic="true"/gu)).toHaveLength(2);
    expect(source).toContain("aria-atomic=\"true\">{arrival}</span>");
    expect(source).toContain("const [arrival, setArrival] = useState(\"\");");
  });

  it("says it once, and never twice for a request the person put down", () => {
    expect(source).toContain("const spokenFor = useRef(new Set<string>());");
    expect(source).toContain("const fresh = snapshot.deferred.filter((request) => !spokenFor.current.has(request.id));");
    // Escape marks its own before deferring, so its sentence is not doubled.
    expect(source).toContain("spokenFor.current.add(current.id);\n                announce.current(approvalDeferralNotice(");
    // Rebuilt from the live snapshot, so the set cannot outgrow the queue.
    expect(source).toContain("spokenFor.current = new Set(snapshot.deferred.map((request) => request.id));");
  });
});
