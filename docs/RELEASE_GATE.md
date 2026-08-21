# Static release gate

Airship ships as a static client. `npm run build` therefore ends by validating
`dist/` rather than preparing a server release.

## The release gate blocks on

- source maps or stray source-map directives;
- credential-shaped payloads in shipped artifacts;
- missing reviewed public files or broken static-host assumptions;
- missing security headers or service-worker boundary regressions;
- asset budget overruns;
- mismatches between optional static packs and their reviewed manifests.

## Executable asset ceilings

The gate measures raw and gzip bytes. Slash-separated figures follow the budget names in the same order.

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
| Baseline JavaScript and workers, lazy packs excluded | 494 KiB | 161 KiB |
| Deferred advanced capability bundle | 246 KiB | 72 KiB |
| First-party and other non-vendor JS/workers | 1962 KiB | 613 KiB |
| Browser Git + Terminal vendor runtime aggregate | 685 KiB | 191 KiB |
| Absolute installed JavaScript/worker backstop | 2646 KiB | 803 KiB |
| Service worker | 12 KiB | 5 KiB |
| Optional execution broker / engine / support / tools | 32 KiB / 56 KiB / 10 KiB / 47 KiB | 10 KiB / 14 KiB / 4 KiB / 15 KiB |
| Optional pinned WASI Preview 1 Worker | 32 KiB | 8 KiB |
| Optional Node/WebContainer pack | 41 KiB | 15 KiB |
| Optional first-party `airship-sh` shell pack | 100 KiB | 30 KiB |
| Optional agent runtime / tool bundle | 57 KiB / 126 KiB | 18 KiB / 40 KiB |
| Optional Workspace / Source Control / browser Git | 86 KiB / 40 KiB / 262 KiB | 28 KiB / 13 KiB / 80 KiB |
| Optional Sessions / Memory / Memory support | 64 KiB / 64 KiB / 2 KiB | 20 KiB / 21 KiB / 1 KiB |
| Optional Skills route / skill editor | 8 KiB / 4 KiB | 4 KiB / 2 KiB |
| Optional Terminal | 425 KiB | 112 KiB |
| Optional semantic worker | 16 KiB | 6 KiB |
| Optional inference/provider + Companion protocol packs | 142 KiB | 42 KiB |
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

## Why this matters

Airship must stay an honest static product. The release gate exists to catch a
build that quietly grows a hidden backend dependency, leaks sensitive material,
or weakens the static browser security boundary.
