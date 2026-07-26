# Verifier report — page-side-bridge

**honest=True**

## Verdict

Honest. The package implemented what it reported: nothing is stubbed, commented out, or weakened to pass. `npx tsc --noEmit` exits 0. Its own five test files are 60/60 green (the 6-file/78-test figure also reproduces, but the sixth file is another package's work); `npm test` is 210/211 files passing with the only failure in src/execution/shell/cancellation.test.ts, which is foreign and untouched by this scope. Tests are genuinely falsifiable: four independent mutations (origin/source check at client.ts:419, id correlation at client.ts:423, destination allowlist at protocol.ts:310, no-silent-fallback in browser-cloud.ts sendProviderRequest) each made exactly the asserting test fail, and all four were reverted (tree verified byte-identical). Handshake presence is a live observation with fail-closed silence, the extension version is the one the reply carried, prompt entries are emitted only when observed, and the absent-bridge OAuth path reports `bridge-unavailable` with the cause named rather than a network verdict. No credential is persisted anywhere. Two substantive defects: (1) the concurrent-request cap is not actually enforced -- check-then-increment straddles an await, and 10 simultaneous callers all got through a cap of 2 in a live probe; (2) the page-side destination allowlist compares raw string prefixes, so `https://api.anthropic.com/v1/../../evil` passes the page (it is caught by the extension's normalized check, so no end-to-end bypass, but the code comment claiming the page never sends anything the extension must refuse is false). Plus a 300 s exchange with no head/first-byte deadline, a 30 s presence memo on the request path that the summary's \"never cached\" phrasing understates, and a now-duplicated presence type in src/ui/connect/extension-bridge-presence.ts that silently drops the extension's own `unavailable[]` reason.

## Security findings

1. Origin + source identity check IS enforced and IS load-bearing: mutation removing client.ts:419-420 made "ignores a reply from another origin or another window" fail (24 tests -> 1 failed). Reverted.

2. Id correlation is single-use and unguessable (UUIDv4 from Web Crypto, src/core/id.ts): mutation making `#receive` fall back to the first pending exchange when the id does not match (client.ts:423) made "drops an unsolicited message instead of letting it settle a live exchange" fail. Reverted. A hostile same-origin script cannot blind-inject into a pending request; it can only interfere if it can read the id, which the module documents as unachievable in a shared realm.

3. Destination allowlist is enforced page-side and is load-bearing: mutation making `isBridgeDestination` return true (protocol.ts:310) failed 3 tests across 2 files. Provider->prefix binding is per-provider, so an xAI token cannot be sent to an Anthropic host. Reverted.

4. No silent fallback: mutation replacing the `bridge-unavailable` throw in browser-cloud.ts `sendProviderRequest` with a direct fetch failed "reports Anthropic OAuth as unavailable, with the cause named, when no bridge exists". Reverted.

5. Header allowlist REFUSES rather than drops, verified by probe: `Authorization` accepted case-normalized; `"authorization "` (trailing space) REFUSED; `x-api-key`, `cookie`, `origin` REFUSED; `authorization: "Bearer x\r\nX-Injected: 1"` REFUSED on the control-char rule (protocol.ts:339). Page allowlist (protocol.ts:40-48) is byte-identical to the extension's FORWARDED_REQUEST_HEADERS (extension/src/policy.ts:132-140), as claimed.

6. postMessage targets the exact origin, never "*" (client.ts:494), so a bearer token is not broadcast to arbitrary frames. Listener is attached only while an exchange is pending (client.ts:438-450).

7. `credentials: "omit"`, `redirect: "error"`, `referrerPolicy: "no-referrer"`, `cache: "no-store"` are preserved on the direct page path (browser-cloud.ts `sendProviderRequest`); the API-key path is otherwise byte-for-byte unchanged and Anthropic keeps `anthropic-dangerous-direct-browser-access` (asserted at browser-cloud-bridge.test.ts:201).

