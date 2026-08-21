# Verifier report — connect-inference-ux

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../../SIMPLIFICATION.md`](../../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

**honest=False**

## Verdict

Substantially real work, unusually candid self-reporting, and genuinely falsifiable tests -- but one material overclaim makes honest=false. VERIFIED: tsc --noEmit clean; vitest src/ui 61 files / 398 tests pass with exactly 99 in src/ui/connect; the two falsifiability reverts produce exactly the claimed 1 and 2 failures; playwright connect-inference.spec.ts runs 12 passed / 4 skipped and disconnected-capabilities 4/4; check:security passes; check:release fails on a budget credibly attributable to the concurrent inference package; the paste-code conformance test runs the real src/auth authority rather than a mock; no credential is persisted anywhere; AccessView is genuinely behind the deferred dynamic import; B12 and the first-run card/banner/welcome findings are really fixed and covered. NOT AS CLAIMED: the extension-bridge observation is not consumed by anything -- observationFromHandshake, bridgeObservation and probeExtensionBridge have zero production callers, so the lanes render a compiled-in NO_BRIDGE_CLIENT constant while the summary and interfacesExported present the consumption as delivered and notDone does not disclose it. That is the one requirement the task stated most explicitly ("consume it, never assume it, never cache it"), and it was reported as done. Around it sit real honesty defects on the shipped surface: an "Add the Airship extension" CTA that cannot work in this build, a Chutes lane summary that re-offers sign-in one line above the sentence saying sign-in is unavailable, a "Check this machine" button that checks nothing, a Grok lane whose no-alternative state is test-locked while the same page sells an xAI API key, and a connect surface that vanishes once Chutes is connected. Nothing was stubbed, deleted or weakened to pass; the gaps are unwired ports and copy that outruns behaviour, not fabricated results. Security review of the extension and bridge found no bypass: all six documented boundary rules are enforced in code with tests over the built artifacts.

## Security findings

1. No bypass found in the extension boundary. Every rule in docs/EXTENSION_BRIDGE.md is enforced in code, not merely documented.

2. Destination allowlist: extension/src/policy.ts:92-121 compiles in exactly the five documented origin+path prefixes; policy.ts:252 matches normalized `url.href.startsWith(prefix)`. I probed `..` traversal, `:443`, uppercase host, `api.x.ai.evil.com`, IDN/punycode homographs, embedded credentials and fragments -- all refused (policy.ts:229 rejects %2f/%5c/backslash pre-parse; 241-249 rejects non-https, userinfo, hash). The declared provider must also own the destination, so an Anthropic token cannot be posted to an xAI endpoint.

3. No redirect escape: `redirect: "manual"` is hardcoded in the frozen init (relay.ts:54,193) and isRedirect() checks opaqueredirect, `redirected`, and raw 3xx status independently (relay.ts:366-370).

4. credentials: "omit" is hardcoded, not caller-supplied (relay.ts:48,193), so the bridge cannot ride logged-in claude.ai cookies.

5. Caller origin check: checkSender (policy.ts:363-389) requires an allowlisted frame URL, rejects non-top frames, and requires sender.origin to agree with the frame URL. Content script is registered only for https://sirouk.github.io/airship/* in the release manifest; the dev loopback origins fold out of the release bundle at build time (policy.ts:177-187).

6. Header allowlist is positive (policy.ts:132-140); CRLF injection is impossible via HEADER_VALUE = /^[\x20-\x7e]*$/ (policy.ts:276); duplicate and oversized headers refused; a caller-supplied user-agent that disagrees with the destination's compiled-in value is refused rather than silently substituted (relay.ts:165).

7. No credential storage: extension/src/boundary.test.ts:18-22 greps the BUILT artifacts for localStorage/.storage/.cookies; the release manifest carries only declarativeNetRequestWithHostAccess.

8. Bounds enforced: BRIDGE_LIMITS (policy.ts:61-77) with request/response/stream/chunk ceilings, wall-clock and idle deadlines, and a concurrency cap, all checked while reading (relay.ts:182-184, 250-294, 330-336).

9. Unsolicited-message injection: the page client requires matching event.origin, event.source, `from === "extension"`, and an id already in #pending before acting (src/inference/bridge/client.ts:419-435); the relay refuses a duplicate in-flight id so a second request cannot steal the first one's terminator (relay.ts:315-321); the content script drops replies re-delivered to the page (content-bridge.ts:65).

10. UA rewrite is scoped to tabIds [-1] (extension/src/user-agent.ts:72), so installing the extension never changes the user agent of anything the user browses.

11. Presence memoization: src/inference/bridge/client.ts:409 memoizes the handshake for `presenceTtlMs` within a page load. That is per-page-load, not persisted, so it does not violate the "never cached across loads" rule -- but it is a bounded staleness window worth naming in the doc.

12. No credential was persisted by this package: src/ui/connect/ contains zero references to localStorage, sessionStorage, indexedDB, caches, document.cookie or navigator.storage. The pasted authorization code lives in component state only and is previewed as first4...last4 (authorization-code-paste.ts:228).

## Issues

1. OVERCLAIM (basis for honest=false): the summary and interfacesExported present the extension-bridge observation as consumed ("Extension-dependent lanes consume the bridge package's handshake outcome"), and notDone does not qualify it. Nothing consumes it. `observationFromHandshake` (src/ui/connect/extension-bridge-presence.ts:113) has zero production callers; app.tsx never passes `bridgeObservation`; and `probeExtensionBridge()` (src/capabilities/extension-bridge.ts:89) -- the observation record another package provides, exactly what the task said to consume -- is called nowhere in the repo. The surface always renders the compiled-in constant NO_BRIDGE_CLIENT (src/ui/access-view.tsx:52).

2. Claude/Grok lanes render the action label "Add the Airship extension" (src/ui/connect/connect-lanes.ts:224-230) in a build with no bridge client, so following that instruction cannot work. Only the smaller observation line admits it. Verified by probing the running app: header reads "Claude | Anthropic | Add the Airship extension".

3. Chutes lane summary "Encrypted inference with per-turn evidence. Sign in, or paste an API key." (connect-lanes.ts:114) renders one line above "Chutes sign-in isn't available in this build" -- the exact B3 pattern of offering a route that does not exist, reintroduced at the summary line. Same pattern on the Codex lane (connect-lanes.ts:115 vs "Not available here").

4. Local lane's primary button is labelled "Check this machine" (connect-surface.tsx:360) but its handler is `onOpenDirectProviders`, which only scrolls; no loopback probe is issued. The lane copy explicitly says checking happens "only when you press Check".

5. The primary B3 fix (auto-expanded API-key panel) is not covered behaviourally. I reverted `open={!chutesSignInAvailable}` (access-view.tsx:700) and the entire e2e spec still passed 6/6 -- the cold-visitor test opens the disclosure itself (connect-inference.spec.ts:44-46). Only a source-string grep (access-view.copy.test.ts:37) fails.

6. ConnectSurface renders only while Chutes is disconnected (access-view.tsx:566/658). A Chutes-connected user loses the whole five-lane surface, and `chutesStatus`'s `connected` branch (connect-lanes.ts:141) plus its rank-0 ordering are unreachable in production.

7. Grok lane offers no API-key alternative and an e2e assertion pins that absence (connect-inference.spec.ts:86), while the same route lists xAI among browser-direct API-key providers (provider-connections-view.tsx:28) and index.html allowlists https://api.x.ai. Disclosed in contractIssues, but shipped and test-locked in the under-claiming direction.

8. `BridgeHandshakeOutcome` is documented as mirroring `BridgeHandshakeResult` "exactly" (extension-bridge-presence.ts:94) but nothing type-binds them; no test imports the real type. Drift would be silent.

9. The extension-absent e2e assertions (connect-inference.spec.ts:56-87) are not mocked, but they assert a state that is a compiled-in constant rather than an observation, so they cannot prove the observation path works.

10. Minor: check:release now throws at the first budget (Optional inference providers, raw 116.14 KiB > 112.00) and never reaches the "First-party JavaScript" budget the report also listed as failing. Attribution to the concurrent inference package is credible (+1302 lines in src/inference, none of which the connect surface touches).

11. Minor vocabulary residue: h1 "Connect models" (access-view.tsx:538) vs h2 "Connect a model" (connect-surface.tsx:73) on the same screen.
