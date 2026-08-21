import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  checkStaticSecurity,
  parseCaddyResponseHeaders,
  parseCaddyScopedHeader,
  netlifyHeaderSectionPaths,
  parseNetlifyHeaderUnsets,
  parseNetlifyHeaders,
  parsePolicy,
  PRIME_KERNEL_WORKER_HEADERS_PATH,
} from "./check-static-security.mjs";

/*
 * A gate that has never been shown a failing input is a claim, not a check.
 *
 * The defect this file exists to prove caught is the one the Caddyfile's own
 * comment used to concede: a policy edit applied to `index.html` and
 * `public/_headers` while the file Caddy actually reads keeps the old text. The
 * repository's real page, static-host, Caddy, and Vite sources are read here,
 * so the shipped tree is held to the same rule rather than only a synthetic one.
 */

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const sources = {
  index: await read("index.html"),
  headers: await read("public/_headers"),
  caddyfile: await read("Caddyfile"),
  viteConfig: await read("vite.config.ts"),
  kernelHost: await read("src/prime/kernel/kernel-host.ts"),
  serviceWorker: await read("public/sw.js"),
};

describe("the synchronized policy sources", () => {
  it("agree in the shipped tree", () => {
    expect(checkStaticSecurity(sources)).toEqual([]);
  });

  it("names a connect-src grant the Caddyfile kept after the reviewed policy dropped it", () => {
    // The real shape of the miss: an origin removed from `_headers` and
    // `index.html` but left granted in the file the deployment reads.
    const caddyfile = sources.caddyfile.replace(
      "connect-src 'self' https:",
      "connect-src 'self' https: https://stale.example",
    );
    const failures = checkStaticSecurity({ ...sources, caddyfile });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("The Caddyfile's CSP is not the reviewed policy");
    expect(failures[0]).toContain("stale.example");
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

  it("keeps the exact Trusted Types policy-name allowlist", () => {
    const widened = replaceInAllPolicies(
      sources,
      "trusted-types default airship-static",
      "trusted-types default attacker-policy airship-static",
    );
    expect(checkStaticSecurity(widened)).toContain(
      "The page trusted-types directive must be the exact reviewed policy-name allowlist.",
    );
  });

  it("requires dynamic provider egress to stay HTTPS-only and wildcard-free", () => {
    const withoutHttps = replaceInAllPolicies(sources, "connect-src 'self' https:", "connect-src 'self'");
    expect(checkStaticSecurity(withoutHttps)).toContain(
      "connect-src must contain exactly one HTTPS scheme grant for user-configured providers.",
    );

    const wildcard = replaceInAllPolicies(sources, "connect-src 'self' https:", "connect-src 'self' https: https://*");
    expect(checkStaticSecurity(wildcard)).toContain("connect-src must never contain a wildcard source.");

    const plaintext = replaceInAllPolicies(sources, "connect-src 'self' https:", "connect-src 'self' https: http:");
    expect(checkStaticSecurity(plaintext)).toContain("connect-src must not grant the broad http: scheme.");

    const unsupported = replaceInAllPolicies(sources, "connect-src 'self' https:", "connect-src 'self' https: data:");
    expect(checkStaticSecurity(unsupported)).toContain("connect-src contains an unsupported source: data:.");

    const remoteHttp = replaceInAllPolicies(sources, "connect-src 'self' https:", "connect-src 'self' https: http://provider.example");
    expect(checkStaticSecurity(remoteHttp)).toContain(
      "connect-src HTTP sources must be exact credential-free loopback origins: http://provider.example.",
    );
  });

  it("rejects an unsafe first duplicate directive in every synchronized CSP", () => {
    const duplicated = replaceInAllPolicies(
      sources,
      "connect-src 'self' https:",
      "connect-src *; connect-src 'self' https:",
    );

    expect(checkStaticSecurity(duplicated)).toEqual([
      "index.html's CSP contains a duplicate CSP directive: connect-src. Browsers honor the first occurrence.",
      "public/_headers' CSP contains a duplicate CSP directive: connect-src. Browsers honor the first occurrence.",
      "The Caddyfile's CSP contains a duplicate CSP directive: connect-src. Browsers honor the first occurrence.",
    ]);
  });

  it("keeps unsafe-eval on the dedicated worker response only", () => {
    const sections = parseNetlifyHeaders(sources.headers);
    const pagePolicy = sections.get("/*").get("content-security-policy").value;
    const workerPolicy = sections.get(PRIME_KERNEL_WORKER_HEADERS_PATH).get("content-security-policy").value;
    expect(pagePolicy).not.toContain("'unsafe-eval'");
    expect(workerPolicy).toBe("default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'");
    expect(parseCaddyScopedHeader(
      sources.caddyfile,
      "primeKernelWorker",
      "Content-Security-Policy",
    )).toBe(workerPolicy);
  });

  it("refuses a Cloudflare rule that would combine the no-eval page CSP with the worker CSP", () => {
    const headers = sources.headers.replace("  ! Content-Security-Policy\n", "");
    expect(checkStaticSecurity({ ...sources, headers })).toContain(
      "The Prime kernel worker rule must remove the inherited page CSP before setting its own policy.",
    );
  });

  it("rejects duplicate, intersecting, out-of-order, and non-inverse worker policy rules", () => {
    const duplicatedHeaders = `${sources.headers}
${PRIME_KERNEL_WORKER_HEADERS_PATH}
  Content-Security-Policy: default-src 'none'
`;
    expect(checkStaticSecurity({ ...sources, headers: duplicatedHeaders })).toContain(
      `public/_headers must declare ${PRIME_KERNEL_WORKER_HEADERS_PATH} exactly once; found 2.`,
    );

    const intersectingHeaders = `${sources.headers}
/assets/*
  Content-Security-Policy: default-src 'none'
`;
    expect(checkStaticSecurity({ ...sources, headers: intersectingHeaders })).toContain(
      "public/_headers has an intersecting Content-Security-Policy rule at /assets/*.",
    );

    const workerStart = sources.headers.indexOf(`${PRIME_KERNEL_WORKER_HEADERS_PATH}\n`);
    const workerEnd = sources.headers.indexOf("\n\n", workerStart);
    expect(workerStart).toBeGreaterThan(0);
    expect(workerEnd).toBeGreaterThan(workerStart);
    const workerBlock = sources.headers.slice(workerStart, workerEnd);
    const withoutWorker = `${sources.headers.slice(0, workerStart)}${sources.headers.slice(workerEnd + 2)}`;
    const outOfOrderHeaders = `${workerBlock}\n\n${withoutWorker}`;
    expect(checkStaticSecurity({ ...sources, headers: outOfOrderHeaders })).toContain(
      "The Netlify worker policy must be later than the pervasive page policy so it overrides rather than intersects it.",
    );

    const caddyfile = sources.caddyfile.replace(
      "@notPrimeKernelWorker not path {$AIRSHIP_PUBLIC_BASE_PATH:/}assets/*.prime-kernel-worker.js\n",
      "",
    );
    expect(checkStaticSecurity({ ...sources, caddyfile })).toContain(
      "The Caddyfile page CSP matcher must be the one exact inverse of the Prime kernel worker matcher.",
    );
  });

  it("rejects self/connect grants and any worker response-header broadening", () => {
    const selfHeaders = sources.headers.replace(
      "script-src 'unsafe-eval'",
      "script-src 'self' 'unsafe-eval'",
    );
    expect(checkStaticSecurity({ ...sources, headers: selfHeaders })).toContain(
      "The Prime kernel worker CSP must never grant script-src 'self'.",
    );

    const connectedHeaders = sources.headers.replace("connect-src 'none'", "connect-src 'self'");
    expect(checkStaticSecurity({ ...sources, headers: connectedHeaders })).toContain(
      "The Prime kernel worker CSP must keep connect-src 'none'.",
    );

    const widenedHeaders = sources.headers.replace(
      "  X-Content-Type-Options: nosniff\n\n/assets/*",
      "  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n\n/assets/*",
    );
    expect(checkStaticSecurity({ ...sources, headers: widenedHeaders }).some((failure) =>
      failure.includes("must set only CSP, COEP, CORP, and nosniff"),
    )).toBe(true);
  });

  it("refuses worker-policy drift in Caddy, Vite, the host preflight, or the service worker", () => {
    const caddyfile = sources.caddyfile.replace(
      "script-src 'unsafe-eval'; connect-src 'none'",
      "script-src 'unsafe-eval'; connect-src 'self'",
    );
    expect(checkStaticSecurity({ ...sources, caddyfile }).some((failure) =>
      failure.includes("Caddyfile's Prime kernel worker CSP diverges"),
    )).toBe(true);

    const viteConfig = sources.viteConfig.replace(
      "script-src 'unsafe-eval'; connect-src 'none'",
      "script-src 'unsafe-eval'; connect-src 'self'",
    );
    expect(checkStaticSecurity({ ...sources, viteConfig }).some((failure) =>
      failure.includes("Vite's Prime kernel worker CSP diverges"),
    )).toBe(true);

    const kernelHost = sources.kernelHost.replace(
      "script-src 'unsafe-eval'; connect-src 'none'",
      "script-src 'unsafe-eval'; connect-src 'self'",
    );
    expect(checkStaticSecurity({ ...sources, kernelHost }).some((failure) =>
      failure.includes("host preflight's Prime kernel worker CSP diverges"),
    )).toBe(true);

    const serviceWorker = sources.serviceWorker.replace(
      "script-src 'unsafe-eval'; connect-src 'none'",
      "script-src 'unsafe-eval'; connect-src 'self'",
    );
    expect(checkStaticSecurity({ ...sources, serviceWorker }).some((failure) =>
      failure.includes("service worker's Prime kernel worker CSP diverges"),
    )).toBe(true);
  });

  it("refuses a service-worker navigation policy without frame-ancestors", () => {
    const serviceWorker = sources.serviceWorker.replace("; frame-ancestors 'none'", "");
    const failures = checkStaticSecurity({ ...sources, serviceWorker });
    expect(failures).toContain("The service worker's navigation CSP is not the exact reviewed response-header expression.");
    expect(failures.some((failure) => failure.includes("frame-ancestors"))).toBe(true);
  });

  it("refuses a missing service-worker navigation policy", () => {
    const serviceWorker = sources.serviceWorker.replace("DOCUMENT_CONTENT_SECURITY_POLICY", "REMOVED_DOCUMENT_POLICY");
    expect(checkStaticSecurity({ ...sources, serviceWorker })).toContain(
      "The service worker does not define a navigation CSP for headerless static hosts.",
    );
  });

  it("does not read header-only frame-ancestors as a divergence", () => {
    // The exception that made this normalization necessary: a `<meta>` CSP is
    // defined to ignore `frame-ancestors`, so its absence there is correct.
    expect(sources.index).not.toContain("frame-ancestors");
    expect(checkStaticSecurity(sources)).toEqual([]);
  });
});

function replaceInAllPolicies(input, from, to) {
  return Object.freeze({
    ...input,
    index: input.index.replace(from, to),
    headers: input.headers.replace(from, to),
    caddyfile: input.caddyfile.replace(from, to),
  });
}

describe("the parsers", () => {
  it("keeps directives ordered and ASCII-lowercases their names before validation", () => {
    expect(parsePolicy("CONNECT-SRC *; connect-src 'self' https:")).toEqual([
      ["connect-src", "*"],
      ["connect-src", "'self' https:"],
    ]);
  });

  it("keeps a CSP whole despite the colons in its origins", () => {
    const sections = parseNetlifyHeaders(sources.headers);
    expect(sections.get("/*").get("content-security-policy").value).toContain("connect-src 'self' https:");
  });

  it("reads only the unconditional header block, not the matcher-scoped ones", () => {
    const served = parseCaddyResponseHeaders(sources.caddyfile);
    // The page and worker CSPs are complementary matcher-scoped headers.
    expect(served.has("content-security-policy")).toBe(false);
    // `header @immutable Cache-Control …` lives outside the block; picking it up
    // would invent a site-wide caching rule the reviewed policy never states.
    expect(served.has("cache-control")).toBe(false);
    // A removal directive sets nothing and has no `_headers` counterpart.
    expect(served.has("server")).toBe(false);
  });

  it("keeps the worker rule later than the one pervasive Cloudflare/Netlify rule", () => {
    const paths = netlifyHeaderSectionPaths(sources.headers);
    expect(paths.filter((path) => path === "/*")).toHaveLength(1);
    expect(paths.filter((path) => path === PRIME_KERNEL_WORKER_HEADERS_PATH)).toHaveLength(1);
    expect(paths.indexOf(PRIME_KERNEL_WORKER_HEADERS_PATH)).toBeGreaterThan(paths.indexOf("/*"));
  });

  it("reads the Cloudflare inherited-header removal separately from values", () => {
    expect(parseNetlifyHeaderUnsets(sources.headers).get(PRIME_KERNEL_WORKER_HEADERS_PATH))
      .toContain("content-security-policy");
  });

  it("refuses a Caddyfile with no unconditional header block at all", () => {
    expect(() => parseCaddyResponseHeaders("example.com {\n\troot * /srv\n}\n")).toThrow(/no unconditional/u);
  });
});
