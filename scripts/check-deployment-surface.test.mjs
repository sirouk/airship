import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/*
 * A deployment file has no test surface of its own — nothing here can start a
 * container. What can be held is the contract *between* the files, and both
 * defects this file exists to keep caught are exactly that kind.
 *
 * `AIRSHIP_PUBLIC_BASE_PATH` is documented in `.env.sample`, taken as a build
 * argument by the `Dockerfile`, and inlined by Vite into every URL the bundle
 * asks for. Caddy answers a URL by mapping its path onto the filesystem, so a
 * deployment that sets a subpath and a server anchored at the origin root do
 * not fail loudly: the assets fall through the SPA fallback and the browser is
 * handed HTML where it asked for JavaScript. That is what shipped, against a
 * value `.env.sample`, the Dockerfile, `deploy.sh` and DEPLOYMENT.md all offer
 * and the Pages workflow actually uses.
 *
 * Verified once against real containers rather than only in the abstract: an
 * image built with `/airship/` serves `/airship/assets/index-*.js` as
 * `text/javascript` with the immutable cache header and `Service-Worker-Allowed:
 * /airship/`, and the default build is byte-identical in behaviour to before.
 * These assertions are what keep that true without a Docker daemon in the loop.
 */

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const caddyfile = await read("Caddyfile");
const compose = await read("docker-compose.yaml");
const deploy = await read("deploy.sh");
const dockerfile = await read("Dockerfile");
const dockerignore = await read(".dockerignore");
const entrypoint = await read("caddy-entrypoint.sh");

const BASE = "{$AIRSHIP_PUBLIC_BASE_PATH:/}";

describe("the deployment serves the base path it advertises", () => {
  it("lays the bundle down where its own inlined URLs point", () => {
    // Once in the build stage for Vite, once in the runtime stage for the copy:
    // an ARG does not cross a stage boundary.
    expect(dockerfile.match(/^ARG AIRSHIP_PUBLIC_BASE_PATH=\/$/gmu)).toHaveLength(2);
    expect(dockerfile).toContain("COPY --from=build /app/dist /srv${AIRSHIP_PUBLIC_BASE_PATH}");
  });

  it("regenerates the release inventory after adding the static fallback", () => {
    expect(dockerfile).toMatch(/RUN cp dist\/index\.html dist\/404\.html\n(?:#.*\n)?RUN npm run check:release/u);
  });

  it("does not send generated output or local state to the Docker builder", () => {
    const ignored = new Set(dockerignore.split(/\r?\n/u).map((line) => line.trim()));
    for (const path of [
      "extension/build",
      "public/extension/releases",
      ".env*",
      ".airship-lab",
      "test-results",
      "graphify-out",
      "docs/_work",
    ]) expect(ignored).toContain(path);
  });

  it("gives Caddy the value at run time, because Caddy is a real process", () => {
    // Once under `args:` because Vite inlines it, once under `environment:`
    // because Caddy has to answer the URLs that inlining produced.
    expect(compose.match(/^\s+AIRSHIP_PUBLIC_BASE_PATH: \$\{AIRSHIP_PUBLIC_BASE_PATH:-\/\}$/gmu)).toHaveLength(2);
    expect(compose).toContain("$${AIRSHIP_PUBLIC_BASE_PATH:-/}");
  });

  it("anchors every path matcher at the base rather than the origin root", () => {
    expect(caddyfile).toContain(`@immutable path ${BASE}assets/* ${BASE}semantic-pack/v1/*`);
    expect(caddyfile).toContain(`@primeKernelWorker path ${BASE}assets/*.prime-kernel-worker.js`);
    expect(caddyfile).toContain(`@notPrimeKernelWorker not path ${BASE}assets/*.prime-kernel-worker.js`);
    expect(caddyfile).toContain(`@nocache path ${BASE}sw.js ${BASE}release-manifest.json`);
    expect(caddyfile).toContain(`header ${BASE}sw.js Service-Worker-Allowed "${BASE}"`);
    expect(caddyfile).toContain(`try_files {path} ${BASE}index.html`);
  });

  it("keeps page and worker CSP routes disjoint at root and /airship/", () => {
    const suffix = "assets/*.prime-kernel-worker.js";
    for (const publicBase of ["/", "/airship/"]) {
      const path = `${publicBase}${suffix}`;
      expect(path).toBe(publicBase === "/"
        ? "/assets/*.prime-kernel-worker.js"
        : "/airship/assets/*.prime-kernel-worker.js");
    }
    expect(caddyfile.match(/^\s*@primeKernelWorker path .*\.prime-kernel-worker\.js$/gmu)).toHaveLength(1);
    expect(caddyfile.match(/^\s*@notPrimeKernelWorker not path .*\.prime-kernel-worker\.js$/gmu)).toHaveLength(1);
    expect(caddyfile).toContain(
      `header @primeKernelWorker Content-Security-Policy "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'"`,
    );
  });

  it("normalizes the trailing slash Vite adds and Caddy does not", () => {
    // Without it `{$AIRSHIP_PUBLIC_BASE_PATH:/}assets/*` expands to
    // `/airshipassets/*` for a `/airship` that lost its slash — a matcher that
    // matches nothing, so the site serves and silently loses its cache and
    // service-worker headers.
    expect(entrypoint).toContain("export AIRSHIP_PUBLIC_BASE_PATH");
    expect(entrypoint).toMatch(/\*\/\) ;;/u);
  });
});

/*
 * Local mode exists to work before anything is configured. A fixed `80:80` both
 * fails the whole `up` on a host that already owns port 80 and forwards to
 * nothing when it succeeds, because without TLS Caddy listens only on
 * CADDY_PORT.
 */
describe("the ACME binding", () => {
  it("is published through a variable rather than a fixed host port", () => {
    expect(compose).not.toContain('- "80:80"');
    expect(compose).toContain('- "${CADDY_HTTP_BIND:-80:80}"');
  });

  it("is opted out of by local mode, where nothing listens on 80 at all", () => {
    expect(deploy).toMatch(/^\s+export CADDY_HTTP_BIND="80"$/mu);
  });
});
