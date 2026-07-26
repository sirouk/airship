# Airship Bridge (browser extension)

Airship is a static page. Two providers cannot be reached from a page at all:

- **xAI** advertises the RFC 8628 device flow, and `https://auth.x.ai/oauth2/device/code`
  answers `200` — with no `access-control-allow-origin`, so the page cannot read
  its own reply.
- **Anthropic**'s token host answers `429` to a `Mozilla/5.0` `User-Agent` and
  reaches code validation for a non-browser one. `User-Agent` is a forbidden
  header name, so no page script can set it.

This extension is the smallest thing that fixes both while keeping every secret
on the device. It relays five URL prefixes, for one origin, with no storage.

Full contract: [`docs/EXTENSION_BRIDGE.md`](../docs/EXTENSION_BRIDGE.md).

## What it will and will not do

| | |
|---|---|
| Fetches | `https://auth.x.ai/oauth2/`, `https://api.x.ai/v1/`, `https://claude.ai/oauth/`, `https://platform.claude.com/v1/oauth/`, `https://api.anthropic.com/v1/` — and nothing else, ever |
| Answers | a top-level document on `https://sirouk.github.io` under `/airship/`, re-checked in the background worker. **The origin is the real boundary** — see below |
| Sends | `credentials: "omit"`, `cache: "no-store"`, `redirect: "manual"`, `referrer: none`, `GET`/`POST` only |
| Path | only unreserved characters and `/` in the destination *path*, so `%2f`, `%25` (double encoding) and `;` path parameters are refused. The **query** is untouched — it cannot move the path, and an OAuth `redirect_uri` needs `%2F` |
| Forwards | `accept`, `anthropic-beta`, `anthropic-version`, `authorization`, `content-type`, `x-app`. Everything else is dropped and the drop is *reported back* |
| Stores | nothing. No `storage`, no `localStorage`, no `indexedDB`, no cookies, no logging of relayed traffic |
| Bounds | 256 KiB request body, 8 MiB response (16 MiB streamed), 32 KiB chunks, 8192 chunks, 4 concurrent requests (handshakes have their own budget of 4), 60 s deadline (300 s streamed, 45 s idle) |

Refusals are explicit messages, never silence: a page that asks for something
outside these lines gets a named error back.

The concurrency cap is enforced at admission, before the worker awaits anything,
so it holds against a burst of requests dispatched in one turn and not only
against requests that arrive one at a time. Same for the refusal of a repeated
request id. `relay.test.ts` dispatches concurrently to prove it; a sequential
test cannot see the difference.

### What the caller allowlist actually buys

The browser enforces the **origin**. The `/airship/` prefix decides which
documents the content script is injected into and which frame URLs the worker
will answer — it is not a security boundary, because
`https://sirouk.github.io/other-project/` is *same-origin* with Airship and can
open, script and drive the Airship window directly. On a shared-origin host like
GitHub Pages, the effective caller allowlist is the whole
`https://sirouk.github.io` origin, and it is exactly as trustworthy as everything
else published under it.

Serving Airship from an origin of its own is the only thing that makes the path
a boundary. If you do, edit `RELEASE_CALLERS` in `src/policy.ts` and rebuild.

### The `User-Agent` question

`fetch` cannot set `User-Agent` even from an extension, so it is applied by a
header-rewrite rule bound to a URL prefix (declarativeNetRequest on Chromium, a
blocking `webRequest` listener on Firefox). A rule matches a URL, not a request,
so the value is **compiled in per destination**:

| destination | user agent | why |
|---|---|---|
| `https://claude.ai/oauth/`, `https://platform.claude.com/v1/oauth/` | `axios/1.7.9` | measured: the token host answers `429` to `Mozilla/5.0` |
| `https://api.anthropic.com/v1/` | `claude-code/1.0.0` | Anthropic's OAuth inference path is served to that fingerprint |
| `https://auth.x.ai/`, `https://api.x.ai/` | the browser's own | no override needed |

If the page asks for a *different* `user-agent`, the request is refused rather
than sent with a value the caller did not choose. Rewrite rules apply only to
requests this worker makes (`tabIds: [-1]`); nothing you browse changes agent.

#### What "the override is live" is, and is not, evidence of

`hello` reports Anthropic only when the worker got the override installed. The
evidence differs by engine, and the difference is not smoothed over:

| engine | mechanism | evidence for `live` | strength |
|---|---|---|---|
| Chromium | `declarativeNetRequest` session rule | the rule is **read back** from the browser and still carries the exact `user-agent` rewrite | observation |
| Firefox | blocking `webRequest` listener | `addListener` returned, and `hasListener` confirms it is attached where the engine exposes it | registration, read back — but nothing about the wire |
| Safari | none offered | never `live` | — |

