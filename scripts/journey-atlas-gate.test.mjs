import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAIN_LINKS,
  loadFindings,
  regenerate,
  renderRouting,
  renderChainLinks,
  verifyAtlasTables,
  verifyChainLinks,
  verifyRouting,
  verifySource,
} from "./journey-atlas-gate.mjs";

/**
 * The gate's own tests, because the first version of it passed states it was
 * written to reject.
 *
 * It read an untracked artifact, so it could not run from a clean checkout. Its
 * `--fix` was not idempotent — the header rewrite matched its own output and
 * stacked five `id` columns over five runs — and the "idempotence check" that
 * missed it compared exit codes rather than bytes. And it proved "exactly one
 * owner" by set-matching `J###` tokens anywhere in the routing document, which
 * cannot distinguish a finding in one lane from the same finding in two.
 *
 * Every one of those is a case below. A control plane that is not itself tested
 * is a claim, and this whole pass exists because of a claim with nothing under
 * it.
 */

const SOURCE = "docs/audit/JOURNEY_FINDINGS.json";

const finding = (overrides = {}) => ({
  id: "J001", lane: "L1-chat-composer", severity: "friction", chainLink: "entry",
  persona: "novice", journey: "first run", what: "A thing that is wrong", evidence: "measured",
  ...overrides,
});

const sourceOf = (findings) => ({
  capture: { surface: "test", viewports: ["1440x900"] },
  personas: [{ persona: "novice", headline: "h", journeys: [{ name: "j", gaps: findings.length }] }],
  findings,
});

