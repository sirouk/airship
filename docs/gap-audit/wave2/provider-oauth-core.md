# Verifier report — provider-oauth-core

**honest=True**

## Verdict

Honest and substantially as reported. The three grant shapes, the injectable transport seam, S256-only PKCE with bounded random verifier/state, honest expiry states with a 120s refresh skew, and the fail-closed provider gate are all really implemented; typecheck is clean and 54 tests pass, plus 366 passing tests across src/inference, src/ui/connect and src/auth. Tests are genuinely falsifiable: I applied 9 mutations (PKCE challenge=verifier, transport gate always-open, state check disabled, slow_down ignored, error_description leaked, fallback on any >=400, device verification-URL check off, response ceiling off, unknown expiry treated as valid) and every one produced a failure; the tree was restored byte-identical afterwards. I independently confirmed the three measured reachability claims over the network with no credentials: auth.openai.com/oauth/token returns access-control-allow-origin '*' (HTTP 400 for a bogus code), auth.x.ai/oauth2/device/code returns 200 with no ACAO, and platform.claude.com/v1/oauth/token returns 429 to a browser User-Agent with no ACAO. Nothing durable is written and no credential material appears in any message. Remaining defects are minor and mostly self-disclosed: the Anthropic console.anthropic.com token fallback is unreachable through the bridge allowlist yet has a green test written against a stub that ignores that allowlist; docs/INFERENCE_PROVIDER_REGISTRY.md:82 and :20 now contradict the shipped OpenAI descriptor and were not flagged; the direct fetch transport gates by provider rather than by destination URL; a pasted full redirect URL's origin is unchecked; and a stale comment in pkce.ts. The release-gate pack-count failure is real but consistent with the foreign browser-cloud restructure.

## Security findings

1. Direct transport has no destination allowlist: src/auth/provider-oauth/transport.ts:119-188 fetches whatever URL is passed to request(); gating is provider-level via requireTransportFor, not URL-level, unlike the bridge transport which enforces compiled-in path prefixes. Only the page CSP bounds it in the deployed app.

2. Provider attribution fallback: src/auth/provider-oauth/transport.ts:195-206 providerOfUrl returns 'openai' for any unrecognised host, so a failure against an arbitrary URL is reported against OpenAI.

3. Pasted redirect URL origin is unchecked: src/auth/provider-oauth/authorization-code.ts:116-133 accepts a full URL from any host without comparing it to registration.redirectUri; a code pasted from a foreign URL still reaches the exchange (mitigated by S256 PKCE binding and the constant-time state check, and stateVerified is reported honestly as false when no state accompanied it).

4. No credential is persisted anywhere: grep for localStorage/sessionStorage/indexedDB/OPFS/vault/cookie/document across src/auth/provider-oauth/ returns nothing but a comment; token sets are returned in page memory only.

5. No token, code, verifier, or error_description reaches any message: ProviderOAuthError text is fixed strings plus displayName, HTTP status, and a regex-validated provider error code (token-set.ts:272-292, authorization-code.ts:298-308); mutation test confirmed the error_description drop is enforced, not documented.

6. Direct fetch flags verified in code and by test: credentials 'omit', redirect 'error', cache 'no-store', referrerPolicy 'no-referrer', content-length plus streamed byte ceiling, request-body ceiling, and a 20s deadline (transport.ts:146-156, 247-304).

7. Extension presence is never cached or assumed in this package: transport.carries is specified as a live per-page-load observation, the direct transport hard-codes only 'openai', and blocked providers throw transport-unavailable naming the extension and the exact cause before any network call (transport.ts:38-47, 209-222).

8. Extension and bridge boundary enforcement (caller-origin check, header allowlist, redirect escape, bounds) lives in extension/ and src/inference/bridge/, which are other packages' scope and were not judged here.

## Issues

1. Dead fallback endpoint: /Users/chrisk/chutes-jumpmaster/airship/src/auth/provider-oauth/registrations.ts:132 lists https://console.anthropic.com/v1/oauth/token as the Anthropic token fallback, but Anthropic is bridge-only and the bridge destination allowlist (src/inference/bridge/protocol.ts:32-36, enforced at :307 isBridgeDestination) has no console.anthropic.com prefix, so the fallback can never execute in production.

2. Test proves an impossible path: /Users/chrisk/chutes-jumpmaster/airship/src/auth/provider-oauth/token-set.test.ts:168 ('moves to the documented fallback host only when the first is unreachable') passes only because its stub bridge does not enforce the destination allowlist the real bridge enforces; the green test overstates the fallback's reality.

3. Doc/code contradiction introduced and not flagged: /Users/chrisk/chutes-jumpmaster/airship/docs/INFERENCE_PROVIDER_REGISTRY.md:82 says 'An OpenAI, Anthropic, or xAI first-party product login does not satisfy this gate', and the table at :20 still lists OpenAI as API-key only, but src/inference/providers/official-providers.ts:51 now ships exactly such a login as a reviewed oauth-public-pkce method. notDone flagged CSP and EXTENSION_BRIDGE.md but not this.

4. Comment drift: /Users/chrisk/chutes-jumpmaster/airship/src/auth/provider-oauth/pkce.ts:11-12 says '32 random bytes -> a 43-character verifier, the RFC 7636 minimum length' while PKCE_VERIFIER_BYTES = 48 (64 chars); those numbers describe PKCE_STATE_BYTES instead.

5. Release-gate failure confirmed present ('Production must contain exactly five optional inference-provider packs; found 4', no assets/openai-*.js emitted). Attribution to the foreign browser-cloud/fabric restructure is plausible (no dynamic import of browser-cloud remains in src) but I did not stash-verify because other packages are editing the tree concurrently.

6. Report says 'contracts.ts and validation.ts are unchanged'; validation.ts is indeed untouched, but contracts.ts IS modified on disk (MAX_MODEL_CONTEXT_WINDOW_TOKENS / model-limit fields) by the foreign browser-cloud package - true of this agent's work, but a reader could be misled about the file's state.

7. official-providers.ts:65-69 emits a review record (id openai-codex-live-cors-2026-07, reviewedAt 2026-07-25, sourceUrl discovery doc) that nothing verifies at runtime; the underlying CORS fact is real (I confirmed it independently) but the 'review' itself is asserted metadata, matching the pre-existing Chutes pattern.
