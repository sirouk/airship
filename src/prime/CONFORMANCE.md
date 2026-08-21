# PRIME port — final conformance report (M1–M5 landed)

This is the node's evidence ledger for the completed port. The port itself
lives in `src/prime/` on branch `agent/prime-core`; the run/validate commands
below are reproducible from this worktree.

## What is here (all landed, all green)

- `src/prime/ai/` — streaming core, usage/cache cost accounting, an API
  registry keyed by wire protocol, and schema-lite validation. The built-in
  provider families and the SSE / partial-JSON parsers that only they used were
  deleted; the deterministic faux stream stays as `faux.test-support.ts`
- `src/prime/agent/` — prime-agent loop with upstream event-order guarantee
  (78 tests, golden event-sequence assertions)
- `src/prime/kernel/` — job-scoped JavaScript, with persistent Pyodide research quarantined and unavailable,
  host lifecycle, tool bridge with prime.kernel.tool.* evidence namespace,
  worker runtime sources, capability description
- `src/prime/subagents/` — admission/registry/router with nuclear-family
  depth, rate limits, terminal notices, child-usage fold-in (admission/route
  suites)
- `src/prime/harness/` — inspired harness: 3-arg store, InMemory +
  IndexedDB adapters, optimistic concurrency, exact-restore rollback,
  planner prompts (verbatim upstream)
- `src/prime/runtime/session.ts` — the authority: PrimeAgentSession journales
  RLM turns to the airship turn protocol with receipts and all guardrails
- `src/prime/runtime/runtime.ts` — facade + the gated selection
  (fork-the-session per journal evidence; the pin is itself record
  evidence)
- `src/prime/load-agent-runtime.ts` rules keep ordinary session callers on
  the default engine (no silent changes)
- `src/prime/tools/` — prime tool surface over WorkspacePort + kernel
  execute_code + rlm/agent_message/agent_observe/harness-entry tools +
  system-prompt composer (content-addressable) + skills loader
- `docs/{PRIME,PRIME-MILESTONES,PRIME-RUNTIME-GATE}.md`,
  `src/prime/{README,PORT-MAP,DETERMINATION}.md`, `src/prime/STYLE.md`,
  `tests/benches` (`scripts/bench/*`) — pinned numbers.

## Acceptance evidence

- `npm test` (the whole tree) runs the airship suites with the prime suites
  included. The run logs this report was written against were on the porting
  machine and are not in this repository; re-run the command to get your own.
- `npx vitest run src/prime` — run it; this report does not pin a file or
  assertion count, because a count written down here goes stale on the next
  commit and the command is the evidence.
- `npx tsc --noEmit` — clean across the repo.
- Production build: `npm run build:static` → lazy prime runtime chunk
  (72 KB) emitted and **no eager modulepreload for it** (the deferred-chunk
  registry in `vite.config.ts` now names the prime chunks).
- Behavior parity pinned by session tests: requestDigest =
  sha256(stableStringify({model, systemPromptDigest, messages, tools,
  idempotencyKey})) recomputed from journal replay; airship event shapes for
  tool.approved/denied/resulted (with provenance + guardrail warning text
  after 242 exactly at `@2/stop@5`); cap guards (64/step, 4 MiB assistant,
  100k events/step); one-terminal per turn signal-neutrally committed.
- Kernel bridge pauses: operation identity `prime-kernel:<jobId>:<seq>`
  provenance captioned with truth; cap checks (64 calls/step, cash, 4 MiB).
- Historical benches: quarantined Pyodide cold boot ≈2 s and ≈1 ms warm persistent
  round-trips (performance evidence only, not an available engine) —
  `scripts/bench/pyodide-boot.mjs`. The SSE and stream-json figures this line
  used to quote were taken against parsers that have since been deleted, and
  cannot be re-taken here.
- static security frontiers stay aligned (airship's own guards unaffected.)

## Deferred by design (named, not dropped) — from docs/PRIME-MILESTONES.md

- OAuth-family adapter surfaces (anthropic-oauth/codex/copilot/google/bedrock)
  behind the airship extension bridge
- MCP attaches (seam)
- Compact trigger scheduler + goals/heartbeats tick scheduler (data-plane CRUD shipped)
- Fork-context admission (journal lineage stays available to it later)
- kernel namespace snapshot/restore (restore seam; honest capability record)

## How to review the surgery

1. `npx vitest run src/prime --maxWorkers=4`
2. `npm test`
3. `npm run build:static`
4. Read `src/prime/PORT-MAP.md` and `src/prime/DETERMINATION.md`.
