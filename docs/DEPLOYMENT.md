# Deploying Airship behind Caddy on a domain

**Status:** Reusable deployment guide. Describes the six files at the repository root as they exist at `03af2c5`.
**Recovered:** 2026-08-04. This guide existed only in a temp directory while the six files it documents were already committed; `ls docs/*DEPLOY*` and `grep -rln Caddy docs/ README.md` both found nothing.

---

Airship compiles to a folder of files. This pattern works for anything that does —
Vite, webpack, Next's static export, Astro, SvelteKit's static adapter, Hugo,
plain HTML — and gives you a container that builds the bundle and serves it over
HTTPS on a domain you set in one environment variable, plus a `deploy.sh` that
stands it up locally with no configuration at all.

**Six files at the repository root:** `Dockerfile`, `Caddyfile`,
`caddy-entrypoint.sh`, `docker-compose.yaml`, `deploy.sh`, and a committed
`.env.sample`.

---

## The shape

**One service, not two.** If you already run an application process and put Caddy
in front of it, keep doing that. Airship has no runtime process — the browser *is*
the application — so Caddy serves the files directly. Reverse proxying to a second
web server just to hand over the same bytes is a container and a hop for nothing.
The other services in this fleet run application + proxy; this one deliberately
does not, and `docker-compose.yaml:3-6` says so at the top of the file.

**Build in the image, serve from the image.** Multi-stage: a `node:22-slim`
builder, a `caddy:2-alpine` runtime that is Caddy plus `dist/`. Nothing from the
builder survives, so the running container has no Node, no npm, no source, and
nothing that can execute application code — because at runtime there is no
application.

---

## The four traps

Read these before you change anything. Each one cost real time.

### 1. STANDING RULE — anything deployment-shaped is a build argument, never a runtime variable

**This is not history. It is how the deployment works and how it must keep working.**

Vite inlines its `VITE_*` inputs *when the bundle compiles*. So do webpack's
`DefinePlugin`, Next's `NEXT_PUBLIC_*`, and Astro's `PUBLIC_*`. A variable passed
at `docker run` reaches nothing, because by then the JavaScript already contains
whatever was there at build time.

Therefore: **the public origin and every OAuth client ID are `ARG`s in the
`Dockerfile` and `args:` in `docker-compose.yaml` — not `environment:`.**
Changing the domain means rebuilding. `deploy.sh` does that for you so nobody has
to remember.

**The base path is the one value in both columns, and that is not a violation of
the rule but a consequence of it.** Vite inlines it, so every URL the browser
asks for carries the prefix — that is the build-argument half. Caddy then has to
*answer* those URLs: map them onto the filesystem, match the cache and
service-worker rules against them, and fall back to the right `index.html`. A
server cannot do any of that from a value baked into JavaScript it never reads.
So it is also `environment:`, and `caddy-entrypoint.sh` normalizes the trailing
slash Vite adds and Caddy does not. The two readings cannot disagree, because
`deploy.sh` builds and starts in one step from one `.env`.

The tell that this was missing: the site serves, and every asset request falls
through the SPA fallback, so the browser is handed HTML where it asked for
JavaScript and the app never boots.

The split in this repository is exact, and it is the thing to preserve:

| Value | Where it lives | Why |
|---|---|---|
| `AIRSHIP_PUBLIC_BASE_PATH` | build arg **and** runtime env | inlined into the manifest and service-worker scope — and Caddy has to answer the URLs that inlining produced, so the same value reaches the runtime container too |
| `VITE_AIRSHIP_PUBLIC_ORIGIN` | build arg | inlined; OAuth redirects are compared against it |
| `VITE_GOOGLE_CLIENT_ID` | build arg | inlined; also selects the default vault at build time |
| `VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID` | build arg | inlined |
| `VITE_AIRSHIP_EXTENSION_INSTALL_URL` | build arg | inlined; empty falls back to the extension this build ships |
| `CADDY_DOMAIN` | runtime env | read by Caddy, which is a real process |
| `CADDY_PORT` | runtime env | read by Caddy |
| `CADDY_TLS` | runtime env | read by `caddy-entrypoint.sh` |

If you add a value, decide which column it belongs in **before** you add it. The
tell that you got it wrong: the site works locally and then talks to the wrong
host in production, or an OAuth redirect comes back to `localhost`.

### 2. Caddy does not read `public/_headers`

`public/_headers` is the Netlify/Cloudflare format. Caddy ignores it completely.
Serving `dist/` with a plain `file_server` publishes Airship with **none of those
headers** — no Content-Security-Policy, no cross-origin isolation, no HSTS.

