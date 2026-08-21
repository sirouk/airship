# Port map — prime-agent → airship `src/prime/`

This is the single reference tying each upstream subsystem to its home in the
prime runtime inside airship. Status: `done` = landed + tested · `flight` =
implementing now · `spec` = design frozen, implementation queued · `gate` =
needs an explicit host capability / acceptance run.

## Decision summary (user-requested determination, evidence below)

- The agentic core is **TypeScript modules inside airship** (`src/prime/**`),
  not Python and not a parallel repo. The shipped kernel uses job-scoped JavaScript.
  Persistent Pyodide remains quarantined and unavailable because cross-cell task provenance cannot be proven, so the model gets the
  prime-agent contract without an ambient cross-job interpreter and
  without pretending the browser's executor tiers have ambient network.
- Airship ports stay authority-ready: `EventJournal`, `ToolRegistry`,
  `ApprovalPolicy`, `WorkspacePort`, `InferenceTransport`/fabrics,
  receipts — reused, never reimplemented. The evidence chain for prime turns
  is the same chain existing sessions produce; no parallel transcript exists.
- Execution walls come down where it is honest: stock JavaScript uses a fresh
  worker for every host-policy-bounded job, while optional Pyodide alone keeps
  a kernel-instance namespace. Sandboxed code reaches the world **only** through
  the tool bridge — reviewed, provenance-bound, journaled under
  `prime.kernel.tool.*` beside (never inside) the canonical transcript.
- Network for the model: ported provider cores drive `fetch`+SSE straight to
  provider endpoints (browser-safe; Anthropic gets the documented browser
  header; scoped by host connectivity), or airship transports via the
  transport-adapter (each transport keeps its own posture).

## Subsystem map

