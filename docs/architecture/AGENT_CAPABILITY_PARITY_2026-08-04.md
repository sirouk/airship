<!--
  Preserved into the repository on 2026-08-04 because it was living in a temp
  directory, which is how the design reviews effectively vanished: measured,
  written down, and then never reachable from the work.

  STATUS OF THE RANKED LIST IN SECTION 2, as of this commit:

  BUILT
    1. In-turn provider resilience (retry, backoff, Retry-After)  src/core/inference-retry.ts
    2. Work preserved across cancellation                          src/core/agent.ts
    5. Parallel dispatch for read-effect tools                     src/core/agent.ts
    6. Tool-loop guardrails (repeat/failure detection)             src/core/agent.ts
    7. Task plan re-injected after compaction                      src/core/agent.ts
    8. Length-limit marker (a cut-off answer says so)              src/core/agent.ts
   12. User-authored skills — authoring UI only                    src/ui/skill-editor.tsx

  NOT BUILT
    3. Tool-result spill to workspace instead of tail-discard
    4. Sub-agent delegation  <- the largest structural ceiling
    9. Cost accounting
   10. Post-write diagnostics
   11. MCP over Streamable HTTP
   13. web_search
   14. Session export and insights

  Anything built after this note should update it here rather than leaving the
  reader to grep. A ranked list nobody maintains becomes another document that
  describes a product that moved on without it.
-->

# Airship ⟷ Hermes parity analysis

**Subjects as observed.** Hermes: `/Users/chrisk/.local/bin/hermes` → `Hermes Agent v0.19.1 (2026.7.30)`, install method `git`, source at `/Users/chrisk/.hermes/hermes-agent` (re-verified live; note the task brief said v0.18.2 — it is 0.19.1). Airship: `/Users/chrisk/airship` on `polish/security-and-function`, HEAD `8bfd9a6` with a **dirty working tree** (`src/core/agent.ts`, `src/tools/workspace-tools.ts`, `scripts/release-gate.mjs` modified) — the supplied inventory was taken at `c183f1a`, so I re-ran the load-bearing greps against the live tree rather than trusting its line numbers.

Rows marked **(rv)** I re-verified myself in this session. Unmarked rows carry the inventory's evidence.

---

## 1. The parity matrix

Grouped by gap kind, most consequential first inside each group.

### 1a. `missing-code` — buildable in a browser, just not built

