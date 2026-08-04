import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/*
 * Three files decide what a browser is actually told, and each is written in a
 * format the other two cannot read.
 *
 * `index.html` carries a `<meta http-equiv>` CSP — what a bare `dist/` on a
 * dumb file host enforces. `public/_headers` is the Netlify/Cloudflare
 * response-header format. The `Caddyfile` is what the self-hosted deployment
 * actually sends, and **Caddy does not read `_headers`**.
 *
 * Until the Caddyfile joined this check, a CSP edit that correctly updated both
 * of the first two passed every gate in the repository while the deployed site
 * went on sending the old policy. That is not hypothetical: a per-chute host
 * stayed granted in the Caddyfile long after embeddings moved to E2EE routing,
 * and nothing said so. `deploy.sh --verify` does compare the two
 * response-header sources, but it runs at deploy time on a machine with Docker
 * — a drift caught only there is caught after review, by whoever is deploying.
 *
 * The Caddyfile's header block is load-bearing beyond CSP: its COEP/COOP pair
 * is what supplies cross-origin isolation, without which the threaded WASM
 * runtime fails to start with an error that reads like a bug in the semantic
 * pack rather than a missing header.
 *
 * Caching rules are deliberately out of scope here. Caddy expresses them with
 * path matchers rather than sections, so comparing them structurally would mean
 * re-implementing Caddy's matcher semantics; the release gate already holds
 * `_headers`' own caching contract and `deploy.sh` observes the served
 * response. This file owns the security header set, where a silent divergence
 * is a policy regression rather than a performance one.
 */

const root = new URL("../", import.meta.url);

/**
 * The Netlify/Cloudflare `_headers` grammar: an unindented line opens a path
 * section and indented `Name: value` lines belong to it. The header name is
 * matched before the first colon, which is why a CSP full of `https://`
 * survives being parsed by a rule that splits on one.
 */
export function parseNetlifyHeaders(source) {
  const sections = new Map();
  let current;
  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      current = new Map();
      sections.set(line.trim(), current);
      continue;
    }
    const field = /^\s+([A-Za-z0-9-]+):\s*(.*)$/u.exec(line);
    if (!field || !current) continue;
    current.set(field[1].toLowerCase(), { name: field[1], value: field[2].trim() });
  }
  return sections;
}

/**
 * The Caddyfile's one unconditional `header { … }` block — the headers every
 * response carries. Matcher-scoped headers (`header @immutable Cache-Control …`)
 * are one-line directives outside it and are not part of the security set.
 */
export function parseCaddyResponseHeaders(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s*header\s*\{\s*$/u.test(line));
  if (start < 0) {
    throw new Error("The Caddyfile declares no unconditional `header { … }` block; a deploy would serve no policy at all.");
  }
  const headers = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "}") return headers;
    if (!line || line.startsWith("#")) continue;
    // `-Server` deletes a header Caddy would otherwise add. It sets nothing, so
    // it has no counterpart in `_headers` and must not be compared as one.
    if (line.startsWith("-") || line.startsWith("+")) continue;
    const field = /^([A-Za-z0-9-]+)\s+"([^"]*)"$/u.exec(line) ?? /^([A-Za-z0-9-]+)\s+(\S.*)$/u.exec(line);
    if (!field) throw new Error(`Unparsed Caddyfile header directive: ${line}`);
    headers.set(field[1].toLowerCase(), { name: field[1], value: field[2].trim() });
  }
  throw new Error("The Caddyfile's `header {` block is never closed.");
}

export function parsePolicy(value) {
  return new Map(
    value
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...tokens] = directive.split(/\s+/u);
        return [name, tokens.join(" ")];
      }),
  );
}

