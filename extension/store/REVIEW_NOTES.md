# Airship Companion reviewer notes

Version: 1.1.0

## Reproduce the submitted source

```sh
npm ci
npm run build:extension
cat public/extension/releases/SHA256SUMS
```

The packages are deterministic ZIP archives with fixed timestamps and sorted
paths. Bundles are intentionally unminified.

## Test the extension

For the localhost build:

```sh
npm run dev
npm run build:extension
npx playwright test e2e/companion-extension.spec.ts --project=desktop-chromium
```

The acceptance test loads the actual Chromium extension, completes a live
companion handshake, opts into the cache from the popup, round-trips an
encrypted fixture, performs a background digest, reloads Airship, and checks the
live UI report.

## Permission justification

- `activeTab` (all targets): after the user opens the popup, inspect that one
  tab's URL and report whether it falls inside this build's compiled Airship
  caller allowlist. It does not grant persistent tab history or page contents,
  and an allowlist match is not reported as a live relay.
- Host permissions: exact provider API/auth prefixes compiled into
  `src/policy.ts`. They are the only relay destinations.
- `declarativeNetRequestWithHostAccess` (Chromium): applies a fixed
  `User-Agent` override for the Anthropic compatibility route because page
  Fetch cannot set that forbidden header.
- `webRequest` + `webRequestBlocking` (Firefox): Gecko’s equivalent fixed
  override mechanism.
- `unlimitedStorage` (Chromium/Firefox): protects the optional encrypted cache
  from small extension-origin quotas. Airship still enforces 4 MiB per record,
  256 MiB total, and 4,096 records.

Safari requests no unavailable header-rewrite or unlimited-storage permission;
it requests only `activeTab` for the same popup diagnostic.

## Data separation

Provider relay requests never enter IndexedDB. The cache is a separate
`airshipCompanion:1` protocol and accepts a write only when the page marks it
`ciphertext: true`. The extension stores no provider token, provider request,
provider response, cookie, or analytics event.

## Known distribution limitations

Store signatures and Apple native wrapper signatures are account-bound. The
repository cannot create them. The install hub labels all current ZIPs as
developer/source packages until the corresponding store listing is live.