| Hermes capability | Airship today | Gap kind | Notes / evidence |
|---|---|---|---|
| Provider retry: jittered decorrelated backoff, `Retry-After` parse (numeric + RFC 7231), ~16 one-shot recovery branches, 401→refresh→retry (`agent/retry_utils.py:38-125`, `agent/turn_retry_state.py:1-92`, `api_max_retries: 3`) | **None.** A provider error propagates out of `collectInference` and kills the turn. Recovery is the human pressing Retry. | missing-code | **(rv)** `grep -n "retry\|backoff\|Retry-After" src/core/agent.ts` → **zero hits** across 987 lines. `fetch` retry is ordinary browser code; `Retry-After` is a CORS-readable response header. |
| Fallback provider chain tried *within* the same turn on 429/401/5xx (`hermes fallback`, `agent/conversation_loop.py:2664`) | None. Route is pinned per session; a dead provider ends the turn. | missing-code | Partly harder here: each fallback needs its credential already in the page vault and its origin in `connect-src`. That is a *cost*, not a boundary — the connection registry already holds multiple providers (`src/inference/providers/connection-registry.ts:24-62`). |
| Length-limit continuation: `finish_reason=length` triggers a "Continue exactly where you left off" nudge and re-issue (`agent/conversation_loop.py:700-712, 3095`) | `finishReason: "length"` is a valid terminal value and is persisted — and then **nothing reads it**. A truncated answer is rendered as a complete one. | missing-code | **(rv)** `src/core/agent.ts:806` includes `"length"` in the union; `:505` branches only on `"tool-calls"`; `:526` stores it. No non-test reader outside `agent.ts`. |
| Overflow-to-disk for large tool results: `<persisted-output>` block naming original size, file path, and the exact `read_file` call to page the middle (`tools/tool_result_storage.py:119-201`) | Oversized results are **cut and the tail discarded**, with an honest in-band marker. Nothing can recover the dropped bytes. | missing-code | **(rv)** `src/core/agent.ts:658-680` `boundToolResultContent` — cuts the tail in the byte array, appends `[Airship truncated this tool result: N bytes exceeded…]`. OPFS + `WorkspacePort` + `read_file`'s `offset`/`nextOffsetBytes` (`src/tools/workspace-tools.ts:112,165` **rv**) are already the two halves of a spill; they are just not connected. |
| Sub-agent delegation with isolated contexts, per-child budgets, leaf/orchestrator roles, durable `async_delegations` rows (`tools/delegate_tool.py`, state.db) | **Nothing.** No subagent concept at any layer. | missing-code | **(rv)** `grep -rn "subagent\|spawnAgent" src` → only unrelated `delegate` uses in `src/inference/fabric.ts:635` (transport wrapper). A child turn is a second `runTurn` over a scoped journal + its own registry — pure application logic. |
| Parallel tool dispatch with a conflict-aware batch planner (read/read overlap OK, any writer closes the run; 8-worker pool, 420s batch deadline) (`agent/tool_dispatch_helpers.py:115-262`, `agent/tool_executor.py:95-98`) | Strictly serial `for (const call of toolCalls)`. | missing-code | **(rv)** `src/core/agent.ts:414` is the only dispatch loop; `grep -n "Promise.all" src/core/agent.ts` → **zero hits**. Tool contract is already async; path canonicalization already exists in `workspace/contracts.ts`. |
| Mid-turn steering (`/steer` injects into the last tool result without stopping; `/busy` policy selector) (`hermes_cli/commands.py:151-155`) | Queue-only. A composer queue defers prompts to the next turn; no injection path. | missing-code | **(rv)** `grep -rn "steer" src --include="*.ts*"` → 2 hits, both unrelated comments. Queue exists: `src/ui/app.tsx:1430,1967,3319`. |
| Tool-loop guardrails: repeat/failure/no-progress detection with warn and hard-stop thresholds, per-turn web-search and spawn caps (`agent/tool_guardrails.py:20-136`) | None. A model can loop the same failing call until `maxSteps` (default 8, UI passes 32) burns out. | missing-code | **(rv)** `src/core/agent.ts:112,280,541`. Signature hashing over `(tool, argsDigest)` is trivially available — the registry already canonicalizes and sha256s arguments (`src/tools/registry.ts:146`). |
| Cost accounting: 5 token classes + estimated/actual USD + `cost_source`/`pricing_version`, broken down per (model, provider, mode, **task**) in `session_model_usage` | Only `{ inputTokens?, outputTokens? }`. No cache/reasoning buckets, no price table, no per-task attribution. | missing-code | **(rv)** `src/core/contracts.ts:219` is the entire usage contract. `grep -rn "costUsd\|estimatedCost\|pricePerToken" src` → **zero non-test hits**. `src/billing/` is subscription client + honesty only. |
| Todo store re-injected into the prompt after every compaction under a stable header (`tools/todo_tool.py:39-42`) | Task plan lives in `/workspace/.airship/tasks.json` — survives compaction by construction, but is **never re-injected**; the model must remember to call `list_tasks`. | partial→missing-code | **(rv)** `src/tools/task-tools.ts:6,21,62`; no injection header anywhere in the tree. |
| Post-write validation: syntax checks + LSP diagnostics surfaced back into the loop, showing only newly-introduced errors (`tools/file_operations.py:194-1535`) | `write_file`/`text_editor` write bytes and return. No syntax check, no diagnostics. | missing-code | Native LSP is platform-bound, but `tsc`/`eslint`/`ruff` under WebContainer or Pyodide is not — both packs are wired (`src/tools/execution-tools.ts:820-890`, WebContainer at `src/terminal/manager.ts:397`). |
| Session store CLI: export in 5 formats with ~25 filter dimensions, prune, archive, stats, rename | `search_sessions` (list + FTS within profile scope) only. No export, no retention, no bulk ops. | missing-code | `src/tools/session-tools.ts:9-96`. The journal is already the authoritative record; export is a serializer. |
| `hermes insights --days N`: token/cost/tool-pattern/activity analytics computed locally from `state.db` | None. | missing-code | Same substrate argument — the journal has the events; there is no reader. Blocked behind the cost gap for the money half. |
| User-authored / installed skills (registries, taps, `/learn`, publish) | Six skills compiled in as digest-sealed `SkillRevision`s; users get on/off/inherit only. | missing-code | **(rv)** `src/profiles/catalog.ts` — exactly 6 `createSkillRevision` calls (`:115,122,130,137,144,151`). Authoring markdown into durable state is not platform-blocked; distribution is a separate question (see 3). |
| `web_search` (Exa/Tavily/Firecrawl/gateway backends) | None. `fetch_url` fetches a *known* URL; nothing discovers one. | missing-code | `src/tools/network-tools.ts:18-74`. Needs one CORS-enabled search API in `connect-src` — a build decision, not a boundary. |
| `hermes prompt-size`: offline byte breakdown of system prompt + tool schemas | No equivalent introspection surface I could find. | missing-code | See §5 — I did not exhaustively search the UI for a context gauge; treat as *probably* missing. |