export function serialize(policy) {
  return [...policy.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name} ${value}`)
    .join(";");
}

/** Which directives actually differ, so a failure names the edit that caused it. */
function describePolicyDivergence(reviewed, candidate) {
  const names = [...new Set([...reviewed.keys(), ...candidate.keys()])].sort();
  return names
    .filter((name) => reviewed.get(name) !== candidate.get(name))
    .map(
      (name) =>
        `${name}: reviewed ${reviewed.has(name) ? `"${reviewed.get(name)}"` : "(absent)"} vs found ${candidate.has(name) ? `"${candidate.get(name)}"` : "(absent)"}`,
    );
}

/**
 * `public/_headers` is the reviewed policy; the other two sources are checked
 * against it.
 *
 * `frame-ancestors` is the one directive a `<meta>` CSP is defined to ignore,
 * so the meta tag is compared against the header set with that directive
 * removed. The Caddyfile sends real response headers, so it is compared against
 * the whole thing — folding it into this same normalization rather than beside
 * it is what keeps the exception stated once instead of copied.
 */
export function checkStaticSecurity({ index, headers, caddyfile }) {
  const failures = [];
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
  const sections = parseNetlifyHeaders(headers);
  const reviewed = sections.get("/*");
  if (!reviewed) throw new Error("public/_headers must declare a `/*` section carrying the site-wide policy.");
  const header = reviewed.get("content-security-policy")?.value;
  if (!meta || !header) throw new Error("Both index.html and public/_headers must define a CSP.");

  const metaDirectives = parsePolicy(meta);
  const headerDirectives = parsePolicy(header);
  const headerWithoutFrameProtection = new Map(headerDirectives);
  headerWithoutFrameProtection.delete("frame-ancestors");
  if (serialize(metaDirectives) !== serialize(headerWithoutFrameProtection)) {
    failures.push(
      `index.html and public/_headers diverge (except header-only frame-ancestors):\n  ${describePolicyDivergence(headerWithoutFrameProtection, metaDirectives).join("\n  ")}`,
    );
  }
  if (headerDirectives.get("frame-ancestors") !== "'none'") {
    failures.push("The response-header CSP must deny all frame ancestors.");
  }

  const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
  if (connections.includes("https:") || connections.some((source) => source.includes("*"))) {
    failures.push("connect-src must use exact origins, never scheme-wide or wildcard grants.");
  }

  const served = parseCaddyResponseHeaders(caddyfile);
  for (const [key, { name, value }] of reviewed) {
    const sent = served.get(key);
    if (!sent) {
      failures.push(`The Caddyfile never sends ${name}; a deploy would serve the site without it.`);
      continue;
    }
    if (key === "content-security-policy") {
      const servedDirectives = parsePolicy(sent.value);
      if (serialize(servedDirectives) !== serialize(headerDirectives)) {
        failures.push(
          `The Caddyfile's CSP is not the reviewed policy:\n  ${describePolicyDivergence(headerDirectives, servedDirectives).join("\n  ")}`,
        );
      }
      continue;
    }
    if (sent.value !== value) {
      failures.push(`The Caddyfile sends ${name}: "${sent.value}", but the reviewed value is "${value}".`);
    }
  }
  // The reverse direction matters too. A header only the Caddyfile sends is a
  // policy nobody reviewed in `_headers`, and it would be absent from every
  // other host this same build is served from — the divergence pointing the
  // other way is still a divergence.
  for (const [key, { name }] of served) {
    if (!reviewed.has(key)) {
      failures.push(`The Caddyfile sends ${name}, which the reviewed public/_headers policy does not declare.`);
    }
  }

  return failures;
}

export async function runStaticSecurityCheck() {
  const [index, headers, caddyfile] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("public/_headers", root), "utf8"),
    readFile(new URL("Caddyfile", root), "utf8"),
  ]);
  const failures = checkStaticSecurity({ index, headers, caddyfile });
  if (failures.length > 0) {
    throw new Error(`Static security policies diverge across the three sources that decide them:\n- ${failures.join("\n- ")}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await runStaticSecurityCheck();
  console.log("Static security policies are aligned across index.html, public/_headers and the Caddyfile.");
}
