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
| Always-available shell JavaScript and workers, including `sw.js` | 640 KiB | 128 KiB |
| Deferred advanced capability bundle | 384 KiB | 110 KiB |
| Total JavaScript and workers across all packs | 1,280 KiB | 264 KiB |
| Optional Worker/WASI/Python adapter pack | 32 KiB | 10 KiB |
| Optional Node/WebContainer pack | 32 KiB | 8 KiB |
| Optional Workspace workbench | 24 KiB | 8 KiB |
| Optional semantic worker facade | 16 KiB | 6 KiB |
| Pinned same-origin Pyodide distribution | 16 MiB | 8 MiB |
| HTML-referenced entry CSS | 160 KiB | 32 KiB |
| Each WASM artifact | 1,024 KiB | 350 KiB |
| All WASM artifacts | 1,024 KiB | 350 KiB |

The aggregate JavaScript/worker and WASM compressed ceilings enforce the goals
in `PRODUCT_SPEC.md` and `FERRARI_AUDIT.md`. The per-entry raw ceilings also
catch parse, memory, and transfer regressions that compression could hide.
Changing a ceiling requires an explicit code and documentation review; a build
must not silently learn a larger baseline.

The shell and shared browser capability bundle are now measured separately at
the dynamic-import boundary already enforced by the app. The shell class pays
for startup, routing, chat, and the service worker; the deferred class pays for
advanced audit, S3, attestation, and route capabilities only after demand. The
full-screen Workspace workbench, Worker/WASI/Python adapter,
Node/WebContainer adapter, and pinned Pyodide distribution remain separate,
blocking budget classes. A new total-JavaScript ceiling prevents chunking from
hiding aggregate growth. The gate rejects production HTML that module-preloads
any of these packs and keeps the 110 KiB entry ceiling intact. Classifying a
lazy pack separately never removes its own raw/gzip or total ceiling.

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

## Hosting boundary

The gate proves that the deployable directory contains the reviewed headers and
service-worker policy. It cannot prove that a hosting provider actually applies
`_headers`, serves the recorded bytes, or rolls back safely. Production release
automation must probe response headers and artifact hashes from the deployed
origin, preserve the manifest out-of-band, and add signed provenance, an SBOM,
and rollback evidence before Airship clears the paid-production gate.
