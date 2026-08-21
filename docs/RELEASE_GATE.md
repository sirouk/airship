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
- any document the release did not review: `.html`, `.htm`, `.xhtml`, `.shtml`,
  `.svg` and `.xml` ship only from an exact list, and `404.html` must be a byte
  copy of the reviewed index;
- missing reviewed public files or broken static-host assumptions;
- missing security headers or service-worker boundary regressions;
- asset budget overruns;
- mismatches between optional static packs and their reviewed manifests.

## Executable asset ceilings

The gate measures raw and gzip bytes. Slash-separated figures follow the budget
names in the same order. The baseline includes the HTML entry and preloads plus
every dynamic chunk awaited before first render, including the
controlled-navigation boundary.

For measurement-justified ceilings, raw and gzip are separate claims. The gate
checks the largest documented raw and gzip readings independently against the
current build and keeps the unit and decimal precision of each selected figure.
For a role governed by the tight whole-KiB rule, its ceiling may take one
tripwire step beyond the smallest clearing step only when the comment states
matching `<n> KiB <role> would have left <m> B` arithmetic. Supported build variants therefore cannot hide crossed maxima or
lend one role another role's precision or margin. These checks do not raise any
ceiling.

| Class | Raw ceiling | Gzip ceiling |
| --- | ---: | ---: |
| HTML-referenced entry JavaScript | 377 KiB | 118 KiB |
| Baseline JavaScript/workers including pre-render chunks, optional packs excluded | 490 KiB | 160 KiB |
| Deferred advanced capability bundle | 229 KiB | 68 KiB |
| First-party and other non-vendor JS/workers | 1974 KiB | 618 KiB |
| Browser Git + Terminal vendor runtime aggregate | 686 KiB | 192 KiB |
| Absolute installed JavaScript/worker backstop | 2659 KiB | 809 KiB |
| Service worker | 12 KiB | 5 KiB |
| Optional execution broker / engine / support / tools | 32 KiB / 56 KiB / 10 KiB / 47 KiB | 10 KiB / 14 KiB / 4 KiB / 15 KiB |
| Optional pinned WASI Preview 1 Worker | 32 KiB | 8 KiB |
| Optional Node/WebContainer pack | 41 KiB | 15 KiB |
| Optional first-party `airship-sh` shell pack | 100 KiB | 30 KiB |
| Optional agent runtime / tool bundle | 57 KiB / 126 KiB | 18 KiB / 40 KiB |
| Optional Workspace / Source Control / browser Git | 86 KiB / 40 KiB / 262 KiB | 28 KiB / 13 KiB / 80 KiB |
| Optional folder on this device | 16 KiB | 6 KiB |
| Optional move-work bundle pack | 19 KiB | 6 KiB |
| Optional Sessions / Memory / Memory support | 66 KiB / 64 KiB / 3 KiB | 20 KiB / 21 KiB / 2 KiB |
| Optional Skills route / skill editor | 8 KiB / 4 KiB | 4 KiB / 2 KiB |
| Optional Terminal | 425 KiB | 113 KiB |
| Optional semantic worker | 16 KiB | 6 KiB |
| Optional inference/provider + Companion protocol packs | 141 KiB | 42 KiB |
| Optional prime runtime pack | 236 KiB | 72 KiB |
| Pinned same-origin Pyodide distribution | 16384 KiB | 8192 KiB |
| HTML-referenced entry CSS | 143 KiB | 26 KiB |
| General WASM excluding separately capped engine WASM | 1024 KiB / 1024 KiB | 350 KiB / 350 KiB |

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
or weakens the static browser security boundary.