This fails quietly. The site loads fine. What breaks is subtle and looks like
something else:

- No `Cross-Origin-Embedder-Policy` means no cross-origin isolation, so
  `SharedArrayBuffer` is unavailable and the threaded WASM runtime cannot start
  its workers — **the semantic pack fails to load with an error that reads like a
  bug in the pack.**
- No CSP means the XSS protection is simply absent, and nothing tells you.

**A header linter that reads your source files will not catch this by default.**
`check-static-security.mjs` was written to compare `index.html` against
`public/_headers`; under this deployment *neither of those is what the browser
receives*. The `Caddyfile` header block is what the browser receives. Any check
that does not read the `Caddyfile` is checking a document with no deployment
consequence.

**So the Caddyfile carries its own copy of the policy, and it is checked twice.**
Duplication that is verified beats duplication that drifts.

- `deploy.sh --verify` compares the two and **refuses to build when they differ**
  (`deploy.sh:135-139`) — before publishing, not after. This runs on the
  deploying machine.
- `check-static-security.mjs` runs inside `npm run check`, so a CSP edit that
  misses the Caddyfile is red at **review** time rather than at deploy time. It
  reads all three sources — `index.html`, `public/_headers` and the `Caddyfile` —
  folded into one normalization (`0245110`). `frame-ancestors` is header-only, so
  the `<meta>` CSP is compared against the header set with that directive removed,
  while the Caddyfile is compared against the whole of it. **A header only the
  Caddyfile sends is also a failure**, because no other host this build is served
  from would send it.

Note what neither check covers: **the matcher-scoped caching headers**
(`@immutable`, `@nocache`) are deliberately out of scope. Caddy expresses them
with path matchers, and they have no `public/_headers` counterpart to be compared
against — re-implementing matcher semantics to check them would be a second
gate's worth of guessing. **They are verified by the post-deploy `curl` probes
below, or not at all.**

### 3. The local path must not require configuration

The whole point of a "run it locally" option is that it works before anything is
set up. If it demands a `.env` with a domain, it defeats itself.

Local mode overrides the domain, port, TLS and origin anyway, so it needs no
config file. It reads one **if it happens to exist**, for the optional provider
registrations it does not dictate, and runs without it otherwise. That is
`deploy.sh:91-109`, with the reasoning kept in the file.

### 4. Test the entry point, not the layer beneath it

Running `docker compose` directly with the right variables exercises the
containers and never touches `deploy.sh`'s own branching — which is where the
local-mode overrides, the header refusal, and the post-deploy probes live. Run
`./deploy.sh` the way a person will.

---

## The files

### `Dockerfile`

Two stages. The build stage is the load-bearing one.

```dockerfile
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG AIRSHIP_PUBLIC_BASE_PATH=/
ARG VITE_AIRSHIP_PUBLIC_ORIGIN=
ARG VITE_GOOGLE_CLIENT_ID=
ARG VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID=

ENV AIRSHIP_PUBLIC_BASE_PATH=${AIRSHIP_PUBLIC_BASE_PATH} \
    VITE_AIRSHIP_PUBLIC_ORIGIN=${VITE_AIRSHIP_PUBLIC_ORIGIN} \
    VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID} \
    VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID=${VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID}
```

**Annotations, following the file's own comments:**

- `AIRSHIP_PUBLIC_BASE_PATH` (`Dockerfile:20-22`) — `/` for a domain root. **A
  subpath needs the trailing slash** (`/airship/`) or the manifest and service
  worker resolve wrong.
- `VITE_AIRSHIP_PUBLIC_ORIGIN` (`:23-25`) — the origin the app tells providers to
  return to. **OAuth redirects are compared against this exactly**, so it must
  match the domain Caddy answers on.
- The two client IDs (`:26-30`) — optional. **Absent is a supported
  configuration**: Vite strips the Drive connect branch entirely when the Google
  client ID is empty.

Then the part that is easy to miss (`:37-45`):

```dockerfile
RUN if [ -n "$VITE_GOOGLE_CLIENT_ID" ]; then \
      export VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=google-drive; \
    else \
      export VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=ephemeral; \
    fi; \
    npm run build
```

**This fails closed.** An unconfigured deployment starts in explicit Ephemeral
page memory rather than silently creating durable storage or offering a Drive
default this artifact cannot connect to. It mirrors `.github/workflows/pages.yml`,
and it mirrors the runtime resolution at `src/ui/platform-shell.tsx:463-468`
(`resolveDefaultVaultBackend`). Change one and you must change all three.

`RUN cp dist/index.html dist/404.html` (`:47-49`) — Airship is hash-routed, but a
deep link or a refresh can still arrive at a path the bundle does not emit. Same
fallback the Pages workflow uses.