| Upstream prime-agent (file/dir) | Size | Destination here | Status | Notes |
|---|---|---|---|---|
| packages/ai/src/types.ts | 472 | `src/prime/ai/types.ts` | done | plain JSON Schema for tool params (no typebox); Model/Usage/StopReason 1:1 |
| packages/ai/src/utils/event-stream.ts | 87 | `src/prime/ai/event-stream.ts` | done | latching terminal + async iterator 1:1 |
| packages/ai/src/api-registry.ts | ~60 | `src/prime/ai/registry.ts` | done | lazy provider loaders added (structural chunk split) |
| packages/ai/src/stream.ts | 59 | `src/prime/ai/stream.ts` | done | never-throw contract; lazy resolution via streamLazy |
| packages/ai/src/utils/json-parse.ts | 124 | — | removed | partial-JSON parser; its only callers were the deleted provider stack |
| packages/ai/src/utils/sanitize-unicode.ts | 25 | — | removed | surrogate sanitiser; its only callers were the deleted provider stack |
| packages/ai/src/utils/overflow.ts | 153 | — | excluded | no caller in the shipped retry/compression path; provider-specific string tables are not retained speculatively |
| packages/ai/src/utils/hash.ts | 13 | `src/prime/ai/hash.ts` | done | + WebCrypto sha256/hmac helpers |
| packages/ai/src/cache-pricing.ts | 78 | `src/prime/ai/cost.ts` | done | + usageCost helper |
| packages/ai/src/utils/validation.ts | n/a | `src/prime/ai/validate.ts` | done | schema-lite checker replacing typebox Value.Check (same fail-closed semantics) |
| packages/ai/src/utils/event-sse equivalents in providers | — | — | removed | shared SSE parser; its only callers were the deleted provider stack |
| packages/ai/src/providers/anthropic.ts | 1279 | — | removed | provider-ID dispatch; nothing shipped it, and Airship chooses a transport by wire |
| packages/ai/src/providers/openai-completions.ts | 1163 | — | removed | held `isZai`, `isMoonshot`, `isGrok`, `isDeepSeek` and the URL auto-compat table |
| packages/ai/src/providers/openai-responses(+shared).ts | 864 | — | removed | same stack, same reason |
| packages/ai/src/providers/transform-messages.ts | 220 | — | removed | cross-model replay policy for the removed stack |
| packages/ai/src/providers/faux.ts | 499 | `src/prime/ai/faux.test-support.ts` | test support | deterministic scripted stream; the runtime suites use it, so it survived the deletion as what it always was |
| packages/ai/src/providers (bedrock/google/azure/codex/mistral/oauth) | ~15k | — | excluded | host-specific OAuth/localhost flows; re-entry via bridge/extension |
| packages/ai/src/mcp/* | ~1.5k | — | excluded (seam) | deferred behind adapter seam |
| packages/ai/src/providers/register-builtins.ts | 17 | — | removed | the registration entry point nothing was allowed to import; `src/prime/provider-stack.contract.test.ts` now refuses its return |
| packages/agent/src/types.ts | 421 | `src/prime/agent/types.ts` | done | JsonSchema params for typebox |
| packages/agent/src/agent-loop.ts | 986 | `src/prime/agent/agent-loop.ts` | done | invariants 16-21 enforcement; mixed-step batched lane added — contiguous declared-read runs parallelize, everything else is a barrier (W4) |
| airship fork-context admission (`assertForkContextHistoryCompatible` + seed verify) | ~430 | `src/prime/runtime/fork-admission.ts` | done | v1 replay-only gate first, seed at events[1], byte-identical refusals, byte-equal materialize options (W3) |
| airship read-effect batch discipline (`readEffectBatch`) | ~140 | `src/prime/agent/tool-batches.ts` | done | allSettled concurrency, completion-order ends, source-order results, abort-blocked starts (W4; session declares from registry effect) |
| airship conversation naming | — | `src/core/conversation-title.ts` | replaced | bounded deterministic first-prompt title; no provider request, receipt, or usage side channel (W5) |
| airship runtime gate default | — | `src/load-agent-runtime.ts` + `src/prime/runtime/agent-runtimes.ts` + lazy UI tag | done | prime default by journal evidence, fork-the-session refusals, honest status surface (W1/W6) |
| packages/agent/src/agent.ts | 613 | `src/prime/agent/agent.ts` | done | Agent class + queue semantics + settlement |
| packages/agent/src/proxy.ts | 367 | — | excluded | daemon transport (in-process single page) |
| packages/coding-agent/src/core/kernel/* (ZMQ/CPython runtime) | 3329 | `src/prime/kernel/*` | done (kernel-contract, kernel-worker-source, kernel-host, tool-bridge) | job-scoped JavaScript, quarantined unavailable Pyodide research, and approval-bound bridge (semantics re-hosted; ZMQ dropped) |
| packages/coding-agent/src/core/ipython tool | 708 | `src/prime/tools/kernel-tool.ts` | done | execute_code binding to kernel; sequential executionMode preserved |
| packages/coding-agent/src/core/tools/* (file tools) | ~2k | `src/prime/tools/*.ts` | done | prime vocabulary over WorkspacePort + CAS |
| packages/coding-agent/src/core/refinement/* | 1018 | `src/prime/harness/*` | done | prompts verbatim; optimistic concurrency; rollback |
| packages/coding-agent harness state json | — | `src/prime/harness/store.ts` | done | IndexedDB adapter + in-memory (browser-native atomicity) |
| packages/coding-agent subagents/rlm/agent_message/observe | ~1.1k | `src/prime/subagents/*` | done | nuclear-family reach, admission handles, depth gate, rate limits |
| packages/coding-agent/src/core/system-prompt.ts + prompts | ~500 | `src/prime/system-prompt.ts` | done | layered composer with cache-key fragments |
| packages/coding-agent/src/core/agent-session.ts | 11188 | `src/prime/runtime/session.ts` | done (authority) | the turn authority (guardrails, receipts, journal mapping) |
| packages/coding-agent/src/core/session-manager.ts | 2324 | `src/prime/runtime/runtime.ts` | done (facade + gate) | façade: create/attach/list/prompt/dispose over one page runtime |
| packages/coding-agent/src/core/daemon* (protocol v7) | ~18k | — | excluded | single-page runtime = the inference daemon; replay/lease semantics yield to journal + session cursors |
| packages/coding-agent TUI/themes/export-html | ~31k | — | excluded | airship owns UI |
| packages/coding-agent/src/core/skills.ts (+ skill creator) | ~2.3k | — | deferred | no stock skill discovery/composition or Python-skill execution lane; profile skill governance is a separate Airship feature |
| packages/coding-agent goals/heartbeats/cron | ~2.6k | `src/prime/tools/goals-tools.ts` + runtime scheduler seam | spec | data-plane CRUD now; tick driver as a host seam |
| packages/coding-agent compaction | 1398 | session transformContext seam + airship planContextCompression | done | pinned compression, calibrated summarizer, plan restatement after summary only — see W2 in docs/PRIME-RUNTIME-GATE.md |
| packages/coding-agent extensions/hooks | 3900 | — | excluded v1 | swallow map later |
| new: transport vocabulary bridge | — | `src/prime/transport-adapter.ts` | done (child) | both directions incl. receipt out-channel |
| new: kernel tool bridge | — | `src/prime/kernel/tool-bridge.ts` | done | prime.kernel.* evidence namespace |
| new: runtime contracts | — | `src/prime/runtime/types-prime.ts`, `prime-events.ts` | done | frozen parent/child contracts |

## Evidence chain (what auditors can verify)

- `src/core/agent.ts` — untouched; prime turns produce the same event types
  for the six turn-protocol states (no parallel transcript). Verified by
  byte-parity tests in `src/prime/runtime/session.test.ts` (requestDigest =
  sha256(stableStringify({model, systemPromptDigest, messages, tools,
  idempotencyKey})) reproduced from the journal).
- `src/prime/runtime/prime-events.ts` — the `prime.*` vocabulary, with the
  payload accounting rules (bounded, provenance-bearing, side-by-side).
- `src/prime/provider-stack.contract.test.ts` — the refusal that keeps a
  transport chosen by wire protocol rather than by provider identity, after the
  5,053-line built-in provider stack was deleted.

The §9.3 behaviour-compat checklist this table was written against was a working
note on the porting machine. It was never in this repository, so it is not cited
here; `src/prime/runtime/session.test.ts` is the executable form of it.
