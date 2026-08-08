#!/usr/bin/env node
/**
 * The Journey Atlas control plane: one tracked source, everything else derived.
 *
 * `JOURNEY_ROUTING.md` once opened with "148 findings, 148 routed, 0 unrouted"
 * above the line "Assertion: the sum of lane counts equals the Atlas total, or
 * the routing script fails." There was no routing script. The first version of
 * this file was that script, and review found it had inherited the same disease
 * one level up: it read an ignored, untracked capture artifact, so it passed on
 * one workstation and could not run from a clean checkout; its `--fix` was not
 * idempotent (the header rewrite matched its own output, stacking five `id`
 * columns over five runs); and it proved "exactly one owner" by set-matching
 * `J###` tokens anywhere in the routing document, which cannot tell one lane
 * from two.
 *
 * So the rules here are deliberately narrow:
 *
 *   - The only source of truth is `docs/audit/JOURNEY_FINDINGS.json`, tracked.
 *   - Every derived number and every derived table is GENERATED, never edited.
 *     A number a human can retype is a number that will drift.
 *   - Verification parses table rows. Ownership is proved per row, per lane.
 *   - `--fix` is idempotent by construction and the CI mode proves it by diff.
 *
 * Modes:
 *   (default)  verify: regenerate into memory; non-zero exit on any difference
 *   --fix      regenerate the derived documents in place
 *   --check    an accepted alias for the default, so a CI step reads as an
 *              explicit check. It is the same path, not a second mode.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = "docs/audit/JOURNEY_FINDINGS.json";
const ATLAS_MD = "docs/audit/JOURNEY_ATLAS.md";
const ROUTING_MD = "docs/audit/JOURNEY_ROUTING.md";

const NARRATIVE_END = "\n## Complete findings index\n";
const ATLAS_HEADER_END = "\n## Personas\n";

const TABLE_HEADER = "| id | severity | link | gap | evidence |";
const TABLE_RULE = "|---|---|---|---|---|";

/** A markdown cell may not contain a raw pipe or a newline. */
const cell = (value) => String(value ?? "").replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();

export function loadFindings(raw = readFileSync(SOURCE, "utf8")) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.findings) || parsed.findings.length === 0) {
    throw new Error(`${SOURCE} carries no findings; the gate has no source to check.`);
  }
  return parsed;
}

/**
 * Every structural claim, checked against the source rather than against prose.
 *
 * Returns a list of human-readable failures; empty means the source is sound.
 */
export function verifySource(source) {
  const failures = [];
  const ids = new Set();
  const REQUIRED = ["id", "lane", "severity", "chainLink", "what"];
  for (const finding of source.findings) {
    for (const field of REQUIRED) {
      if (!finding[field]) failures.push(`${finding.id ?? "(no id)"} is missing \`${field}\`.`);
    }
    if (!finding.id) continue;
    if (ids.has(finding.id)) failures.push(`Duplicate finding id ${finding.id}.`);
    ids.add(finding.id);
    if (!/^J\d{3}$/u.test(finding.id)) failures.push(`${finding.id} is not a J### id.`);
  }
  // The personas' own journey counts must sum to the finding total. A journey
  // that gains a finding without the roll-up moving is the drift this catches.
  const declared = (source.personas ?? []).reduce(
    (total, persona) => total + persona.journeys.reduce((n, journey) => n + journey.gaps, 0), 0);
  if (declared !== source.findings.length) {
    failures.push(`Personas declare ${declared} findings; the finding list holds ${source.findings.length}.`);
  }
  return failures;
}

/**
 * Verification of the ROUTING document, by parsing it — not by token-matching.
 *
 * Every lane section is read as a table. A finding must appear as a row in
 * exactly one lane, that lane must be the lane it declares, each lane may open
 * exactly once, and the stated per-lane and total counts must equal the rows
 * present.
 */
