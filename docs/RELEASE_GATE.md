# Static release gate

Airship's production artifact is a static client. `npm run build` therefore
ends by running `scripts/release-gate.mjs` against `dist/`; there is no release
server and no build-time credential exchange.

## Blocking checks

The gate fails the build when it finds:

- a `.map` artifact or an inline/external `sourceMappingURL` directive;
- a high-confidence Chutes, AWS, GitHub, npm, Slack, Stripe, JWT, PEM private
  key, or long bearer-credential shape (the failure reports the class and file,
  never the matching value);
- a missing or changed reviewed public artifact: `_headers`, `sw.js`,
  `manifest.webmanifest`, or `favicon.svg`;
- a missing CSP/header boundary, immutable hashed-asset caching, or
  service-worker/release-manifest revalidation or service-worker scope rule;
- a service worker that loses its same-origin, GET-only, authorization/range
  bypass, network-first navigation, static-asset scope, or `Set-Cookie`
  exclusion invariant;
- anything other than one same-origin hashed JavaScript entry and one
  same-origin hashed stylesheet entry in `index.html`;
- a web app manifest that escapes the same-origin root scope or loses its
  reviewed install/icon contract;
- a missing crypto WASM artifact; or
- an artifact budget overrun.

The credential scanner deliberately permits documentation-shaped prefixes such
as `cak_` and `cpk_`; it rejects only sufficiently long credential-shaped
values. It is a last-line build check, not a substitute for secret scanning in
source history or for rotating an exposed credential.

## Enforced artifact budgets

All compressed measurements use deterministic level-9 gzip. Raw and compressed
ceilings are both blocking.

| Class | Raw ceiling | Gzip ceiling |
| --- | ---: | ---: |
| HTML-referenced entry JavaScript | 384 KiB | 110 KiB |
| Initial JavaScript and module preloads | 640 KiB | 132 KiB |
| Deferred advanced capability bundle | 388 KiB | 113 KiB |
| First-party and other non-vendor JS/workers | 1,768 KiB | 462 KiB |
| Browser Git + Terminal vendor runtime aggregate | 656 KiB | 182 KiB |
| Absolute installed JavaScript/worker backstop | 2,152 KiB | 643 KiB |
| Service worker | 12 KiB | 4 KiB |
| Optional execution broker / engine / support | 32 / 56 / 8 KiB | 10 / 14 / 3 KiB |
| Optional pinned WASI Preview 1 Worker | 32 KiB | 8 KiB |
| Optional Node/WebContainer pack | 32 KiB | 8 KiB |
| Optional first-party `airship-sh` shell pack | 100 KiB | 30 KiB |
| Unpromoted WASIX JavaScript / WASM | 0 / 0 KiB | 0 / 0 KiB |
| Optional agent runtime / tool bundle | 48 / 128 KiB | 14 / 36 KiB |
| Optional Workspace / Source Control / browser Git | 28 / 48 / 276 KiB | 10 / 14 / 83 KiB |
| Optional Sessions / Memory / Memory support / Proof | 48 / 36 / 2 / 64 KiB | 14 / 12 / 1 / 20 KiB |
| Optional Terminal | 384 KiB | 100 KiB |
| Optional semantic worker / model catalog | 16 / 32 KiB | 6 / 10 KiB |
| Optional inference/provider + Companion protocol packs | 124 KiB | 38 KiB |
| Optional Intel DCAP QVL JS / WASM | 32 / 1,536 KiB | 8 / 512 KiB |
| Pinned same-origin Pyodide distribution | 16 MiB | 8 MiB |
| HTML-referenced entry CSS | 160 KiB | 32 KiB |
| General WASM excluding separately capped DCAP | 1,024 KiB each and aggregate | 350 KiB each and aggregate |

These values mirror the executable ceilings exported by
`scripts/release-gate.mjs`; reviewers must update this inventory in the same
change when a ceiling moves. The 224 KiB compressed startup figure in
`PRODUCT_SPEC.md` is an engineering target, while the stricter
HTML-entry and 132 KiB initial-load ceilings above are blocking gates. Lazy
route and vendor packs do not count as startup bytes, but they remain subject to
both individual limits and the 530 KiB installed-JavaScript backstop. Raw limits
also catch parse and memory regressions that compression can hide. Changing a
ceiling requires an explicit code and documentation review; a build must not
silently learn a larger baseline.

