# Verifier report — inference-fabric

**honest=True**

## Verdict

HONEST — the report is accurate and unusually self-limiting; I found no claimed work that was not done and no check that does not pass. Empirical baseline proof: I created a detached git worktree at HEAD (ad5cda8), copied in only the six modified/new test files, and ran them — 14 tests fail at HEAD and pass on the working tree, including 'expected { model: \"provider/model\" } to not have property \"tools\"' for both the Responses and Messages payloads, 'fabric.declareModelMetadata is not a function', the four revocation tests, the alternate-loopback-port test, and the availability-limits test. No test mocks the thing it proves: the payload tests capture the real request body from the real transport's fetch, and the agent-awareness test parses the actual InspectInferenceConnectionsTool JSON result rather than the prompt renderer. Nothing was stubbed, weakened, or deleted — the only deletions in scope are the intended ones (tools/tool_choice/parallel_tool_calls, max_tokens 8192, the old bridge handler signature). Its test output reproduces exactly (25 passed | 2 skipped files, 214 passed | 12 skipped tests); tsc is clean in its four directories; scripts/check-static-security.mjs passes with the widened CSP. I independently re-verified the Chutes IdP factual verdict by fetching https://api.chutes.ai/.well-known/openid-configuration: revocation_endpoint https://api.chutes.ai/idp/token/revoke, token_endpoint_auth_methods_supported includes 'none', code_challenge_methods_supported includes 'S256' — exactly as reported, so 'Chutes OAuth is genuinely possible, the other three are not' is accurate. Most importantly, every self-incriminating claim checks out: declareModelMetadata, revokeChutesToken and renderInferenceAvailabilityForPrompt genuinely have no production caller; ChutesCredentialBroker is referenced nowhere outside src/auth; the vendor wire gate is real but skips; and the blocking follow-up it flagged is real (src/ui/app.tsx:5045-5051 does stamp provider-catalog provenance unconditionally, src/sessions/library.ts:43,172 do hardcode historyCopied: false). The honesty-contract direction of travel is correct — docs/PROVIDER_FABRIC.md and docs/MASTER_PROMPT_ACCEPTANCE.md were made WEAKER, naming OpenAI/Anthropic/xAI as never executed against a real endpoint. The issues I list are one genuine untested defect (a 8M-vs-100M declaration ceiling mismatch that can brick an Anthropic connection at request time), two code comments whose wording exceeds the evidence while the docs beside them hedge correctly, and three minor documentation/scope nits. None of them is a claim of work not done.

## Issues

### 1.

DEFECT (real, untested): validation-ceiling mismatch between the fabric and the transport. src/inference/providers/model-catalog.ts:150 accepts a declared maxOutputTokens up to 100_000_000, but src/inference/providers/browser-cloud.ts:133 sets MAX_DECLARED_OUTPUT_TOKENS = 8_000_000 and browser-cloud.ts:848 throws on anything above it. A declaration of e.g. 20_000_000 is therefore ACCEPTED by fabric.declareModelMetadata (src/inference/fabric.ts:434) and then makes every subsequent Anthropic request throw TypeError('The declared maximum output for model X is invalid.'), bricking that model until re-declared. The new fabric test (src/inference/fabric.test.ts:356-367) only exercises contextWindowTokens: 0, so this boundary is uncovered. The report's phrase 'unusable declarations fail closed' is true only for the range both ceilings agree on.

### 2.

OVERCLAIM IN A COMMENT (minor honesty drift): src/inference/providers/browser-cloud.ts:674 states as fact that a Responses request declaring tool_choice/parallel_tool_calls without tools 'is rejected rather than ignored'. The report itself admits no 400 was ever observed from OpenAI/xAI (no vendor key exists here). docs/PROVIDER_FABRIC.md correctly hedges this as 'a request the vendor was entitled to refuse'; the code comment does not. Same pattern at browser-cloud.ts:121-127, which asserts 'Its live /v1/models directory still lists models whose ceiling is 4096' as an observed fact, although Anthropic's /v1/models requires a key that does not exist in this environment. The Anthropic half ('Messages requests validate tool_choice against the declared tool list') is accurate per Anthropic's published contract; the OpenAI/xAI half is inference stated as observation.

### 3.

USER-VISIBLE REGRESSION NOT STATED IN ONE PLACE: lowering DEFAULTS.maxOutputTokens from 8192 to 4096 (browser-cloud.ts:129) combined with 'declareModelMetadata has no UI caller yet' means every Anthropic turn is now hard-capped at 4096 output tokens, halved from before, on models whose real ceiling is 64k. Both halves are disclosed (docs/PROVIDER_FABRIC.md 'Model limits and where they come from', report notDone), but the practical consequence is never joined up anywhere an operator would read it.

### 4.

DOC DESCRIBES A NARROWER BOUNDARY THAN THE CODE ENFORCES: docs/LOCAL_MODEL_PROVIDERS.md:58-59 presents the allowlist as per-provider port partitions ('Ollama and equivalents: 11434, 11435, 11436' / 'LM Studio and equivalents: 1234, 1235, 1236'), but src/inference/local/endpoint-policy.ts:84-90 checks one flat Set of all twelve origins with no provider association, so an Ollama endpoint may legally be set to http://127.0.0.1:1234. Cosmetic, but it is a boundary statement the runtime does not enforce.

### 5.

SHARED-HELPER RELAXATION LEAKS BEYOND ITS JUSTIFICATION: scripts/local-chutes-oauth-bridge.ts:170-171 replaced 'if (!response.body) throw new Error("Chutes token response had no body.")' with 'return new Uint8Array(0)', justified by the comment 'RFC 7009 permits an empty revocation response'. readUpstreamResponse is shared with the token-exchange route, so a bodyless TOKEN response is now silently treated as empty instead of erroring. Dev-only bridge and the downstream JSON parse still fails, so impact is low, but the comment justifies a change wider than its stated scope.

### 6.

STALE (not wrong when written): the report's typecheck claim 'Only foreign error remaining in the tree is src/ui/sources-view.tsx(607,97)' no longer matches the tree. npx tsc --noEmit now also reports 9 errors in src/git/terminal-commands.ts (lines 75-109, 'Cannot find name reset/restore/log/show/tag/stash/merge/remote/worktreeCommand'). These are the concurrent git package's, not this agent's; its own scope (src/inference, src/models, src/auth, src/billing) is genuinely clean.

### 7.

NOT A DEFECT, RECORDED FOR THE OWNER: declareModelMetadata rewrites the whole row's source.kind to 'manual' (fabric.ts:449) even though id/label/capability evidence still came from the provider directory. This is a provenance DOWNgrade (conservative) and per-capability evidence keeps its own source, so nothing overclaims — but the row now understates where its non-declared fields came from.
