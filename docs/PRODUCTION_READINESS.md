# Airship production readiness

Updated: 2026-07-26

Airship is a static, edge-first application. The browser owns the agent
runtime, workspace, credentials, provider connections, local indexes, and
encrypted cache. Airship does not introduce an application backend to make the
companion extension work.

This document separates the state of the repository from the external release
work that cannot be completed by source code alone.

## Release state

| Surface | Repository state | Production distribution state |
| --- | --- | --- |
| Airship PWA | Static build, release budgets, CSP/security checks, PWA assets, and GitHub Pages workflow are present | Not deployed: the public URL is currently 404, Pages run `29720716701` was blocked before execution by account billing/spending limits, and the audited branch is not merged to `main` |
| Chrome | Manifest V3 release package, deterministic ZIP, checksum, install instructions, privacy disclosure, popup, provider relay, encrypted cache, and background compute are present | Chrome Web Store publisher upload, review, and signing remain external |
| Microsoft Edge | Uses the reviewed Chromium Manifest V3 package | Microsoft Partner Center upload, review, and signing remain external |
| Firefox desktop | Firefox-specific WebExtension package and temporary-install path are present | Permanent installation requires Mozilla AMO signing/review |
| Firefox Android | The Firefox package is the intended mobile extension path | Real-device compatibility and AMO Android availability must be signed off before claiming support |
| Safari macOS / iOS / iPadOS | Safari-targeted WebExtension source package is present | Requires Apple’s Safari Web Extension Packager (App Store Connect or command line), owned bundle/team identifiers, a containing native app, signing, real-device testing, and App Store review |
| Chrome / Edge Android | Airship PWA remains usable | These browsers do not provide a general mobile extension installation path; the UI must not offer an impossible install |

The install hub is served at `/extension/index.html`. It exposes source packages today
and must switch to signed store links when the store listings exist. Developer
or temporary-install packages are acceptance artifacts, not a substitute for a
signed production release.

## Companion boundary

The extension has three independent, inspectable capabilities:

1. **Provider relay.** A fixed-destination, bounded relay for reviewed provider
   protocols blocked by ordinary page CORS/header policy. It does not persist
   tokens, include cookies, follow redirects, or create provider authorization.
2. **Encrypted acceleration cache.** Disabled by default. When the user enables
   it in the extension popup, it accepts only caller-declared ciphertext pages
   subject to namespace, item, count, total-byte, and integrity limits. The
   Vault remains authoritative.
3. **Background compute.** Bounded SHA-256 and cosine top-k work can move off the
   Airship interface thread. This is a measured responsiveness benefit; the UI
   does not claim GPU or native acceleration that was not actually activated.

The provider grant and the transport are deliberately separate. Installing the
extension can make an already-supported OAuth or API protocol reachable. It
cannot manufacture an OAuth grant that OpenAI, Anthropic, xAI, or another
provider has not documented and approved for third-party use.

## Provider launch contract

| Provider | Current Airship contract |
| --- | --- |
| Chutes | Authorization Code + S256 PKCE when the registered Chutes app is public/native and the production callback is registered; API credential remains an explicit alternate lane |
| OpenAI | API credential path only until Airship owns a documented, reviewed third-party OAuth grant and callback contract |
| Anthropic | API credential path only until Airship owns a documented, reviewed third-party OAuth grant and callback contract |
| xAI | API credential path only until Airship owns a documented, reviewed third-party OAuth grant and callback contract |
| Ollama / LM Studio | Local discovery and explicit local endpoint connection; no cloud OAuth implied |

Provider cards must report this state honestly. “Extension ready” means the
transport is reachable; it never means the account is authorized.

## Required release gates

Run from the repository root:

```sh
npm ci
npm run check
npm run test:e2e
npm run test:e2e:master
npm run test:e2e:static-host
```

Before a tagged public release, also run:

```sh
npm run test:e2e:portability
npm run semantic:prepare
npm run test:e2e:semantic
```

The semantic command enables both the direct worker and production-UI gates.
It fails if the prepared, hash-pinned same-origin pack is absent or cannot
execute; it does not turn missing assets into skipped release evidence.