### 1b. `partial` — exists, materially narrower

| Hermes capability | Airship today | Gap kind | Notes / evidence |
|---|---|---|---|
| Interrupt semantics: soft interrupt rebuilds the *same logical turn* keeping partial reasoning + completed tool results; hard interrupt fenced against compaction commit; per-thread signalling; propagates to children (`run_agent.py:3020-3264`) | Cancellation is clean and its terminal record is guaranteed (deliberately bypasses the turn signal) — but a cancelled/failed turn is **dropped whole** from provider history: the user's request, every approved call, every result. | partial | **(rv)** `src/core/agent.ts:860` builds `nonActionableTurns`; `:887` skips every event of those turns. The events *are* in the journal; they are filtered at materialization. Recovering them is a materialization change, not new infrastructure. |
| MCP client (stdio + HTTP), OAuth, per-tool selection, mTLS, curated catalog | Nothing speaks MCP. Tool schemas are already "a small MCP-compatible shape". | partial (wire) / missing-code (HTTP) / platform-bound (stdio) | **(rv)** `grep -rli "mcp" src/` → **zero files**. CANON mentions MCP only at `docs/CANON.md:504` (a table cell) and `:1269` (roadmap gate) — it is honestly *not* claimed. Streamable-HTTP MCP is buildable; stdio never is. |
| Custom inference providers (`custom_providers:` with arbitrary `base_url`) | `InferenceProviderCatalog.register()` exists and validates, but the only caller is the constructor and descriptors are compile-time constants. No UI to add an endpoint. | partial | `src/inference/providers/provider-catalog.ts:31-46`; `official-providers.ts:15-40`. Adding the UI is small; reaching an arbitrary origin is CSP-bound (see 3). |
| Approval mining (`hermes approvals suggest`) turning past decisions into an allowlist | Three approval modes with typed provenance, but no learning loop from history. | partial | `src/core/contracts.ts:266-272`. The journal holds every `tool.approved` with provenance — the mining query is the missing piece. |
| Turn-level history editing: `/undo N`, `/branch`/`/fork`, durable `rewind_count` | `/sessions fork` exists; no undo-N-turns-and-re-prompt. | partial | **(rv)** `src/commands/registry.ts:157` — `/sessions [list|new|open|fork]`. Immutable history (CANON §3.4) makes *destructive* undo illegal, but fork-at-turn-N is already the legal shape. |
| Local git worktree isolation for parallel agents (`hermes -w`) | Browser Git has worktrees with `expectedWorktreeVersion` optimistic concurrency, but no parallel-agent story to use them. | partial | **(rv)** `src/git/` has `workspace-binding.ts`, `workspace-adapter.ts`, worktree params throughout `src/tools/git-tools.ts:66-187`. Blocked behind delegation. |
| Structured logs with level/session/component/time filters (`hermes logs`) | Journal + receipts, no operator log view of that shape. | partial | `src/receipts/`, `src/core/session-audit.ts`. |

