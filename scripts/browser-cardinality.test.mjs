import { describe, expect, it } from "vitest";
import { countTests, evaluateProject, renderSummary } from "./browser-cardinality.mjs";

/**
 * The gate that decides whether a browser run counts, tested against the run
 * that made it necessary.
 *
 * The inline version this replaces summed the execution report's own counts and
 * compared them to nothing. Review caught it: 89 passed + 0 failed + 38 skipped
 * is a self-consistent 127, and with a zero exit code it was waved through even
 * though 184 tests exist. The first case below is that run, and it must fail.
 */

/** A Playwright-shaped report holding `count` tests across two nested suites. */
const report = (count, stats) => JSON.stringify({
  stats,
  suites: [{
    specs: Array.from({ length: Math.floor(count / 2) }, () => ({ tests: [{}] })),
    suites: [{ specs: Array.from({ length: count - Math.floor(count / 2) }, () => ({ tests: [{}] })) }],
  }],
});

const discovery = (count) => report(count, { expected: 0, unexpected: 0, skipped: count, flaky: 0 });
const execution = (passed, failed, skipped, flaky = 0) =>
  report(passed + failed + skipped + flaky, { expected: passed, unexpected: failed, skipped, flaky });

describe("the browser cardinality gate", () => {
  it("passes a complete run with nothing failing", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: execution(146, 0, 38),
      exit: "0",
    });
    expect(result.ok).toBe(true);
    expect(result.expected).toBe(184);
    expect(result.actual).toBe(184);
  });

  it("fails the exact run that motivated it: 127 executed against 184 discovered", () => {
    /*
     * 89 passed, 0 failed, 38 skipped, exit 0. Internally consistent, zero
     * failures, runner content — and 57 tests never ran. The predecessor
     * called this "ok".
     */
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: execution(89, 0, 38),
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("executed 127 of 184 discovered tests");
  });

  it("fails a nonzero runner exit that reported no failure", () => {
    const result = evaluateProject({
      project: "mobile-chromium",
      discovery: discovery(92),
      execution: execution(92, 0, 0),
      exit: "1",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/runner exited 1 with no reported failure/u);
  });

  it("fails an unreadable discovery report", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: "not json",
      execution: execution(184, 0, 0),
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("discovery report unreadable");
  });

  it("fails a missing discovery report, which is how a skipped step would look", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: undefined,
      execution: execution(184, 0, 0),
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("discovery report unreadable");
  });

  it("fails an unreadable execution report", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: "",
      exit: "1",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/execution report unreadable \(runner exit 1\)/u);
  });

  it("fails when discovery finds nothing", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(0),
      execution: execution(0, 0, 0),
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("discovery found no tests");
  });

  it("fails when nothing executed", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: execution(0, 0, 0),
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no tests executed");
  });

  it("fails a real failure even when the cardinality is perfect", () => {
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: execution(144, 2, 38),
      exit: "1",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("2 failed");
  });

  it("counts a flaky test as executed rather than as missing", () => {
    // Flaky tests pass on retry and belong in the total; excluding them would
    // make an honest run look truncated.
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(169),
      execution: execution(128, 0, 39, 2),
      exit: "0",
    });
    expect(result.ok).toBe(true);
    expect(result.flaky).toBe(2);
  });

  it("fails a report whose outcome counts disagree with its own tree", () => {
    // Defence in depth: the tree says 184 and `stats` says 100. Neither number
    // is trusted over the other; the disagreement itself is the failure.
    const inconsistent = report(184, { expected: 100, unexpected: 0, skipped: 0, flaky: 0 });
    const result = evaluateProject({
      project: "desktop-chromium",
      discovery: discovery(184),
      execution: inconsistent,
      exit: "0",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outcome counts total 100 against 184 tests");
  });

  it("counts tests from the suite tree rather than from stats", () => {
    /*
     * `--list` reports every discovered test under `stats.skipped`, so reading
     * `stats` would compare "tests that exist" with "tests that ran" using one
     * field to mean two things. The tree means the same thing in both reports.
     */
    expect(countTests(JSON.parse(discovery(184)))).toBe(184);
    expect(countTests(JSON.parse(execution(146, 0, 38)))).toBe(184);
  });

  it("renders every project into the summary, including the ones that failed", () => {
    const summary = renderSummary([
      evaluateProject({ project: "desktop-chromium", discovery: discovery(184), execution: execution(146, 0, 38), exit: "0" }),
      evaluateProject({ project: "mobile-chromium", discovery: discovery(184), execution: execution(89, 0, 38), exit: "0" }),
    ]);
    expect(summary).toContain("| desktop-chromium | 184 | 184 |");
    expect(summary).toContain("executed 127 of 184 discovered tests");
  });
});
