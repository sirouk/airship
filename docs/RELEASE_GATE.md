# Static release gate

Airship ships as a static client. `npm run build` therefore ends by validating
`dist/` rather than preparing a server release.

## The release gate blocks on

- source maps or stray source-map directives;
- any trace of the host-composed loopback storage lab. The lab is composed in
  by `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1` and out of every other build, so a stock
  release must contain no lab chunk, no S3 request signing, no baked loopback
  endpoint or disposable keys, and no copy that names the destination;
- credential-shaped payloads in shipped artifacts, including decompressed
  Companion ZIP members. Vendor keys are matched on the literal each vendor
  issues; a key that is bare hex or bare base64 has no shape to match, and no
  credential belongs in a build input in the first place;
- a Pyodide distribution that is not the pinned bytes: the five shipped files
  are matched by SHA-256 and byte length, and no sixth file may sit beside
  them;
- a stylesheet no shipped script or document references;
- any document the release did not review: `.html`, `.htm`, `.xhtml`, `.shtml`,
  `.svg` and `.xml` ship only from an exact list, and `404.html` must be a byte
  copy of the reviewed index;
- missing reviewed public files or broken static-host assumptions;
- missing security headers or service-worker boundary regressions;
- asset budget overruns;
- mismatches between optional static packs and their reviewed manifests;
- documentation that no longer matches the executable: the budget table below
  must mirror the ceilings `scripts/release-gate.mjs` exports, and
  `docs/SESSION_LIBRARY.md` must still state the fork contract. A
  documentation-only change can fail this gate.

The gate writes `release-manifest.json`, a deterministic inventory of the
artifacts it measured, and prints that the manifest is explicitly unsigned. It
is an inventory, not a signature, an attestation, or a provenance claim.

## Two classes of ceiling

Every ceiling is in one of two classes, and each budget's comment says which
one and why.

**Class 1 — what a person waits for before anything works.** The entry
JavaScript, the entry stylesheet, the baseline JavaScript and workers including
the chunks awaited before first render, and the service worker. These stay
hard: the ceiling is the smallest whole-KiB step that clears the reading, one
further step is available only against written `<n> KiB <role> would have left
<m> B` arithmetic, and every reviewed build variant has to be recorded. Today
that is about 163 KiB gzip of JavaScript and 25 KiB gzip of CSS, and it should
stay there.

**Class 2 — what a route or a feature costs when somebody opens it, plus the
aggregates.** Nobody waits for these before the first screen. Their ceilings
are set with deliberate headroom — the reading plus twice a stated headroom,
rounded up — so ordinary honest work does not have to re-measure five builds to
change a sentence. What replaces the tight step is stricter measurement rather
than looser enforcement: every ceiling states a reading, every reading names
the reviewed variant that reproduces it, a ceiling above three headrooms is
refused, and a reading that grows by a quarter (or 16 KiB, whichever is
smaller, never less than a kilobyte) has to be accompanied by a sentence naming
what was added. Every budget records a previous reading as two numbers. There is
no "nothing recorded before this pass" form: it silenced the alarm for
twenty-six of fifty-nine budgets, and one line of it silenced a 16,983 B jump.

## Reviewed build variants

A reading nobody can rebuild is a number, not a measurement. These are the
build shapes this release reviews; `scripts/release-gate.mjs` exports them as
`REVIEWED_BUILD_VARIANTS` with the exact environment for each.

| Variant | Environment |
| --- | --- |
| canonical config-free | `npm run build:static` |
| Docker defaults | `AIRSHIP_PUBLIC_BASE_PATH=/ VITE_AIRSHIP_PUBLIC_ORIGIN= VITE_GOOGLE_CLIENT_ID= VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=ephemeral` |
| Pages | `AIRSHIP_PUBLIC_BASE_PATH=/airship/ VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=ephemeral` |
| Google-Drive-configured | `VITE_GOOGLE_CLIENT_ID=<web client id> VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=google-drive` |
| Pages Google-Drive-configured | `AIRSHIP_PUBLIC_BASE_PATH=/airship/ VITE_GOOGLE_CLIENT_ID=<web client id> VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER=google-drive` |

