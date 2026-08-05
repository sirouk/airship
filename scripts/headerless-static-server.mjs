import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = boundedPort(process.argv[3] ?? "4193");
const installDelayMs = boundedDelay(process.argv[4] ?? "0");
const publicBasePath = normalizedBasePath(process.argv[5] ?? "/");
const host = "127.0.0.1";
let workerVersion = 0;

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".zip": "application/zip",
});

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === `${publicBasePath}__airship_test__/bump-sw`) {
      workerVersion += 1;
      response.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }
    const relativePath = stripPublicBasePath(url.pathname);
    if (relativePath === undefined) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found.");
      return;
    }
    const requested = resolveRequest(relativePath);
    const existing = await regularFile(requested);
    const acceptsHtml = request.headers.accept?.includes("text/html") === true;
    if (!existing && !acceptsHtml && relativePath !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    const file = existing ? requested : resolve(root, "index.html");
    if (file.endsWith("release-manifest.json") && installDelayMs) {
      await new Promise((complete) => setTimeout(complete, installDelayMs));
    }
    const source = await readFile(file);
    const payload = file.endsWith("sw.js") && workerVersion
      ? Buffer.concat([source, Buffer.from(`\n// static-host fixture version ${workerVersion}\n`)])
      : source;
    response.writeHead(200, {
      "Content-Length": payload.byteLength,
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      // Intentionally no COOP, COEP, or CORP. This fixture proves that the
      // reviewed service worker can establish isolation on an ordinary static
      // origin whose server cannot configure response headers.
      "Cache-Control": file.endsWith("sw.js") || file.endsWith("release-manifest.json")
        ? "no-cache"
        : "public, max-age=0",
    });
    response.end(request.method === "HEAD" ? undefined : payload);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Static fixture failed.");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Airship headerless static fixture listening at http://${host}:${port}${publicBasePath}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function resolveRequest(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error("Static fixture refused a malformed path.");
  }
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Static fixture refused a path outside dist.");
  }
  return candidate;
}

function stripPublicBasePath(pathname) {
  if (publicBasePath === "/") return pathname;
  if (pathname === publicBasePath.slice(0, -1)) return "/";
  if (!pathname.startsWith(publicBasePath)) return undefined;
  return `/${pathname.slice(publicBasePath.length)}`;
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function boundedPort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new TypeError("Static fixture port must be an integer from 1024 through 65535.");
  }
  return parsed;
}

function boundedDelay(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new TypeError("Static fixture delay must be an integer from 0 through 10000.");
  }
  return parsed;
}

function normalizedBasePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("Static fixture public base must be an absolute URL path.");
  }
  const withTrailingSlash = value.endsWith("/") ? value : `${value}/`;
  if (withTrailingSlash.includes("//") || withTrailingSlash.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Static fixture public base must be a normalized URL path.");
  }
  return withTrailingSlash;
}
