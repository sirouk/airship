# Local full-system lab

The local lab is a reproducible developer setup for the static Airship client,
a disposable S3-compatible vault target, and the normal browser workflows that
do not require a public deployment.

## What it covers

- the Vite app on `http://127.0.0.1:4173`;
- disposable local storage infrastructure for Vault testing;
- sessions, workspace, editor, terminal, Git, and agent flows;
- local validation of the browser-only product boundary.

It does **not** fabricate third-party provider guarantees. If you want to test a
real cloud provider, connect it manually from the UI with a disposable key.

## Start

Requirements: Node.js 22+, Docker with Compose, and repository dependencies.

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

## Stop

```sh
npm run lab:stop
```

The lab is intentionally disposable. It is for local integration work, not for
long-lived personal data.