The runtime stage (`:52-63`) copies `dist` to `/srv`, the `Caddyfile` to
`/etc/caddy/Caddyfile`, `chmod +x` the entrypoint, exposes 80 and 443.

### `Caddyfile`

**Re-read this file before editing it. The CSP has changed since this guide was
first written** — most recently in `2989e70`, "the Caddyfile kept granting a host
the app no longer calls". Do not copy a CSP out of a document; copy it out of
`public/_headers` and let `deploy.sh --verify` confirm.

```caddy
{$CADDY_PROTOCOL:}{$CADDY_DOMAIN:localhost}:{$CADDY_PORT:443} {
	root * /srv
	encode zstd gzip

	header {
		Content-Security-Policy "…"        # one policy, matching public/_headers

		Cross-Origin-Embedder-Policy "credentialless"
		Cross-Origin-Opener-Policy "same-origin"
		Cross-Origin-Resource-Policy "same-origin"

		Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()"
		Referrer-Policy "no-referrer"
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"

		-Server
	}

	@immutable path /assets/* /semantic-pack/v1/*
	header @immutable Cache-Control "public, max-age=31536000, immutable"

	@nocache path /sw.js /release-manifest.json
	header @nocache Cache-Control "no-cache"
	header /sw.js Service-Worker-Allowed "/"

	try_files {path} /index.html
	file_server
}
```

**Annotations:**

- `{$CADDY_PROTOCOL:}` is set by `caddy-entrypoint.sh` from `CADDY_TLS`: empty
  enables automatic HTTPS, `http://` disables it for local testing.
- **The cross-origin trio is not optional here.** `credentialless` is what lets
  the threaded WASM runtime start its workers; drop these two and the semantic
  pack fails to load with an error that looks like a bug in the pack
  (`Caddyfile:23-25`).
- **Airship's CSP is long and specific.** At `03af2c5` it allowlists the Chutes
  API and LLM hosts, three OpenAI/Anthropic/xAI endpoints, twelve loopback origins
  for local model servers, GitHub API and raw content, the Shelbynet API, Phala's
  PCCS, the Wasmer registry and CDN, and three Google identity origins — plus a
  `trusted-types` allowlist naming eight policies and `require-trusted-types-for
  'script'`. Every one of those is load-bearing for a feature. Removing a host
  breaks that feature silently at runtime, in production only.
- `-Server` strips Caddy's version banner: free reconnaissance, buys nothing.
- **`/semantic-pack/v1/*` is in the immutable set** alongside `/assets/*` — both
  are content-addressed by the build, so a year is safe and a rebuild busts it.
- **`/release-manifest.json` is in the no-cache set** alongside `/sw.js`. The
  service worker decides when the app updates; caching it defeats that — a stale
  worker keeps serving a stale build long after a deploy.

### `caddy-entrypoint.sh`

Sixteen lines, one job: turn `CADDY_TLS` into a protocol prefix the Caddyfile can
interpolate.

```sh
#!/bin/sh
CADDY_TLS=${CADDY_TLS:-true}

if [ "$CADDY_TLS" = "false" ]; then
    export CADDY_PROTOCOL="http://"
else
    export CADDY_PROTOCOL=""
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

Same contract as the proxy services in this fleet: `CADDY_TLS=false` serves plain
HTTP (local testing, or behind another terminator); anything else lets Caddy
provision certificates itself. **`chmod +x` it and commit the bit** — the
`Dockerfile` re-applies it at `:60`, but the committed bit is what makes the file
runnable outside the image.

### `docker-compose.yaml`

The service is named `airship` (`:14`), and the container is `airship` (`:23`).
Build args and runtime environment are the two columns from trap #1, kept
separate. Three things are worth naming:

```yaml
    ports:
      - "${CADDY_PORT:-443}:${CADDY_PORT:-443}"
      # Caddy's plain-HTTP listener: ACME HTTP-01 and the http:// redirect. Not
      # harmless without TLS, where nothing listens on it — local mode sets
      # CADDY_HTTP_BIND=80 so Docker picks the host port.
      - "${CADDY_HTTP_BIND:-80:80}"
    volumes:
      # Certificates and OCSP staples. Without this every restart re-requests
      # from Let's Encrypt and walks into the rate limit.
      - caddy_data:/data
      - caddy_config:/config
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:80/"]
```

- **Port 80 must be mapped when TLS is on — and only then.** ACME HTTP-01
  challenges arrive there, and without it there is no certificate. With
  `CADDY_TLS=false` Caddy puts no listener on 80 at all, so the binding forwards
  to nothing and still aborts `up` on a host that already owns the port. That is
  why local mode sets `CADDY_HTTP_BIND=80` and lets Docker choose the host side.
- **`caddy_data` must be a named volume.** Without it every restart re-requests
  from Let's Encrypt and walks into the rate limit.
- **The healthcheck goes over loopback inside the container**, so it does not
  depend on public DNS or on a certificate having been issued yet. A check that
  needs the thing it is checking to already work is not a check.

### `.env.sample`

```bash
CADDY_DOMAIN=airship.example.com
CADDY_PORT=443
CADDY_TLS=true

