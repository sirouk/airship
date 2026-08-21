# Local full-system lab

The local lab is a reproducible developer setup for the static Airship client,
a disposable S3-compatible vault target, and the normal browser workflows that
do not require a public deployment.

The lab is opt-in at build time. `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1` composes the
S3 adapter, the loopback endpoint and the lab's selector copy into a build;
every other build carries none of it, and the release gate fails a stock
artifact that does. `npm run lab:start` sets that variable itself, for the Vite
server it owns, and also supplies a syntactically valid placeholder
`VITE_GOOGLE_CLIENT_ID` so the Drive route is reachable in the lab. A plain
`npm run dev` therefore shows neither the MinIO destination nor Google Drive.

## What it covers

- the Vite app on `http://127.0.0.1:4173`;
- disposable local storage infrastructure for Vault testing;
- sessions, workspace, editor, terminal, Git, and agent flows;
- local validation of the browser-only product boundary.

It does **not** fabricate third-party provider guarantees. If you want to test a
real cloud provider, connect it manually from the UI with a disposable key.

## Start

Requirements: Node.js 22.13+, Docker with Compose, and repository dependencies.
`npm run lab:start` owns port 4173; stop any other dev server first.

```sh
npm ci
npm run lab:start
npm run lab:status
```

Useful helper commands:

```sh
npm run lab:logs
npm run lab:storage
npm run lab:test
```

`npm run lab:storage` starts MinIO only and no Vite, for a caller that owns its
own web server — the Playwright matrix needs a server with no synthetic Google
registration. `npm run lab:test` builds and gates a *stock* artifact even when
the lab flag is exported in your shell.

## Stop

```sh
npm run lab:stop
```

The lab is intentionally disposable. It is for local integration work, not for
long-lived personal data.