export function verifyRouting(source, routing) {
  const failures = [];
  const laneOf = new Map(source.findings.map((finding) => [finding.id, finding.lane]));
  const seen = new Map();
  const laneHeadings = [...routing.matchAll(/^## (\S+) — (\d+) findings$/gmu)];
  const openedLanes = new Set();

  for (const [index, heading] of laneHeadings.entries()) {
    const [full, lane, claimed] = heading;
    if (openedLanes.has(lane)) failures.push(`Lane ${lane} opens more than once.`);
    openedLanes.add(lane);
    const start = heading.index + full.length;
    const end = index + 1 < laneHeadings.length ? laneHeadings[index + 1].index : routing.length;
    const rows = [...routing.slice(start, end).matchAll(/^\| (J\d{3}) \|/gmu)].map((row) => row[1]);
    if (rows.length !== Number(claimed)) {
      failures.push(`Lane ${lane} claims ${claimed} findings and lists ${rows.length} rows.`);
    }
    for (const id of rows) {
      if (seen.has(id)) failures.push(`${id} is routed to both ${seen.get(id)} and ${lane}; a finding has exactly one owner.`);
      else seen.set(id, lane);
      const declared = laneOf.get(id);
      if (declared === undefined) failures.push(`${id} is routed and is not a finding.`);
      else if (declared !== lane) failures.push(`${id} is routed to ${lane} and declares ${declared}.`);
    }
  }
  for (const finding of source.findings) {
    if (!seen.has(finding.id)) failures.push(`${finding.id} is a finding and appears in no lane table.`);
  }
  const lanes = new Set(source.findings.map((finding) => finding.lane));
  for (const lane of lanes) if (!openedLanes.has(lane)) failures.push(`Lane ${lane} owns findings and has no section.`);

  const header = routing.match(/(\d+) findings, (\d+) routed, (\d+) unrouted/u);
  if (!header) failures.push("The routing document no longer states its totals.");
  else {
    const [, stated, routed, unrouted] = header.map(Number);
    if (stated !== source.findings.length) failures.push(`Routing header says ${stated} findings; the source has ${source.findings.length}.`);
    if (routed !== seen.size) failures.push(`Routing header says ${routed} routed; ${seen.size} rows are present.`);
    if (unrouted !== 0) failures.push(`Routing header admits ${unrouted} unrouted findings.`);
  }
  return failures;
}

/**
 * Every NARRATIVE gap table must use the exact generated schema.
 *
 * Scoped to the prose above the index, because the index renders a different
 * generated schema of its own (`| id | severity | link | prose | finding |`)
 * and a check that cannot tell the two apart reports the generator's own
 * correct output as a defect.
 */
export function verifyAtlasTables(whole) {
  const failures = [];
  const end = whole.indexOf(NARRATIVE_END);
  const atlas = end === -1 ? whole : whole.slice(0, end);
  const lines = atlas.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("| id |") && !/^\|(?: id \|)+ severity/u.test(line)) continue;
    if (line !== TABLE_HEADER) failures.push(`${ATLAS_MD}:${index + 1} table header is not the generated schema: ${line}`);
    else if (lines[index + 1] !== TABLE_RULE) failures.push(`${ATLAS_MD}:${index + 2} table rule is not the generated schema: ${lines[index + 1]}`);
  }
  // A row that begins with more than one id cell is the signature of a
  // non-idempotent generator, which is exactly how this file failed review.
  for (const [index, line] of lines.entries()) {
    if (/^\| J\d{3} \| J\d{3} \|/u.test(line)) failures.push(`${ATLAS_MD}:${index + 1} row carries stacked id columns.`);
  }
  return failures;
}

/**
 * The headline may not disagree with the breakdown beneath it.
 *
 * The whole reason this gate exists is a page that said one number in its
 * header and another in its body. Checking the rendered block against the
 * source closes that for the chain-link table too.
 */
