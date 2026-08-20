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
| `ai/` | Ported model/streaming core: message vocabulary, terminal-latching `EventStream`, lazy provider registry, SSE and partial-JSON parsers, usage/cache cost accounting, and schema-lite validation. Production protocols are `anthropic-messages`, `openai-completions`, and `openai-responses`; deterministic faux code is explicitly test support. |
| `agent/` | Ported `packages/agent`: the turn loop state machine with all hook contracts (prepare → validate → beforeToolCall → execute → afterToolCall → finalize), parallel/sequential twins, abort-as-value, Agent wrapper with settlement semantics. |
| `kernel/` | The RLM execution kernel: a serialized host queue, host-attributed streaming, and the approval-bound tool bridge (`KernelToolBridge`) that gives sandboxed code exactly the host's tool surface under `prime.kernel.tool.*` identity. Stock JavaScript uses one terminated worker per job; only the environment-qualified, non-stock Pyodide engine keeps a kernel-instance namespace. |
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

- Prime is an application-internal module family, not a published source
  package. Callers import the exact `ai/`, `agent/`, `runtime/`, or transport
  module they use; there is no broad production barrel.
- `src/prime/SRC_PRIME_SPEC.md` — the binding implementation contract for
  the session authority (validate against it; the suite pins it).
- `scripts/bench/` — Pyodide boot/roundtrip + SSE/stream-json throughput
  numbers that back `DETERMINATION.md`.