The last row is the shape this repository's own Pages workflow publishes when
the `VITE_GOOGLE_CLIENT_ID` repository variable is set, and until now no
comment measured it. A base path is inlined beside every asset URL, so each of
its characters costs about 9 raw bytes across the first-party aggregate, which
makes it the largest of the five. `VITE_GOOGLE_CLIENT_ID` is listed even when
empty because empty and absent are different builds: Vite inlines `""` for one
and `undefined` for the other, and the first-party and installed aggregates
measure 32 raw bytes more when it is absent. The Dockerfile's `ENV` line always
defines it.

## Executable asset ceilings

The gate measures raw and gzip bytes. The baseline includes the HTML entry and
preloads plus every dynamic chunk awaited before first render, including the
controlled-navigation boundary and the packs the shell mounts with.

Raw and gzip are separate claims. The gate checks the largest recorded raw and
gzip readings independently against the current build, in both directions: a
comment that overstates the artifact loses the ceiling it bought, and a comment
that understates it reports headroom the build does not have.

No gzip ceiling may sit within 512 bytes of the artifact it governs. Raw bytes
are a byte count; gzip bytes are whatever this machine's deflate implementation
produced, and compressing this build with Node 22.22.3's bundled compressor and
with zlib 1.2.12 at the same level differs by up to 388 B on one artifact and
431 B across the release. The tightest gzip margin used to be 35 B, so a
colleague on a different Node could be handed a red gate for a tree nobody
touched. Several gzip ceilings therefore take a further whole-KiB step with the
arithmetic written beside them: that step is not slack, it is the width of the
measuring instrument.

A few roles are declared absolute backstops rather than headroom claims — the
pinned Pyodide distribution, which is a byte set verified against recorded
SHA-256 digests, and the general WASM ceilings, which govern a class this build
does not emit. They still record a reading and are still compared with the
artifact. Entry and baseline raw bytes are *not* on that list: being called a
backstop removed every shape rule, and a 377 KiB entry ceiling could be rewritten
to 512 KiB with a green gate. Both raw roles take the same whole-KiB step rule as
their gzip halves.

