# Deploying Airship

Airship is a static application. Deployment means serving the built files with
the right headers and base path, not running an app server.

## Basic local flows

From the repository root:

```sh
npm ci
npm run build
npm run preview
# open http://127.0.0.1:4173
```

For the reproducible local Docker+Caddy path, use the checked-in helpers:

```sh
./deploy.sh
./deploy.sh --verify
```

## Deployment rules

1. **Treat Airship as static.** Serve `dist/` from a static host, CDN, or file
   server with SPA fallback for deep links.
2. **Keep the browser security headers.** CSP, cross-origin isolation, cache
   rules, and service-worker scope are part of the product boundary.
3. **Pass public values at build time.** Vite inlines its public inputs while
   building the bundle.
4. **Do not depend on provider-specific deployment ceremony.** The simplified
   product contract is provider-neutral. Transitional provider-specific build
   args in root deployment templates should not be the basis of new docs or new
   operational policy.

The Prime JavaScript kernel is the one scoped CSP exception. Its content-hashed
worker response must receive the exact worker policy from the built `_headers`,
Caddy's disjoint matcher, or the controlling service worker. Do not append that
policy beside the page policy: browsers enforce both, so the page policy would
still block the REPL. Do not add `unsafe-eval` to the document policy. A
headerless host must let the service worker claim and reload the page before the
kernel becomes available; the host preflight fails closed rather than starting
an unrestricted worker.

## Values you should expect to configure

- `AIRSHIP_PUBLIC_BASE_PATH`
- `VITE_GOOGLE_CLIENT_ID` when enabling Drive
- Caddy or host-specific listener/domain values

Airship is never told its own origin. Google Identity Services authorizes the
origin the page is served from, so the only place a deployment origin has to be
written down is the client ID's Authorized JavaScript origins list.

See the root `Dockerfile`, `docker-compose.yaml`, `.env.sample`, and
`deploy.sh` for the exact repository templates currently shipped.

## What the base path reaches, and what it does not

`AIRSHIP_PUBLIC_BASE_PATH` is inlined into the bundle, so every URL the browser
asks for carries it, and the files have to be laid down at the matching place:
`/srv<base>` in the image, `<base>` in the Pages artifact. Two things also have
to carry it, and one of them cannot:

- The Caddyfile's matchers do. Each is written `{$AIRSHIP_PUBLIC_BASE_PATH:/}…`,
  and `caddy-entrypoint.sh` supplies the trailing slash Caddy will not.
- `public/_headers` does not, except for the Prime kernel worker rule, which is
  written as a leading splat for that reason. `/assets/*`, `/sw.js`,
  `/release-manifest.json` and `/semantic-pack/v1/*` are anchored at the origin
  root and match nothing on a subpath deployment. On Netlify or Cloudflare
  Pages, a subpath site keeps its security headers — those come from `/*` — and
  silently loses its cache lifetimes and its `Service-Worker-Allowed` scope.
  Add base-prefixed copies of those four rules before deploying to a subpath on
  a host that reads this format. GitHub Pages and Caddy never read it.

## What a deployment must not add

- an Airship plaintext session backend;
- a credential broker that silently changes the trust model; or
- provider routing that makes one provider more privileged than the others.
