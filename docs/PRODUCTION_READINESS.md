# Airship production readiness

This document separates what the repository can validate from the launch work that
still depends on external infrastructure, provider registrations, and store
reviews.

## Current release shape

Airship is a static web application. A release must validate:

- the build stays static and self-contained;
- the browser security headers remain correct;
- unit, integration, and browser gates pass;
- the optional extension packages build;
- storage and local execution claims remain honest.

## Main repository commands

Run from the repository root:

```sh
npm ci
npm run test
npm run check
npm run build
```

Important browser and release gates:

```sh
npm run test:e2e
npm run test:e2e:master
npm run test:e2e:static-host
npm run test:e2e:portability
npm run test:e2e:google-drive
npm run test:e2e:semantic
npm run test:vault:live
npm run test:pyodide:live
```

## What `npm run check` validates

`npm run check` runs the current local gate:

- TypeScript checks for app and extension code;
- static security checks;
- unit/integration tests;
- extension packaging;
- static production build;
- release gate validation;
- browser layout/overflow checks.

## External release work still needed

Repository success is not the same as public launch readiness. A public launch
still needs, as applicable:

- a real hosted origin;
- extension store review and signing;
- provider account setup and acceptable browser-facing auth choices;
- Google Drive OAuth registration if Drive is enabled on that origin;
- public documentation for supported browsers and known limits;
- live smoke testing on the exact deployed origin.

## Claim rules for launch copy

Do not promise:

- an Airship backend;
- provider-side confidential computing for ordinary remote calls;
- a provider-specific privileged lane; or
- browser capabilities that depend on an optional extension, local server, or
  host environment unless the product clearly says so.

Historical release notes for the older Chutes-specialized stack were moved to
`docs/archive/`.