| Class | Tier | Raw ceiling | Gzip ceiling |
| --- | ---: | ---: | ---: |
| HTML-referenced entry JavaScript | 1 | 378 KiB | 118 KiB |
| Baseline JavaScript/workers, including pre-render chunks | 1 | 491 KiB | 160 KiB |
| Deferred advanced capability bundle | 2 | 292 KiB | 87 KiB |
| First-party and other non-vendor JS/workers | 2 | 2038 KiB | 683 KiB |
| Browser Git + Terminal vendor runtime aggregate | 2 | 749 KiB | 248 KiB |
| Absolute installed JavaScript/worker backstop | 2 | 2723 KiB | 873 KiB |
| Service worker | 1 | 12 KiB | 5 KiB |
| Companion install-hub script | 2 | 8 KiB | 6 KiB |
| Optional execution broker | 2 | 6 KiB | 5 KiB |
| Optional execution engine | 2 | 5 KiB | 5 KiB |
| Optional execution support | 2 | 12 KiB | 7 KiB |
| Optional execution tools | 2 | 61 KiB | 18 KiB |
| Optional pinned WASI Preview 1 Worker | 2 | 33 KiB | 11 KiB |
| Optional Node/WebContainer pack | 2 | 52 KiB | 19 KiB |
| Optional first-party `airship-sh` shell pack | 2 | 124 KiB | 37 KiB |
| Optional browser-Git client | 2 | 22 KiB | 8 KiB |
| Optional shared route primitives | 2 | 23 KiB | 12 KiB |
| Optional request-failure vocabulary | 2 | 9 KiB | 6 KiB |
| Optional slash commands | 2 | 19 KiB | 9 KiB |
| Optional agent runtime | 2 | 74 KiB | 22 KiB |
| Optional agent runtime status | 2 | 6 KiB | 5 KiB |
| Optional multimodal parts | 2 | 5 KiB | 5 KiB |
| Optional context policy | 2 | 8 KiB | 6 KiB |
| Optional agent tool bundle | 2 | 162 KiB | 52 KiB |
| Optional Workspace workbench | 2 | 112 KiB | 36 KiB |
| Optional workspace binding | 2 | 5 KiB | 5 KiB |
| Optional workspace codec | 2 | 5 KiB | 5 KiB |
| Optional folder on this device | 2 | 20 KiB | 10 KiB |
| Optional Source Control | 2 | 50 KiB | 17 KiB |
| Optional source selection store | 2 | 2 KiB | 1 KiB |
| Optional browser Git engine | 2 | 326 KiB | 103 KiB |
| Optional Sessions route | 2 | 84 KiB | 25 KiB |
| Optional post-paint session metadata | 2 | 10 KiB | 7 KiB |
| Optional favorite ordering | 2 | 5 KiB | 5 KiB |
| Optional session fork | 2 | 18 KiB | 9 KiB |
| Optional Capabilities route | 2 | 17 KiB | 9 KiB |
| Optional browser capabilities | 2 | 23 KiB | 10 KiB |
| Optional Memory route | 2 | 82 KiB | 28 KiB |
| Optional Memory support | 2 | 7 KiB | 6 KiB |
| Optional move-work bundle pack | 2 | 25 KiB | 10 KiB |
| Optional Skills route | 2 | 12 KiB | 7 KiB |
| Optional skill editor | 2 | 8 KiB | 6 KiB |
| Optional shared confirm dialog | 2 | 6 KiB | 5 KiB |
| Optional keyboard shortcut sheet | 2 | 7 KiB | 6 KiB |
| Optional shell overlays | 2 | 12 KiB | 7 KiB |
| Optional palette actions | 2 | 5 KiB | 5 KiB |
| Optional lost-work report | 2 | 10 KiB | 7 KiB |
| Optional message parts | 2 | 18 KiB | 9 KiB |
| Optional approval dock | 2 | 17 KiB | 9 KiB |
| Optional Terminal | 2 | 488 KiB | 145 KiB |
| Optional semantic worker | 2 | 13 KiB | 8 KiB |
| Optional inference/provider + Companion protocol packs | 2 | 182 KiB | 53 KiB |
| Optional prime runtime pack | 2 | 290 KiB | 86 KiB |
| Optional Companion observation | 2 | 7 KiB | 6 KiB |
| Optional Local Device Vault | 2 | 76 KiB | 22 KiB |
| Pinned same-origin Pyodide distribution | 2 | 16384 KiB | 8192 KiB |
| HTML-referenced entry CSS | 1 | 144 KiB | 26 KiB |
| Each general WASM artifact, excluding separately capped engine WASM | 2 | 1024 KiB | 350 KiB |
| All general WASM, excluding separately capped engine WASM | 2 | 1024 KiB | 350 KiB |

## Main local commands

```sh
npm run build
npm run check:release
npm run test:e2e:static-host
```

Use `npm run check` for the broader local gate and `npm run test:e2e:master`
for the heavier browser matrix.

`npm test` runs the unit suite as a lab build, because that is the build whose
S3 and lab paths the suite exercises. `npm run test:stock` re-runs the
storage-choice suites with the lab composed out, so the picker, its comparison
table and every refusal are asserted in both build modes. `npm run check` runs
both, then builds and gates a stock artifact.

## Why this matters

Airship must stay an honest static product. The release gate exists to catch a
build that quietly grows a hidden backend dependency, leaks sensitive material,
or weakens the static browser security boundary — and to catch documentation
that has stopped describing it.