The installed-only backstop moved from 1,760 / 528 KiB to 1,768 / 530 KiB when
genuine linked worktrees landed. That capability preserves isolated worktree
indexes and administration state over one shared object/ref database. The
reviewed build measured 1,767.75 KiB raw and 529.55 KiB gzip after the
nested-repository container exclusion was added, so the new ceiling keeps less
than 1 KiB headroom on each axis. No startup, route, service-worker,
vendor-aggregate, or Browser Git pack ceiling changed.

The shell and shared browser capability bundle are measured separately at the
dynamic-import boundary already enforced by the app. The initial-load class
pays for startup, routing, and chat; the service worker has its own cap. The
deferred class pays for advanced audit, S3, attestation, and route capabilities
only after demand. The
full-screen Workspace workbench, Worker/WASI/Python adapter,
Node/WebContainer adapter, and pinned Pyodide distribution remain separate,
blocking budget classes. A new total-JavaScript ceiling prevents chunking from
hiding aggregate growth. The gate rejects production HTML that module-preloads
any of these packs and keeps the 110 KiB entry ceiling intact. WASIX is an
unpromoted research candidate and therefore has a zero-byte production budget.
Classifying a lazy pack separately never removes its own raw/gzip or total
ceiling.

## Deterministic manifest

After all checks pass, the gate writes `dist/release-manifest.json`. It contains
only a schema name, `sha256` algorithm identifier, `signed: false`, and a
lexicographically sorted list of artifact paths, raw byte counts, and SHA-256
digests. It has no timestamp, host path, environment value, or secret. The
manifest excludes itself so it has no impossible self-hash.

For identical output bytes, repeated gate runs produce byte-identical manifests.
The manifest is an inventory, not an attestation: it is **not signed**, does not
identify a builder, and does not prove a clean-room rebuild. A future provenance
system must sign or transparently anchor the release manifest and build record
under a separately trusted release key. Until then, the UI and documentation
must not call this release verified or reproducible merely because the hashes
exist.

## Explicit live acceptance

`npm run check` remains deterministic, credential-free, and suitable for an
offline checkout. It does not imply that a paid external provider was reachable.
Before a release that claims real Chutes interoperability, run the separate
fail-closed gate with a disposable credential and explicit provider model IDs:

```sh
AIRSHIP_CHUTES_API_KEY='cpk_…' \
AIRSHIP_CHUTES_TOOL_MODEL='provider/tool-capable-model' \
AIRSHIP_CHUTES_VISION_MODEL='provider/vision-capable-model' \
npm run check:release:live
```

This is a post-build gate: run `npm run check` first. Its browser stage serves
the existing `dist/` artifact through Vite Preview on strict port 4188 rather
than transforming application source at test time.

The wrapper exits unsuccessfully before starting a child process when any of
those three values is absent or malformed. It maps the credential into process
memory for two real suites without putting it in command arguments or wrapper
logs:

1. Chutes model discovery, WASM E2EE streaming, journal/receipt auditing, and a
   model-directed `write_file` plus `read_file` tool turn.
2. A hermetic Chromium session on its own strict port that discovers the
   configured vision model, submits an encrypted inline image, receives a real
   response, and then exercises the endpoint-attestation evidence screen.

The live Playwright configuration disables screenshots, traces, video, and HTML
reports because a failed browser run must not retain the memory-only credential.
Models are supplied by ID instead of inferred from a hard-coded provider model.

## Hosting boundary

The gate proves that the deployable directory contains the reviewed headers and
service-worker policy. It cannot prove that a hosting provider actually applies
`_headers`, serves the recorded bytes, or rolls back safely. Production release
automation must probe response headers and artifact hashes from the deployed
origin, preserve the manifest out-of-band, and add signed provenance, an SBOM,
and rollback evidence before Airship clears the paid-production gate.