describe("the journey atlas gate", () => {
  it("reads a tracked source, so a clean checkout can run it", () => {
    // The defect that made the first version unusable in CI: the source was
    // `.ui-capture/atlas.json`, and `.ui-capture/` is gitignored.
    const source = loadFindings(readFileSync(SOURCE, "utf8"));
    expect(source.findings.length).toBeGreaterThan(0);
    expect(readFileSync(".gitignore", "utf8")).not.toContain("docs/audit/JOURNEY_FINDINGS.json");
  });

  it("rejects a source with no findings rather than reporting success over nothing", () => {
    expect(() => loadFindings(JSON.stringify({ findings: [] }))).toThrow(/no findings/u);
  });

  it("catches a duplicate finding id", () => {
    const failures = verifySource(sourceOf([finding(), finding()]));
    expect(failures.join("\n")).toMatch(/Duplicate finding id J001/u);
  });

  it("catches a finding with no lane, because an unlaned finding is unowned", () => {
    const failures = verifySource(sourceOf([finding({ lane: undefined })]));
    expect(failures.join("\n")).toMatch(/missing `lane`/u);
  });

  it("catches persona totals that have drifted from the finding list", () => {
    const source = sourceOf([finding(), finding({ id: "J002" })]);
    source.personas[0].journeys[0].gaps = 7;
    expect(verifySource(source).join("\n")).toMatch(/Personas declare 7 findings; the finding list holds 2/u);
  });

  it("catches a finding routed into two lanes", () => {
    // The exact case token set-matching cannot see: the id appears in the
    // document, so a `Set` of tokens is satisfied while ownership is not.
    const source = sourceOf([finding()]);
    const routing = [
      "1 findings, 1 routed, 0 unrouted",
      "## L1-chat-composer — 1 findings", "| J001 | friction | entry | novice | x | y |",
      "## L2-continuation — 1 findings", "| J001 | friction | entry | novice | x | y |",
    ].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/J001 is routed to both/u);
  });

  it("catches a finding routed into a lane it does not declare", () => {
    const source = sourceOf([finding()]);
    const routing = ["1 findings, 1 routed, 0 unrouted", "## L2-continuation — 1 findings",
      "| J001 | friction | entry | novice | x | y |"].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/routed to L2-continuation and declares L1-chat-composer/u);
  });

  it("catches a lane opened twice", () => {
    const source = sourceOf([finding()]);
    const routing = ["1 findings, 1 routed, 0 unrouted",
      "## L1-chat-composer — 1 findings", "| J001 | friction | entry | novice | x | y |",
      "## L1-chat-composer — 0 findings"].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/opens more than once/u);
  });

  it("catches a lane whose stated count disagrees with its rows", () => {
    const source = sourceOf([finding()]);
    const routing = ["1 findings, 1 routed, 0 unrouted", "## L1-chat-composer — 4 findings",
      "| J001 | friction | entry | novice | x | y |"].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/claims 4 findings and lists 1 rows/u);
  });

  it("catches a finding that reaches no lane table at all", () => {
    // Four findings sat in the Atlas prose owned by nothing. This is that case.
    const source = sourceOf([finding(), finding({ id: "J002" })]);
    const routing = ["2 findings, 2 routed, 0 unrouted", "## L1-chat-composer — 1 findings",
      "| J001 | friction | entry | novice | x | y |"].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/J002 is a finding and appears in no lane table/u);
  });

  it("catches a stale total in the routing header", () => {
    const source = sourceOf([finding()]);
    const routing = ["148 findings, 148 routed, 0 unrouted", "## L1-chat-composer — 1 findings",
      "| J001 | friction | entry | novice | x | y |"].join("\n\n");
    expect(verifyRouting(source, routing).join("\n")).toMatch(/header says 148 findings; the source has 1/u);
  });

  it("catches a malformed narrative table header", () => {
    expect(verifyAtlasTables("| id | severity | link |\n|---|---|---|").join("\n"))
      .toMatch(/table header is not the generated schema/u);
  });

  it("catches the stacked id columns a non-idempotent generator leaves behind", () => {
    // The literal shape the shipped Atlas was found in: `| id | id | id | id | id |`.
    expect(verifyAtlasTables("| id | id | severity | link | gap | evidence |").join("\n"))
      .toMatch(/table header is not the generated schema/u);
    expect(verifyAtlasTables("| J001 | J001 | friction | entry | x | y |").join("\n"))
      .toMatch(/stacked id columns/u);
  });

  it("does not report the index's own schema as malformed", () => {
    const atlas = "| id | severity | link | gap | evidence |\n|---|---|---|---|---|\n"
      + "\n## Complete findings index\n\n| id | severity | link | prose | finding |\n|---|---|---|---|---|\n";
    expect(verifyAtlasTables(atlas)).toEqual([]);
  });

  it("regenerates identically on a second pass over its own output", () => {
    // Proved by bytes, not by exit code — comparing exit codes is what let the
    // five stacked id columns ship.
    const source = loadFindings(readFileSync(SOURCE, "utf8"));
    const disk = readFileSync("docs/audit/JOURNEY_ATLAS.md", "utf8");
    const once = regenerate(source, disk);
    const twice = regenerate(source, once.atlas);
    expect(twice.atlas).toBe(once.atlas);
    expect(twice.routing).toBe(once.routing);
  });

  it("collapses any number of stacked id columns back to exactly one", () => {
    const source = sourceOf([finding()]);
    // `## Personas` is where the generated header ends and the hand-written
    // narrative begins; the chain-link block above it is generated now too.
    const damaged = "\n## Personas\n\n| id | id | id | severity | link | gap | evidence |\n"
      + "|---|---|---|---|---|---|---|\n| J001 | J001 | J001 | friction | entry | A thing that is wrong | measured |\n";
    const built = regenerate(source, damaged);
    expect(built.atlas).toContain("| id | severity | link | gap | evidence |");
    expect(built.atlas).not.toMatch(/\| id \| id \|/u);
    expect(built.atlas).toMatch(/\| J001 \| friction \| entry \| A thing that is wrong \| measured \|/u);
  });

  it("generates a routing document that its own verifier accepts", () => {
    const source = loadFindings(readFileSync(SOURCE, "utf8"));
    expect(verifyRouting(source, renderRouting(source))).toEqual([]);
  });

  it("prints every chain link, including the ones with no findings", () => {
    /*
     * The hand-written block omitted `intent` entirely, which reads as "not part
     * of the model" rather than "nothing was found here". On an audit page a
     * link with no findings is a result, not an absence.
     */
    const block = renderChainLinks(sourceOf([finding({ chainLink: "proof" })])).join("\n");
    for (const link of CHAIN_LINKS) expect(block).toContain(`**${link}**`);
    expect(block).toContain("**intent** — 0");
    expect(block).toContain("**proof** — 1");
  });

  it("catches a chain-link breakdown that does not total the findings", () => {
    // The exact defect: a headline of 152 above a hand-written breakdown of 100.
    const source = sourceOf([finding(), finding({ id: "J002" })]);
    const stale = "# Atlas\n\n- **proof** — 17\n- **discovery** — 15\n";
    expect(verifyChainLinks(source, stale).join("\n")).toMatch(/totals 32; the Atlas has 2 findings/u);
  });

  it("catches a chain-link block that is not the one the source generates", () => {
    const source = sourceOf([finding()]);
    expect(verifyChainLinks(source, "# Atlas\n\nno block here\n").join("\n"))
      .toMatch(/not the one the source generates/u);
  });

  it("accepts the block it generates", () => {
    const source = sourceOf([finding()]);
    expect(verifyChainLinks(source, renderChainLinks(source).join("\n"))).toEqual([]);
  });

  it("holds the shipped documents to all of the above", () => {
    const source = loadFindings(readFileSync(SOURCE, "utf8"));
    expect(verifySource(source)).toEqual([]);
    expect(verifyRouting(source, readFileSync("docs/audit/JOURNEY_ROUTING.md", "utf8"))).toEqual([]);
    expect(verifyAtlasTables(readFileSync("docs/audit/JOURNEY_ATLAS.md", "utf8"))).toEqual([]);
    expect(verifyChainLinks(source, readFileSync("docs/audit/JOURNEY_ATLAS.md", "utf8"))).toEqual([]);
  });
});