AIRSHIP_PUBLIC_BASE_PATH=/
VITE_AIRSHIP_PUBLIC_ORIGIN=https://airship.example.com

VITE_GOOGLE_CLIENT_ID=
VITE_AIRSHIP_CHUTES_PUBLIC_CLIENT_ID=
VITE_AIRSHIP_EXTENSION_INSTALL_URL=
```

`VITE_AIRSHIP_PUBLIC_ORIGIN` **must match `CADDY_DOMAIN` exactly, scheme
included, or sign-in comes back to nowhere.** Leaving `VITE_GOOGLE_CLIENT_ID`
empty is supported and starts Airship in Ephemeral page memory; setting it
switches the default to Drive, so set it only when the origin above is a
registered redirect. Local Device remains an explicit encrypted offline choice.

Commit the sample, never the `.env`. **If `.gitignore` has `.env*`, add
`!.env.sample` after it** or the template gets swallowed too.

### `deploy.sh`

An interactive menu plus three flag forms. The flags come first
(`deploy.sh:70-79`) so `--verify`, `--logs` and `--stop` never prompt:

```
./deploy.sh --verify    # check Caddyfile against public/_headers, exit
./deploy.sh --logs      # docker compose logs -f
./deploy.sh --stop      # docker compose down
./deploy.sh             # menu: 1 deploy · 2 deploy locally · 3 stop · 4 logs
```

`verify_headers()` (`:24-57`) is the trap-#2 enforcement. It does two different
kinds of check, and the difference matters:

- **The CSP is compared for equality** between `public/_headers` and the
  `Caddyfile` (`:29-32`). On mismatch it prints a **sorted, directive-split diff**
  (`:37-38`) so you can see which directive drifted rather than eyeballing a
  2 KB string.
- **Eight other headers are checked for presence only** (`:44-54`) — the
  cross-origin trio, `Referrer-Policy`, `X-Content-Type-Options`,
  `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy`.

Then, after the containers are up, it checks **what is actually served rather than
what you configured** (`:155-172`): an HTTP status, a real `content-security-policy`
response header, and a real `cross-origin-embedder-policy` response header — with
the COEP absence reported as "the semantic pack's threaded runtime will not start",
which is the observable symptom rather than the header name.

Note `:151-153`: the probe URL omits the port when `CADDY_PORT` is 443, so the
check is made against the address a user would actually type.

---

## Standing it up

```bash
./deploy.sh          # choose 2 → http://localhost:8080, no domain, no config needed
```

Local mode needs nothing configured. It overrides the domain, TLS, port, origin
and base path, and reads `.env` only if it exists, for the optional provider
registrations.

For the real thing:

1. Point an A/AAAA record at the host.
2. `cp .env.sample .env` and set `CADDY_DOMAIN` and `VITE_AIRSHIP_PUBLIC_ORIGIN`
   to the same domain. (Running `./deploy.sh` → 1 with no `.env` does the copy for
   you and stops so you can edit it — `deploy.sh:59-68`.)
3. `./deploy.sh` → 1.

Caddy obtains the certificate itself on the first request, which is why **port 80
has to be mapped and DNS has to resolve first**. If the post-deploy probe reports
no answer, that is usually all it is; `./deploy.sh --logs` shows the ACME attempt.

---

## Checks worth keeping

After the first deploy, confirm what is being served rather than what you
configured:

```bash
curl -sI https://your.domain/ | grep -iE "content-security-policy|cross-origin|strict-transport"
curl -sI https://your.domain/assets/<some-hashed-file> | grep -i cache-control
curl -sI https://your.domain/sw.js | grep -i cache-control
curl -s -o /dev/null -w "%{http_code}\n" https://your.domain/some/deep/link
```

Immutable caching on hashed assets, `no-cache` on the service worker and
`release-manifest.json`, a deep link returning 200, and every security header
present. **If any of those is missing, it is missing for every visitor and nothing
else will tell you.**

Run `./deploy.sh --verify` in CI or before any release that touches
`public/_headers`. It costs nothing and it is the only thing standing between a
reviewed policy and a served one.
