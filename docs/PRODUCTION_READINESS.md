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
- `npm run test` — the unit/integration suite, built with the loopback lab
  composed in, because that is the build whose lab paths it exercises;
- `npm run test:stock` — the storage-choice suites again with the lab composed
  out, so the picker and its refusals are asserted in both build modes;
- extension packaging;
- static production build;
- release gate validation, which also checks that `docs/RELEASE_GATE.md`'s
  budget table still mirrors the executable ceilings and that
  `docs/SESSION_LIBRARY.md` still states the fork contract;
- browser layout/overflow checks, which start servers on `127.0.0.1:4173` and
  `127.0.0.1:4174`.

Documentation is therefore part of this gate. A doc edit can fail
`npm run check`.

## Launch-facing documentation

Before a public launch, re-read the newcomer path — `README.md`,
`docs/CANON.md`, `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`,
`docs/THREAT_MODEL.md`, `docs/PROTOCOLS.md`, `docs/WORK_BUNDLE.md` — against the
build, not against the previous revision. The surfaces most likely to drift are
the ones this branch added: parallel conversations, the opt-in loopback lab, a
folder on this device, work bundles, and the rule that a file grants no
authority.

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
- a provider-specific privileged lane;
- browser capabilities that depend on an optional extension, local server, or
  host environment unless the product clearly says so;
- signing, sealing, attestation, or provenance verification of local metadata.
  Receipts, session journals, and work bundles are unsigned. A digest chain
  shows internal consistency only, and the release manifest states that it is
  unsigned.

Say plainly which capabilities are browser-dependent. Opening a folder on this
device needs the Chromium File System Access API and is unavailable in browsers
without it.

Historical release notes for the older Chutes-specialized stack were moved to
`docs/archive/`.
