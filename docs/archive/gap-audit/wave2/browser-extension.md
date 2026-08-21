# Verifier report — browser-extension

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../../SIMPLIFICATION.md`](../../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

**honest=True**

## Verdict

Genuine, well-built work; the security boundary is implemented in code, not merely documented, and its tests are falsifiable. I mutated nine boundaries (destination prefix match, credentials:\"omit\", caller path check, redirect refusal, from-marker refusal, header allowlist, encoded-separator check, concurrency cap, event.source check) one at a time and every mutant was killed. tsc (both root and extension) is clean, the extension's 87 tests pass, `npm test` genuinely picks all 9 files up, `node extension/build.mjs` reproduces the reported byte sizes and SHA-256s exactly, and the built bundle contains zero storage/logging calls, exactly one fetch(, and one credentials:\"omit\". No credential is persisted anywhere. Provider availability is derived from observed capabilities with named causes and a 30s TTL, never from the browser name - the honesty posture holds. Two real defects: the concurrency cap and the duplicate-request-id refusal are both TOCTOU-racy across the `await resolveCapabilities()` in relay.ts, which I demonstrated (12 concurrent fetches against a cap of 4; two head/end pairs under one id). Neither is a cross-origin escape - the caller is still the allowlisted page - but rule 6's concurrency bound is not actually enforced in the window that matters. Two lesser normalization gaps (`..;` and `%252e%252e` survive the encoded-separator filter) and one over-refusal (that filter also rejects %2F inside a query string). None of these makes the extension a CORS-bypass weapon for a foreign page: the destination allowlist, provider binding, caller origin re-check, credential-free init, header allowlist, and total redirect refusal all held against every bypass I tried.

## Security findings

1. Concurrency cap (contract rule 6) is bypassable via a TOCTOU window at extension/src/relay.ts:330 vs :181, straddling `await options.resolveCapabilities()` at :138. Measured: 12 concurrent fetches against a cap of 4, 0 refusals. Reachable on worker wake and at each 30s capability-TTL boundary. Impact: resource-bound weakening / self-DoS by the allowlisted page, not a cross-origin escape.

2. Duplicate-request-id refusal (extension/src/relay.ts:315) has the same TOCTOU window; two requests with one id both execute and emit head+end, defeating the stated protection against a second request stealing the first's terminal message.

3. Encoded-separator filter at extension/src/policy.ts:229 covers only %2f/%5c/backslash. `https://api.x.ai/v1/..;/admin` and `https://api.x.ai/v1/%252e%252e/admin` both resolve ok:true - path-parameter and double-encoding shapes that a decoding router could walk off the approved prefix.

4. The `/airship/` caller path prefix is not a security boundary on GitHub Pages: `https://sirouk.github.io/other-project/` is the same origin as `/airship/` and can script the Airship window directly. Effective caller allowlist is the whole sirouk.github.io origin; the README's 'Answers the Airship page only (https://sirouk.github.io/airship/*)' reads stronger than the browser can deliver.

5. extension/src/policy.ts:370 only enforces top-frame-only when sender.frameId is a number; a browser that omits frameId reduces the worker-side subframe defence to the content script's own window.top===window guard.

6. Chromium userAgentOverride 'live' confirms only that a modifyHeaders session rule read back, not that the rewrite reaches the vendor; Firefox 'live' confirms only that addListener did not throw. Both are disclosed in code comments and in the report's notDone, but the README does not distinguish them. If Safari ever accepts and reads back a modifyHeaders rule it does not apply, hello would falsely claim Anthropic - unverifiable without a device.

7. No cross-origin bypass found: destination allowlist (host-suffix, traversal, %2e%2e, port, userinfo, scheme, fragment, cross-provider), caller origin/source checks, credentials:"omit", header allowlist (CRLF, non-ASCII, duplicates, oversize), and total redirect refusal (opaqueredirect, redirected flag, raw 3xx) all held under direct probing.

## Issues

1. CONFIRMED TOCTOU: the concurrency cap is bypassable. extension/src/relay.ts:330 checks inflight.size before `await options.resolveCapabilities()` at :138, but registration happens at :181. Measured directly: 12 requests dispatched against a cap of 4 produced peak 12 concurrent fetches and 0 refusals when the capability probe takes one macrotask. Reachable in the real worker (background.ts:100 does `void relay.handle(message)`; background.ts:64-70 re-observes capabilities on wake and every 30s via a genuine permissions.contains()+DNR round trip). The existing test passes only because it inserts `await flush()` before the third request.

2. CONFIRMED TOCTOU: the duplicate-request-id refusal has the same window. extension/src/relay.ts:315 checks inflight.has() before the same await. Two requests sharing one id produced ["head","end","head","end"] - two exchanges crossing on one id, exactly what the comment at relay.ts:316-318 says must not happen. The second entry also overwrites the first in the inflight map.

3. README overstates the concurrency bound: extension/README.md line 'Bounds | ... 4 concurrent requests' is true only outside the capability-observation window (see above).

4. extension/src/policy.ts:229 over-refuses: the /%2f|%5c|\\/iu filter tests the whole URL string including the query, so a legitimate percent-encoded query value (e.g. an OAuth redirect_uri) is refused with the misleading reason 'encoded path separator'. No test covers a legitimate encoded query value.

5. extension/src/policy.ts:370 skips the top-frame check when sender.frameId is not a number, so the README's 'top frame only, re-checked in the background worker' is conditional on the browser supplying frameId. Mitigated by all_frames:false and the window.top===window guard in content-script.ts.

6. extension/src/user-agent.ts:180 returns userAgentOverride 'live' on the Firefox path merely because addListener did not throw - an assertion, not an observation. The source comment is honest about this; the README's 'the worker observes that' does not distinguish the two mechanisms.

7. extension/src/protocol.ts iterates Object.entries(raw.headers) with no key-count bound before selectRequestHeaders applies the 16-header cap, so a page can make the worker walk an unbounded header object. Caller is the allowlisted page only.

8. Root `npx tsc --noEmit` does not cover extension/ (root tsconfig include is ["src","vite.config.ts"]). Disclosed in the report; `npx tsc -p extension/tsconfig.json --noEmit` is clean, as is root tsc.

9. No icons, no signed Firefox XPI, no committed Safari Xcode project, no packaging step. Disclosed.

10. Report listed a third full-suite failure in src/inference/bridge/client.test.ts that no longer reproduces; my `npm test` run showed 211 files / 1682 tests / 2 failed, both timeouts in src/execution/shell/cancellation.test.ts (foreign). Cosmetic drift, not a misstatement.