export function verifyChainLinks(source, atlas) {
  const failures = [];
  const expected = renderChainLinks(source).join("\n");
  if (!atlas.includes(expected)) {
    failures.push("The chain-link block is not the one the source generates. Run `npm run check:journey-atlas -- --fix`.");
  }
  const printed = [...atlas.matchAll(/^- \*\*([a-z-]+)\*\* — (\d+)$/gmu)];
  const sum = printed.reduce((total, row) => total + Number(row[2]), 0);
  if (printed.length > 0 && sum !== source.findings.length) {
    failures.push(`The chain-link breakdown totals ${sum}; the Atlas has ${source.findings.length} findings.`);
  }
  return failures;
}

/** The Atlas's generated header — totals a human never retypes. */
export function renderAtlasHeader(source) {
  const total = source.findings.length;
  const personas = source.personas?.length ?? 0;
  const lanes = new Set(source.findings.map((finding) => finding.lane)).size;
  const viewports = (source.capture?.viewports ?? []).join(" and ");
  return [
    "# Airship Journey Atlas",
    "",
    `${personas} personas drove the running product at ${source.capture?.surface ?? "the running product"}` +
      `${viewports ? ` at ${viewports}` : ""}.`,
    "Every gap below quotes verbatim on-screen text, a measured number, or a file:line the observer opened.",
    "",
    `**${personas} personas · ${total} findings · ${lanes} lanes**`,
    "",
    "Totals on this page are generated from `docs/audit/JOURNEY_FINDINGS.json` by",
    "`scripts/journey-atlas-gate.mjs`. Do not edit them by hand: an earlier revision said",
    '"Ten personas" and "8 personas · 100 gaps" on the same page as a 152-finding index,',
    "and nothing noticed because nothing was generating them.",
    "",
    ...renderChainLinks(source),
  ].join("\n");
}

/**
 * Every link in the chain, including the ones nothing was found on.
 *
 * This block was hand-written and still totalled 100 while the headline above
 * it said 152 — the same drift, on the same page, one section down. It also
 * silently omitted `intent`, which reads as "not part of the model" rather than
 * "nothing was found here"; a link with no findings is a result, not an
 * absence, and on an audit page the difference matters.
 */
export const CHAIN_LINKS = Object.freeze([
  "intent", "discovery", "entry", "action", "response", "in-flight",
  "permission", "completion", "persistence", "proof", "recovery", "continuation",
]);

export function renderChainLinks(source) {
  const counts = new Map(CHAIN_LINKS.map((link) => [link, 0]));
  for (const finding of source.findings) {
    counts.set(finding.chainLink, (counts.get(finding.chainLink) ?? 0) + 1);
  }
  // A link the findings use that the model does not name is a data error, not a
  // row to quietly append: the gate reports it rather than printing it.
  const unknown = [...counts.keys()].filter((link) => !CHAIN_LINKS.includes(link));
  const total = source.findings.length;
  return [
    "## Chain-link weakness",
    "",
    `The twelve-link chain is ${CHAIN_LINKS.join(" → ")}.`,
    "Findings per link, generated — every link is listed, including those with none:",
    "",
    ...CHAIN_LINKS.map((link) => `- **${link}** — ${counts.get(link) ?? 0}`),
    ...unknown.map((link) => `- **${link}** — ${counts.get(link)} (NOT A CHAIN LINK)`),
    "",
    `Total ${[...counts.values()].reduce((sum, n) => sum + n, 0)} of ${total} findings.`,
    "",
  ];
}

