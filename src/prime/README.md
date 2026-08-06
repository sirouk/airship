# src/prime — the prime-agent port inside Airship

MIT-licensed port of the prime-agent agentic core (`packages/ai`,
`packages/agent`, and the `coding-agent` core state machines) into
Airship-native TypeScript modules. It carries prime-agent's streaming
contract, agent loop, RLM kernel, continual harness, and family-scoped
subagent orchestration into Airship's evidence chain — journaled turns,
approval-bound tools, and ConversationReceipts — instead of forking beside
them.

The **Port Map** (`PORT-MAP.md`) is the subsystem-by-subsystem inventory of
what was ported 1:1, adapted, deferred behind a gate, or deliberately
excluded. **DETERMINATION.md** is the measured answer to "could this have
been Python?" Session conformance is validated against
`SRC_PRIME_SPEC.md` (the binding behavior contract for `runtime/`).

## Layout

| Area | What lives here |
|---|---|
| `ai/` | Ported model/streaming core: message vocabulary, `EventStream` latching terminal stream, provider registry (lazy chunk-per-family), SSE parser, partial-JSON streaming parser, usage/cache cost accounting, overflow detection patterns, schema-lite validator. Providers: `anthropic-messages`, `openai-completions`, `openai-responses`, `faux` (deterministic test provider). |
| `agent/` | Ported `packages/agent`: the turn loop state machine with all hook contracts (prepare → validate → beforeToolCall → execute → afterToolCall → finalize), parallel/sequential twins, abort-as-value, Agent wrapper with settlement semantics. |
| `kernel/` | The persistent RLM execution kernel: a long-lived worker per kernel instance, a serialized REPL job queue, host-attributed streaming, the approval-bound tool bridge (`KernelToolBridge`) that gives sandboxed code exactly the host's tool surface under `prime.kernel.tool.*` identity, and the Pyodide engine path (persistent CPython namespace). |
| `subagents/` | `PrimeAgentRegistry`: admission (never awaited), nuclear-family routing, depth gate (chat > global > env > default), rate limits, terminal notices incl. `completed_without_reply`, usage fold-in surface. |
| `harness/` | The continual harness: entry model, InMemory + IndexedDB stores, optimistic-concurrency + KV adapter, refinement pipeline (validate → atomic apply), exact-restore rollback. Verbatim refine prompts live in `prompt.ts`. |
| `runtime/` | `types-prime.ts` (the frozen cross-module contract), `prime-events.ts` (the `prime.*` journal vocabulary), and `session.ts` + `runtime.ts`: the turn authority that maps prime agent-loop events into byte-identical Airship turn events, guardrails and receipts included. |
| `tools/` | Prime-native tool vocabulary over `WorkspacePort`: `read_file`, `write_file`, `edit_file`, `list_files`, `search_text`, `execute_code` (kernel), RLM family tools, harness CRUD tools, heartbeat/goal data-plane. |
| `transport-adapter.ts` | The vocabulary bridge both directions: Airship `InferenceTransport` ⇄ prime `StreamFn`, with receipt out-channel and structural transport-failure folding so airship's retry layer keeps working. |

## Non-negotiable invariants

1. **Journal-first parity**: everything the provider sees is journaled first.
   `materializeMessages` + `SRC_PRIME_SPEC.md` byte-parity tests pin this.
2. **Terminal-event guarantee**: every turn ends with exactly one durable
   terminal; its append is signal-neutral.
3. **Approval is identity-bound**: every tool effect crosses
   `ToolRegistry.review` → `executeApproved` with session/turn/operation
   identity — for turn calls AND kernel-originating calls
   (`prime-kernel:<jobId>:<seq>`).
4. **Guardrails are honest and shared**: tool calls/step 64, assistant text
   4 MiB, step events 100k, reserved response tokens 1,024,
   repeated-identical-failure warn@2/stop@5.
5. **The agent loop is policy-free about evidence**: evidence writes happen
   only in the session authority.

## Entry points

- `src/prime/index.ts` re-exports the portable surfaces (`ai/`, `agent/`,
  the transport adapter). The session runtime joins as `runtime/session.ts`
  lands.
- `src/prime/SRC_PRIME_SPEC.md` — the binding implementation contract for
  the session authority (validate against it; the suite pins it).
- `scripts/bench/` — Pyodide boot/roundtrip + SSE/stream-json throughput
  numbers that back `DETERMINATION.md`.
