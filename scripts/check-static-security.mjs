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

export const PRIME_KERNEL_WORKER_HEADERS_PATH = "/*.prime-kernel-worker.js";
export const PRIME_KERNEL_WORKER_CADDY_MATCHER = "{$AIRSHIP_PUBLIC_BASE_PATH:/}assets/*.prime-kernel-worker.js";
const PRIME_KERNEL_WORKER_POLICY_EXPORT = "PRIME_KERNEL_WORKER_CONTENT_SECURITY_POLICY";
const DOCUMENT_POLICY_EXPORT = "DOCUMENT_CONTENT_SECURITY_POLICY";
const EXACT_PRIME_KERNEL_WORKER_POLICY = "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'";
const PRIME_KERNEL_WORKER_HEADER_SET = new Map([
  ["content-security-policy", EXACT_PRIME_KERNEL_WORKER_POLICY],
  ["cross-origin-embedder-policy", "credentialless"],
  ["cross-origin-resource-policy", "same-origin"],
  ["x-content-type-options", "nosniff"],
]);
const EXACT_TRUSTED_TYPES_ALLOWLIST = "default airship-static airship-worker airship-prime-kernel-worker airship-prime-kernel-worker-asset airship-semantic-worker airship-wasi-preview1-worker airship-opfs-worker airship-google-identity";

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

export function netlifyHeaderSectionPaths(source) {
  return source.split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#") && !/^\s/u.test(line))
    .map((line) => line.trim());
}

/** Header removals use Cloudflare Pages' indented `! Name` form. */
export function parseNetlifyHeaderUnsets(source) {
  const sections = new Map();
  let current;
  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      current = new Set();
      sections.set(line.trim(), current);
      continue;
    }
    const field = /^\s+!\s*([A-Za-z0-9-]+)\s*$/u.exec(line);
    if (field && current) current.add(field[1].toLowerCase());
  }
  return sections;
}

/**
 * The Caddyfile's one unconditional `header { … }` block — the headers every
 * response carries. CSP is deliberately outside it because the page and Prime
 * kernel worker need complementary policies.
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

export function parseCaddyScopedHeader(source, matcher, headerName) {
  const escapedMatcher = matcher.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedHeader = headerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^\\s*header\\s+@${escapedMatcher}\\s+${escapedHeader}\\s+"([^"]*)"\\s*$`,
    "mu",
  );
  return pattern.exec(source)?.[1];
}

function configuredPolicy(source, exportName) {
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${exportName}\\s*=\\s*"([^"]+)";`,
    "u",
  );
  return pattern.exec(source)?.[1];
}

function configuredKernelWorkerPolicy(source) {
  return configuredPolicy(source, PRIME_KERNEL_WORKER_POLICY_EXPORT);
}

/**
 * Keep CSP directives ordered until every duplicate name has been rejected.
 * Browsers use the first occurrence of a duplicated directive, so constructing
 * a Map while parsing would silently replace the policy the browser enforces.
 */
export function parsePolicy(value) {
  return value
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [rawName, ...tokens] = directive.split(/\s+/u);
      const name = rawName.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
      return [name, tokens.join(" ")];
    });
}

