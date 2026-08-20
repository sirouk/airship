# PORT.md — prime session authority + runtime (`src/prime/runtime/`)

Upstream anchors: `packages/coding-agent/src/core/agent-session.ts` (turn
authority) and `packages/coding-agent/src/core/session-manager.ts` (facade),
pinned against airship's `src/core/agent.ts#runTurn`, the session audit
(`src/core/session-audit.ts`), the §9.3 behavior-compat checklist in
`pa-audit/airship-integration-map.md`, and `SRC_PRIME_SPEC.md` §1–§17.

## Port mapping (upstream concept → what carries it here)

| # | upstream / airship | this port | notes |
|---|---|---|---|
| 1 | `agent-session.ts` prompt pipeline + `runTurn` pipeline | `session.ts` `PrimeAgentSession.prompt` → `runTurn` | open checks mirror core/agent.ts in order (manifest v2 only, provider pin, tool digest, unfinished turn, context-history, images) |
| 2 | prime loop transcript (`state.messages`) | **dropped as provider input**: `convertToLlm` re-materializes canonical history from the journal every step (`materializeMessages`, v2 options `allowEmbeddedContext:false`, `allowSelectedContext:false/true`) | journal is the sole transcript; the loop's messages become lifecycle plumbing only |
| 3 | provider request identity | instrumented `streamFn` (`createInstrumentedStreamFn`) | runs after convertToLlm, before the stream: `inference.started` with `idempotencyKey = sessionId:turnId:step`, `requestId = randomUuid`, and `requestDigest = sha256(stableStringify({model, systemPromptDigest, messages, tools, idempotencyKey}))` — byte parity with core/agent.ts and the audit |
| 4 | `collectInference` bounds | `onAgentEvent` / `onAssistantEnd` | same numbers (see pinned guardrails below); 64-call/op-id checks raise *before* any batch is drafted, matching `reserveToolCallBatch` |
| 5 | phase-1 review in strict call order + tickets | `beforeToolCall` | `ToolRegistry.review` then provenance (`approvalProvenance`), denial sentence `Permission denied for ${name}.`, review-throw → `tool.failed`, all mirrored; `shouldStopAfterTurn` journals the stop@5 terminal after the batch like the core throw |
| 6 | phase-3 bounded journaling | `onToolResultEnd` | `boundToolResultContent` imported from `../../core/agent` — identical truncation marker + `contextBudgetTruncated`/original/retained metadata |
| 7 | receipts | `completeAssistantTurn` | provider receipt via adapter `getLastReceipt`/`onReceipt` → `finalizeProviderReceipt(providerId, requestDigest, responseDigest)`; absent → `createLocalReceipt` naming manifest bindings. **The receipt binds the digest of the request that produced the FINAL answer (the current step)** — checked against the audit's `RECEIPT_BINDING_MISMATCH` |
| 8 | terminal guarantee | `onAgentEnd` + `settleTurn` reconcile | one terminal per turn; terminal appends signal-neutral; settle re-reads the journal and writes `turn.failed` if a handler error left none |
| 9 | repeated-identical-failure guardrail | `noteFailedOutcome` | key `${name.length}:${name}|${toolArgumentsDigest(args)}|error`, warn@2 sentence inline in the tool message, stop@5 terminal sentence — copied verbatim from core/agent.ts |
| 10 | abort | `abortTurn` | loop abort + kernel cancel, 500 ms grace then terminate; terminal written by the settle path, never the aborter |
| 11 | steering/follow-up | session queues → own turns | never mid-turn injection: anything not journaled does not exist for the next request |
| 12 | RLM kernel custody | `kernelHost` getter + `onEvent` journaling | `prime.kernel.job.*` lifecycle (64 KiB value / 256 KiB stream head-cuts), `prime.notice` namespace-reset on crash, bridge op identity `prime-kernel:<jobId>:<seq>` via the landed `KernelToolBridge` |
| 13 | `session-manager.ts` registry | `runtime.ts` `PrimeRuntime` | create/attach/list/prompt/abort/dispose, instance map keyed by sessionId, disposal serialized |
| 14 | manifest assembly | `createSession` → airship `createSessionManifest` | byte-identical manifests (checked against a direct call with pinned `now`) |
| 15 | runtime gate (load-agent-runtime seam) | `runPrimeTurn`, `sessionRuntimeKind` | journal-record selection: a fresh Prime run writes one `prime.session.runtime.selected` marker before its first turn; the historical event name is accepted on reads only (see differences) |

