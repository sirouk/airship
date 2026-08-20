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
