# DETERMINATION — prime-agent inside airship

> The question given: "a completely ported and ideal for ~/airship/ version of
> prime-agent, which might just be python if it can run on ~/airship without
> any issues in the python supported execution that it has. Make the
> determination of performance and full featured work." Then: "break down the
> walls and keep all the features ... full capabilities of the browser."

Answer, with numbers.

## 1. What airship Python execution can actually host (verified against code)

Every figure here is from `src/tools/execution-tools.ts` /
`src/execution/*-contract.ts` (cross-checked table in
`/root/pa-audit/airship-exec-budgets.md`; no contradiction found between
docs and code):

- Pyodide pack: 64 KiB source per job, `timeoutMs ≤ 10_000` per job (after a
  separately-bounded 30 s boot), fresh interpreter per job, ambient
  fetch/XHR/Worker/indexedDB removed after bootstrap, `loadPackagesFromImports`
  never called, 256 KiB per stream cap, workspace mounts bounded 256 files /
  512 KiB / 4 MiB with `.airship/.git/node_modules` exclusion on both
  ingress and egress.
- These are honest caps for *disposable executors* — not for an agent loop.
  An agent turn needs minutes of model round-trips, a persistent interpreter
  across steps, and tools that reach the network.

**Measured on this machine (Pyodide 314.0.2, node executor, warm-asset
loadPyodide calls; `scripts/bench/pyodide-boot.mjs`):**

```
boot 0: 2573 ms | boot 1: 1857 ms | boot 2: 1782 ms   (mean 2071 ms)
persistent job roundtrips (×10): 2.9, 1.0, 0.7, 0.8, 0.8, 1.8, 1.1, 0.8, 0.6, 0.7 ms
disposable-per-job at 10 jobs: 20.7 s | persistent: 2.6 s + 11 ms   (~8×)
```

One fresh-boot-per-task agent (prime-agent's IPython cadence, 10 kernel jobs
across one turn) would spend ≈ 21 s of a turn merely re-booting CPython in
this tier, before any model call, and the tier's 30 s boot budget sits inside
its 10 s/default job boundary with a whole-network preamble removed. A
persistent kernel kills 95 % of that fixed cost.

**Stream/parse throughput of the ported parsers** (`scripts/bench/parse-throughput.test.ts`,
200k SSE events streamed through the ported parser + 100k partial-JSON parses):

```
run isolated (node):  SSE 131.1 MB/s · 1,640,431 events/s → covers 100k-events/step broker budgets ~120×
                      stream-json partial parse: 30,227 ops/s at ~4 KiB args
run under vitest full-suite parallelism (same machine, contention):
                      SSE 58.9 MB/s  · 736,931 events/s
                      stream-json:   11,728 ops/s
```

Provider-realistic load (~2–10k SSE events per agent turn with ~400B
events) is two orders of magnitude below the contended floor, so parsing
cost never sets the loop budget.

## 2. The call

**The agentic execution library is TypeScript, integrated in airship, in
`src/prime/**`.** Python (Pyodide) is the REPL *engine inside the library's
kernel* — the same role IPython has upstream — not the runtime substrate.

Reasons, in order of weight:

1. **Evidence chain.** Airship's value proposition is its journaled,
   hash-chained audit trail with approval tickets and receipts. Prime turns
   must land in *that same chain*. Any Python-ported loop becomes a second
   transcript + second approval model (forked evidence), or spends its life
   tunneling through `execute_workspace_program`'s ≤16 predeclared exact
   calls, which is a hard ceiling on prime-agent's RLM shape.
2. **Feature completeness.** Prime-agent is ≈ 6–7k lines of semantic core
   (streaming + loop + harness + subagents + session machines) per
   `/root/pa-audit/prime-agent-port-manifest.md`. A faithful port needs those
   exact voucher semantics on live journals — Python-in-Pyodide replicas
   would require a TypeScript "assistant governor" anyway.