## Pinned guardrail numbers (verbatim)

- `64` tool calls/step; op ids non-empty ≤512 chars, no C0/DEL controls;
  session-scoped uniqueness, also vs every prior journaled operationId.
- `100_000` streamed events/step; assistant text ≤ `4 * 1024 * 1024` bytes.
- warn at 2 identical failures, stop at 5 (sentences copied from core/agent.ts).
- `PRIME_DEFAULT_MAX_STEPS = 32` (airship UI's value, core default 8 stays untouched).
- `PRIME_TERMINATE_GRACE_MS = 500` kernel cooperative-then-terminate grace.
- context budget: `RESERVED_RESPONSE_TOKENS = 1024`,
  `OVER_WINDOW_LOOP_ALLOWANCE_TOKENS = 2048`, `DEFAULT_BYTES_PER_TOKEN = 3.6`.

## Exact differences during a migrate (deliberate, test-pinned)

- **Sequential tool execution** maps to seq=full-interleave. Airship's
  read-effect batch parallelism is deliberately not reproduced; the journal
  order (call order) is identical in both worlds, only schedule differs.
- **`inference.usage` payload** carries the transport token fields
  (`type`, `inputTokens`, `outputTokens`) mirrored from the prime Usage AND
  `providerId`, `model`, plus prime's own fields (`input`, `output`,
  `cacheRead`, `cacheWrite`) — the audit reads the transport vocabulary
  (`inputTokens`), prime accounting keeps its own names. Zero-usage stays
  un-journaled (usage is provider-reported, never synthesized).
- **`inference.started.posture`** = transport posture, else manifest
  securityPosture, else `local` — the only value that never claims remote
  properties the runtime cannot see.
- **Blocked-call in-loop content** equals the journaled denial/fail content
  (reason carries the same text), so in-loop and journal transcripts never
  disagree; the loop's blocked message is *not* re-journaled as
  `tool.resulted`.
- **Unknown tools** journal `tool.denied` with the canonical denial sentence
  (core review denies unregistered tools); the loop's "Tool X not found" text
  never reaches the journal.
- **Runtime-selection marker**: one `prime.session.runtime.selected` record is
  written before a fresh journal's first Prime turn. The gate recognizes the
  historical `prime.session.runtime.seal` name only when reading existing
  journals; no current constant or write path emits it.

## Remaining seams (milestone IDs)

- `M1 transformContext pruning` — MNA; the loop hook exists, no consumer yet.
- `M2 compaction hook` (turn-boundary `planContextCompression` +
  `turn.plan.restated` + `context.summary.updated`) — MNA; the over-window
  fail-closed sentence already matches core's.
- `M3 harness checkpoint` / `M4 refinement checkpoint` — MNA; queues drain at
  turn boundaries but no harness/refine serialization gates yet.
- `M5 fork-context admission` — MNA and fail-closed: lineage-pinned manifests
  throw at prompt open instead of silently dropping seed material.
- `M6 read-effect batch parallelism` — see differences; a semantic, not
  journal-level, change when it lands.
- `M7 usage calibration` (`calibrateBytesPerToken` from journaled
  `inputTokens`) — deferred; `3.6 B/token` projection is used; the payload
  fields calibration reads are written, so adoption is a policy decision, not
  a record-format migration.
