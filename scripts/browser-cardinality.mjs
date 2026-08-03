#!/usr/bin/env node
/**
 * Did the browser suite run everything it was supposed to run?
 *
 * The first version of this gate lived inline in the workflow and summed the
 * counts the execution report gave it — passed + failed + skipped + flaky —
 * then called that "the total". That is circular. The number it checked came
 * from the same report it was checking, so a run that executed 127 of 184 tests
 * and reported 89 passed, 0 failed, 38 skipped reconciled perfectly against
 * itself and was waved through. That exact run has happened in this repository.
 * The step's own comment claimed it caught that case. It did not.
 *
 * A cardinality check needs a number the execution cannot influence, so the
 * expected count now comes from a separate discovery pass — `playwright test
 * --list` — taken before the run. Discovery and execution are two independent
 * statements about the same suite, and the gate is that they agree.
 *
 * Usage:
 *   node scripts/browser-cardinality.mjs \
 *     desktop-chromium:desktop-list.json:desktop.json:$DESKTOP_EXIT \
 *     mobile-chromium:mobile-list.json:mobile.json:$MOBILE_EXIT
 */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Tests in a Playwright JSON report, counted from the suite tree.
 *
 * Not from `stats`: in `--list` mode Playwright reports every discovered test
 * under `stats.skipped`, so a gate that read `stats` would be comparing "tests
 * that exist" against "tests that ran" using two different meanings of the same
 * field. Walking the tree counts the same thing in both reports. Verified on
 * real output: discovery and execution agree at 169 and at 184.
 */
export function countTests(report) {
  let tests = 0;
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) tests += (spec.tests ?? []).length;
  };
  for (const suite of report.suites ?? []) walk(suite);
  return tests;
}

/** Outcome counts from an execution report. */
export function outcomes(report) {
  const stats = report.stats ?? {};
  return {
    passed: stats.expected ?? 0,
    failed: stats.unexpected ?? 0,
    skipped: stats.skipped ?? 0,
    flaky: stats.flaky ?? 0,
  };
}

const parse = (raw) => {
  if (raw === undefined || raw === null) return undefined;
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One project's verdict. Every branch is a refusal to call an incomplete run a
 * pass; `ok` is only reachable when discovery and execution agree, both are
 * non-empty, nothing failed, and the runner agreed it was fine.
 */
export function evaluateProject({ project, discovery, execution, exit }) {
  const discovered = parse(discovery);
  if (!discovered) return { project, ok: false, reason: "discovery report unreadable" };
  const executed = parse(execution);
  if (!executed) return { project, ok: false, reason: `execution report unreadable (runner exit ${exit})` };

  const expected = countTests(discovered);
  const actual = countTests(executed);
  const counts = outcomes(executed);
  const base = { project, expected, actual, ...counts };

  if (expected === 0) return { ...base, ok: false, reason: "discovery found no tests" };
  if (actual === 0) return { ...base, ok: false, reason: "no tests executed" };
  // The check the inline version never made.
  if (actual !== expected) {
    return { ...base, ok: false, reason: `executed ${actual} of ${expected} discovered tests` };
  }
  // Defence in depth: the outcome counts must also add up to the tests present,
  // so a report that is internally inconsistent cannot pass on the tree count
  // alone.
  const summed = counts.passed + counts.failed + counts.skipped + counts.flaky;
  if (summed !== actual) {
    return { ...base, ok: false, reason: `outcome counts total ${summed} against ${actual} tests` };
  }
  if (counts.failed > 0) return { ...base, ok: false, reason: `${counts.failed} failed` };
  if (String(exit) !== "0") {
    return { ...base, ok: false, reason: `runner exited ${exit} with no reported failure` };
  }
  return { ...base, ok: true, reason: "ok" };
}

export function renderSummary(results) {
  return [
    "### Browser matrix",
    "",
    "| project | discovered | executed | passed | failed | skipped | flaky | |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.project} | ${r.expected ?? "—"} | ${r.actual ?? "—"} | ${r.passed ?? "—"} | ${r.failed ?? "—"} | ${r.skipped ?? "—"} | ${r.flaky ?? "—"} | ${r.reason} |`),
    "",
  ].join("\n");
}

function main() {
  const read = (path) => {
    try { return readFileSync(path, "utf8"); } catch { return undefined; }
  };
  const results = process.argv.slice(2).map((argument) => {
    const [project, listPath, runPath, exit] = argument.split(":");
    return evaluateProject({
      project,
      discovery: read(listPath),
      execution: read(runPath),
      exit: exit ?? "0",
    });
  });
  if (results.length === 0) {
    console.error("::error::No projects given to the cardinality gate.");
    process.exit(1);
  }
  const summary = renderSummary(results);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary); } catch { /* the log above is the record */ }
  }
  for (const result of results) {
    if (!result.ok) console.error(`::error::${result.project}: ${result.reason}`);
  }
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

/*
 * Resolved through `realpath` before comparing, because a plain
 * `file://${process.argv[1]}` check is false whenever the invoking path crosses
 * a symlink — `/tmp` is a link to `/private/tmp` on macOS, so running this from
 * a temp directory silently did nothing and exited 0. It found me while I was
 * using it to verify a CI result, which is the worst moment for a gate to be
 * quietly inert. CI's paths are not symlinked, so it ran correctly there; that
 * is luck, not design.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