### 1c. `platform-bound` — needs something a browser tab does not have

| Hermes capability | Airship today | Gap kind | Notes |
|---|---|---|---|
| `terminal` on the real host: persistent cwd/env, background jobs, PTY, `process` stdin control | `execute_shell` (airship-sh: first-party POSIX sh, no subprocesses, no job control, no signals but `trap EXIT`), plus WebContainer `jsh` behind cross-origin isolation | platform-bound | No host process, no fork/exec. `src/execution/shell/` (198 vitest cases pass); `src/terminal/manager.ts:397`. |
| 7 pluggable execution backends (local/docker/ssh/modal/daytona/vercel/singularity) | Browser's own worker+WASM sandbox; WebContainer for Node | platform-bound | No container runtime reachable from a tab. |
| `computer_use` (screen/keyboard/mouse via cua-driver) | Nothing | platform-bound | Requires OS accessibility APIs. |
| Browser automation toolset (CDP, 12 tools, stealth backends) | Nothing — Airship *is* the browser but cannot drive another origin's DOM | platform-bound | Same-origin policy. |
| Cron scheduler, inbound webhooks, gateway-as-OS-service, `hermes serve` HTTP API, `hermes send` | Nothing | platform-bound | CANON `:1163-1174` names it: no "guaranteed background work after browser suspension"; no hidden backend (§3.2). |
| Ambient credentials (`~/.hermes/.env` inherited by every spawned process) and iron-proxy egress credential injection | Page-memory credentials only, never ambient | platform-bound → **inverted into a design property** | No process to inherit them. `src/inference/providers/connection-registry.ts:24-62`; `src/auth/chutes-oauth.ts:220`. |
| Native LSP servers | None | platform-bound (native binaries); the *diagnostics* half is missing-code (see 1a) | |
| Repo-local config (`AGENTS.md`, `.cursorrules`, project plugins) read from the checkout | Profiles only; workspace is OPFS | platform-bound for a file next to the user's real code | Reading an imported repo's `AGENTS.md` from `/workspace` after `import_github_repository` *is* buildable — that half is missing-code. |
| Arbitrary provider/search/git origins | Enumerated `connect-src`; local models restricted to 12 hardcoded loopback origins | platform-bound (CSP) | `src/inference/local/endpoint-policy.ts:22-51` states the reason: the list must be repeated as exact CSP sources and a wildcard fails the static-security gate. |
| Desktop app, ACP editor integration, MCP stdio, batch runner | None | platform-bound | All require a local process. |

### 1d. `deliberate` — Airship chose otherwise

| Hermes capability | Airship position | Why (CANON) |
|---|---|---|
| Plugin system loading arbitrary Python (5 discovery sources, `register(ctx)`, 22 hook events) | No plugin loader, no hook system, no lifecycle callbacks | **(rv)** No `src/hooks` or `src/plugins` dir among 24 `src/` subdirs. Strict CSP with no `unsafe-eval` + Trusted Types make arbitrary third-party code a deliberate refusal, not an oversight. Interop is promised only "at narrow contracts" (CANON §3.7, `:210`). |
| `--yolo` / `approvals.mode: off` as a global bypass | Three modes with typed provenance; no bypass that erases the record | CANON §3.4 History is immutable (`:108`); every decision carries `ApprovalProvenance` (`src/core/contracts.ts:266-272`). |
| Mutable session model (config re-read mid-session, model swappable) | Pinned session semantics: `contextPolicy`, `systemPromptDigest`, skills digest fixed at creation; changing them starts a new session | CANON §7.6; `src/profiles/domain.ts:437-501`. |
| Plaintext cross-device sync (Skill Sync) | Would have to ride the encrypted Vault | CANON §3.3 "Cloud state is ciphertext, not trust" (`:95`). |