8. NO CREDENTIAL PERSISTENCE: grep for localStorage/sessionStorage/indexedDB/opfs/navigator.storage/setItem/writeFile across src/inference/bridge/** and src/capabilities/extension-bridge.ts returns nothing. Tokens are leased per request through connection-registry's `useCredential` and never written anywhere durable.

9. Weakness (see issues): the page-side allowlist is a raw-string prefix test, so `..` segments escape the path prefix on an allowlisted host. Refused by the extension's normalized check, so no end-to-end bypass was found.

10. Weakness (see issues): concurrency cap is bypassable by simultaneous entry (measured 10/10 admitted against a cap of 2). Byte and deadline ceilings are enforced correctly.

## Issues

1. CONCURRENCY CEILING NOT ENFORCED under simultaneous entry. src/inference/bridge/client.ts:197 checks `#activeFetches >= maxConcurrentRequests` BEFORE `await this.#observePresence()` (client.ts:203), while the increment happens later in `#exchange` (client.ts:229). Check-then-increment is not atomic across the await, so callers that enter in the same tick all pass. Measured with a scratch probe (since deleted): cap=2, 10 simultaneous `fetch()` callers -> busy-refusals=0, fetch-messages-posted=10. This contradicts docs/EXTENSION_BRIDGE.md rule 6 ("a concurrent-request cap") and the report's claim of "independent byte/deadline/concurrency ceilings". The existing test (client.test.ts:345 "refuses to exceed its concurrent-request ceiling") only exercises sequential entry, so it does not catch this.

2. PAGE ALLOWLIST MATCHES RAW STRING PREFIXES, NOT A NORMALIZED URL. src/inference/bridge/protocol.ts:310 `url.startsWith(prefix)`. Probed: `https://api.anthropic.com/v1/../../evil` PASSES and resolves to `https://api.anthropic.com/evil`; `https://api.anthropic.com/v1/\evil.test` PASSES and resolves to `/v1//evil.test`. Origin escape is NOT possible (`https://api.anthropic.com@evil.test/v1/`, `https://api.anthropic.com./v1/`, `HTTPS://...` were all correctly REFUSED), so this is a path-prefix escape within an already-allowlisted host, not a CORS-bypass weapon. The foreign extension package normalizes first (`new URL(path)` then `url.href.startsWith(prefix)`, extension/src/policy.ts:237,253), so the traversal is refused end-to-end. But the comment at protocol.ts:24-27 -- "the page refuses to *send* anything outside it so a caller bug can never become a request the extension has to refuse" -- is not literally true.

3. NO FIRST-BYTE/HEAD DEADLINE for a bridged exchange. client.ts:253 arms one timer for `requestTimeoutMs` (300_000, protocol.ts:102). An extension that accepts a `fetch` and never sends `head` holds the exchange for the full 5 minutes. Bounded earlier only by the caller (oauth-transport.ts:109 uses the OAuth package's 20 s; browser-cloud's own totalTimeoutMs is also 300 s), so an inference turn can hang 5 minutes on a silent-but-installed extension.

4. PRESENCE IS MEMOIZED FOR REQUEST GATING. client.ts:407-416 caches the handshake result for `presenceTtlMs` = 30 s (protocol.ts:110). The honesty claim still holds -- it is per page load, never persisted, and `probeExtensionBridge`/`handshake()` are always live -- but the report's `built` bullet "probe never cached, never inferred" describes the capability probe only; the request path does memoize, including memoizing `silent` (so installing the extension mid-session is not noticed for up to 30 s).

5. TEST-COUNT ATTRIBUTION IS LOOSE. The report says "78 tests across my six test files". Its own five files hold 60 tests (protocol 15, client 24, oauth-transport 6, capabilities/extension-bridge 7, browser-cloud-bridge 8) and all 60 pass. The sixth file, src/inference/providers/browser-cloud.test.ts, is a pre-existing file whose 282 added lines are another package's tool-block / max_tokens work (no bridge, withCredential, or oauth references in its diff). 78/6 does reproduce; the attribution does not.

6. CROSS-PACKAGE DUPLICATION now exists for the capability record. The `notDone` claim "nothing consumes probeExtensionBridge yet" is still accurate (grep finds no importer outside its own test), but src/ui/connect/extension-bridge-presence.ts has since landed with its own `BridgeHandshakeOutcome` restated structurally (lines 91-104, explicitly "restated rather than imported"), a different state vocabulary (present/absent vs available/unavailable/failed) and NO `unavailable[]` arm -- so the extension's own named per-provider reason, which this package went to trouble to parse and surface, cannot reach the connect surface through that module. Needs reconciliation between the two packages.

7. MINOR: oauth-transport.ts:102 hardcodes `8 * 1_024` for the request-body ceiling instead of importing `MAX_OAUTH_REQUEST_BODY_BYTES` from ../../auth/provider-oauth/transport, which it already imports from. Silent drift risk if the OAuth package changes its bound.

8. MINOR: `bridgeProviderOfUrl` (oauth-transport.ts:212-217) applies only the prefix test, skipping the `maxUrlChars` and control-character checks `isBridgeDestination` performs (protocol.ts:308-309). Harmless today because client.fetch re-checks with the strict function, but it is the exported classification helper.
