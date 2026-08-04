import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { checkStaticSecurity, parseCaddyResponseHeaders, parseNetlifyHeaders } from "./check-static-security.mjs";

/*
 * A gate that has never been shown a failing input is a claim, not a check.
 *
 * The defect this file exists to prove caught is the one the Caddyfile's own
 * comment used to concede: a policy edit applied to `index.html` and
 * `public/_headers` while the file Caddy actually reads keeps the old text. The
 * repository's real three sources are read here too, so the shipped tree is
 * held to the same rule rather than only a synthetic one.
 */

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const sources = {
  index: await read("index.html"),
  headers: await read("public/_headers"),
  caddyfile: await read("Caddyfile"),
};

describe("the three policy sources", () => {
  it("agree in the shipped tree", () => {
    expect(checkStaticSecurity(sources)).toEqual([]);
  });

  it("names a connect-src grant the Caddyfile kept after the reviewed policy dropped it", () => {
    // The real shape of the miss: an origin removed from `_headers` and
    // `index.html` but left granted in the file the deployment reads.
    const caddyfile = sources.caddyfile.replace(
      "connect-src 'self' https://api.chutes.ai",
      "connect-src 'self' https://stale.chutes.ai https://api.chutes.ai",
    );
    const failures = checkStaticSecurity({ ...sources, caddyfile });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("The Caddyfile's CSP is not the reviewed policy");
    expect(failures[0]).toContain("stale.chutes.ai");
  });

  it("refuses a Caddyfile that stops supplying cross-origin isolation", () => {
    const caddyfile = sources.caddyfile.replace(/^\s*Cross-Origin-Embedder-Policy .*$/mu, "");
    const failures = checkStaticSecurity({ ...sources, caddyfile });
    expect(failures).toEqual(["The Caddyfile never sends Cross-Origin-Embedder-Policy; a deploy would serve the site without it."]);
  });

  it("refuses a Caddyfile that weakens a reviewed value rather than dropping it", () => {
    const caddyfile = sources.caddyfile.replace('X-Frame-Options "DENY"', 'X-Frame-Options "SAMEORIGIN"');
    expect(checkStaticSecurity({ ...sources, caddyfile })).toEqual([
      'The Caddyfile sends X-Frame-Options: "SAMEORIGIN", but the reviewed value is "DENY".',
    ]);
  });

  it("refuses a header only the Caddyfile sends, because no other host would send it", () => {
    const caddyfile = sources.caddyfile.replace('X-Frame-Options "DENY"', 'X-Frame-Options "DENY"\n\t\tX-Airship-Unreviewed "1"');
    expect(checkStaticSecurity({ ...sources, caddyfile })).toEqual([
      "The Caddyfile sends X-Airship-Unreviewed, which the reviewed public/_headers policy does not declare.",
    ]);
  });

  it("still reports a meta CSP that drifts from the reviewed header", () => {
    const index = sources.index.replace("object-src 'none'; ", "");
    const failures = checkStaticSecurity({ ...sources, index });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("index.html and public/_headers diverge");
    expect(failures[0]).toContain("object-src");
  });

  it("does not read header-only frame-ancestors as a divergence", () => {
    // The exception that made this normalization necessary: a `<meta>` CSP is
    // defined to ignore `frame-ancestors`, so its absence there is correct.
    expect(sources.index).not.toContain("frame-ancestors");
    expect(checkStaticSecurity(sources)).toEqual([]);
  });
});

describe("the parsers", () => {
  it("keeps a CSP whole despite the colons in its origins", () => {
    const sections = parseNetlifyHeaders(sources.headers);
    expect(sections.get("/*").get("content-security-policy").value).toContain("https://api.chutes.ai");
  });

  it("reads only the unconditional header block, not the matcher-scoped ones", () => {
    const served = parseCaddyResponseHeaders(sources.caddyfile);
    expect(served.has("content-security-policy")).toBe(true);
    // `header @immutable Cache-Control …` lives outside the block; picking it up
    // would invent a site-wide caching rule the reviewed policy never states.
    expect(served.has("cache-control")).toBe(false);
    // A removal directive sets nothing and has no `_headers` counterpart.
    expect(served.has("server")).toBe(false);
  });

  it("refuses a Caddyfile with no unconditional header block at all", () => {
    expect(() => parseCaddyResponseHeaders("example.com {\n\troot * /srv\n}\n")).toThrow(/no unconditional/u);
  });
});
