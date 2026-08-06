# Provider layer port — src/prime/ai/providers

Port of prime-agent `packages/ai/src/providers/` (core providers) to a
browser-safe TypeScript library. Upstream builds on the `@anthropic-ai/sdk`
and `openai` SDK clients plus Node APIs; this port speaks `fetch` +
`ReadableStream` SSE directly and carries no SDK, env, or filesystem
dependency. Registered APIs: `anthropic-messages`, `openai-completions`,
`openai-responses`.

## Shared infrastructure (ported support modules)

- `http.ts` — replaces SDK request plumbing: JSON POST via fetch, retry on
  `408/409/429/5xx` with `x-should-retry` override, `retry-after-ms` /
  `retry-after` (seconds or HTTP-date) honoring, exponential backoff
  (500 ms × 2^n, ≤25 % jitter) capped by `maxRetryDelayMs` (default 8000 ms,
  matching the Anthropic SDK's max; default `maxRetries` = 2). `timeoutMs` is
  per attempt and composes with the caller's `AbortSignal` (never replaces
  it), so a timeout can never masquerade as a caller abort. Non-2xx results
  throw `HttpResponseError` with parsed body + request id for the failure
  classifier.
- `stream-failure.ts` — 1:1 port of the failure taxonomy
  (`classifyStreamFailure`, `StreamFailureError`, message composition,
  `streamFailureFromStopReason`, `formatStreamFailureMessage`).
  `recordStreamFailure` appends this library's `AssistantMessageDiagnostic`
  shape (`{code: "provider_stream_failure", message, detail}`); upstream's
  structured log line is folded into the diagnostic `detail` JSON because
  the browser library has no log sink.
- `model-util.ts` — `clampThinkingLevel` / `getSupportedThinkingLevels` /
  `applyUsageCost` from upstream `models.ts` (the generated catalog is not
  ported).
- `simple-options.ts` — `buildBaseOptions`, `clampReasoning`,
  `adjustMaxTokensForThinking`, 1:1.
- `api-key.ts` — credential injection replacing `env-api-keys.ts` (see
  below).
- `cloudflare.ts` / `github-copilot-headers.ts` — 1:1 ports; Cloudflare
  `{VAR}` baseUrl placeholders fail closed (no process.env to resolve from).
- `test-helpers.ts` — `globalThis.fetch` stub + SSE builders used by the
  colocated tests.

## anthropic.ts

**Ported 1:1:** message conversion (system prompt as top-level block array
with per-block `cache_control`; consecutive tool results coalesced into one
user message with `is_error` preserved; cache marker on the last user
block); tool schema conversion with per-tool `eager_input_streaming` and
`fine-grained-tool-streaming-2025-05-14` beta fallback;
`interleaved-thinking-2025-05-14` beta on non-adaptive models; adaptive vs
budget-based thinking with `clampThinkingLevel` effort mapping and
temperature suppression; redacted thinking round-trip; signature-delta
accumulation without events; usage captured at `message_start` first and
merged field-wise from `message_delta`; Anthropic cache-write pricing via
`getAnthropicCacheWriteCost` from the reported `cache_creation` 5 m/1 h
split; stop-reason table (`end_turn/stop_sequence/pause_turn→stop`,
`max_tokens→length`, `tool_use→toolUse`, `refusal/sensitive→error` with
`stopReasonRaw`, unknown→throw → malformed terminal); in-stream
`event: error` classification; `message_stop` integrity check (start
without stop ⇒ `malformed_response`); request id from `request-id`;
`anthropic-version: 2023-06-01`; x-api-key / github-copilot Bearer /
cloudflare `cf-aig-authorization` header branches; tool id normalization to
`[a-zA-Z0-9_-]{1,64}`.

**Browser adjustments:**
- `resolveApiKey(options, provider)`: `options.apiKey` ?? injected
  `options.resolveApiKey` resolver; never `process.env`. `PI_CACHE_RETENTION`
  fallback is gone (default stays `"short"`).
- `anthropic-dangerous-direct-browser-access: true` defaults on for
  `api.anthropic.com` hosts so CORS preflights succeed; controlled by
  `compat.directBrowserAccess` (`false` ⇒ never sent, `true` ⇒ sent for any
  host). Copilot/cloudflare branches keep upstream's unconditional header.
- `onPayload`/`onResponse` hooks operate on plain JSON/records instead of
  SDK param types.
- Timeout now composes `timeoutMs` per attempt with the caller signal via
  AbortController composition; retries/backoff are implemented in `http.ts`
  (previously delegated to the SDK). Note: upstream declared
  `maxRetryDelayMs` in `StreamOptions` but never consumed it — this port
  honors it as the cap for both backoff and server-requested waits.

**Deliberately excluded:**
- OAuth token handling: `sk-ant-oat` detection, the Claude Code identity
  system block, `user-agent: claude-cli/...`, `x-app: cli`, the
  `claude-code-20250219`/`oauth-2025-04-20` betas, and the Claude Code
  tool-name canonicalization (`toClaudeCodeName`/`fromClaudeCodeName`). The
  oauth flows in `utils/oauth/*` are not portable to a page-owned trust
  boundary and are a documented gap.
- `options.client` SDK injection (there is no SDK client; tests stub
  `globalThis.fetch`).

## openai-completions.ts

