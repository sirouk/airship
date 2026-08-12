# PRIME runtime inside Airship — overview

> PRIME runs every prime-pinned journal and every explicit `runtime: "prime"`
  request. It is **not** what a fresh session starts on today: `f04cf29`
  narrowed the unpinned branch in `src/load-agent-runtime.ts` so an unpinned
  journal takes the airship-core lane whenever a transport is attached, and
  `transport` is a required field of `RunTurnOptions` — so every unpinned
  session the shipped app can start routes to airship-core. That branch is
  there because `runPrimeTurn` does not yet forward the vendor stream and its
  key getter; prime becomes the fresh-session default again when it does.
  Selection is otherwise journal-evidence-driven: sessions with airship-core
  history stay airship-core, prime records pin prime, and a caller
  contradicting the journal pin is refused with a fork-the-session sentence.
  The full contract and its acceptance state live in
  `docs/PRIME-RUNTIME-GATE.md`; verification at the flip: full tree 408 files
  / 4,350 tests / 0 failures.

This document is the product-level handoff for the port. For engineering
detail start at `src/prime/README.md`, `src/prime/PORT-MAP.md`, and
`src/prime/DETERMINATION.md` (the measured architecture call).

## What this is

A faithful, Airship-native port of the prime-agent agentic core:

- **Model/streaming core** (`packages/ai` → `src/prime/ai/`): one latching
  event stream, exact stop-reason taxonomy, usage+cost accounting, three
  provider families (Anthropic Messages, OpenAI Completions, OpenAI
  Responses with shared handling), dependency-free partial-JSON streaming,
  URL auto-compat heuristics, and a deterministic `faux` provider for
  tests. Providers speak `fetch`+SSE; no Node APIs anywhere.
- **Agent loop** (`packages/agent` → `src/prime/agent/`): prepare →
  validate → beforeToolCall → execute → afterToolCall → finalize;
  parallel/sequential twins; abort-as-value; settlement-correct events.
  78 loop tests pin upstream event ordering.
- **RLM kernel** (`src/prime/kernel/`) — the "walls down" half: persistent
  REPL workers (JS engine shipped, Pyodide engine behind an install+probe
  gate on pinned same-origin assets), serialized jobs, streaming, a
  persistent namespace, and a **approval-bound tool bridge** with its own
  journal evidence namespace (`prime.kernel.tool.*`) so sandbox code can
  call the full host tool surface without a parallel authority.
- **Continual harness** (`src/prime/harness/`): entries + snapshot/restore
  + optimistic concurrency + atomic refine/validate/apply + exact-restore
  rollback, on IndexedDB for device persistence or in-memory for sessions.
- **Subagent orchestration** (`src/prime/subagents/`): admission handles
  (never awaited), nuclear-family messaging (parent/siblings/children),
  depth gates with chat-scoped override, token-bucket rate limits,
  completed_without_reply terminal notices.
- **Workspace tools + RLM/agent tools** (`src/prime/tools/`): read/write/
  edit/search bounded over `WorkspacePort` with CAS honesty, `execute_code`
  on the kernel, `rlm`/`agent_message`/`agent_observe`/`prime_harness`/
  heartbeat data tools.
- **Transport bridge** (`src/prime/transport-adapter.ts`): Airship
  `InferenceTransport` ⇄ prime `StreamFn`, both directions, with receipt
  out-channel and structural retry-shape folding — Chutes/E2EE transports
  keep their posture when driving prime models.

## What this is not

- Not Python-hosted. Python runs inside the kernel as the REPL *engine*
  (persistent Pyodide, opt-in); the runtime substrate is TypeScript so the
  evidence chain stays one chain. The full reasoning and numbers live in
  `DETERMINATION.md` (~8× steady-state win vs the disposable executor, plus
  streaming parse throughput).
- Not a parallel authority. Every effect crosses
  `ToolRegistry.review → executeApproved`; every turn is journaled in the
  same vocabulary `core/agent.ts` already produces; receipts are
  `ConversationReceipt`s.

## How turns run (session authority)

`src/prime/runtime/session.ts` binds: an adapted prime `Agent`, the
session's `EventJournal`, its `ToolRegistry` + `ApprovalPolicy`, its
`InferenceTransport` or a ported provider stream, its `SessionManifest`
(the Airship authoritative pin), and the kernel. Every turn:

1. `turn.requested` lands first, then per-step `inference.started` with
   the requestDigest recomputed exactly as `core/agent.ts` does over the
   journal-materialized canonical message list (byte parity asserted by
   test against stableStringify of `{model, systemPromptDigest, messages,
   tools, idempotencyKey}`).
2. Streaming surfaces as `text-delta`/`tool-output`/`status` AgentSignals
   (page-memory presentation); durable writes hold the same shapes as the
   stock loop.
3. Tool admission in strict call order (review tickets, provenance,
   `tool.approved`/`tool.denied` journaled), read-parallel batches, byte
   ceiling truncation via `boundToolResultContent`, repeated-identical-
   failure warn@2/stop@5, 64 calls/step, 4 MiB assistant, 100k step events.
4. Exactly one terminal event per turn committed signal-neutrally;
   `assistant.completed` carries the finalized receipt; `turn.completed`
   references its receiptId.
5. Kernel jobs journaled under `prime.kernel.*` with bridge operation
   identity `prime-kernel:<jobId>:<seq>`.

## Capability posture (honest)

| Capability | State | Boundary |
|---|---|---|
| Anthropic / OpenAI compat providers | ready (tests pinned) | fetch-only, CORS bound |
| Chutes E2EE via transport adapter | ready when the fabric pins it | posture flows up |
| Local Ollama/LM Studio | ready via adapter on loopback | host loopback |
| RLM kernel (javascript engine) | ready | no ambient net; bridge for effects |
| RLM kernel (Pyodide engine) | installable→probe→ready | same-origin pinned assets |
| Subagent spawn/messaging | ready | nuclear family only |
| Harness refine/rollback | ready | atomic+snapshotted |
| OAuth-protected provider families (codex/copilot/google/bedrock) | deferred | extension bridge seam |
| MCP | deferred | seam |
| Goals/heartbeats tick scheduler | data-plane ready; tick seam next | host clock |

## Conformance proof

`npm test` on this worktree: **4,004+ passed (4,005)** at all
freeze states to date (all 382 airship suites + every one of ~545 prime tests
through green gates). Full-tree test-run records under `/root/pa-audit/`. See `PORT-MAP.md` for
per-subsystem accounting and `scripts/bench/` for the reproducible numbers.