**Neither mechanism is evidence that the vendor received the rewritten agent.**
Only the vendor's reply shows that, and the relay hands that reply back
untouched. What these checks do rule out is the case that matters: claiming
Anthropic on a browser with no rewrite mechanism at all.

One residual risk is stated rather than hidden: a browser that accepted a
`modifyHeaders` rule, read it back intact, and then did not apply it would be
reported as `live` and Anthropic would fail at the token exchange with the
vendor's own `429`. The read-back is checked down to the header value to make
that harder, but it cannot be excluded without a device to measure on.

If the browser offers no rewrite mechanism at all, the worker observes that and
`hello` reports **Anthropic as unavailable, with the reason** — it never claims a
provider it cannot carry. xAI needs no override and keeps working.

## Browser support

| browser | supported | how |
|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi, Arc (desktop) | yes | `build/release/chromium`, MV3 service worker, Chrome 116+ |
| Firefox desktop | yes | `build/release/firefox`, MV3 event page, Firefox 128+ |
| Firefox for Android | yes | same Firefox build; the only mobile browser with real extension support |
| Safari desktop / iOS / iPadOS | yes, **xAI only** | `build/release/safari` — MV3 non-persistent background page, Safari 16.4+, loaded through an Xcode wrapper (below). Safari has neither header-rewrite mechanism, so Anthropic reports unavailable and xAI works |
| **Chrome for Android** | **no** | Chrome on Android has no extension support at all. Anthropic and xAI stay unavailable there. Every other provider is unaffected |
| Chrome OS, Chromium forks with MV3 | yes | Chromium build |

Airship must never imply the bridge is available where it is not, or that it
carries a provider it cannot. Presence is a live `hello` per page load, never a
user-agent guess. The page memoizes one `hello` result for at most 30 s
*within* a page load (`presenceTtlMs`, `src/inference/bridge/protocol.ts`); that
memo is never persisted and never survives a reload, so the staleness is bounded
and no absence of an extension can ever read as presence.

## Build

```sh
node extension/build.mjs                        # release, all three targets
node extension/build.mjs --target=firefox       # one target
node extension/build.mjs --target=safari        # input to the Xcode wrapper
node extension/build.mjs --channel=development  # adds http://localhost:4173 and http://127.0.0.1:4173
```

Output goes to `extension/build/<channel>/<target>/`, printing the byte size and
SHA-256 of each artifact. Builds are **not minified**: a browser reviewer and a
suspicious user both have to be able to read what they are installing.

The build fails closed if a bundle contains a storage API, a logging call, or
`externally_connectable`, and `build.test.mjs` asserts that a release artifact
does not so much as *contain* the development origins.

The `development` channel is a separate build precisely so a shipped extension
can never be reached by an unrelated page on a developer's machine.

### Self-hosting Airship

The caller allowlist is compiled in. If you serve Airship from your own origin,
edit `RELEASE_CALLERS` in `src/policy.ts` and rebuild; the content-script match
patterns are generated from that same list, so they cannot drift apart.

## Install

### Chrome / Edge / Brave / Opera / Vivaldi / Arc

1. `node extension/build.mjs --target=chromium`
2. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`, …).
3. Turn on **Developer mode**.
4. **Load unpacked** → select `extension/build/release/chromium`.
5. Reload the Airship tab. Connect → the bridge reports itself.

To reload after a rebuild, press the ↻ icon on the extension card.

### Firefox (desktop)

1. `node extension/build.mjs --target=firefox`
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → select
   `extension/build/release/firefox/manifest.json`.
4. Firefox treats MV3 host permissions as **opt-in**. Open `about:addons` → the
   Airship Bridge → **Permissions**, and allow access to the provider hosts.
   Until you do, `hello` honestly reports every provider as unavailable with
   "not been granted access to the provider hosts".

A temporary add-on is removed when Firefox closes. For a persistent install,
sign the build with `web-ext sign` (an unsigned add-on cannot be installed
permanently in release Firefox).

### Firefox for Android

Firefox for Android installs extensions from an add-on collection (or from
`about:debugging` over USB with `adb` in the Nightly build). The build is the
same `--target=firefox` output; no separate source.

### Safari (desktop, iOS, iPadOS)

Safari cannot load an unpacked extension directly: a Safari web extension is
delivered inside a native app bundle. The same source tree is the input.

```sh
node extension/build.mjs --target=safari
xcrun safari-web-extension-converter extension/build/release/safari \
  --project-location extension/build/safari-xcode \
  --app-name "Airship Bridge" --bundle-identifier ai.chutes.airship.bridge \
  --swift --no-open
