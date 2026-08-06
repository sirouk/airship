# Transport bridge notes — `src/prime/transport-adapter.ts`

Why this exists: airship's `InferenceTransport` (five flat event kinds, whole
tool calls, receipts, structural failure naming) and the ported prime
`StreamFunction` (block-scoped deltas, thinking, cost accounting, terminal
`done`/`error` frames) are both streaming contracts, and each runtime must be
able to drive the other's transports. One module maps both directions so no
vocabulary leaks across the seam.

## Event mapping

| Canonical `InferenceEvent` | → prime `AssistantMessageEvent` | Prime `AssistantMessageEvent` | → canonical `InferenceEvent` |
|---|---|---|---|
| `text-delta` | `text_start` (once per block) + `text_delta` per event | `text_delta` | `text-delta` |
| `progress{phase:"reasoning"}` | `thinking_start` / `thinking_end` boundaries, empty content | `thinking_start` | `progress{phase:"reasoning"}` |
| — (no counterpart) | — | `thinking_delta` / `thinking_end` text | dropped |
| `tool-call` (whole) | `toolcall_start` + one `toolcall_delta` (full JSON) + `toolcall_end` | `toolcall_end` (assembled) | `tool-call` (whole) |
| `usage{inputTokens,outputTokens}` | folded into `AssistantMessage.usage`; cost recomputed via `usageCost(model.cost, …)` | `done.message.usage` (input/output only, only when > 0) | `usage{inputTokens,outputTokens}` |
| `completed.finishReason` stop / tool-calls / length | `done.reason` stop / toolUse / length | `done.reason` stop / toolUse / length | `completed.finishReason` stop / tool-calls / length |
| `completed.receipt` | **out-channel**: `onReceipt` callback + `getLastReceipt()` | — | never synthesized; absent |
| — | `start` (first) | `start`, `text_start`/`text_end`, `thinking_end`, `toolcall_start`/`toolcall_delta` | — (boundaries implied by order) |
| thrown `ProviderTransportError`-shaped error | terminal `error` event, `stopReason:"error"`, diagnostics + errorMessage carry `{code,status,retryAfter}` | terminal `error` event | thrown `PrimeBridgeTransportError` (structurally read by `withInferenceRetry`) |
| abort (signal) | terminal `error` event, `reason:"aborted"`, no diagnostics | terminal `error` event, `reason:"aborted"` | thrown `signal.reason` (caller abort) or code `"cancelled"` (provider-side abort) |

## Lossy points (all pinned by tests)

1. **Reasoning text never crosses either direction.** Canonical `progress`
   carries no text, so the forward bridge emits thinking *boundaries* with
   honestly empty content and never fabricates a `thinking_delta`. Reverse:
   real `thinking_delta` text drops; only the phase marker survives.
2. **Receipts travel beside the prime stream, not in it.** `AssistantMessage`
   has no receipt field by design, so `completed.receipt` is exposed via
   `onReceipt` / `getLastReceipt()`. A `completed` event that round-trips
   comes back receipt-less; the client mints its local receipt as usual.
3. **Cost is recomputed, never transported.** The canonical wire has no cost
   fields; the forward bridge recomputes `usage.cost` from the model table.
   Cache token counts have no canonical home and drop. A zeroed usage block
   is treated as the absence of a report and produces no `usage` event on the
   reverse side.
4. **`ToolDefinition.effect` has no prime counterpart.** It is inert on the
   provider wire (no transport reads it; approval gating uses the tool
   registry's own definitions). The forward bridge defaults it to `"write"`,
   overridable per tool via `toolEffect`. Reverse: the prime side never sees
   it.
5. **Structurally, failure `code` and `status` round-trip; `retryAfter` does
   not.** Prime diagnostics carry `{code, message, detail}` — `detail` is
   text. The reverse bridge recovers `status` from the preserved
   `"HTTP <status>"` message text (never guessed) and re-arms the retry
   layer's 429 classification; `retryAfter` survives only as text.
6. **History degradation (canonical → prime).** Assistant `thinking` blocks
   drop (canonical transcripts carry none anyway). Tool-result `toolName` is
   recovered from the assistant call it answers (orphans get `"unknown"`),
   and `isError` is always `false` because the canonical vocabulary has no
   error flag.

## Error folding

| Source | Condition | Result |
|---|---|---|
| forward, transport throws | `signal.aborted` or `AbortError` | `error` event, `reason:"aborted"`, message from `signal.reason`, **no diagnostics** (never retry-shaped) |
| forward, transport throws | structural `{code,status,retryAfter}` | `error` event, `errorMessage: "<msg> [code=… status=… retryAfter=…]"`, one `AssistantMessageDiagnostic{code,message,detail}` |
| forward, transport throws | unnamed | diagnostic code `unnamed-transport-error` (not in any retryable set) |
| forward, stream ends without `completed` | — | `error` event, code `stream-truncated` |
| reverse, `error` event | `reason:"aborted"`, caller aborted | throws `signal.reason` |
| reverse, `error` event | `reason:"aborted"`, provider-side | `PrimeBridgeTransportError("cancelled", …)` |
| reverse, `error` event | diagnostics present | `PrimeBridgeTransportError(diagnostics[0].code, msg, status-from-text?)` |
| reverse, `error` event | `HTTP <status>` in message | `PrimeBridgeTransportError("http", msg, status)` |
| reverse, `error` event | nothing named | `PrimeBridgeTransportError("stream-interrupted", …)` |
| reverse, iterable throws | structural name already present | rethrown untouched (retry layer reads the original) |
| reverse, stream ends without terminal | — | `PrimeBridgeTransportError("stream-truncated", …)` |

## Guarantees

- **Exactly one terminal, nothing after it, both directions.** Forward: the
  single partially-mutated `AssistantMessage` is shared by every pushed event
  and the stream latches on `done`/`error`. Reverse: the generator returns at
  the first terminal and drops anything a contract-broken producer yields
  after it. Double reverse-wrapping preserves single-terminal (tested).
- **Retry contract respected.** No event crosses before the retry layer's
  first-observed bound that would misclassify: unnamed failures get a
  non-retryable name, aborts carry no failure name at all, and `http` keeps
  its numeric status whenever the provider named one in its message.

## Layering

- The adapter type-imports `../core/contracts` only; it must not import
  `src/inference` (mirroring how `core/inference-retry` reads failure shapes
  structurally instead of importing error classes). The receipt type is
  extracted from the `completed` event variant, so `src/receipts` stays a
  one-way dependency of `src/core`.
- `structuralFailureName` deliberately duplicates `namedTransportFailure`'s
  read rather than importing it: a runtime dependency from `src/prime` into
  `src/core` is exactly what the core's own layering rule forbids in the
  other direction.
- `zeroUsage` is local because importing `./ai/stream` would pull the
  provider registry into any chunk that touches this adapter.
- Browser-safe only: Web Crypto UUIDs, `DOMException`, `AbortSignal`; no node
  APIs, no dynamic imports.
