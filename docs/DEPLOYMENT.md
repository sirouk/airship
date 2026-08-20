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

## Values you should expect to configure

- `AIRSHIP_PUBLIC_BASE_PATH`
- `VITE_AIRSHIP_PUBLIC_ORIGIN`
- `VITE_GOOGLE_CLIENT_ID` when enabling Drive
- `VITE_AIRSHIP_EXTENSION_INSTALL_URL` when pointing at a published extension
- Caddy or host-specific listener/domain values

See the root `Dockerfile`, `docker-compose.yaml`, `.env.sample`, and
`deploy.sh` for the exact repository templates currently shipped.

## What a deployment must not add

- an Airship plaintext session backend;
- a credential broker that silently changes the trust model; or
- provider routing that makes one provider more privileged than the others.