```

The Safari target differs from the other two in exactly two ways, both in
`src/manifest.ts`: an MV3 **non-persistent background page** rather than a
service worker, and `browser_specific_settings.safari.strict_min_version`
`16.4` — the same release `build.mjs` compiles the bundle for, so the manifest
cannot admit a Safari that would not parse it. No rewrite permission is
requested, because Safari has no mechanism to honour one.

**Route 1 — run it locally, unsigned.** No paid account needed.

1. Open `extension/build/safari-xcode/Airship Bridge/Airship Bridge.xcodeproj`.
2. Set the signing team to *None* / your personal team, and build & run once
   (⌘R). The container app launches and registers the extension.
3. Safari → Settings → **Advanced** → tick *Show features for web developers*.
4. Safari → **Develop** → **Allow Unsigned Extensions**. This resets every time
   Safari restarts, so it is a development route, not an install.
5. Safari → Settings → **Extensions** → enable *Airship Bridge*, then grant it
   access to the provider hosts (Safari asks per host).
6. Reload the Airship tab.

On iOS/iPadOS the equivalent is running the converted app on a device from
Xcode, then Settings → Safari → Extensions → enable and allow the hosts.

**Route 2 — distribute through the App Store.** Requires a paid Apple Developer
account. Sign the container app with a Developer ID (macOS) or a distribution
profile (iOS), notarise it, and submit; App Review reads the extension source,
which is why `build.mjs` never minifies. This repository ships no signed Safari
build and no committed Xcode project — the converter regenerates one from the
manifest above, so there is no second copy of the boundary to drift.

**Known Safari limitation, and its consequence.** Safari offers neither
declarativeNetRequest header rewriting nor blocking `webRequest`. `User-Agent`
therefore cannot be rewritten, so:

- **xAI works.** It needs no override.
- **Anthropic reports unavailable**, with the reason, and Airship must not
  offer it. Anthropic **API keys** are unaffected — they never use the bridge.

That report comes from what the worker observed at runtime, not from the
browser's name. The Safari manifest withholds the permission (there is none to
ask for); it does not hard-code the answer.

## How it works

```
page  --postMessage-->  content script  --port-->  background worker  --fetch-->  provider
page  <--postMessage--  content script  <--port--  background worker  <---------  provider
```

`externally_connectable` is deliberately unused: it is Chromium-only, and a
content script plus `postMessage` is the one shape that works on all three
engines.

Messages are `{ airshipBridge: 1, from, id, kind, … }`. The page sends `hello`,
`fetch` and `cancel`; the worker answers one `head`, ordered base64 `chunk`s
(`seq` from 1), and exactly one `end` or `error`. `from` exists because
`window.postMessage` delivers a page's own message back to the page, so without
a direction marker a `hello` request and a `hello` reply are the same message.

If the background worker dies mid-request, the content script answers every
outstanding id with `bridge-disconnected` rather than leaving the page waiting.

## Layout

| file | role |
|---|---|
| `src/policy.ts` | the whole boundary: destinations, callers, headers, ceilings |
| `src/protocol.ts` | envelope parsing and reply construction |
| `src/relay.ts` | the request state machine — injectable `fetch`, clock and channel |
| `src/content-bridge.ts` | page framing and the per-page port |
| `src/user-agent.ts` | the rewrite rules and the honest report of whether they installed |
| `src/manifest.ts` | one manifest per target, generated from the allowlists |
| `src/background.ts`, `src/content-script.ts` | thin entries; they supply the platform and nothing else |

## Tests

```sh
npx vitest run extension/src extension/build.test.mjs   # this package only
npm test                                                # the repository suite picks these up too
npx tsc -p extension/tsconfig.json --noEmit             # the root tsconfig covers src/, not this tree
```

They are plain vitest against the handlers as pure functions — no browser, no
`webextension-polyfill`, no mocking framework. Each boundary rule has a test
that proves the *refusal*: a non-allowlisted host, a non-allowlisted path prefix
under an allowlisted host, a path shape a decoding router could walk off that
prefix, a foreign caller origin, a sender whose frame the browser did not
identify, a dropped header, an injected header value, a substituted user agent,
an over-budget body, an over-budget response, a chunk-count ceiling, a deadline
breach, a concurrency cap, a repeated request id, and four shapes of redirect.

The concurrency cap and the repeated-id refusal are additionally tested by
*concurrent* dispatch — twelve requests handed to the relay in one turn — because
a sequential test passes whether or not the check runs before the reservation it
depends on, and so cannot tell you the bound holds.

`src/interop.test.ts` runs this relay against the *page's* reply parser
(`src/inference/bridge/protocol.ts`), so the two packages cannot drift apart
without a red test.