3. **Performance.** Persistent kernel vs fresh-boot-per-job: measured ≈ 8×
   on warm assets, worse with network-fetched assets; streaming provider
   calls are fetch+SSE, native to TypeScript; Python fetches would round-trip
   through JS bridges or ambient net removal games.
4. **The agent keeps its REPL.** The walls that matter are removed honestly:
   the prime kernel is a persistent worker with per-job budgets (host policy;
   default 5 min wall clock — named in results, not implied), bridge calls
   from code are arbitrary in number (bounded by per-job call budget) and
   each is approval-bound + journaled with its own operation identity
   (`prime-kernel:<jobId>:<seq>`), the harness/persistence runs on IndexedDB,
   and engine=pyodide (true persistent CPython namespace) sits behind an
   install+probe gate on the same kernel host.

## 3. What ships (feature accounting vs upstream)

Complete (earned by the port map): the full semantic core + RLM kernel
+ continual harness (prompts verbatim, rollback) + subagent orchestration
(admission handles, nuclear-family routing, stop-at-terminal notices)
+ workspace/file/kernel tools + harness-backed memory + factory registry.

Deferred honestly (documented gates, named-not-dropped):

| Deferred | Why | Gate to un-block |
|---|---|---|
| engine=pyodide kernel | needs airship's `/execution-packs/pyodide` assets + a real probe | install task: boot, JSON result, artifact check; bootMs reported |
| daemon/RPC/tui | page is the session owner | protocol-bridge if a paired host appears |
| oauth/codex/google/bedrock providers | localhost callbacks + SDKs; browser OAuth flows become extension-bridge add-ons | airship bridge companion + per-provider adapters |
| MCP client surface | sse/ws transports browser-shaped but auth flows are host flows | extension bridge neighbor |
| goals/cron tick scheduler | needs page-lifetime timers + durable due-ledger semantics | journal-backed due events + host tick seam (data-plane CRUD ships) |
| compaction trigger | airship ships a context-policy-compressor whose summarizer is transport-bound | integrate summarizer in-session at boundaries with pinned policies |
| fork-context admission | airship lineage-verified seeds | adopt when runtime adopts forks (M6.3) |

## 4. Performance plan & budget accounting

- Bundle: every ported provider/kernel/tool family lives behind lazy
  dynamic-import chunks; the `vite.config.ts DEFERRED_HTML_PRELOAD` registry is
  extended for `prime*` chunks (in this branch) so startup preload is
  unchanged. Release-gate executable-size classes apply to `src/prime/**`
  like any other pack.
- Compute: kernel job defaults maxJobWallMs = 300 s (named in results);
  bridges bounded per call (args ≤ 1 MiB), per-job calls ≤ 1000, capture
  per stream ≤ 1 Mi in page memory; kernel namespace persistent per kernel
  instance (reset named on restart; semantics documented).
- All agent-turn guardrails carry airship's exact numbers (tool-call/step
  64, assistant text 4 MiB, step events 100k, reserved response tokens 1024,
  repeated-identical-failure warn@2/stop@5).
- Concurrency: k contracts per session (one turn at a time); subagent fan-out
  through admission handles (parent never waits silently).

## 5. Full-tree evidence (as of the gate landing)

- `npm test`: 400 test files passed / 4,289 tests passing / 14 skipped —
  airship suites + every prime suite, zero failures.
- `npx vitest run src/prime`: 32 files, 552 passing + 13 gated live lane skips.
- `npm run build:static`: clean; the prime runtime emits as a 72 KB lazy
  chunk; zero eager HTML module preload (registry updated in vite.config.ts).

## 6. Migration safety

- `src/core/**` is not modified; the selection between `airship-core` and
  `prime` runtimes rides behind an explicit, manifest-pinned, fail-closed
  gate (fork-the-session-to-switch), mirroring how providerId/tool-manifest
  pins behave already. Default stays airship-core until conformance evidence
  is green.
