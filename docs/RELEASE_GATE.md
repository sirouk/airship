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
- a missing crypto WASM artifact;
- an optional semantic pack that is partial, contains an unreviewed file, or
  differs in byte length or SHA-256 from its pinned artifact manifest, including
  a mismatch between the build's availability declaration and emitted files; or
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
| HTML-referenced entry JavaScript | 384 KiB | 118 KiB |
| Baseline JavaScript and workers, lazy packs excluded | 768 KiB | 195 KiB |
| Deferred advanced capability bundle | 447 KiB | 133 KiB |
| First-party and other non-vendor JS/workers | 2,377 KiB | 754 KiB |
| Browser Git + Terminal vendor runtime aggregate | 680 KiB | 190 KiB |
| Absolute installed JavaScript/worker backstop | 3,057 KiB | 943 KiB |
| Service worker | 12 KiB | 4 KiB |
| Optional execution broker / engine / support / tools | 32 / 56 / 10 / 49 KiB | 10 / 14 / 4 / 15 KiB |
| Optional pinned WASI Preview 1 Worker | 32 KiB | 8 KiB |
| Optional Node/WebContainer pack | 32 KiB | 11 KiB |
| Optional first-party `airship-sh` shell pack | 100 KiB | 30 KiB |
| Unpromoted WASIX JavaScript / WASM | 0 / 0 KiB | 0 / 0 KiB |
| Optional agent runtime / tool bundle | 54 / 128 KiB | 16 / 39 KiB |
| Optional Workspace / Source Control / browser Git | 87 / 48 / 276 KiB | 29 / 14 / 83 KiB |
| Optional Sessions / Memory / Memory support / Proof | 65 / 64 / 2 / 89 KiB | 20 / 21 / 1 / 28 KiB |
| Optional Skills route / skill editor | 8 / 4 KiB | 3 / 2 KiB |
| Optional Terminal | 423 KiB | 112 KiB |
| Optional semantic worker / model catalog | 16 / 33 KiB | 6 / 12 KiB |
| Optional inference/provider + Companion protocol packs | 165 KiB | 53 KiB |
| Optional prime runtime pack | 161 KiB | 48 KiB |
| Optional Intel DCAP QVL JS / WASM | 32 / 1,536 KiB | 8 / 512 KiB |
| Pinned same-origin Pyodide distribution | 16 MiB | 8 MiB |
| HTML-referenced entry CSS | 185 KiB | 32 KiB |
| General WASM excluding separately capped DCAP | 1,024 KiB each and aggregate | 350 KiB each and aggregate |

These values mirror the executable ceilings exported by
`scripts/release-gate.mjs`, and `assertReleaseGateDocumentationMirrors` in that
file now refuses a build where they do not. That check exists because this
paragraph used to be the only thing holding them together, and six rows had
stopped being true — entry JavaScript read 110 KiB against a 113 KiB ceiling,
the installed backstop 2,152 / 643 against 2,746 / 846 — while two rows
described gates the file does not contain. A reader who argued a raise against
those numbers was arguing against a build that never existed. The table is now
the only place a ceiling is written down in prose; the figures that used to be
repeated in the paragraphs below were a second copy with nothing keeping it
honest, and repeating a number is how a mirror cracks.

`PRODUCT_SPEC.md`'s compressed startup figure is an engineering target, not a
gate; the entry and baseline rows above are the blocking ones. Lazy route and
vendor packs do not count as startup bytes, but they remain subject to both
their individual limits and the installed-JavaScript backstop. Raw limits also
catch parse and memory regressions that compression can hide. Changing a ceiling
requires an explicit code and documentation review, in the same change, or the
gate above fails; a build must not silently learn a larger baseline.

Ceilings move with measurements, not with need. Each one in
`scripts/release-gate.mjs` carries the reading that sets it, the budgets named in
`MEASUREMENT_JUSTIFIED_BUDGETS` are required to, and
`assertDocumentedMeasurementsMatchBuild` compares those readings against the
artifacts the same run measures — so a justification that quotes a build nobody
produced fails the gate rather than surviving it.

The shell and shared browser capability bundle are measured separately at the
dynamic-import boundary already enforced by the app. The baseline class pays for
startup, routing, and chat; the service worker has its own cap. The deferred
class pays for advanced audit, S3, attestation, and route capabilities only
after demand. The full-screen Workspace workbench, Worker/WASI/Python adapter,
Node/WebContainer adapter, and pinned Pyodide distribution remain separate,
blocking budget classes. A total-JavaScript ceiling prevents chunking from
hiding aggregate growth. The gate rejects production HTML that module-preloads
any of these packs and keeps the entry ceiling intact. WASIX is an unpromoted
research candidate and therefore has a zero-byte production budget. Classifying
a lazy pack separately never removes its own raw/gzip or total ceiling.

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

## Browser product acceptance

`npm run check` deliberately keeps the long browser matrices separate. Before a
browser release candidate is accepted, run the full product journey suite and
each specialized boundary suite against the same tree:

```sh
npm run test:e2e
npm run test:e2e:google-drive
npm run test:e2e:portability
npm run test:e2e:master
npm run test:e2e:static-host
```

The default suite covers the ordinary product journeys. The specialized runs
exercise deterministic Google Drive composition, the cross-engine and
constrained-device portability matrix, the master browser/WebContainer boundary,
and the built artifact on a headerless static host at the same `/airship/`
subpath used by the Pages build. The portability and static-host lanes explicitly
build without the optional semantic pack and require its control to be unavailable
without issuing a pack request; the opt-in semantic command in
[Semantic embedding pack](SEMANTIC_EMBEDDING_PACK.md#verification) exercises the
hash-pinned pack itself. They remain separate because their browser, network, and
runtime requirements are materially longer and broader than the bounded offline
check.

## Explicit live acceptance

`npm run check` remains credential-free and suitable for an offline checkout.
The checks are deterministic against the artifact they inspect, but Rollup's
chunk layout is not yet byte-for-byte deterministic across otherwise identical
checkouts; both reviewed layouts must satisfy the same ceilings. The check does
not imply that a paid external provider was reachable.
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