export function duplicatePolicyDirectiveNames(directives) {
  const seen = new Set();
  const duplicates = new Set();
  for (const [name] of directives) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

export function serialize(policy) {
  const entries = policy instanceof Map ? [...policy.entries()] : [...policy];
  return entries
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
 * The stock workbench accepts user-configured HTTPS provider endpoints.
 * `https:` is therefore an intentional dynamic egress capability, not an
 * accidental wildcard. Keep every weaker form closed: no wildcard host, no
 * broad plaintext/WebSocket scheme, and no non-loopback HTTP origin.
 */
export function validateConnectSources(connections) {
  const failures = [];
  if (connections.filter((source) => source === "https:").length !== 1) {
    failures.push("connect-src must contain exactly one HTTPS scheme grant for user-configured providers.");
  }
  if (connections.some((source) => source.includes("*"))) {
    failures.push("connect-src must never contain a wildcard source.");
  }
  for (const source of connections) {
    if (["http:", "ws:", "wss:"].includes(source)) {
      failures.push(`connect-src must not grant the broad ${source} scheme.`);
      continue;
    }
    if (source === "'self'" || source === "https:") continue;
    if (source.startsWith("https://")) {
      let url;
      try {
        url = new URL(source);
      } catch {
        failures.push(`connect-src contains an invalid HTTPS source: ${source}.`);
        continue;
      }
      if (url.origin !== source || url.username || url.password) {
        failures.push(`connect-src HTTPS host sources must be exact credential-free origins: ${source}.`);
      }
      continue;
    }
    if (!source.startsWith("http://")) {
      failures.push(`connect-src contains an unsupported source: ${source}.`);
      continue;
    }
    let url;
    try {
      url = new URL(source);
    } catch {
      failures.push(`connect-src contains an invalid HTTP source: ${source}.`);
      continue;
    }
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.origin !== source
      || url.username
      || url.password
    ) {
      failures.push(`connect-src HTTP sources must be exact credential-free loopback origins: ${source}.`);
    }
  }
  return failures;
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
export function checkStaticSecurity({ index, headers, caddyfile, viteConfig, kernelHost, serviceWorker }) {
  const failures = [];
  const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
  const sectionPaths = netlifyHeaderSectionPaths(headers);
  const sections = parseNetlifyHeaders(headers);
  const unsets = parseNetlifyHeaderUnsets(headers);
  for (const path of ["/*", PRIME_KERNEL_WORKER_HEADERS_PATH]) {
    const occurrences = sectionPaths.filter((candidate) => candidate === path).length;
    if (occurrences !== 1) {
      failures.push(`public/_headers must declare ${path} exactly once; found ${occurrences}.`);
    }
  }
  const rootPolicyIndex = sectionPaths.indexOf("/*");
  const workerPolicyIndex = sectionPaths.indexOf(PRIME_KERNEL_WORKER_HEADERS_PATH);
  if (rootPolicyIndex >= 0 && workerPolicyIndex >= 0 && workerPolicyIndex <= rootPolicyIndex) {
    failures.push("The Netlify worker policy must be later than the pervasive page policy so it overrides rather than intersects it.");
  }
  for (const [path, values] of sections) {
    const setsCsp = values.has("content-security-policy");
    const unsetsCsp = unsets.get(path)?.has("content-security-policy") === true;
    if ((setsCsp || unsetsCsp) && path !== "/*" && path !== PRIME_KERNEL_WORKER_HEADERS_PATH) {
      failures.push(`public/_headers has an intersecting Content-Security-Policy rule at ${path}.`);
    }
  }
  const reviewed = sections.get("/*");
  if (!reviewed) throw new Error("public/_headers must declare a `/*` section carrying the site-wide policy.");
  const header = reviewed.get("content-security-policy")?.value;
  if (!meta || !header) throw new Error("Both index.html and public/_headers must define a CSP.");

  const workerReviewed = sections.get(PRIME_KERNEL_WORKER_HEADERS_PATH);
  const workerHeader = workerReviewed?.get("content-security-policy")?.value;
  if (!workerHeader) {
    failures.push(`public/_headers must give ${PRIME_KERNEL_WORKER_HEADERS_PATH} its dedicated CSP.`);
  }
  if (!unsets.get(PRIME_KERNEL_WORKER_HEADERS_PATH)?.has("content-security-policy")) {
    failures.push("The Prime kernel worker rule must remove the inherited page CSP before setting its own policy.");
  }
  if (workerReviewed) {
    const unexpected = [...workerReviewed.keys()].filter((name) => !PRIME_KERNEL_WORKER_HEADER_SET.has(name));
    const missing = [...PRIME_KERNEL_WORKER_HEADER_SET.keys()].filter((name) => !workerReviewed.has(name));
    if (unexpected.length > 0 || missing.length > 0) {
      failures.push(
        `The Prime kernel worker _headers rule must set only CSP, COEP, CORP, and nosniff (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
      );
    }
    for (const [name, expected] of PRIME_KERNEL_WORKER_HEADER_SET) {
      const found = workerReviewed.get(name)?.value;
      if (found !== undefined && found !== expected) {
        failures.push(`The Prime kernel worker _headers ${name} value is not exact.`);
      }
    }
  }

  const expectedCaddyMatcher = `@primeKernelWorker path ${PRIME_KERNEL_WORKER_CADDY_MATCHER}`;
  const expectedCaddyInverse = `@notPrimeKernelWorker not path ${PRIME_KERNEL_WORKER_CADDY_MATCHER}`;
  const caddyLines = caddyfile.split("\n").map((line) => line.trim());
  if (caddyLines.filter((line) => line === expectedCaddyMatcher).length !== 1) {
    failures.push("The Caddyfile must declare exactly one base-aware Prime kernel worker matcher.");
  }
  if (caddyLines.filter((line) => line === expectedCaddyInverse).length !== 1) {
    failures.push("The Caddyfile page CSP matcher must be the one exact inverse of the Prime kernel worker matcher.");
  }
  for (const matcher of ["primeKernelWorker", "notPrimeKernelWorker"]) {
    const count = caddyLines.filter((line) => line.startsWith(`header @${matcher} Content-Security-Policy `)).length;
    if (count !== 1) failures.push(`The Caddyfile must set exactly one CSP through @${matcher}; found ${count}.`);
  }

  const served = parseCaddyResponseHeaders(caddyfile);
  if (served.has("content-security-policy")) {
    failures.push("The Caddyfile must not send an unconditional CSP that intersects its disjoint page and worker policies.");
  }
  const pageCaddy = parseCaddyScopedHeader(caddyfile, "notPrimeKernelWorker", "Content-Security-Policy");
  const workerCaddy = parseCaddyScopedHeader(caddyfile, "primeKernelWorker", "Content-Security-Policy");
  const configuredWorkerPolicy = configuredKernelWorkerPolicy(viteConfig);
  const hostWorkerPolicy = configuredKernelWorkerPolicy(kernelHost ?? "");
  const serviceWorkerPolicy = configuredKernelWorkerPolicy(serviceWorker ?? "");
  const serviceWorkerDocumentPolicy = configuredPolicy(serviceWorker ?? "", DOCUMENT_POLICY_EXPORT);
  const servedPage = new Map(served);
  if (pageCaddy) {
    servedPage.set("content-security-policy", { name: "Content-Security-Policy", value: pageCaddy });
  }

  const metaDirectiveList = parsePolicy(meta);
  const headerDirectiveList = parsePolicy(header);
  const servedDirectiveList = pageCaddy ? parsePolicy(pageCaddy) : undefined;
  const serviceWorkerDocumentDirectiveList = serviceWorkerDocumentPolicy ? parsePolicy(serviceWorkerDocumentPolicy) : undefined;
  const workerHeaderDirectiveList = workerHeader ? parsePolicy(workerHeader) : undefined;
  const workerCaddyDirectiveList = workerCaddy ? parsePolicy(workerCaddy) : undefined;
  const workerViteDirectiveList = configuredWorkerPolicy ? parsePolicy(configuredWorkerPolicy) : undefined;
  const workerHostDirectiveList = hostWorkerPolicy ? parsePolicy(hostWorkerPolicy) : undefined;
  const workerServiceWorkerDirectiveList = serviceWorkerPolicy ? parsePolicy(serviceWorkerPolicy) : undefined;
  const orderedPolicies = [
    ["index.html's CSP", metaDirectiveList],
    ["public/_headers' CSP", headerDirectiveList],
    ...(servedDirectiveList ? [["The Caddyfile's CSP", servedDirectiveList]] : []),
    ...(serviceWorkerDocumentDirectiveList ? [["The service worker's navigation CSP", serviceWorkerDocumentDirectiveList]] : []),
    ...(workerHeaderDirectiveList ? [["public/_headers' Prime kernel worker CSP", workerHeaderDirectiveList]] : []),
    ...(workerCaddyDirectiveList ? [["The Caddyfile's Prime kernel worker CSP", workerCaddyDirectiveList]] : []),
    ...(workerViteDirectiveList ? [["Vite's Prime kernel worker CSP", workerViteDirectiveList]] : []),
    ...(workerHostDirectiveList ? [["The host preflight Prime kernel worker CSP", workerHostDirectiveList]] : []),
    ...(workerServiceWorkerDirectiveList ? [["The service worker's Prime kernel worker CSP", workerServiceWorkerDirectiveList]] : []),
  ];
  for (const [label, directives] of orderedPolicies) {
    for (const name of duplicatePolicyDirectiveNames(directives)) {
      failures.push(`${label} contains a duplicate CSP directive: ${name}. Browsers honor the first occurrence.`);
    }
  }
  // Do not construct or consult a directive Map until every ordered policy has
  // passed the duplicate check. A Map preserves the last occurrence, while the
  // browser enforces the first.
  if (failures.some((failure) => failure.includes("duplicate CSP directive"))) return failures;

  const metaDirectives = new Map(metaDirectiveList);
  const headerDirectives = new Map(headerDirectiveList);
  const servedDirectives = servedDirectiveList ? new Map(servedDirectiveList) : undefined;
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
  if (!serviceWorkerDocumentDirectiveList) {
    failures.push("The service worker does not define a navigation CSP for headerless static hosts.");
  } else {
    const navigationDirectives = new Map(serviceWorkerDocumentDirectiveList);
    if (serviceWorkerDocumentPolicy !== header) {
      failures.push("The service worker's navigation CSP is not the exact reviewed response-header expression.");
    }
    if (serialize(navigationDirectives) !== serialize(headerDirectives)) {
      failures.push(
        `The service worker's navigation CSP diverges from public/_headers:
  ${describePolicyDivergence(headerDirectives, navigationDirectives).join("\n  ")}`,
      );
    }
  }
  for (const [label, directives] of [
    ["index.html", metaDirectives],
    ["public/_headers", headerDirectives],
    ...(servedDirectives ? [["the Caddy page response", servedDirectives]] : []),
  ]) {
    if (directives.get("script-src")?.split(/\s+/u).includes("'unsafe-eval'")) {
      failures.push(`${label} must not grant page-wide unsafe-eval.`);
    }
  }

  if (metaDirectives.get("trusted-types") !== EXACT_TRUSTED_TYPES_ALLOWLIST) {
    failures.push("The page trusted-types directive must be the exact reviewed policy-name allowlist.");
  }

  const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
  failures.push(...validateConnectSources(connections));

  for (const [key, { name, value }] of reviewed) {
    const sent = servedPage.get(key);
    if (!sent) {
      failures.push(`The Caddyfile never sends ${name}; a deploy would serve the site without it.`);
      continue;
    }
    if (key === "content-security-policy") {
      if (!servedDirectives || serialize(servedDirectives) !== serialize(headerDirectives)) {
        failures.push(
          `The Caddyfile's CSP is not the reviewed policy:\n  ${describePolicyDivergence(headerDirectives, servedDirectives ?? new Map()).join("\n  ")}`,
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
  // other host this same build is served from.
  for (const [key, { name }] of servedPage) {
    if (!reviewed.has(key)) {
      failures.push(`The Caddyfile sends ${name}, which the reviewed public/_headers policy does not declare.`);
    }
  }

  const workerPolicies = [
    ["public/_headers", workerHeaderDirectiveList, workerHeader],
    ["the Caddyfile", workerCaddyDirectiveList, workerCaddy],
    ["Vite", workerViteDirectiveList, configuredWorkerPolicy],
    ["the host preflight", workerHostDirectiveList, hostWorkerPolicy],
    ["the service worker", workerServiceWorkerDirectiveList, serviceWorkerPolicy],
  ];
  const referenceWorkerDirectives = workerHeaderDirectiveList ? new Map(workerHeaderDirectiveList) : undefined;
  for (const [label, directives, sourcePolicy] of workerPolicies) {
    if (!directives) {
      failures.push(`${label} does not define the Prime kernel worker CSP.`);
      continue;
    }
    const policy = new Map(directives);
    if (sourcePolicy !== EXACT_PRIME_KERNEL_WORKER_POLICY) {
      failures.push(`${label}'s Prime kernel worker CSP is not the exact reviewed expression.`);
    }
    if (referenceWorkerDirectives && serialize(policy) !== serialize(referenceWorkerDirectives)) {
      failures.push(
        `${label}'s Prime kernel worker CSP diverges from public/_headers:\n  ${describePolicyDivergence(referenceWorkerDirectives, policy).join("\n  ")}`,
      );
    }
  }
  if (referenceWorkerDirectives) {
    const required = new Map([
      ["default-src", "'none'"],
      ["script-src", "'unsafe-eval'"],
      ["connect-src", "'none'"],
      ["worker-src", "'none'"],
    ]);
    if (referenceWorkerDirectives.get("script-src")?.split(/\s+/u).includes("'self'")) {
      failures.push("The Prime kernel worker CSP must never grant script-src 'self'.");
    }
    if (referenceWorkerDirectives.get("connect-src") !== "'none'") {
      failures.push("The Prime kernel worker CSP must keep connect-src 'none'.");
    }
    if (serialize(referenceWorkerDirectives) !== serialize(required)) {
      failures.push("The Prime kernel worker CSP must contain only default-src, unsafe-eval script-src, denied connect-src, and denied worker-src.");
    }
  }

  return failures;
}

export async function runStaticSecurityCheck() {
  const [index, headers, caddyfile, viteConfig, kernelHost, serviceWorker] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("public/_headers", root), "utf8"),
    readFile(new URL("Caddyfile", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("src/prime/kernel/kernel-host.ts", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
  ]);
  const failures = checkStaticSecurity({ index, headers, caddyfile, viteConfig, kernelHost, serviceWorker });
  if (failures.length > 0) {
    throw new Error(`Static security policies diverge across the sources that decide them:\n- ${failures.join("\n- ")}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await runStaticSecurityCheck();
  console.log("Static security policies are aligned across index.html, public/_headers, the Caddyfile, Vite, the Prime worker host preflight, and the service worker.");
}