**Ported 1:1:** the compat auto-detection table from provider+baseUrl
(cerebras/xai/chutes/deepseek/zai/moonshot/opencode/cloudflare workers-ai &
ai-gateway/prime-inference/grok heuristics; store/developer-role/
reasoning-effort/max_tokens vs max_completion_tokens/strict/retention
flags); system prompt as `developer` role when `model.reasoning &&
supportsDeveloperRole`; assistant replay as plain-string content (never
part arrays) with thinking round-tripping into the recorded reasoning field
(`thinkingSignature` as field name) and DeepSeek's `reasoning_content: ""`
blank-field rule; `reasoning.encrypted` → `thoughtSignature` JSON;
tool-call/tool-result framing (name field on demand, image hoisting into the
synthetic "Attached image(s) from tool result:" user message, assistant
bridges for `requiresAssistantAfterToolResult`); tools empty-omitted /
history-forced `[]`; thinking-format dispatch
(openai/openrouter/deepseek/zai/qwen/qwen-chat-template);
`stream_options.include_usage`, `store: false`, `prompt_cache_key` /
`prompt_cache_retention: "24h"`; session-affinity headers; tool id
normalization (pipe-form split, sanitized, 40-char truncation);
SSE→event mapping (index- and id-keyed tool-call assembly, first-non-empty
reasoning field, `choice.usage` Moonshot fallback, `responseModel`
recording); usage normalization (input excludes cached; OpenRouter
cache-write double-counting undone); finish-reason mapping incl.
`content_filter`/`network_error`/unknown→error with
`Provider finish_reason: <raw>`; [DONE] handling; scratch fields
(`partialArgs`/`streamIndex`) stripped before terminal emission.

**Browser adjustments:** credential injection as above; fetch+SSE instead of
the SDK iterator (per-record `parseJsonWithRepair`; malformed chunk ⇒
`malformed_response`); Cloudflare placeholder URLs fail closed.

**Deliberately excluded:** three compat knobs that this library's
`OpenAICompletionsCompat` type does not declare —
`openRouterRouting`/`vercelGatewayRouting` (request-side provider routing
prefs; upstream reads them off `model.compat`) and `zaiToolStream`
(`tool_stream: true` for z.ai). prime-inference `X-Prime-Team-ID` header
(it came from an env var; hosts can set it via `model.headers`).

**Deliberately normalized:** the terminal error path now also records a
`provider_stream_failure` diagnostic — upstream had none here (an
inconsistency vs anthropic/responses). `errorMessage` semantics are
unchanged: SDK-style `status body` passthrough plus OpenRouter
`error.metadata.raw` tail.

## openai-responses.ts / openai-responses-shared.ts

**Ported 1:1:** context→input items (developer role for reasoning models,
text replay with `TextSignatureV1` id/phase plus `msg_<n>`/`msg_<shortHash>`
fallbacks, reasoning items replayed verbatim from `thinkingSignature`,
`function_call` items with pipe-form ids — foreign calls hashed to
`fc_<shortHash>`, different-model same-provider fc_ id omission to dodge
OpenAI's reasoning-item pairing validation, `function_call_output` text or
structured image parts, `parseStreamingJson` argument assembly with
done-event suffix resync); `convertResponsesTools` (`strict:false`,
`strict:null`); `prompt_cache_key`/`prompt_cache_retention` +
`session_id`/`x-client-request-id` affinity headers; reasoning effort via
`thinkingLevelMap` with `include: ["reasoning.encrypted_content"]`; usage
from `response.completed` (input = input_tokens − cached_tokens);
service-tier pricing multipliers (`flex ×0.5`, `priority ×2`, `gpt-5.5
priority ×2.5`); status mapping (`completed→stop`, `incomplete→length`,
`failed/cancelled→error` with `stopReasonRaw`, `in_progress/queued→stop`,
toolCall promotion to `toolUse`); `error`/`response.failed` → classified
`StreamFailureError`; request id from `x-request-id`.

**Browser adjustments:** credential injection; fetch+SSE iteration parsing
`data:` payloads through `parseJsonWithRepair` (the `event:` name and
payload `type` are redundant — payload wins); `[DONE]` tolerated.

**Deliberately excluded:** background mode; websocket and websocket-cached
transports (only openai-codex-responses used them upstream, and codex
requires OAuth — the whole codex variant, including its WS→SSE fallback
learning, is out here); the azure variant (deployment/env mapping);
`GET /responses/:id` retrieval; `store: true` server-side retrieval flows.

## transform.ts

1:1 port of `transform-messages.ts`: cross-model replay policy (thinking /
redacted thinking / thoughtSignature retention scoped to the exact
(provider, api, model) triple, degradation to plain text otherwise),
tool-call id normalization with first-pass map + toolResult rewrite,
non-vision image placeholder downgrade with run dedupe, errored/aborted
assistant message removal, orphan tool-call healing with synthetic
`"No result provided"` error results (boundary + end of conversation).

## faux.ts

1:1 port of the deterministic in-memory test provider (scripted response
queue, factory callbacks receiving `state.callCount`, token-paced chunking,
session cache accounting, abort-as-value terminal events), registering via
`registerApiProvider(..., sourceId)` / `unregisterApiProviders(sourceId)`.

## Transport & browser-safety notes

- No `node:*`, `process`, env access, or SDK imports anywhere in this
  directory; cancellation is `AbortSignal` end to end; SSE parsing is the
  shared `SseParser`/`sseRecords` from `../sse.ts` (streaming `TextDecoder`,
  CRLF-tolerant).
- Streaming JSON repair and surrogate sanitizing come from the ported
  `../stream-json.ts` and `../sanitize.ts`; every outbound text runs through
  `sanitizeSurrogates`.