### 1e. `parity`

Bounded step loop; per-step abuse caps; typed tool schemas; approval gating on write/network effects; turn-boundary context compaction with pinned thresholds; workspace file read/write/search/batch-edit; persistent cross-session memory; session search; slash commands; task/plan store; bounded tool output; git operations; runtime capability reporting. Evidence for each is in the two inventories; I spot-checked `src/core/agent.ts:87-112`, `src/tools/registry.ts:97-161`, `src/tools/workspace-tools.ts:557-565` **(rv)**.

---

## 2. What Airship should build, ranked by ceiling raise

**1. In-turn provider resilience: retry + backoff + failover.**
Today a single 429 or a dropped connection destroys a turn that may have run 20 steps and written files — and because cancelled/failed turns are dropped from materialization, the model loses all of it. This is the single largest gap between "an agent" and "a demo". Build: an attempt loop around `collectInference` with jittered decorrelated backoff, `Retry-After` header parse, and a credential-refresh branch; then a per-session ordered fallback list drawn from already-connected providers. Builds on `src/inference/fabric.ts` (the transport delegate seam at `:635-710` is exactly where a retrying wrapper belongs) and `connection-registry.ts`. Roughly a week including the failover UX. Copy `agent/retry_utils.py:38-125` for the math.

**2. Preserve completed work across cancellation and failure.**
`nonActionableTurns` (**rv** `src/core/agent.ts:860,887`) discards the user's request and every completed tool result of an interrupted turn. On a browser, where a backgrounded tab can stall a turn, this converts a recoverable hiccup into total amnesia. Build: keep `tool.resulted` events of a cancelled turn actionable, append a role-safe checkpoint plus the reason, and drop only the unresolved `tool.requested` tail. This is a materialization change plus one new event shape — no new infrastructure, the events are already durable. High ceiling, low cost. Do it with #1.

**3. Tool-result spill to workspace instead of tail-discard.**
`boundToolResultContent` (**rv** `:658-680`) is honest but lossy: a 3 MiB grep result becomes a marker. Hermes hands the model a path and a resume call and keeps working. Build: write the full payload to `/workspace/.airship/results/<operationId>.txt` and replace the in-context content with a block naming byte size, path, and the exact `read_file(path, offset, maxBytes)` call. Every piece already exists — `WorkspacePort`, `read_file` windowing with `nextOffsetBytes` (**rv** `:112,165`), and the control-plane path filter that keeps `.airship/**` out of `list_files` (`:51-62`). Two days. Raises the ceiling on every large-output tool at once.

