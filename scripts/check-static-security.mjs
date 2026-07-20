import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [index, headers] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("public/_headers", root), "utf8"),
]);

const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u.exec(index)?.[1];
const header = /^\s*Content-Security-Policy:\s*(.+)$/mu.exec(headers)?.[1];
if (!meta || !header) throw new Error("Both index.html and public/_headers must define a CSP.");

const metaDirectives = parsePolicy(meta);
const headerDirectives = parsePolicy(header);
const headerWithoutFrameProtection = new Map(headerDirectives);
headerWithoutFrameProtection.delete("frame-ancestors");
if (serialize(metaDirectives) !== serialize(headerWithoutFrameProtection)) {
  throw new Error("Meta and header CSP directives diverge (except header-only frame-ancestors).");
}
if (headerDirectives.get("frame-ancestors") !== "'none'") {
  throw new Error("The response-header CSP must deny all frame ancestors.");
}

const connections = metaDirectives.get("connect-src")?.split(/\s+/u) ?? [];
if (connections.includes("https:") || connections.some((source) => source.includes("*"))) {
  throw new Error("connect-src must use exact origins, never scheme-wide or wildcard grants.");
}

function parsePolicy(value) {
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

function serialize(policy) {
  return [...policy.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name} ${value}`)
    .join(";");
}

console.log("Static security policies are aligned.");
