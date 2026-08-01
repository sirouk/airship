#!/usr/bin/env node
/**
 * The Atlas totals, asserted rather than stated.
 *
 * `JOURNEY_ROUTING.md` opened with "148 findings, 148 routed, 0 unrouted" and
 * the line "Assertion: the sum of lane counts equals the Atlas total, or the
 * routing script fails." There was no routing script. The number was true when
 * it was typed and nothing kept it true, which is the same shape of defect this
 * audit spent its time finding in the product: a claim with no mechanism under
 * it.
 *
 * This is that mechanism. It checks four things a reader would otherwise have
 * to take on trust:
 *
 *   1. The per-journey gap lists sum to the Atlas total. If a journey gains a
 *      finding and the header is not updated, the two disagree and this fails.
 *   2. Every finding has a unique id and a lane. An unlaned finding is an
 *      unowned one, and unowned findings are how 88 of 148 went unassigned
 *      before the routing pass existed.
 *   3. Every id reaches `JOURNEY_ROUTING.md`, and the routing doc introduces no
 *      id the Atlas does not have. Routing is a permutation, not a filter.
 *   4. The counts the routing header states are the counts the file contains —
 *      both the total and each lane's own "— N findings".
 *
 * Run with `--fix` to back-fill the id column into the Atlas gap tables so a
 * row on screen can be traced to the lane that owns it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const ATLAS_JSON = ".ui-capture/atlas.json";
const ATLAS_MD = "docs/audit/JOURNEY_ATLAS.md";
const ROUTING_MD = "docs/audit/JOURNEY_ROUTING.md";

const failures = [];
const fail = (message) => failures.push(message);

const atlas = JSON.parse(readFileSync(ATLAS_JSON, "utf8"));
const routing = readFileSync(ROUTING_MD, "utf8");

// 1. The arithmetic.
const perJourney = atlas.records.flatMap((record) => record.journeys.flatMap((journey) => journey.gaps ?? []));
if (perJourney.length !== atlas.gaps.length) {
  fail(`Atlas total disagrees with its own journeys: ${atlas.gaps.length} at the top, ${perJourney.length} across ${atlas.records.length} personas.`);
}

// 2. Identity and ownership.
const ids = new Set();
for (const gap of atlas.gaps) {
  if (!gap.id) fail(`A finding has no id: ${String(gap.what).slice(0, 80)}…`);
  else if (ids.has(gap.id)) fail(`Duplicate finding id ${gap.id}.`);
  else ids.add(gap.id);
  if (!gap.lane) fail(`${gap.id ?? "(no id)"} has no lane, so nobody owns it.`);
}

// 3. Routing is a permutation of the Atlas, in both directions.
const routedIds = new Set(routing.match(/\bJ\d{3}\b/gu) ?? []);
for (const id of ids) if (!routedIds.has(id)) fail(`${id} is in the Atlas and not in the routing table.`);
for (const id of routedIds) if (!ids.has(id)) fail(`${id} is routed and is not an Atlas finding.`);

// 4. The routing document's stated counts are the counts it contains.
const header = routing.match(/(\d+) findings, (\d+) routed, (\d+) unrouted/u);
if (!header) fail("The routing document no longer states its totals.");
else {
  const [, stated, routed, unrouted] = header.map(Number);
  if (stated !== atlas.gaps.length) fail(`Routing header says ${stated} findings; the Atlas has ${atlas.gaps.length}.`);
  if (routed !== routedIds.size) fail(`Routing header says ${routed} routed; ${routedIds.size} ids appear in the table.`);
  if (unrouted !== 0) fail(`Routing header admits ${unrouted} unrouted findings.`);
}
for (const [, lane, claimed] of routing.matchAll(/^## (\S+) — (\d+) findings$/gmu)) {
  const section = routing.split(`## ${lane} — `)[1]?.split("\n## ")[0] ?? "";
  const actual = new Set(section.match(/\bJ\d{3}\b/gu) ?? []).size;
  if (actual !== Number(claimed)) fail(`Lane ${lane} claims ${claimed} findings and lists ${actual}.`);
}

// The Atlas markdown must let a reader trace a row to its owner.
const atlasMd = readFileSync(ATLAS_MD, "utf8");
const wantsFix = process.argv.includes("--fix");
if (wantsFix) {
  let next = atlasMd
    .replaceAll("| severity | link | gap | evidence |\n|---|---|---|---|", "| id | severity | link | gap | evidence |\n|---|---|---|---|---|");
  // Matched on the finding text rather than on row order: a row that moves
  // keeps its id, and a row whose text was edited is reported rather than
  // silently given the neighbouring row's identity.
  const severities = [...new Set(atlas.gaps.map((gap) => gap.severity))];
  const byWhat = new Map(atlas.gaps.map((gap) => [String(gap.what).trim(), gap.id]));
  // A markdown row can be a truncated rendering of the finding it came from, so
  // an exact miss falls back to a leading-text match. 48 characters is long
  // enough that no two of these 148 findings share one, and the check below
  // still reports anything that matches neither.
  const PREFIX = 48;
  const byPrefix = new Map();
  for (const gap of atlas.gaps) {
    const key = String(gap.what).trim().slice(0, PREFIX);
    byPrefix.set(key, byPrefix.has(key) ? null : gap.id);
  }
  const unmatched = [];
  const rowPattern = new RegExp(String.raw`^\| (${severities.join("|")}) \| ([a-z-]+) \| (.+?) \| (.*)$`, "gmu");
  next = next.replaceAll(rowPattern, (row, severity, link, what, evidence) => {
    const trimmed = what.trim();
    const id = byWhat.get(trimmed) ?? byPrefix.get(trimmed.slice(0, PREFIX)) ?? undefined;
    if (!id) { unmatched.push(trimmed.slice(0, 60)); return row; }
    return `| ${id} | ${severity} | ${link} | ${what} | ${evidence}`;
  });
  /*
   * The index exists because the narrative was never complete.
   *
   * The per-persona tables above are a curated read — they carry the findings
   * whichever pass wrote that section chose to show, which turned out to be 100
   * of 152. The other 52 were real, routed and owned, and a reader working from
   * this document alone would never have met them. Rather than pad the
   * narrative with rows nobody wrote a story around, the full set is generated
   * here from the same data the routing table is generated from, so the two can
   * never disagree and nothing can be quietly dropped from either.
   */
  const MARKER = "\n## Complete findings index\n";
  const trimmed = next.includes(MARKER) ? next.slice(0, next.indexOf(MARKER)) : next.replace(/\s*$/u, "\n");
  const shown = new Set(trimmed.match(/\bJ\d{3}\b/gu) ?? []);
  const lanes = [...new Set(atlas.gaps.map((gap) => gap.lane))].sort();
  const index = [
    MARKER,
    `\nGenerated by \`scripts/journey-atlas-gate.mjs\` from \`${ATLAS_JSON}\`. Every finding, its `,
    "owning lane, and whether a journey section above tells its story. Rows marked ",
    "`prose: no` are owned and evidenced but not narrated — they are findings, not gaps ",
    "in the audit.\n",
    `\n${atlas.gaps.length} findings across ${lanes.length} lanes.\n`,
  ];
  for (const lane of lanes) {
    const owned = atlas.gaps.filter((gap) => gap.lane === lane);
    index.push(`\n### ${lane} — ${owned.length}\n`, "\n| id | severity | link | prose | finding |\n|---|---|---|---|---|\n");
    for (const gap of owned) {
      index.push(`| ${gap.id} | ${gap.severity} | ${gap.chain_link ?? "—"} | ${shown.has(gap.id) ? "yes" : "no"} | ${String(gap.what).replace(/\|/gu, "\\|")} |\n`);
    }
  }
  writeFileSync(ATLAS_MD, trimmed + index.join(""));
  if (unmatched.length > 0) {
    console.log(`${unmatched.length} Atlas rows could not be matched to a finding id:`);
    for (const what of unmatched) console.log(`  - ${what}…`);
  }
}

const atlasIdCount = new Set(readFileSync(ATLAS_MD, "utf8").match(/\bJ\d{3}\b/gu) ?? []).size;
if (atlasIdCount !== atlas.gaps.length) {
  fail(`The Atlas prints ${atlasIdCount} of ${atlas.gaps.length} finding ids, so ${atlas.gaps.length - atlasIdCount} rows cannot be traced to the lane that owns them. Run with --fix.`);
}

if (failures.length > 0) {
  console.error("Journey Atlas gate failed:");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`Journey Atlas: ${atlas.gaps.length} findings, ${atlas.records.length} personas, ${new Set(atlas.gaps.map((gap) => gap.lane)).size} lanes, all routed and all traceable.`);