`npm audit --omit=dev --audit-level=high` currently reports zero production
dependency vulnerabilities. The full development audit still reports the
no-fix `sharp`/libvips advisory inherited by the pinned Transformers.js build
tool. Airship neither invokes that Node image path nor ships `sharp` or libvips
in the PWA, extension, or semantic pack; Transformers.js therefore remains a
development dependency and this upstream build-environment advisory stays
visible rather than being misrepresented as client runtime exposure.

Where credentials and infrastructure are available, run the opt-in live gates:

```sh
npm run test:e2e:live
npm run test:e2e:google-drive
npm run test:e2e:dcap-live
npm run test:vault:live
npm run test:chutes:live
```

`test:chutes:live` requires `CHUTES_TEST_API_KEY`; `CHUTES_TEST_MODEL` may
override its reviewed default. The command fails when the credential is absent
and must never report a release pass composed only of skipped live tests.

The master matrix explicitly enables and runs `e2e/live-webcontainer.spec.ts`
on its one authoritative desktop Chromium project; tablet and phone projects
continue to prove the supported fallback surfaces. The DCAP live gate owns
strict port 4191 and requires a captured
`.airship-lab/attest/fixtures/evidence.json` plus outbound access to current
Intel collateral. Invoking its npm script enables the gated spec, so a missing
fixture or failed collateral verification is a failure rather than a silent
release pass.

The static-host command first rebuilds and release-validates `dist/`, then
serves that exact output from an ordinary Node server that deliberately sends
no COOP, COEP, or CORP headers. A fresh Chromium
profile must observe the first headerless document, one service-worker takeover
reload, an isolated controlled document with `SharedArrayBuffer`, no reload
loop, and a browser-owned WebContainer terminal that executes a real Node
command. This is the release proof that Airship does not quietly depend on
deployment-specific `_headers` support for its browser execution tier.
The same gate delays first install, begins an unsent chat draft, and verifies
that takeover is deferred behind an explicit reload once the user has
interacted. It then installs a changed worker and proves one click promotes and
reloads it without losing the draft.

The checked-in companion acceptance launches a real Chromium extension context,
opens the actual popup, enables the encrypted cache, performs a ciphertext
round-trip, invokes background hashing, reloads Airship, and confirms the
capability remains live.

## External launch checklist

Airship is production-distributable only after all of the following are true:

- [ ] Resolve the GitHub account billing/spending-limit failure that currently
  prevents the Pages workflow from starting.
- [ ] Merge the reviewed release commit to `main`, run required checks against
  that exact SHA, publish its Pages artifact, and verify the public URL no
  longer returns 404.
- [ ] Set the GitHub Pages repository variables documented in
  `.github/workflows/pages.yml`, including the production origin and public
  OAuth client identifiers.
- [ ] Register exact production OAuth callbacks. No client secret may be
  embedded in the PWA or extension.
- [ ] Upload, review, sign, and publish the Chrome, Edge, and Firefox packages.
- [ ] Run the Safari source through Apple’s Web Extension Packager, assign
  owned identifiers, sign the containing apps, and pass macOS/iPhone/iPad
  acceptance.
- [ ] Replace developer-package calls to action with signed store links while
  retaining checksums and the privacy disclosure.
- [ ] Capture store screenshots and complete each publisher privacy/data-use
  declaration from the actual reviewed build.
- [ ] Run the full release gates against the exact commit and exact generated
  artifacts that will be published.
- [ ] Perform real-device signoff for Chromium desktop, Firefox desktop,
  Safari desktop, iPhone, iPad, and the supported Firefox Android configuration.
- [ ] Confirm Chutes production PKCE, encrypted invocation, and fresh evidence
  verification with the production registration.
- [ ] Confirm Google Drive consent, encrypted shard upload/download, offline
  recovery, and revocation with the production Google registration.

Until those account-bound checks are complete, the correct release label is:
**source-complete release candidate**, not **production distributed**.

## Publisher references

- [Chrome Web Store publishing](https://developer.chrome.com/docs/webstore/)
- [Microsoft Edge Add-ons publishing](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Mozilla signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Apple Safari Web Extension Packager](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Apple App Store Connect web-extension packaging](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)