**4. Sub-agent delegation.**
The biggest structural ceiling. A parent turn cannot currently fan out research or parallel edits; everything competes for one 32-step budget and one context window. Build: a `delegate_task` tool that opens a child session pinned to the same profile, runs `runTurn` with a narrowed registry (no delegation, no memory writes — copy Hermes's leaf-deprivation rule), and returns only a bounded summary. Builds on session forking (`/sessions fork`), `ToolRegistry` construction (`src/tools/tool-bundle.ts:19-42`), and the existing per-session journal isolation. Two to three weeks. Note the browser's genuine advantage here: several children are just several async `runTurn` calls, and the approval broker already scopes by session.

**5. Parallel dispatch for read-effect tools.**
Six `read_file` calls currently cost six sequential round trips through review→execute. Since every tool already declares `effect`, the safe subset is free: batch consecutive `effect === "read"` calls with `Promise.all`, keep everything else a barrier, and add path-conflict checking later if writers ever join. Builds on the serial loop at **(rv)** `src/core/agent.ts:414`. Two days for the read-only version, and it is the cheapest latency win available.

**6. Tool-loop guardrails.**
With `maxSteps: 32` and no repeat detection, a model can burn the whole turn on one broken call. Build: hash `(toolName, argumentsDigest, wasError)` per turn — the registry already computes the argument digest (`src/tools/registry.ts:146`) — warn at 2 identical failures, synthesize a guidance tool-result at 5. One to two days.

**7. Re-inject the task plan after compaction.**
`planContextCompression` runs at the turn prologue; the plan file is right there. Emit a system note listing open tasks whenever a compaction fires. Half a day, and it directly fixes the classic "long turn forgets its own plan" failure. Builds on `src/core/agent.ts:240-279` and `src/tools/task-tools.ts:13-28`.

**8. Length-limit continuation and a truncation marker.**
`finishReason: "length"` is recorded and ignored (**rv** `:806` vs `:505`). At minimum, render a visible "response was cut off" marker; better, append a continuation nudge and re-issue. Half a day for the marker, two for the continuation.

**9. Cost accounting.**
No `costUsd` anywhere (**rv**). Extend `InferenceEvent.usage` with cache/reasoning buckets, ship a per-model price table, and attribute the second payer the auditor already identifies (`src/core/session-audit.ts:1414-1440` — the Auto-Approve review borrows the adjudicated call's operationId). Airship's advantage is that it can be *exact* per session because the journal is complete. One week including a usage view.

**10. Post-write diagnostics.**
Run `tsc --noEmit` / `eslint` / `ruff` under WebContainer or Pyodide after a write and feed back only newly-introduced errors. Builds on `execute_node_project` and the Pyodide pack. One to two weeks; large quality effect on coding turns.

**11. MCP over Streamable HTTP.**
The schema dialect is already MCP-shaped (`docs/PRODUCT_SPEC.md:84`), so the work is transport, auth, and a per-server allowlist that respects `connect-src`. Do not promise stdio. Two to three weeks, and it is the only path to third-party tools that does not require a plugin loader Airship has deliberately refused.

**12. User-authored skills.**
Six compiled-in skills is a demo-scale corpus. Authoring markdown into the durable catalog is small (the union-on-upgrade routine at `src/profiles/catalog.ts:39-78` already tolerates unknown persisted skills). Distribution/sync is the hard half and should ride the Vault.

**13. `web_search`.** Pick one CORS-enabled search API, add its origin to `connect-src`, wrap it like `fetch_url`. Days of work; without it the agent cannot find a URL it was not given.

**14. Session export + insights.** Serializers over the journal. Low ceiling raise for the agent, high for the operator.

---

## 3. Platform-bound, and the honest workaround

**Host shell and arbitrary processes.** Real constraint: a tab cannot fork/exec, has no PTY, no signals, no host filesystem. Nearest offers, in descending honesty: WebContainer gives *real Node processes and a real `jsh` PTY* — but only under cross-origin isolation, only Node-family, and it is third-party runtime delivery plus npm egress. `airship-sh` gives real POSIX-sh *command language* semantics over the workspace on every browser with zero activation, and explicitly no subprocesses, no `&`, no job control, no signals beyond `trap EXIT`. WASI runs *precompiled* `wasm32-wasip1` artifacts and is not a compiler. **Not equivalent, and should not be claimed as such:** none of these is "a shell on your machine". The tree's own UI copy gets this right (`src/ui/terminal-view.tsx:549-551`); CANON §12.3 does not — it says xterm renders sessions "over those browser runtimes" (plural) when `BrowserTerminalManager` spawns only `jsh` (**rv** — `manager.ts:397` is the only spawn site; no reference to wasi/pyodide/airship-sh in that file). Fix the sentence, and consider a bounded per-command terminal over `airship-sh` for non-COI hosts.

**Background and scheduled work.** Real constraint: a suspended tab stops; there is no process to continue and no backend to hold the schedule (CANON §3.2, and `:1163-1174` names "guaranteed background work after browser suspension" as not promised). Nearest offer: Service Worker + Background Sync for *opportunistic* resumption, and a Vault-durable "resume this turn" record so reopening the tab continues rather than restarts. **Not equivalent:** cron, gateways, and inbound webhooks require an always-on listener. Do not build a cron UI.

**Ambient credentials and egress interception.** Real constraint: no `.env`, no keychain, no process to inherit environment, and the page cannot MITM its own TLS. Hermes's iron-proxy exists to *withhold* real keys from a sandbox; Airship's answer is structural — credentials never leave page memory and there is nothing to withhold them from. The egress panel records and preflights rather than intercepts (`src/ui/connect/egress-*.ts`). This is the one place where the platform limitation produces a *better* property, and it should be stated that way rather than as a gap.

**Arbitrary origins.** Real constraint: CSP `connect-src` is a build artifact and the static-security gate rejects wildcards (`src/inference/local/endpoint-policy.ts:22-51`). Nearest offer: the companion extension relays exactly five URL prefixes for two specific impossibilities (a CORS-less device-flow reply, and setting the forbidden `User-Agent` header). **Not equivalent to a proxy**, and the extension README already says so, including the sharpest part — the `/airship/` caller allowlist is not a security boundary on a shared origin like `sirouk.github.io`. A custom-provider UI must therefore ship with a curated origin list, not a free-text field.

**Desktop control and cross-origin browser automation.** No workaround. Do not build a stub.

**Native LSP.** No workaround for the servers. The *diagnostics outcome* is reachable via WebContainer-hosted `tsc`/`eslint` — offer that, and call it what it is.

---

## 4. Where Airship is genuinely ahead

**Execution-audit contract stronger than Hermes's message log.** Every tool call persists a complete request *before* review, then approve/deny with typed provenance, then result — and the approval ticket holds a sha256 of the canonicalized arguments, so `executeApproved` **throws** if the arguments changed between approval and execution. A TOCTOU argument swap is structurally impossible. `src/tools/registry.ts:97-161`, digest check at `:146`. Hermes has an approval gate and a message log; it has no argument-digest binding and no at-most-once operation reservation.

**Fail-closed schema dialect.** Airship compiles its own JSON Schema subset and **rejects tool registration** on any unsupported keyword, so the UI can never imply validation the runtime does not perform; `pattern` requires a `maxLength ≤ 4096` and must fall inside a linear-time regex subset, so a tool schema cannot be a ReDoS vector (`src/tools/schema.ts:98-125, 378-435`). Hermes normalizes incoming MCP schemas (`tools/schema_sanitizer.py`) but does not refuse registration on unsupported constructs.

**Profile-scoped memory silos with journal-derived authority.** `recall_memory`/`update_memory` derive scope from the *session's pinned profile in the journal*, not from arguments, and `forget` can only delete an ID visible in the caller's own scope — a silo you cannot read you cannot destroy by guessing (**rv** `src/tools/memory-tools.ts:30-39, 171-175, 247-254`). Hermes memory is a single `~/.hermes/memories/MEMORY.md` with a char limit; profiles isolate homes but there is no per-profile authority check inside the tool.

**Encrypted vault as the storage substrate.** OPFS/IndexedDB authority with recovery, export/restore, persistence probing and runtime adoption, plus Drive/S3/MinIO/Ephemeral remotes composed as *ciphertext* with digest validation and OPFS-first worker acceleration (**rv** `src/vault/` — 8 modules with conformance-tested backends in `src/storage/`). Hermes's equivalent is a 95.8 MB plaintext `state.db` and a zip backup.

**TEE attestation and receipts.** Local Intel DCAP verification pack, evidence-acquisition queue with workspace persistence, provider-endpoint evidence, and a receipt type (**rv** `src/attestation/` — 18 files including `dcap/`, `tdx.ts`, `verifiers.ts`; `src/receipts/types.ts`). Hermes has content-free OTLP monitoring and no attestation concept at all. This is a category Hermes does not compete in.

**Browser Git as a real database, not a shell-out.** Every mutation carries `expectedWorktreeVersion`/`expectedRepositoryVersion` optimistic-concurrency tokens; `import_github_repository` runs the snapshot commit and the Git admission as one transaction with rollback so the two projections cannot drift (**rv** `src/git/` — 25 modules; `src/tools/git-tools.ts:66-187, 191-236`; `src/tools/repository-admission.ts:19-90`). Hermes runs `git` via `terminal` and inherits whatever the working tree is.

**Capability probing with evidence typing.** Six WASM features probed by *validating hand-written module bytes*, WebGPU limits read from a real adapter, OPFS proven via `createSyncAccessHandle`, and every observation tagged `probe-passed` vs `api-exposed` so an exposed constructor is never reported as a working capability (`src/capabilities/browser-runtime.ts:190-262`). Hermes has `doctor`; it does not distinguish "the API exists" from "I ran it".

**Tokenizer calibration from real provider usage.** Bytes-per-token is derived from `inference.usage` events already in the journal; the 3.6 constant is used only until the first real datum. Hermes divides by a fixed 4 chars/token (`tools/budget_config.py:75-81`). Airship's is strictly better.

**`airship-sh`.** A complete first-party POSIX-sh interpreter with real cancellation on a single-threaded runtime (`ShellBudget.tick()` yields a MessageChannel macrotask every 4096 steps, every fourth forced onto `setTimeout` so a timer-fired abort can be observed) — 198 passing tests, ships in the bundle, needs no COI and no pack. Hermes has no portable shell because it never needed one; this is genuinely a thing Airship built that Hermes does not have. **And CANON does not mention it at all** — `grep -n 'airship-sh\|POSIX\|execute_shell' docs/CANON.md` returns nothing, while §17 lists three unreachable continuum modules as Implemented. That is the ledger's only under-claim and it is under-claiming the one tier that works everywhere.

---

## 5. What I could not verify

**Hermes was never driven live.** The provider credential returns `HTTP 401`, per the brief. Everything I report about Hermes rests on: `--help` text (I re-ran `hermes --version` and `hermes --help` — **rv**, confirming v0.19.1 and the 63-subcommand set), the operator's `~/.hermes/config.yaml`, the readable Python source tree, and the sqlite schemas. Specifically **unobserved in execution**: the retry/backoff branches, the parallel batch planner's conflict handling, compaction behaviour and its cooldowns, delegation child lifecycle, `/steer` and `/queue` semantics, guardrail thresholds firing, iron-proxy, the gateway, and every "documented-only" row in the supplied inventory (MoA, egress, monitoring, outbound webhooks, plugin `ctx` surface, MCP option table, mTLS, managed scope). Treat those as *design intent as coded*, not as *proven behaviour*.

**Version and revision drift.** The brief said Hermes v0.18.2; live is **v0.19.1 (2026.7.30)**, 33 commits behind upstream per the inventory. The Airship inventory was taken at `c183f1a`; the tree is at `8bfd9a6` with `src/core/agent.ts`, `src/tools/workspace-tools.ts`, `src/workspace/content-search.ts` tests and `scripts/release-gate.mjs` **modified and uncommitted**. I re-verified the negatives that drive section 2 against the live dirty tree; line numbers inherited from the inventory for rows I did not re-check may be a few lines off.

**Airship claims I did not re-verify.** The dist-bundle assertions (Pyodide emitted, semantic pack absent, wasix absent, continuum modules tree-shaken) — I did not rebuild; I am carrying the inventory's `ls dist/...` evidence. The `/context`-equivalent introspection question: I searched for cost and usage but did not exhaustively sweep the UI for a context-window gauge, so "prompt-size has no Airship equivalent" is *probable*, not proven — settle it with `grep -rn "contextWindow\|tokensUsed" src/ui`. The composer queue's runtime behaviour (pause latch, per-session backlog) is verified by code presence (**rv** `src/ui/app.tsx:1430,1967,3319`), not by running the app.

**Two things worth settling before planning.** (a) Whether the three unreachable continuum modules (`planContinuumPlacement`, `transitionContinuumJob`, `PORTABLE_TERMINAL_CANDIDATES`) are intended as forward scaffolding or should be deleted — CANON §17 lists two of them under *Implemented*, which will mislead the next reader as badly as an overstated gap misleads a planner. (b) Whether the semantic pack's absence from `vite build` is intentional lab-only scoping or a build-wiring bug — CANON files it under "depends on browser/device support", which names the wrong blocker.