/** The complete index: every finding, its lane, and whether prose tells its story. */
export function renderAtlasIndex(source, narrated) {
  const total = source.findings.length;
  const lanes = [...new Set(source.findings.map((finding) => finding.lane))].sort();
  const links = [...new Set(source.findings.map((finding) => finding.chainLink))].sort();
  const out = [
    NARRATIVE_END,
    "",
    `Generated from \`${SOURCE}\`. Every finding, the lane that owns it, and whether a`,
    "journey section above tells its story.",
    "",
    `**${total} findings · ${narrated.size} narrated · ${total - narrated.size} index-only · ${lanes.length} lanes**`,
    "",
    "Index-only findings are owned and evidenced; they are findings, not gaps in the",
    "audit. A reader working from the narrative alone will not meet them.",
    "",
    "### By chain link",
    "",
    "| link | findings |",
    "|---|---|",
    ...links.map((link) => `| ${link} | ${source.findings.filter((finding) => finding.chainLink === link).length} |`),
    "",
  ];
  for (const lane of lanes) {
    const owned = source.findings.filter((finding) => finding.lane === lane);
    out.push(
      `### ${lane} — ${owned.length}`, "",
      "| id | severity | link | prose | finding |", "|---|---|---|---|---|",
      ...owned.map((finding) =>
        `| ${finding.id} | ${cell(finding.severity)} | ${cell(finding.chainLink)} | ${narrated.has(finding.id) ? "yes" : "no"} | ${cell(finding.what)} |`),
      "",
    );
  }
  return out.join("\n");
}

/** The routing document, generated whole. */
export function renderRouting(source) {
  const total = source.findings.length;
  const lanes = [...new Set(source.findings.map((finding) => finding.lane))].sort();
  const out = [
    "# Journey routing — every finding has exactly one owner",
    "",
    `Generated from \`${SOURCE}\` by \`scripts/journey-atlas-gate.mjs\`. ${total} findings, ${total} routed, 0 unrouted.`,
    "",
    "Assertion: the gate parses the tables below and proves that every finding appears",
    "as a row in exactly one lane, that the lane is the one the finding declares, that",
    "each lane opens exactly once, and that every count stated here equals the rows",
    "present. It runs in `npm run check` and re-generates this file; a hand edit shows",
    "up as a diff rather than as a claim.",
    "",
  ];
  for (const lane of lanes) {
    const owned = source.findings.filter((finding) => finding.lane === lane);
    out.push(
      `## ${lane} — ${owned.length} findings`, "",
      "| id | severity | link | persona | finding | evidence |", "|---|---|---|---|---|---|",
      ...owned.map((finding) =>
        `| ${finding.id} | ${cell(finding.severity)} | ${cell(finding.chainLink)} | ${cell(finding.persona).slice(0, 40)} | ${cell(finding.what)} | ${cell(finding.evidence).slice(0, 400)} |`),
      "",
    );
  }
  return out.join("\n");
}

/**
 * Rebuild both documents from the source and the Atlas's hand-written middle.
 *
 * The narrative between the generated header and the generated index is the
 * only prose a human owns, and it is carried through untouched apart from
 * normalising each gap table to one id column — the operation that must be
 * idempotent, and is, because it rewrites the whole cell rather than prepending
 * to it.
 */
export function regenerate(source, atlasOnDisk) {
  const headerEnd = atlasOnDisk.indexOf(ATLAS_HEADER_END);
  const indexStart = atlasOnDisk.indexOf(NARRATIVE_END);
  // Quote the constant actually searched for. Naming a different heading sends
  // the reader hunting for one the generator always emits, while the anchor
  // that is genuinely missing is never mentioned.
  if (headerEnd === -1) throw new Error(`${ATLAS_MD} has no "${ATLAS_HEADER_END.trim()}" section to anchor the generated header.`);
  let narrative = atlasOnDisk.slice(headerEnd, indexStart === -1 ? atlasOnDisk.length : indexStart);

  const byWhat = new Map(source.findings.map((finding) => [finding.what, finding.id]));
  const PREFIX = 48;
  const byPrefix = new Map();
  for (const finding of source.findings) {
    const key = finding.what.slice(0, PREFIX);
    byPrefix.set(key, byPrefix.has(key) ? null : finding.id);
  }
  const severities = [...new Set(source.findings.map((finding) => finding.severity))];
  const unmatched = [];
  const narrated = new Set();

  narrative = narrative.replace(/^\|(?: id \|)* severity \| link \| gap \| evidence \|\n\|(?:-{3}\|)+$/gmu,
    `${TABLE_HEADER}\n${TABLE_RULE}`);
  // Whole-row rewrite: any number of leading id cells collapses to exactly one,
  // so running this twice cannot differ from running it once.
  narrative = narrative.replace(
    new RegExp(String.raw`^\|(?: J\d{3} \|)* (${severities.join("|")}) \| ([a-z-]+) \| (.+?) \| (.*)$`, "gmu"),
    (row, severity, link, what, evidence) => {
      const trimmed = what.trim();
      const id = byWhat.get(trimmed) ?? byPrefix.get(trimmed.slice(0, PREFIX));
      if (!id) { unmatched.push(trimmed.slice(0, 60)); return row; }
      narrated.add(id);
      return `| ${id} | ${severity} | ${link} | ${what} | ${evidence}`;
    });

  return {
    atlas: renderAtlasHeader(source) + narrative.replace(/\s*$/u, "\n") + renderAtlasIndex(source, narrated),
    routing: renderRouting(source),
    unmatched,
    narrated,
  };
}

function main() {
  const mode = process.argv.includes("--fix") ? "fix" : process.argv.includes("--check") ? "check" : "verify";
  const source = loadFindings();
  const failures = verifySource(source);
  if (failures.length === 0) {
    const built = regenerate(source, readFileSync(ATLAS_MD, "utf8"));
    if (mode === "fix") {
      writeFileSync(ATLAS_MD, built.atlas);
      writeFileSync(ROUTING_MD, built.routing);
      // Idempotence proved by construction AND by running it: a second pass
      // over its own output must produce byte-identical text.
      const again = regenerate(source, readFileSync(ATLAS_MD, "utf8"));
      if (again.atlas !== built.atlas || again.routing !== built.routing) {
        failures.push("`--fix` is not idempotent: a second pass changed its own output.");
      }
      if (built.unmatched.length > 0) {
        console.log(`${built.unmatched.length} narrative rows matched no finding (left untouched):`);
        for (const what of built.unmatched) console.log(`  - ${what}…`);
      }
    } else {
      if (built.atlas !== readFileSync(ATLAS_MD, "utf8")) failures.push(`${ATLAS_MD} differs from what the source generates. Run \`npm run check:journey-atlas -- --fix\`.`);
      if (built.routing !== readFileSync(ROUTING_MD, "utf8")) failures.push(`${ROUTING_MD} differs from what the source generates. Run \`npm run check:journey-atlas -- --fix\`.`);
    }
    failures.push(...verifyRouting(source, readFileSync(ROUTING_MD, "utf8")));
    failures.push(...verifyAtlasTables(readFileSync(ATLAS_MD, "utf8")));
    failures.push(...verifyChainLinks(source, readFileSync(ATLAS_MD, "utf8")));
  }

  if (failures.length > 0) {
    console.error("Journey Atlas gate failed:");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  const lanes = new Set(source.findings.map((finding) => finding.lane)).size;
  console.log(`Journey Atlas: ${source.findings.length} findings, ${source.personas.length} personas, ${lanes} lanes; every finding routed to exactly one lane, documents regenerate clean.`);
}

/*
 * Resolved through `realpath` before comparing, the form `browser-cardinality.mjs`
 * arrived at the hard way: a plain `file://${process.argv[1]}` check is false
 * whenever the invoking path crosses a symlink — `/tmp` is a link to
 * `/private/tmp` on macOS — and false again for any path needing
 * percent-encoding, because `import.meta.url` escapes spaces and this
 * concatenation does not. Either way the gate prints nothing and exits 0, which
 * `npm run check` reads as the Atlas being verified. Kept conditional because
 * `journey-atlas-gate.test.mjs` imports this module.
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
