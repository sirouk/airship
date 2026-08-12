# Airship Definitive Build Plan
**Repo root:** this repository (all paths below are repository-relative)
**Input:** 70 adversarially-verified gaps across 8 dimensions. 22 refuted items are excluded and listed at the end as "do not re-raise."

---

## 0. Executive shape

The audit says something specific and useful: **the engines are real; the wiring, the reachability, and the last 5% of polish are not.** Almost nothing here is "build a new engine." It is "connect the engine that already exists to the surface the user touches, and stop paying for capability you already own."

Three structural facts drive the whole plan:

1. **Four files are collision magnets** — `src/ui/app.tsx` (6,315 lines), `src/tools/execution-tools.ts` (1,422), `src/git/workspace-adapter.ts` (1,198), `src/capabilities/browser-runtime.ts` (776). Fifteen of the 70 findings touch `app.tsx` alone. Package boundaries below are drawn to keep each of these owned by **one** package per wave.
2. **Three resources are globally serialized** and must never be edited by two packages concurrently: the **CSP pair** (`index.html` + `public/_headers`, byte-identical enforcement), **`scripts/release-gate.mjs`** (budgets + classifiers), and **`docs/MASTER_PROMPT_ACCEPTANCE.md`** (the honesty ledger).
3. **Two confirmed findings directly contradict each other** (`memory-recall-normalized-by-query-length` says "replace with BM25 and bump `indexFormat`"; `three-different-memory-recall-algorithms` says "extract verbatim, do NOT introduce BM25"). Resolved in W11 below by doing extraction first and upgrading once, in one place, with one lineage-label bump.

**Wave summary**

| Wave | Packages | Theme | Parallel agents |
|---|---|---|---|
| **1** | W1–W7 | Silent bugs + first-run + agent I/O. Everything small, everything user-visible. | 5 |
| **2** | W8–W14 | Reachability: make owned capability actually usable. | 5 |
| **3** | W15–W20 | Depth: capability surface, honesty ledger, inference fabric. | 4 |
| **After** | W21–W30 | Depends on Wave 1–3 landing, or is very-large. | — |
| **Cannot** | C1–C7 | Needs user credentials/hardware, or is physically impossible in-page. | — |

---

## 1. Collision map & sequencing rules

These are the only places where two packages want the same file. Obey these or you will get merge pain.

| File | Packages | Rule |
|---|---|---|
| `src/ui/app.tsx` | W3 (UX, lines ~4020–4460, 5460–5970), W6 (vault, ~1080–1170, 3049, 4680), W16 (inference, ~3400–3700, 4978, 5066–5183), W20 (chat parts, 2294), W23 (subagent, 1504) | Regions are disjoint. **W3 owns the file in Wave 1**; W6 lands first (Wave 1, tiny, vault region only) then W3 rebases. W16/W20/W23 are Wave 2/3 and must rebase onto W3. Never two app.tsx packages in the same wave except W3+W6 (with W6 first). |
| `src/tools/execution-tools.ts` | W8 (all 8 execution findings), W12 (jsh shell tool), W29 (terminal bridge) | **W8 is sole owner.** W12 is a strict follow-on that adds one `case` to the dispatch W8 leaves in place. W29 is BUILD AFTER. |
| `src/git/workspace-adapter.ts` | W7 (stat fix + gitignore + seed), W18 (history/merge/remotes), W19 (CSP origin gate) | **W7 first** (touches `stat()` in `workspace-fs.ts` and `stage()`/`initializeSeed()`), then **W19** (adds gate at `clone`/`fetch`/`push` heads), then **W18** (adds new adapter methods). Strictly serial. |
| `src/capabilities/browser-runtime.ts` | W1 (`start()` kick), W10 (all dead-field work + SW probe) | **W1 first** (3-line addition), W10 rebases. |
| `src/indexing/semantic-transformers-loader.ts` | W5 (`PACK_ROOT` base path), W10 (`powerPreference`, `numThreads`) | **W5 first** (one-line `PACK_ROOT`), W10 rebases. |
| `src/retrieval/federated-turn-context.ts` | W11 (ranker extraction), W14 (lineage export), W30 (graph prior) | **W11 first**, W14 second (imports the extracted `memoryLineage`), W30 is BUILD AFTER. |
| `src/vault/encrypted-workspace.ts` | W21 (block reuse / manifest coalescing), W22 (segmented text writes), W26 (transactional scope) | All three BUILD AFTER. Order: **W26 scope → W21 growth → W22 ranges.** |
| `index.html` + `public/_headers` (**serialized**) | W13 (`api.tavily.com`), W19 (git-remote origin constant, read-only) | `scripts/check-static-security.mjs` fails the build on any divergence between the two. **W13 is the only package that edits the CSP.** W19 reads it and adds a subset assertion. Any later CSP need queues behind W13. |
| `scripts/release-gate.mjs` (**serialized**) | W5 (semantic pack classifier + budget), W7 (`airship-memory-git` absence check), W8 (WASI artifact budget), W10 (second e2ee wasm artifact) | Land in this order: **W7 → W5 → W8 → W10.** Each adds one classifier/budget; conflicts are trivial if serialized, brutal if not. |
| `docs/MASTER_PROMPT_ACCEPTANCE.md` (**serialized**) | Nearly all | Each package appends its own row to its own section as the **final commit of the package**. Run a serialized "ledger merge" step at the end of each wave. |
| `src/ui/styles.css` | W3 (`.skip-link`, `.transcript.no-turns`), W9 (`--tok-*` tokens in `:root`) | Different regions; W3 first. `src/ui/design-contract.test.ts` and `src/ui/css-variable-contract.test.ts` will catch violations either way. |
| `src/core/operating-charter.ts` | W13 (capability-boundary section), W16 (model facets), W24 (carried-context sentence) | **Charter version bumps rotate every new session's prompt digest and require updating the pinned digest at `operating-charter.test.ts:11-15`.** Allow **at most one** charter-version bump per wave. W13 owns the bump in Wave 2; W16 adds fields without a bump; W24 gets its own bump in a later wave. |

---

# BUILD NOW

## Wave 1 — Silent bugs, first-run, agent I/O

### W1 — Kill the WebGPU boot-order race
**Score: 25 (impact 5 × feasibility 5 ÷ effort 1)** · Gap: `probe-never-runs-before-first-use`

**Goal.** On a WebGPU-capable machine with semantic embeddings enabled, the semantic worker must latch **WebGPU**, not WASM. Today the capability refresh is two deferred dynamic imports behind a 120 ms indexing debounce, so at ≥150 ms RTT the first embed permanently pins WASM for the page lifetime — and the UI honestly reports the wrong backend.

**Files.**
- `src/indexing/semantic-browser-provider.ts` (:41 options type, :53 default, :56 predicate)
- `src/indexing/semantic-worker-provider.ts` (:104 `webgpuAvailable` widen, :152-173 `ensureReady`)
- `src/capabilities/browser-runtime.ts` (:377-394 `start()`)
- `src/main.tsx` (early non-blocking refresh)
- `src/retrieval/client-context-runtime.ts` (:71-79 `setEmbeddingMode` disposes provider)
- Tests: `semantic-browser-provider.test.ts`, `semantic-worker-provider.test.ts`, `e2e/live-semantic-embedding.spec.ts`

**Approach.** Make the decision *await* the probe instead of racing it. Change `BrowserSemanticProviderOptions.capabilities` to return a `Promise`, defaulting to `getBrowserCapabilityRegistry().refresh().catch(() => undefined)`. Widen `webgpuAvailable` to `() => boolean | Promise<boolean>` and await it inside `ensureReady()` before the `initialize` postMessage (already async; probe is deadline-bounded at 3 s/sub-probe). Add `void this.refresh().catch(() => undefined)` at the end of `start()` and an early kick in `main.tsx` purely to hide latency — **not** as the fix, since the registry is first touched from inside `webgpuAvailable()` itself. Dispose the semantic provider on `setEmbeddingMode("semantic")` so a mislatched page can recover.
**Do not** touch `client-context-runtime.ts:247-252` scheduling fallback — `client-context-engine.ts:460` re-reads the closure per generation, so it is deliberate and self-correcting.

**Acceptance test (real).** Extend `e2e/live-semantic-embedding.spec.ts` (run under `playwright.semantic.config.ts` against a real prepared pack): apply `Network.emulateNetworkConditions` with 300 ms latency via CDP, enable Local semantic, and assert (a) the worker's `initialize` message carries `preferredBackend: "webgpu"`, and (b) the UI's *active backend* readout (`src/ui/context-view.tsx:364`) reads `webgpu`. This test **fails today** (measured: `"wasm"` latched at t=1968 ms, probe started t=2167 ms) and passes after. Add a hermetic vitest companion asserting that an `undefined` synchronous snapshot plus a resolving `refresh()` still yields `"webgpu"`.

---

### W2 — Stop the silent Git data loss (same-second stat cache)
**Score: 25** · Gap: `stat-cache-hides-same-second-edits`

**Goal.** Any same-byte-length edit written inside the same wall-clock second is currently invisible to `git status`/`diff`/`stage`/`commit` — permanently, not just for one second. Agent tool loops and editor autosave hit this constantly. This is the single worst class of defect in the whole audit: a change is on disk, differs from HEAD, and Airship reports "clean."

**Files.**
- `src/git/workspace-fs.ts` (:176 stat construction, :245 `ino`, :247 constructor)
- Tests: `src/git/workspace-adapter.test.ts`, `src/git/encrypted-workspace-adapter.test.ts`

**Approach.** ~6 lines. Make `ino` a constructor parameter defaulting to `0` (so the directory branch at `:177` is untouched), and pass `revisionInode(file.revision)` — an FNV-1a hash of the workspace revision clamped to `uint32` (isomorphic-git's `GitIndex._entryToBuffer` writes `ino` with `writeUInt32BE`). Every `WorkspacePort.write` mints a fresh revision (`src/workspace/memory.ts:48`, `src/workspace/indexeddb.ts:78`, `src/vault/encrypted-workspace.ts:120`) and `workspace-fs.ts:113` short-circuits identical content, so the inode changes exactly when bytes may have. Bonus: this also fixes the identical stale-cache hole on `.git/index` itself in isomorphic-git's `GitIndexManager`.

**Acceptance test (real).** In `workspace-adapter.test.ts`: seed a real `WorkspaceGitAdapter` over `MemoryWorkspace` with `{"a.txt": "tracked1\n"}`, commit, assert `status() === []`, then `await workspace.write(".../a.txt", "MUTATED1\n", { expectedRevision })` with **no delay** and assert `[{ path: "a.txt", worktree: { kind: "modified" } }]`. Re-assert after an awaited tick to prove the miss was permanent, not sub-second. Mirror through `client.writeWorkingFile`. Add the same case to `encrypted-workspace-adapter.test.ts` — real isomorphic-git, real workspace port, nothing mocked.

---

### W6 — First-run vault: stop shipping a dead default
**Score: 16.7** · Gaps: `drive-default-is-dead-on-arrival`

**Goal.** Every visitor to the deployed build currently gets Google Drive as the default provider, a red developer-facing error, and a silently ephemeral runtime — while a fully working, zero-config, encrypted, offline Local Device vault sits one dropdown away and is never suggested.

**Files.**
- `src/ui/platform-shell.tsx` (:227-232 `resolveDefaultVaultBackend`, **:244 `loadPreferenceOverrides` — the second hardcoded default the naive fix misses**)
- `src/ui/platform-shell.test.ts` (:7-10 pins old behavior)
- `src/ui/google-drive-setup.tsx` (:123-125 developer alert → user card + `onUseLocalDevice` prop)
- `src/ui/app.tsx` (:4680 wire `onUseLocalDevice` → existing `changeVaultProvider` at :3049) — **vault region only; land before W3**
- `.github/workflows/pages.yml` (:36-41 env block)
- `docs/MASTER_PROMPT_ACCEPTANCE.md` (new row; do **not** edit the existing :85 row — its evidence text is accurate)

**Approach.** Make the default deployment-aware as a **pure function taking the client ID as an explicit argument** (keeps it testable). Reuse the exact regex from `src/storage/google-drive-auth.ts:102` so a malformed value can never ship a default that throws at construction. Critically, patch **both** defaults: `:244` must downgrade a *persisted* `"google-drive"` when no valid client ID exists, because `app.tsx:1553-1560` already wrote that value to `airship.display-preferences.v1` for every existing visitor. Replace the red operator notice with a user-facing card ("Google Drive is not configured on this deployment") + primary "Use Local Device" button, operator detail inside `<details>`. Add `VITE_GOOGLE_CLIENT_ID: ${{ vars.VITE_GOOGLE_CLIENT_ID }}` to the Pages workflow — load-bearing, because Vite strips the entire connect branch without it.

**Acceptance test (real).** (1) `platform-shell.test.ts`: both arms — configured build → `"google-drive"`, unconfigured build → `"local-device"`, and a **persisted** `"google-drive"` with no client ID → `"local-device"`. (2) New Playwright project building `dist` with `VITE_GOOGLE_CLIENT_ID` **unset**: assert `localStorage["airship.display-preferences.v1"].vaultBackend === "local-device"`, assert no red `VITE_GOOGLE_CLIENT_ID` string is in the DOM, and complete a real Local Device enrollment → write a file → reload → file survives. Existing `e2e/vault-provider-switch.spec.ts` still passes because all four Playwright configs export a well-formed client ID.

---

### W7 — Git correctness quick wins
**Score: 13.3** · Gaps: `stage-all-impossible-above-512-paths`, `terminal-worktree-claims-unavailable`, `gitignore-real-but-untested-and-mislabeled`, `simulated-git-still-shipped`

**Goal.** Make the documented import→review→stage→commit loop actually completable on a real repository; stop the terminal lying about worktrees; guard `.gitignore` with tests and fix its wrong error; remove the 1,400-line Git *simulation* from the shipped bundle.

**Files.**
- `src/git/validation.ts` (:12 limits, `validatePathList` optional limit)
- `src/git/operations.ts` (:31-37 stage/unstage normalization — **mandatory**, `describeGitOperation` re-runs normalization at approval time, so a client-only fix changes nothing)
- `src/git/client.ts` (:112-120 chunked stage/unstage with chained `expectedWorktreeVersion`)
- `src/git/terminal-commands.ts` (:93-94 worktree case → real `list/add/remove`; :377-393 `help()`)
- `src/git/workspace-adapter.ts` (:306 stage error → gated `isIgnored` check; :618 `initializeSeed` diagnostic)
- `src/git/memory-adapter.ts` (:220-231 same ignore treatment — reachable via encrypted vault path)
- `src/git/index.ts` (:3 delete `export * from "./memory-adapter"`)
- `src/deferred-capabilities.ts` (line 13, `EncryptedWorkspaceGitAdapter` — **verified present**)
- `src/tools/git-tools.ts` (:53 `maxItems`)
- `scripts/release-gate.mjs` (new `airship-memory-git` absence assertion — **first in the serialized release-gate queue**)
- Test import repoints: `src/tools/airship-tools.test.ts:2`, `src/core/airship-agent.live.test.ts:3`, `src/profiles/catalog.test.ts:4`

**Approach.** Keep `maxPathsPerOperation = 512` as the per-adapter-call bound; add `maxPathsPerRequest = 4096` (≥ the importer's 2,000 default) validated in `operations.ts`, and chunk in `client.ts` inside a single `mutate("stage", …)` scope with the version fence chained from each chunk's returned worktree version. Partial failure must report *how many paths were actually staged* — staging is durable and must never be reported as rolled back. **Do not** add a `git.add({filepath: "."})` fast path: it throws `NotFoundError` on deletions and would stage outside the reviewed set. For `.gitignore`, gate the new `path-ignored` error on *untracked-ness first* (`git.listFiles`) — `isIgnored` returns true for already-tracked clean files, so the naive fix swaps one wrong message for another; and thread `force` through `operations.ts`'s `frozen()` whitelist or it is silently stripped.

**Acceptance test (real).** (1) New `src/git/terminal-commands.test.ts` case: build a 600-change worktree, run `git add -A`, assert all 600 staged and one commit succeeds — fails today with `Select between 1 and 512 paths.` (2) `git worktree list/add/remove` round trip against the memory adapter. (3) New `src/git/gitignore.test.ts`: untracked-ignored absent from status; `.git/info/exclude` honored; negation re-includes; **file tracked before the pattern was added still reports modified**; seeded `.gitignore` no longer silently drops seed files. (4) `npm run build && grep -rl "airship-memory-git" dist` returns nothing, enforced in `release-gate.mjs`.

---

### W3 — Chat UX tier-1 (the polish that reads as "finished")
**Score: 12.5** · Gaps: `keyboard-path-to-composer`, `empty-chat-dead-space`, `jargon-in-chat-header`, `no-regenerate-affordance`, `native-confirm-dialogs`, `approval-dock-focus-escape`

**Goal.** Six small, independently verifiable fixes that together remove every remaining "example app" tell on the primary screen.

**Files.**
- `src/ui/app.tsx` — `main` id (:4248-4250), skip cluster in `.app-shell` (:4043), transcript class (:4339), composer autofocus (:4452-4466), overlay flag (:4023), header copy (:4328), attestation labels (:5550, :5606), Retry gate (:5838), resumed-row `originatingPrompt` (:2810-2817, :3950-3960), confirm dialogs (:5937, :5961)
- `src/ui/styles.css` (`.skip-link` beside `.sr-only` :4553; `.transcript.no-turns` after :1160; `.transcript-jump` justify-self)
- `src/ui/approval-dock.tsx` (Tab trap + focus restore)
- `src/ui/platform-shell.tsx` (extract trap; new `ConfirmDialog`), `src/ui/platform-shell.css`
- New `src/ui/focus-trap.ts`; `src/ui/mobile-navigation.tsx` (:283 delete duplicate)
- `src/ui/attestation-seal.test.ts`
- e2e updates: `e2e/master-browser-acceptance.spec.ts:122`, `e2e/conversation-navigation.spec.ts:79` (both currently `dialog.accept()` on native confirm)

**Approach — the four non-obvious details.**
- **Autofocus:** an effect calling `textarea.current?.focus()` at mount is **dead code** — the identical pattern already exists at `app.tsx:1681-1684` and provably never fires at mount (`document.activeElement` stays `BODY` through the first 3.5 s). Use the file's established deferred pattern: `requestAnimationFrame(() => textarea.current?.focus({preventScroll:true}))`, keyed on the composer being mounted, guarded on no overlay open, and skipped at ≤640px so the mobile keyboard never pops. Note the side effect: `useGlobalNavigationJumps` bails on typing targets (`platform-shell.tsx:193`), so `g`-chords are suppressed while the composer holds focus — either accept (chat-first) or exempt an empty composer.
- **Empty chat:** `align-content: safe center`, **never bare `center`**. Measured: at 1100×520 and iPhone 390×844 the 280 px zero-state block overflows the transcript, and bare `center` puts the welcome card at −33 px inside a container with no start-edge scroll — permanently clipped.
- **Focus trap:** extract the **`mobile-navigation.tsx` variant** and add `summary`/`textarea` to its selector. The `platform-shell.tsx` selector omits `summary`, and the approval panel's `<summary>Arguments shown to the approval policy</summary>` sits *before* the footer buttons — the naive shared helper would make the arguments disclosure unreachable in exactly the dialog where reading arguments matters. Also add `approvalPending` (via `ApprovalBroker.subscribe`) to `platformOverlayOpen` so the background actually becomes `inert`.
- **Retry:** gate on `originatingPrompt` only, keep the label **"Retry"** (blueprint vocabulary), route through the existing same-session `onRetry` — **not** `onBranch`, which forks with `historyCopied: false` and would destroy the conversation. Populate `originatingPrompt` on resumed sessions or the ungated button never renders after reload.

**Acceptance test (real).**
- New `e2e/keyboard-and-zero-state.spec.ts` against built `dist`: Tab from `document.body` reaches the composer in ≤2 stops (**35 today**); the skip link is visible on focus; at 1440×1000 the transcript's first child `offsetTop > 150`; at 1100×520 and 390×844 its `offsetTop >= 0` (regression guard for `safe center`).
- Approval trap: extend `e2e/github-import.spec.ts` — trigger the real approval, press Tab 12 times, assert `document.activeElement` stays inside `[role="dialog"]` on every press and that `<main>` has `inert`.
- Retry: with the real `DemoInferenceTransport` (zero setup), send a turn, click Retry on the **successful** assistant message, assert a second assistant turn streams and the journal holds two `turn.completed` events.
- Confirm dialogs: assert `page.on("dialog")` **never** fires during profile archive/discard and that the in-app `[role="dialog"]` appears.
- Copy: assert the chat header no longer matches `/page-journal/` and no seal label equals `"TEE not checked"`.

---

### W4 — Agent file I/O that survives a real repository
**Score: 12.5** · Gaps: `read-file-hard-fails-over-1mib`, `grep-caps-at-512-files`

**Goal.** `read_file` currently hard-fails on any file over ~1 MiB with an error that points at an output budget instead of a fix. `search_text` scans only the *alphabetically first* 512 files with no continuation, so searching Airship's own repo from `/workspace` reads `.github/`, `docs/`, `e2e/` and returns confident false negatives before reaching `src/`. These are the agent's two most-used primitives.

**Files.**
- `src/tools/workspace-tools.ts` (:74-99 `read_file`, :168-251 `searchText`)
- `src/workspace/content-codec.ts` (extract shared UTF-8-boundary window helper)
- `src/ui/app.tsx:5335-5349` (dedupe into the shared helper — **read-only region, no conflict with W3**)
- `src/tools/registry.ts` (:136-138 message only)
- `src/tools/workspace-tools.test.ts`

**Approach.** `read_file` gains `offsetBytes` / `maxBytes` (default & max 262144) and **always clamps itself** — do **not** gate on `workspace.readBounded`, which is a trap: `GitSynchronizedWorkspace.readBounded` delegates to `this.workspace.read` when the inner port lacks it (`IndexedDbWorkspace` does), so the method is *present* on the wired workspace and returns the whole file. Trim trailing partial UTF-8 sequences and report *post-trim* byte counts so `nextOffsetBytes = offsetBytes + returnedBytes` resumes exactly.
`search_text` gains `include`/`exclude` globs applied **before** the 512 slice (ordering is load-bearing) and a `cursor` (both backends return `localeCompare`-sorted lists, so paging is deterministic). **The critical correction:** `metadata.truncated` is invisible to the model — `agent.ts:750` and `session-audit.ts:1123,1151` forward only `payload.content`. The truncation notice and `nextCursor` must be embedded in **`content`** on both the match and no-match branches. Skip regex, or gate it fail-closed — a step counter cannot bound a JS `RegExp`; one `exec()` runs to completion in the engine and catastrophic backtracking freezes the whole main-thread agent.

**Acceptance test (real).** In `workspace-tools.test.ts` against a real `MemoryWorkspace`: (1) a 601-file fixture where the only match lives in the last file — the unscoped call states the bound **in `content`**, following the returned cursor reaches the match, and `include: ["**/*.ts"]` surfaces it in one call; (2) a 3 MiB file — read it in windows following `nextOffsetBytes`, concatenate, and assert byte-identity with the original; assert a mid-multibyte boundary never emits `U+FFFD`.

---

### W11 — One memory ranker, and make it actually recall
**Score: 13.3** · Gaps: `memory-recall-normalized-by-query-length`, `three-different-memory-recall-algorithms` **(these two findings conflict — resolution below)**

**Goal.** Today the same profile-memory corpus is searched three different ways, and the *automatic* path divides relevance by the length of the user's message: a 25-token question sharing one distinctive token scores 0.03 + recency, so only the single newest record clears the 0.25 gate. Users experience this as "it remembered my name yesterday but not today." The agent's two fallback tools (`search_memory`, `recall_memory`) are strictly *worse* — whole-query substring matches that essentially never fire.

**Conflict resolution (mandatory).** Finding A says "replace with BM25, bump `indexFormat` to `bounded-bm25-recent-v1`." Finding B says "extract verbatim, keep `bounded-lexical-recent-v1`, do NOT introduce BM25." **Do both, in order, in one package:** (step 1) extract the existing ranker verbatim into a shared module and repoint all three call sites with zero behavior change; (step 2) upgrade that one function to BM25 and bump the lineage label **once**. Doing them as separate packages guarantees a merge conflict on the same 16 lines and two lineage-label churns.

**Files.**
- New `src/retrieval/memory-ranking.ts`
- `src/retrieval/federated-turn-context.ts` (:148-164 ranker, :181 `indexFormat`, :186 tokenize)
- `src/tools/federated-memory.ts` (:102-105 filter; :29/:156 **ProfileGroup label only** — leave the identical ThreadGroup string at :22/:150 alone, that lane genuinely is reverse-chronological substring)
- `src/tools/memory-tools.ts` (:60-63; **preserve the `!query ||` branch** — `memory-tools.test.ts:28,67,94` call `recall_memory` with `{}`)
- `docs/MEMORY_CONTEXT_SCOPE.md:17` (stale: claims automatic injection does not happen; it does)

**Approach.** BM25 (k1=1.2, b=0.75) over the already-scoped ≤512 records, with a query-bigram bonus replacing the whole-query substring term. **Two guardrails the naive fix gets wrong:** normalize by the *theoretical ideal-document score* (all query terms at saturating tf, average length), **never** by the observed corpus maximum — observed-max normalization pins the best candidate at 1.0 every turn, so the `> 0.25` gate can never return empty and an irrelevant memory is injected as context on every single turn, converting a recall bug into a precision/honesty bug. And keep the recency prior strictly below the threshold so a genuine no-match turn still injects nothing. `indexFormat` is a free bounded string validated only by `boundedString(...,256)`; `verifyContextSelection` does not re-derive scores, so no sealed-record contract breaks.

**Acceptance test (real).** (1) `federated-turn-context.test.ts`: a multi-sentence question containing the memory's distinctive terms retrieves it (fails today); a genuinely unrelated multi-sentence question retrieves **nothing** (guards the normalization trap). (2) A cross-path test asserting `FederatedTurnContextProvider`, `search_memory`, and `recall_memory` return the **same ordered ids** for the same corpus + query. (3) `recall_memory({})` still returns the newest `limit` records reverse-chronologically.

---

## Wave 2 — Reachability: use what you already own

### W19 — Stop the app lying about Git remotes
**Score: 10** · Gap: `csp-blocks-every-git-remote`

**Goal.** This is the one place in the git dimension where the app states something **untrue**. `capabilities.features.clone/fetch/push` all report `available: true`, and when a clone fails the error says *the remote refused this browser CORS* — but the request never left the page: the deployed `connect-src` allowlists `api.github.com` and `raw.githubusercontent.com` and **no Git host at all**. Users go configure CORS on servers they don't control.

**Files.**
- `src/git/validation.ts` (new `GIT_REMOTE_CONNECT_ORIGINS` + `assertRemoteOriginPermitted`; leave `validateRemoteUrl` intact so existing registry records stay valid)
- `src/git/workspace-adapter.ts` (gate at `clone` :491, `fetch` :530, `push` :545; `permittedOrigins` in the capability block :1075-1080; rewrite `directHttpError` :1162)
- `src/git/types.ts` (:37-42 remote capability shape)
- `src/git/terminal-commands.ts` (:279-296 pre-flight before approval; :389 help)
- `src/ui/sources-view.tsx` (:353-359 render permitted origins + route to the snapshot importer that works)
- `scripts/check-static-security.mjs` (assert the constant is a subset of the shipped `connect-src` — one gate, no drift)
- `docs/BROWSER_GIT.md` (new CSP subsection ~124-148)

**Approach.** Gate first, then the surviving `TypeError: Failed to fetch` is genuinely remote-side and the existing CORS wording becomes true by construction. Throw a new `GitDomainError("remote-origin-not-permitted")` naming *Airship's own CSP*, listing permitted origins, pointing at the snapshot importer. **Do not** add a `fetch(url,{mode:"no-cors"})` sentinel — it rejects identically on DNS/offline failure so it distinguishes nothing and emits an unwanted cross-origin request. **Do not** ship a corsProxy: that would require rewriting four standing "Airship never inserts a proxy" claims and is a separate reviewed decision.

**Acceptance test (real).** `workspace-adapter.test.ts`: `clone("https://github.com/o/r.git")` rejects with an error naming Airship's Content-Security-Policy and **not** naming the remote's CORS policy (today: asserts the opposite at :327-335). `check-static-security.mjs` fails when a constant origin is absent from `connect-src`. Playwright: the Sources empty state renders the permitted-origin list and a working handoff to the importer.

---

### W5 — Ship the semantic pack in production builds
**Score: 10** · Gap: `semantic-pack-absent-from-production-build`

**Status: implemented.** A complete prepared pack is hash-verified once, emitted
under the configured public base, and bound to the built-in runtime declaration;
an absent or drifted pack leaves a disabled control and no request path.

**Original defect.** The "Local semantic" button was enabled on every deployment
and 404ed on static hosts: the pack was served by Vite **dev/preview middleware
only** and never emitted to `dist/`.

**Files.**
- `scripts/semantic-pack-assets.ts` (one verified snapshot for availability,
  middleware, and `generateBundle` emission)
- `scripts/release-gate.mjs` (exact optional file-set and byte/hash validation;
  exclusion from ordinary application JavaScript/WASM budgets)
- `src/indexing/semantic-transformers-loader.ts` (public-base-aware pack root)
- `src/ui/context-view.tsx` (disabled action and visible reason when unpublished)
- the portability and static-host browser gates (absent-pack and subpath proof)

**Implemented approach.** A missing pack remains a valid lightweight build and
`build:static` never downloads it. When the prepared directory is present, Vite
reads and SHA-256 verifies the complete manifest once, uses that immutable
snapshot for the compile-time declaration and emitted files, and the release
gate verifies the emitted set again. `AIRSHIP_DISABLE_SEMANTIC_PACK=1` gives
credential-free and portability lanes a deterministic absent-pack build. All
runtime and Trusted Types paths derive from `import.meta.env.BASE_URL`.

**Acceptance test (real).** `npm run semantic:prepare && AIRSHIP_PUBLIC_BASE_PATH=/airship/ npm run build && npm run check:release`, then a Playwright run serving `dist` under `/airship/`: select "Local semantic" and get a real embedding. Un-mockable — the build and loader verify every asset's byte length and SHA-256 against the pinned manifest. Second case: build with `AIRSHIP_DISABLE_SEMANTIC_PACK=1` and assert the button renders disabled with the stated reason without issuing a pack request.

---

### W10 — Accelerator policy: honesty, then real wiring
**Score: 10** · Gaps: `max-worker-concurrency-sizes-nothing`, `heavy-pack-loading-dead`, `preferred-workspace-storage-dead`, `service-worker-observation-is-api-presence-only`, `power-preference-never-applied`, `wasm-tier-decorative`

**Goal.** The Capabilities panel is scrupulously honest everywhere except one row that prints "N workers" for a pool that does not exist. Meanwhile a laptop at 15% battery gets the discrete GPU while the panel says "low-power," a metered 2G connection with data-saver on pulls 38–46 MB while the panel says "Manual," and `preferredWorkspaceStorage` has literally zero consumers.

**Files.** `src/capabilities/browser-runtime.ts` (:67, :171-202, :243-244, :274, :277, :310-317, :426-435, :608-621) · `src/ui/capabilities-view.tsx` (:105) · `src/indexing/semantic-worker-provider.ts` (:38, :65-70, :102-104, :164-168, :255-259) · `src/indexing/semantic-browser-provider.ts` (:44-57) · `src/indexing/semantic-transformers-loader.ts` (:19-20, :36-37) · `src/storage/client-ciphertext-cache.ts` (:64-68, :155-165) · `src/vault/coordinator.ts` (:467) · `src/ui/context-view.tsx` (:107-112) · `scripts/build-e2ee.mjs`, `src/inference/chutes/crypto.ts:31` · fixtures: `browser-runtime.test.ts:73,165`, `semantic-browser-provider.test.ts:106`, `e2e/edge-portability.spec.ts:31,110`

**Approach — in cost order.**
1. **Honesty (hours).** Replace `"{maxWorkerConcurrency} workers"` with `"{maxIndexingConcurrency} indexing lanes"` (the value actually consumed by `concurrentMap`) and rename/delete `maxWorkerConcurrency` on the policy type — a UI-only edit is insufficient because `src/tools/browser-capabilities.ts` serializes the whole report to the model. Drop or qualify `heavyPackLoading` in the same row.
2. **`powerPreference` (small).** Thread the policy into the worker and **override the pack's hard-coded high-performance default**. Map to ORT's accepted set first — ORT *throws* on `"default"` (`wasm-core-impl.ts:117-119`), so `"default"` must never be forwarded. Mutate `onnx.webgpu` **in place**, not spread-replaced: ORT later installs `device`/`adapter` accessors on that same object. Flag the deliberate behavior change (hosts classed `"default"` currently get high-performance from Transformers.js and would fall back).
3. **`heavyPackLoading` (small).** Gate the ~38–46 MB pack fetch on an in-card confirmation naming the byte total, on **both** the explicit toggle and the silent `localStorage`-restore path (the latter is the one that matters). **Do not** add a dialog to `execution-tool-proxies.ts` — Pyodide is already fail-closed behind `install_execution_runtime`.
4. **`preferredWorkspaceStorage` (small).** Make it a **skip-hint that can only avoid work, never assert capability**: pass `"indexeddb-fallback"` to skip the OPFS attempt (saving the full 5 s `OPFS_START_TIMEOUT_MS` stall in private-browsing-style engines); the worker's own sync-handle probe stays the sole authority for the *reported* backend.
5. **Service-worker / cache observations (small).** Promote from API-presence to page reality: `controller != null` → `probe-passed`; registered-not-controlling → distinct detail; match `/^airship-shell-v\d+$/` against real `caches.keys()` (**never** hardcode `v6` — `release-gate.mjs:996` only pins the pattern). Emit `observation.evidence` at :310-317 instead of hardcoded `"api-exposed"`.
6. **`preferredWasmTier` (medium).** Honour the class in ORT `numThreads`. **Do not** set `onnx.wasm.simd` — it only gates feature *checking* and ORT 1.25 ships no non-SIMD artifact. Real tiering applies to the **e2ee crate only** (`sha2 0.11.0` genuinely selects a `wasm32_simd128` compress); build a second `+simd128` artifact and select via the existing `moduleOrPath` constructor param. **Do not** duplicate the DCAP QVL artifact — `release-gate.mjs:401-404` throws unless there is exactly one, and `:587-588` budgets that single 1031 KB file.

**Acceptance test (real).** (1) `capabilities-view.test.ts` source contract: the row no longer contains `maxWorkerConcurrency` or an unqualified `heavyPackLoading`. (2) `e2e/edge-portability.spec.ts` `chromium-constrained-2c-2gib` project: assert **no `/semantic-pack/v1/` request is issued** until the confirmation is accepted (today it only asserts the policy string is `"manual"`). (3) `client-ciphertext-cache.test.ts`: with the hint, the injected `openOpfs` spy is never called and the backend reports `"indexeddb"`; without it, OPFS is attempted first. (4) `browser-runtime.test.ts`: controlling / registered-not-controlling / no-registration, and a `cacheKeys()` returning an `airship-shell-v*` key → `probe-passed`; a rejecting `cacheKeys()` → `failed` (a real honesty gain — Firefox private browsing raises `SecurityError` here and today reports "available"). (5) A vitest asserting `"default"` is never forwarded to ORT.

---

### W13 — Declared capability boundary + web search
**Score: 8** · Gaps: `no-negative-capability-declaration`, `no-web-search`
**Owns the CSP for this wave.**

**Goal.** The prompt manifest is a positive list only. The model cannot distinguish "Airship has no push" from "push exists but is human-only" — exactly the hallucination class the charter tries to prevent. And there is no web search at all, while `fetch_url`'s failure message blames the *remote* for what is in fact Airship's own policy refusal.

**Files.**
- `src/core/operating-charter.ts` (new `[Airship declared capability boundary]` section beside `installedToolSection` :134; **owns the single charter version bump for this wave**, `AIRSHIP_CORE_CHARTER_VERSION` 6→7)
- `src/core/operating-charter.test.ts` (:11-15 pinned digest **must** be updated; new sync test)
- `src/tools/network-tools.ts` (new `web_search`; :50 fix the misleading CORS message; :200-213 `safeHttpUrl` pre-fetch origin check against the CSP list)
- `index.html:13` + `public/_headers:2` (**serialized CSP edit — this package only**): add exact origin `https://api.tavily.com`
- `src/ui/vault-view.tsx:222` (already surfaces the connect-src list — reuse it)

**Approach.** Scope the boundary section to the **bounded, code-derivable** set: capabilities another surface in this same build demonstrably has but the agent tool set withholds — exactly `{push, worktree-create, worktree-remove}`. **Do not** add a host-bash entry (charter line 15 already covers it). Phrase web-search manifest-relative ("no search tool is present in the manifest above") so a host-registered `additionalTool` can't turn the line into a lie. Enforce anti-rot with a **test**, not runtime derivation, since the composer only receives `{name, description, effect}`.
For search: **Tavily, not Brave.** Verified: Tavily's preflight reflects Origin and permits `content-type,authorization`, and the POST returns `access-control-allow-origin: *`. Brave's preflight returns **405 with no CORS headers** — shipping it would be a permanently broken tool. Register `web_search` only when a key is present so the manifest never advertises a dead capability. Disclose in the tool description that query text egresses to a non-TEE third party.

**Acceptance test (real).** (1) New `operating-charter.test.ts` case reading the `git_change`/`git_remote` action enums and the `GitAdapterCapabilities` features map: **fails** if a boundary entry names an action that has become reachable, **or** if an available feature has neither a tool nor a boundary entry. (2) Live-gated `web_search` test behind `AIRSHIP_TAVILY_API_KEY` (skipped without it) hitting the real endpoint. (3) `npm run check:security` passes with the added origin and fails if the meta/header pair diverges by one byte. (4) A test asserting an off-allowlist `fetch_url` is refused **before** the fetch with a message naming Airship's own policy.

---

### W8 — Execution runtime: reachability + the four real bugs
**Score: 6.7** · Gaps: `wasi-runner-unreachable`, `wasi-no-stdin`, `result-discarded-on-workspace-budget-overflow`, `pyodide-writeback-missing-control-plane-guard`, `pyodide-timeout-includes-cold-boot`, `wasi-ceilings-too-small-for-real-work`, `wasi-single-preopen-no-cwd-no-tmp`, `poll-oneoff-busy-spin`
**Sole owner of `execution-tools.ts` — all eight findings, one agent.**

**Goal.** The WASI runner is the strongest under-used asset in the repo (a real `std` Rust binary exercised argv/env/cwd/read/write/rename/copy/mkdir/seek/truncate/readdir/1 MiB files/clock/`exit(7)` correctly). It is practically inert because the only way to supply a binary is 2.4 M characters of base64 in a tool argument. Plus four correctness bugs that make every runtime feel broken.

**Files.** `src/execution/wasi-preview1-pack.ts`, `wasi-preview1-worker.ts`, `wasi-preview1-contract.ts`, `runtime-registry.ts` · `src/tools/execution-tools.ts`, `execution-tool-proxies.ts` · `src/execution/wasix-pack.ts` (delegate to shared guard) · new `src/execution/workspace-egress.ts` · `e2e/browser-worker.spec.ts`, `e2e/fixtures/rust-wasi-preview1.{ts,rs}` · `scripts/release-gate.mjs` (**third in queue**) · `docs/BROWSER_EXECUTION_PACKS.md`

**Approach — ordered, with the traps.**
1. **`wasmPath` (unblocks everything).** Add to both schemas; resolve with `normalizeWorkspacePath`; require a bound workspace; reject in the `javascript-worker`/`python-pyodide` branches or the "accepts only code and timeoutMs" contract silently gains a hole. **Read the artifact OUTSIDE `captureWorkspace`** — the snapshot enforces 512 KiB/file, so a >512 KiB `.wasm` inside the mounted root makes the mount throw before the run starts. Ship base64→bytes as `Uint8Array` over structured clone, but **keep a base64 entry point or update `e2e/browser-worker.spec.ts:60,95,109,127,155`**, which drives `runDisposableWasi` with `RUST_WASI_PREVIEW1_BASE64` and is the gate cited in the acceptance ledger.
2. **Control-plane egress guard (small, honesty-critical).** Extract `assertAllowedWorkspaceEgressPath` from the three duplicate definitions and apply it in `execution-tools.ts` while building `returned` at :897 — **before** `changed`/`deleted`/`changedPaths` — so it fires even when `writeBack` is false, since `changedPaths` is reported to the model. Add WASI's normalization + root-prefix assert + duplicate rejection. `docs/BROWSER_EXECUTION_PACKS.md:127` currently claims this is already true.
3. **Preserve results on collection overflow.** Post `workspaceError` with the `files` key **ABSENT, not `[]`** — an empty list is indistinguishable from "the guest deleted everything" and would make both reconcilers report every mounted path as deleted. Refuse writeback unconditionally when set, and change `isError` at :260 to `exitCode !== 0 || Boolean(workspace?.workspaceError)` so a run whose artifacts were dropped is never reported as clean success.
4. **Split the Pyodide timer.** Post `{type:"ready"}` after `loadPyodide()` resolves (keep boot inside `onmessage`, not top-level await — the main thread posts with no handshake). Insert the `ready` branch **alongside** the `output` branch at :1041-1045, **before** the `ok !== true` check at :1046, or it is swallowed as "initialization failed." **Drop the pooled warm interpreter entirely** — it breaks the `disposable-worker`/`ephemeral` declaration in four pinned places including `e2e/browser-worker.spec.ts:507-511`, and `sys.modules`/globals/pending asyncio survive a pool.
5. **Ceilings.** `maximum: 120_000` in both schema copies, per-runtime ceilings enforced in the existing discriminated `validateExecuteCodeArguments` branches (JSON Schema `maximum` can't vary by runtime). Replace silent output truncation with **declared** truncation (`droppedBytes` per stream in `ExecutionResult`), following the `node-webcontainer-adapter.ts:236` `limitReason` precedent. **Do not** write an overflow log into the workspace — WASI's mount is optional and `collectFiles` would turn truncation into a hard failure.
6. **`/tmp` scratch + `cwd`.** Append `new PreopenDirectory("/tmp", new Map())` **after** the workspace preopen — order is load-bearing (the repo's own `no_std` fixture hardcodes fd 3; scratch-first exits 41). Inject `TMPDIR=/tmp` because `std::env::temp_dir()` panics on wasip1. **The proposed cwd mechanism is wrong:** renaming the preopen does *not* set cwd (verified: cwd stays `/` and every relative path fails). Mount the requested subtree as the first `PreopenDirectory(".")` and expose the wider tree as a named absolute mount; fix the `reconcileWorkspace` path join accordingly; and say "relative paths resolve under `<cwd>`", never "working directory."
7. **`poll_oneoff`.** Wrap the import table (`{...wasi.wasiImport, poll_oneoff}`) — safe, the shim closes over `const self = this`. Use `Atomics.wait` on a pre-allocated `SharedArrayBuffer` (legal in a dedicated worker; COOP/COEP are already served). Where SAB is absent, cap the spin at ~50 ms and return `ERRNO_NOTSUP` rather than melting a core. **Change the engine provenance string** (`browser-wasi-shim-0.4.2-worker+poll_oneoff`) — `docs/BROWSER_EXECUTION_PACKS.md:57-58` currently states the shim is unmodified upstream.
8. **stdin.** `stdin?: string` on `ExecutionRequest` + schema (`additionalProperties: false` means it's mandatory, not optional), `WASI_PREVIEW1_MAX_STDIN_BYTES`, `decodeWorkspaceBytes` so binary works, `new OpenFile(new File(message.stdin ?? new Uint8Array()))`. Add `stdin: "batch" | "streaming" | "none"` to `ExecutionCapability`. Streaming stdin is BUILD AFTER (needs `crossOriginIsolated` gating and a `fd_fdstat_get` character-device filetype).

**Acceptance test (real).** All in `e2e/browser-worker.spec.ts` (real Chromium, real WASI shim, real Pyodide):
- Write the existing pinned Rust `wasm32-wasip1` fixture bytes into the workspace via `encodeWorkspaceBytes`, run `execute_code` with **`wasmPath`**, assert `exit 7` and the fixture's stdout.
- A new stdin fixture (compiled with the installed rustc, digest-pinned like the existing one) echoes fd 0 → assert byte-exact round trip including a binary payload.
- Python job printing `ok`, exiting 0, and writing a 600 KiB file → assert stdout `ok`, `exitCode 0`, `isError true`, `workspaceError` present, and **zero workspace writes**.
- Python `os.makedirs(".git"); open(".git/config","w")` with `writeBack:true` → rejects with `/excludes control-plane path/`; assert no write occurred.
- Python `time.sleep(0.1)` with `timeoutMs: 1000` on a **cold** worker → succeeds (fails today; cold boot is 2–4 s).
- A guest writing to `/tmp` → file is **not** in `changedPaths` and is never adopted.
- A guest sleeping 500 ms → completes; unit test asserts the wrapper preserves upstream `ERRNO_INVAL`/`ERRNO_NOTSUP` and takes the `Atomics.wait` path.

---

### W9 — Syntax highlighting + markdown completeness
**Score: 6.4** · Gaps: `no-syntax-highlighting`, `markdown-inline-gaps`

**Goal.** Every code block the agent emits and every file the user opens renders as undifferentiated monospace — the most visible quality gap versus competitors, on a product whose own principle is "The Transcript is the Instrument." Meanwhile italics, strikethrough, nested lists, rules and images render wrong or flattened.

**Files.** New `src/ui/chat/highlight.ts` + `highlight.test.ts` · `src/ui/chat/markdown.tsx` (:13, :43-62, :129-132, :142-153, :171-173), `markdown.test.ts` · `src/ui/chat/message-parts-view.css` (:17-21) · `src/ui/styles.css` (`:root` `--tok-*`) · `src/ui/workspace-view.tsx` (:462 gutter), `workspace-view.css`

**Approach.** Zero-dependency ordered-regex scanner returning non-overlapping spans; unknown language → `[]` (fail-open to today's plain rendering, never a wrong-language guess). Normalize the language key by first whitespace word — ` ```ts title=foo ` yields `"ts title=foo"` through `boundedLabel`, so raw equality silently misses. Render via `createElement` only (`require-trusted-types-for 'script'` + `script-src 'self' 'wasm-unsafe-eval'` stay intact). **Streaming is the trap:** `IncrementalMarkdownView` re-renders the trailing block every flush, so tokenize **per block inside `MarkdownBlockView`** on already-frozen block objects — re-tokenizing the frozen prefix turns the O(n) streaming property into O(n²).
Define a dedicated `--tok-kw/str/num/com/fn` family. **Do not** reuse `--v-verified/--v-caution/--v-failed/--copper` — `design-contract.test.ts:37-50` locks those as verdict tones, `type-floor.test.ts:29-32` forbids `--copper` in `message-parts-view.css`, and `DESIGN_LANGUAGE.md:49` says color must never carry meaning: a keyword must not look like a proof state.
For markdown: `**bold**` must precede `*italic*` in **both** the alternation and the dispatch chain; guard `_..._` with non-word boundaries or `snake_case` identifiers italicize; `---` and `h4-h6` are **unreachable** without also teaching `startsBlock` (:171-173) — the paragraph accumulator swallows them first; nested lists need a depth-carrying item type plus a nesting cap. **Emit alt text + a `safeHref` link for images, never `<img>`** — `img-src` blocks remote model-supplied images and they are a tracking-pixel/IP-leak vector.

**Acceptance test (real).** `highlight.test.ts` invariants: spans non-overlapping, monotonic, and slicing+concatenating reproduces the input **exactly** (the correctness property that matters). `markdown.test.ts`: bold-before-italic ordering, `MARKDOWN_LIMITS`-style snake_case non-italicization, `---` immediately after a prose line, nested-depth preservation, image → alt text + link and **no `<img>` node**. Playwright against `dist`: a ` ```ts ` block contains `.tok-kw` elements, and a `securitypolicyviolation` listener records **zero** events during render.

---

### W14 — Lineage on agent-facing retrieval
**Score: 7.5** · Gap: `lineage-dropped-on-agent-tool-retrieval`

**Goal.** "Full lineage on every retrieval" holds for injected turn context and fails for everything the agent *fetches deliberately*. Most consequentially, `search_context` drops the `embedding.posture` field — so the model cannot tell whether its hits came from the deterministic hash bootstrap or the real semantic model, and will reason about lexical-overlap hits as semantic matches.

**Files.** `src/tools/context-tools.ts` (:15 limit, :28-50) · `src/tools/federated-memory.ts` (:153-167) · `src/tools/memory-tools.ts` (:64-74) · `src/core/context-selection.ts` (:41, :304-306 retriever enum) · `src/retrieval/federated-turn-context.ts` (:166 export `memoryLineage` — **after W11**)

**Approach.** Attach lineage from the runtime's own generation. Two honest options for the digest — **pick one and be explicit**: (a) clamp the tool to the canonical contract (limit 20→`MAX_HITS`=8, same 32 KiB byte budget, per-hit `textDigest`) and call `sealContextSelection`; or (b) keep 20 hits and emit `sha256(stableStringify(payload))` labeled a **payload digest, not a `selectionDigest`**. Never seal a >8-hit, byte-unaccounted payload — `canonicalContextSelection` would reject it and the digest would be a false badge. Add a distinct retriever id (`airship-workspace-tool-search-v1`) to **both** the union and the validator; reusing the turn-context id would misdescribe the retriever. In vault mode, read lineage from the local memory-only runtime and report `persistence: "memory-only"` — never copy the turn selection's lineage, which may describe an encrypted mirror with a different generation id.

**Acceptance test (real).** Vitest: `search_context` output includes `embedding.provider/dimensions/posture` and `indexFormat`; switching the runtime from hash to semantic changes the reported posture. A negative test asserting a 20-hit payload is **not** accepted by `canonicalContextSelection` (proving option (b) was labeled honestly, or that option (a) actually clamps). `search_memory` profile group carries a generation with `memory.json` revision + `sourceDigest`; `recall_memory` records carry `contentDigest`.

---

### W25 — Repository import fidelity (binaries)
**Score: 7.5** · Gap: `import-drops-binaries-and-cannot-auth` (binary half only; auth half → **Cannot Build C5**)

**Goal.** Import any real repository today and you get a repo that is not the repository: no images, fonts, wasm, or binary lockfiles. The workspace already has a lossless binary path (`encodeWorkspaceBytes`) that the importer simply never calls.

**Files.** `src/tools/repository-import.ts` (:138-142, :27/:197 `skippedBinary`, :112-115 caps) · `src/ui/sources-view.tsx` (:317-319, :330, :583) · `src/ui/app.tsx` (:2578, :2586 approval copy — **read-only region**) · `src/tools/network-tools.ts:78` · `docs/BROWSER_GIT.md:84-86`, `docs/EDGE_RUNTIME_CAPABILITY_LADDER.md`

**Approach.** `content: encodeWorkspaceBytes(bytes)`. **The size accounting is the trap:** `validateFileContent` measures the *envelope string* against `GIT_LIMITS.maxFileBytes` (8 MiB), and base64 inflates ~1.34×, so a 7 MiB asset imports into the Workspace and then fails Git admission, **rolling back the entire import**. Cap binaries at ~6 MiB decoded (or raise the limit), charge encoded length against `maxBytes`, and report it in `bytesWritten`. Retire or redefine `skippedBinary` and its receipt row. Keep `raw.githubusercontent.com` (uncapped CDN) as the anonymous transport.

**Acceptance test (real).** Extend `e2e/github-import.spec.ts`: import a fixture repository containing a PNG, assert the workspace file round-trips byte-identically through `decodeWorkspaceBytes`, assert `git status` sees it, and assert the receipt no longer reports it as skipped. Add a unit case: a 7 MiB binary is rejected **before** staging with an explicit reason and the import of the remaining files still succeeds.

---

### W20 — Make compression and retrieval visible in the transcript
**Score: 7.5** · Gap: `compression-and-retrieval-invisible-in-chat`

**Goal.** Every claim in the context dimension is true in the durable journal and invisible in the product. A user cannot see that their turn pulled three workspace chunks and one profile memory, which files, that the session compressed at 82%, or that the model summarizer failed and the deterministic extractive fallback ran. For a project whose thesis is that *shown claims must be true*, the deeper failure is that **true claims are not shown**.

**Files.** `src/ui/chat/message-parts.ts` (:5-14 kinds, :284-410 event branches, :571-578, :691) · `src/ui/chat/message-parts-view.tsx` (:128-136) · `src/ui/chat/session-message-presentation.ts` (:449-456) · `src/ui/app.tsx` (:2294 — **rebase onto W3**) · corresponding `.test.ts` files

**Approach.** Additive and **fail-closed**: run `turn.context.selected` payloads through `canonicalContextSelection()` and `context.summary.updated` through `canonicalContextSummary()`; if canonicalization returns `undefined`, **emit nothing** — never render an unvalidated payload. Cheapest correct rendering path is the already-registered-but-never-produced `"citation"` part kind whose renderer exists. To land the retrieval row under the *user* message, `userPartsForGroup` must also receive the group's `turn.context.selected` event (it currently passes only `[group.request]`). `lineage` is optional (required only for v2) — say plainly "historical v1 selection, no lineage recorded" rather than hiding the row. Surface `summaryMethod` and, when `summarizerAttempt` is present, state that the model summarizer failed and the deterministic fallback ran.

**Acceptance test (real).** `message-parts.test.ts`: a real canonical selection produces the part; a malformed payload produces **nothing**. `session-message-presentation.test.ts`: a group containing both events renders the row and the compression marker in the right positions. Playwright: run a turn with a seeded workspace index under the **real** `DemoInferenceTransport`, assert the retrieval row names the actual retrieved file paths and the embedding posture.

---

## Wave 3 — Depth

### W18 — Git capability surface: history, verbs, remotes, push
**Score: 5.7** · Gaps: `no-history-anywhere`, `no-merge-stash-tag-revert-discard`, `no-remote-management`, `git-push-and-worktrees-withheld`
**Strictly after W7 and W19 (same files).**

**Goal.** The commit graph is written but never readable — no `log`, `show`, `blame`, so the agent literally cannot reason about *why* code is the way it is. Branching is write-only. And `push` / worktree create-remove are implemented and human-reachable but withheld from the model with no declaration.

**Files.** `src/git/types.ts` (:3-14 `GIT_CAPABILITIES`, :37-42, :110-145, :176, :233-266, :288-310) · `client.ts` (:61, :112-120, :224-234 `validateCapabilities`) · `workspace-adapter.ts` · `memory-adapter.ts` · `encrypted-workspace-adapter.ts` · `operations.ts` · `terminal-commands.ts` (:63-97, :377-393) · `src/tools/git-tools.ts` · `src/ui/sources-view.tsx` · `docs/BROWSER_GIT.md`, `docs/PRODUCT_SPEC.md:127`

**Approach — the four traps.** (1) Adding a capability to `GIT_CAPABILITIES` is a **three-adapter** change: `validateCapabilities` rejects any adapter that omits one or marks it unavailable without a reason. (2) `git.log` already accepts `filepath`/`follow`/`since`/`depth` — no `git.walk` needed for path history. (3) **`git.merge` alone does NOT update the working tree** — `_merge` writes only the ref on the fast-forward path; isomorphic-git's own `_pull` calls `_merge` then `_checkout`. Omitting the checkout silently desynchronizes `WorkspacePort` from HEAD. (4) `push` is a **separate tool with `effect: "identity"`** (per `operations.ts:126`), not an action on `git_remote` (whose effect is `"network"`); tool effect is per-tool, and mislabeling it corrupts the approval descriptor. Also: catch `GitDomainError` and return `{ok:false, code, message}` — `agent.ts:323` journals only `error.message`, so `push-outcome-unknown` would otherwise be lost. Worktree actions on `git_change` need `required` to become per-action (`expectedRepositoryVersion` vs `expectedWorktreeVersion`).
Phase 2 (defer): `cherryPick` is a direct call; `rebase` and `revert` have **no isomorphic-git export** and must stay labeled unavailable.

**Acceptance test (real).** `workspace-adapter.test.ts` against real isomorphic-git: `log` over a 5-commit chain returns 5 oids in order; `log({filepath})` returns only touching commits; `show(oid)` renders a real +/- patch. A merge test asserting **the working-tree files on `WorkspacePort` match the merged HEAD tree** (this is what catches trap 3). `stash`/`stashApply` round trip. `terminal-commands.test.ts` for `git log/show/merge/stash/tag/remote add`. `git-tools` test asserting `git_push` carries `effect: "identity"` and that `airship-tools.test.ts:17-24`'s tool-name/effect set is updated deliberately.

---

### W16 — Inference: context windows and model metadata
**Score: 6.4** · Gaps: `cloud-no-context-window`, `agent-model-metadata-thin`

**Goal.** OpenAI/Anthropic/xAI sessions run with **context compression completely disabled** — no window is ever discovered, so `contextPolicy` is `undefined` and the conversation grows until the vendor 400s, while the identical conversation on Chutes compresses correctly. Anthropic additionally ships a hardcoded `max_tokens: 8192` that **exceeds the limit of models Anthropic still lists**, so those turns 400 today. And the agent's roster is close to a bare ID list — no window, no output cap, no price — so "use the cheap model" is unanswerable.

**Files.** `src/inference/providers/browser-cloud.ts` (:35, :111, :702-717) · `contracts.ts` (:143-158, :257-263) · `session-route.ts` (:168-178) · `src/ui/provider-connections-view.tsx` (:296-310, :534) · `src/ui/app.tsx` (:4978-4990, :5066-5083, :5164-5183 — **rebase onto W3**) · `src/core/operating-charter.ts` (:42-46, :96-105 — **no version bump**) · `src/core/context-policy.ts` (:173-182)

**Approach.** **Do not** build a model-name/family capability table — explicitly forbidden by `docs/PROVIDER_FABRIC.md:23` invariant 5 and by comments in `agent.ts:167-168`. Build the **operator-declared** path: a per-model window/output override on the connection surface, persisted as a model row with `source: {kind:"manual"}` (already validated and labeled "Manual metadata"). Branch `contextPolicyForProviderModel` to emit `{kind:"runtime-config", label:"operator-declared context window"}` — an already-accepted variant, no contract change. **Anthropic's cap must be per-request, not per-transport** — transports are built per *connection*, before any model is selected, and cached by connection id. Lower the unconfigured default below the smallest limit Anthropic accepts. When no window is declared, the connection card must **state that context compression is unavailable for this model** (CANON 3.5: missing capability stays visibly unavailable).
For metadata: the finding's plumbing **skips a hop** — `InferenceModelPromptDefinition` (`operating-charter.ts:42-46`) and `inferenceDirectoryFromAvailability` (`app.tsx:5164-5183`) have no context/price fields, so editing the emitter alone is invisible. Also `InferenceModelDescriptor` has **no pricing field** — either add one or keep pricing on the Chutes path. And `in$=3.00` **throws**: `$` fails both `promptToken` and `promptFacet` regexes; use facet-safe keys (`usd-in=3.00`) with a numeric guard.

**Acceptance test (real).** Vitest: a cloud route with a declared window pins `contextPolicy.source.kind === "runtime-config"` and a long synthetic transcript triggers `planContextCompression`; an undeclared route pins nothing **and** the UI surfaces the unavailable-compression notice. `browser-cloud.test.ts`: the declared `max_tokens` reaches the Anthropic payload per model, and the unconfigured default is ≤ the smallest listed limit. `provider-registry.test.ts:409-432` extended to assert the new fields survive snapshot → prompt projection (proving the missing hop is wired).

---

### W17 — Drive vault remembers the key and folder
**Score: 5.3** · Gap: `drive-vault-forgets-key-and-folder-on-reload`
**After W6.**

**Goal.** Every refresh, tab restore and browser restart drops the user back to pasting a 128-character recovery key and re-running folder discovery. This is the practical reason a user abandons Drive.

**Scope correction:** mid-session ~1-hour token expiry is **already solved** (`coordinator.ts:333-339` `reauthorizeGoogleDrive`, wired to a renew button). The gap is page reload / new tab / restart only.

**Files.** New `src/storage/workspace-key-handle-store.ts` · `src/storage/local-device-keyring.ts` (export `equivalentWorkspaceKeys`, currently private **and duplicated** at `local-device-vault-setup.tsx:849`) · `src/ui/google-drive-setup.tsx` (:80-90) · `src/storage/google-drive-workspace.ts` · `docs/GOOGLE_DRIVE_VAULT.md:51-53`

**Approach.** New IndexedDB database (`airship-workspace-key-handles-v1`) — **do not** bump `airship-local-device-keyring-v1`, which would force a migration of existing enrollments for no benefit. **Partition keying must differ from the obvious proposal:** `google-drive:<folderId>:<subject>` is unusable as the primary key because neither component is known before authorization, so nothing could be looked up to render the reconnect affordance. Key by `google-drive:<googleSubject>` and store the non-secret `GoogleDriveWorkspace` descriptor + account email alongside, with a `list()` so the UI can render "Reconnect &lt;email&gt; → &lt;folder&gt;" before any click. The existing `keyRecord()` validator silently drops unknown fields and would discard the descriptor — the new module needs its own bounded validator. Fail closed on adoption: re-run `connectExisting()` and assert the rediscovered `workspaceFolderId` and `namespaceId` equal the stored ones. Store only the structured-cloned **non-extractable `CryptoKey`** — raw bytes are never a fallback. Label it "browser-profile unlock"; recovery paste stays the only cross-device route.

**Acceptance test (real).** `e2e/google-drive-vault.spec.ts` extension using the existing deterministic GIS boundary + a real IndexedDB: connect, write a workspace file, **reload the page**, and complete adoption with a single authorize click and **zero recovery-key entry**; assert the file reads back. Negative case: mutate the stored `namespaceId` → adoption refuses and falls back to recovery paste. Unit: `persistedHandle()` round-trips through the store and `equivalentWorkspaceKeys` accepts it while a foreign key is rejected.

---

### W12 — Expose the jsh shell that already runs
**Score: 4.8** · Gap: `no-shell-tool-while-jsh-runs`
**After W8 (same dispatch).**

**Goal.** A real WebContainer `jsh` is already spawned in this codebase for the human terminal and is reachable through `execute_node_project` today — yet that tool's own description tells the model *"No shell string or host Bash is involved."* A real capability is inert **and actively discouraged**.

**Files.** `src/tools/execution-tools.ts` (new registered tool + dispatch case; **:338 and :505 hardcode `shell: "none"`, contradicting `node-webcontainer-adapter.ts:43`**) · `execution-tool-proxies.ts` (byte-identical frozen definition) · `src/execution/runtime-registry.ts` (:42-57 `shellScript?`) · `node-webcontainer-adapter.ts` (:60-70) · `e2e/live-webcontainer.spec.ts` · `docs/MASTER_PROMPT_ACCEPTANCE.md`, `docs/BROWSER_EXECUTION_PACKS.md`

**Approach.** **Gate first, then ship.** Add the opt-in live probe before advertising anything. Then add `execute_shell_command` with an honest description ("one WebContainer jsh script — BusyBox-class builtins, pipes, `&&` sequencing. This is not host Bash: no sudo/apt, no host filesystem, no host processes"). Handle `shellScript` explicitly in the adapter (force `command: "jsh"`, `args: ["-c", script]`) while **keeping** the existing `COMMAND_PATTERN` rejection on the `command` field so the "never routes a shell expression through a hidden shell" invariant (`node-webcontainer-adapter.test.ts:68`) still holds. Emit `shell: "webcontainer-jsh"`, `output: "combined"`. **Do not touch `operating-charter.ts`** — it already names jsh correctly and any edit rotates every prompt digest.

**Acceptance test (real).** `e2e/live-webcontainer.spec.ts`, gated on `AIRSHIP_LIVE_WEBCONTAINER=1`, against real StackBlitz WebContainer: `jsh -c 'exit 7'` → `exitCode 7`; `jsh -c 'cd sub && printf x > out.txt'` at exit 0 → adopted writeback; at nonzero exit → **nothing adopted**; `AbortSignal` kills the process. **Not** in `browser-worker.spec.ts` — line 336 there asserts node-webcontainer is *not* ready.

---

### W15 — Context compression durability
**Score: 4.6** · Gaps: `summary-chain-drops-oldest-deltas`, `no-compression-inside-tool-loop`, `token-estimate-never-calibrated`

**Goal.** After ~4 compressions the earliest summarized conversation stops being sent — the session "remembers" and then quietly forgets its own beginning, which is precisely the property iterative compression exists to avoid. Compression runs once per turn before a 32-step tool loop that can overflow the window it was meant to protect. And the trigger uses a fixed bytes/3.6 guess whose error (25–40%) is larger than the entire 80–85% band, while real `prompt_tokens` sit one event away, unused.

**Files.** `src/core/context-summary-projection.ts` (:6, :20-45, :54-108, :134-193) · `context-compressor.ts` (:43, :159-170, :177-307) · `context-policy.ts` · `agent.ts` (:179, :203-209, :214, :229-245) · `session-audit.ts` (:35-56, :663-706, :1221-1256) · tests

**Approach — three corrections.**
- **Meta-compaction:** cheapest correct variant is to keep the existing `context.summary.updated` event type and add optional `compactionLevel` / `compactedSummaryDigests` fields, avoiding the `KNOWN_EVENT_TYPES` + new-audit-arm work entirely. `planContextCompression`'s `prior = canonicalSummaries(events).at(-1)` must still resolve to the newest **level-0** summary or `coveredThrough` breaks. Fix the independent scaling bug in the same package: `MAX_SUMMARY_PROJECTION_BYTES` is a fixed 48 KiB regardless of a session's pinned window, so a 1M-token model still gets 48 KiB of summary — derive it from `contextWindowTokens` with 48 KiB as the floor.
- **In-loop guard — do NOT hoist compression into the step loop.** `session-audit.ts:663-690` only permits a summary outside a turn or as pre-inference preprocessing, so a mid-loop append audits as `CONTEXT_SUMMARY_INVALID` and the session refuses to resume; and the current turn's tool bytes are never compressible anyway (cutoff must be a `turn.completed`). Ship instead: (a) an in-loop budget guard calling the already-exported `estimateInferenceTokens` after `materializeMessages` and failing closed with a specific, auditable `turn.failed` before `transport.stream()`; (b) a **per-turn cumulative tool-output budget** that stores over-budget results truncated with an explicit marker (the `network-tools.ts` `truncated: true` pattern) so the turn survives and the transcript never misrepresents what the model saw.
- **Calibration:** put the calibrator in `context-compressor.ts` as a pure function taking the materializer as an argument and call it from `agent.ts` — `materializeMessages` is exported from `agent.ts`, so a direct import creates a cycle. `inference.started` records only a `requestDigest`, not the messages, so the sample must be **re-materialized** from the prefix with options matching `agent.ts:214-218` exactly. Divide by the **full** `stableStringify({systemPrompt, messages, tools})` byte length — messages-only over full `prompt_tokens` is systematically biased low. Keep the `[2.0, 6.0]` clamp: `prompt_tokens` is adversary-controlled input flowing into a client-side control decision. If recorded in the commitment, add it as an **optional** field to `CanonicalContextSummary` or `canonicalContextSummary` silently drops it and verification fails on read-back.

**Acceptance test (real).** `agent-compression.test.ts` built through the **real** `EventJournal` + `MemoryJournalBackend` (hand-written fixtures fail the digest-chain check): (1) a 6-compression session — the level-1 node subsumes the oldest deltas, `materializeContextSummary` still projects sequence-1 coverage, and `verifyContextSummary` passes; (2) a turn whose tool results exceed the pinned window produces a deterministic `turn.failed` with the specific message **and** a truncated-with-marker tool result, not a provider 400; (3) replaying a journal with recorded `inference.usage` yields a `bytesPerToken` within the clamp that differs from 3.6, and `estimatedTokensBefore/After` use one basis. Full `session-audit` replay must verify in every case.

---

### W23 — Sub-agent / task tool
**Score: 4.0** · Gap: `no-subagent-task-tool`

**Goal.** Broad exploration ("find every call site of X and summarize") must burn the parent window step by step, with no way to isolate noisy search into a disposable context. Unlike Bash, **nothing about the browser prevents this** — the codebase already performs nested `transport.stream()` calls in two places (the safety reviewer and the inference summarizer).

**Files.** New `src/tools/subagent-tool.ts` · `src/tools/registry.ts` (add `subset(names)`) · `src/ui/app.tsx` (inject via the existing `additionalTools` seam at :1504 — **rebase onto W3**) · `src/load-agent-runtime.ts`

**Approach — five traps.** (1) **Do not** register it in `tool-bundle.ts` — `AirshipToolRegistryOptions` carries no transport, and the transport is per-runtime and user-switchable; construct in the UI and inject via `additionalTools` (the precedent `providerAvailabilityTool` already uses). (2) **Register unconditionally** with a live transport accessor and fail closed inside `execute` — conditional registration makes `toolManifestDigest` connectivity-dependent and trips "The tool manifest changed. Fork the session" on every reconnect. (3) Import `runTurn` lazily via `load-agent-runtime.ts`, never statically. (4) The child manifest must inherit `providerId`/`model`/`systemPrompt` from the parent (`agent.ts:85-89` rejects a mismatched transport id), be built from the **subset** registry's `definitions()` (`:90-95` digest check), and leave `turnContext` at the default unless the subset also forwards the context runtime (`:467-473` throws otherwise). (5) Journal `subagent.started/completed` on the **parent** session — `EventJournal.append` re-reads the head each call, so tool-side appends interleave safely with a suspended parent turn. Pass the parent's `ApprovalPolicy` through unchanged; **do not** couple this to a turn-scoped grant scheme (separate change to the permission model).

**Acceptance test (real).** `src/core/` integration test with the real `DemoInferenceTransport`: a parent turn calls `run_subagent` with `allowedTools: ["search_text","read_file"]`; assert (a) the child completes and returns bounded content, (b) the child's tool calls are **absent** from the parent's materialized messages, (c) the parent journal contains `subagent.started`/`completed` with the parent `turnId`, (d) a child attempting `write_file` fails because it is not in the subset, (e) aborting the parent's signal terminates the child and still writes a durable terminal record, (f) the full journal audits as verified.

---

# BUILD AFTER

These are real and buildable, but each depends on a Wave 1–3 package landing first, or is genuinely very-large and should not compete with the polish work.

| # | Package | Gaps | Depends on | Why deferred |
|---|---|---|---|---|
| **A1** | **Vault growth control** — trash/reclaim, cache eviction, Drive index sharding | `no-delete-vault-grows-forever`, `ciphertext-cache-never-evicts`, `drive-full-index-round-trip-per-write` | W6, W17 | Requires adding `delete(key)` to `ObjectStore` and **every** adapter (memory/direct/s3/drive/local-device) before any retention sweep can exist. Index sharding must be **lexicographic**, not sha256-routed — `list(prefix)` has three real callers. The referenced-set for GC must include **profiles** (`state/profiles/v1`), which the finding's set omits — omitting it deletes live data. Order operations index-entry-first: a crash then leaks an untracked file instead of breaking a live reference. |
| **A2** | **Authenticated partial reads** | `workspace-reads-never-use-ranges`, `local-device-range-reads-whole-record` | A1 (same `encrypted-workspace.ts`) | Text files only; leave Git objects and binary envelopes whole. Blocks must cut on code-point boundaries (the decoder is `fatal: true`). `openFile` cannot be reused — it asserts full length. Local-device needs **envelope block-framing**, not `<id>#<n>` per-block records (record ids must pass a strict 43-char validator and would pollute `list()`, the export inventory digest, and `MAX_OBJECTS`). UI copy at `workspace-view.tsx:461` and two docs must change in the same commit. |
| **A3** | **Workspace FS at scale** | `workspace-fs-collapses-at-scale` | W2, A1 | 2,400 files → 2.5 s status, 205 `list()` + 5,429 `read()`, each a full manifest decrypt on the durable path. Layers: (1) directory + metadata index in `workspace-fs.ts` — note `WorkspaceEntry.size` is the **encoded** length and is ~1.34× wrong for binaries; (2) manifest memoization keyed by head ETag (the dominant cost is AES-GCM + SHA-256 + parse, not I/O — 4.6 s with zero network on 200 files) plus a one-snapshot-per-operation scope. **Do not** add a plaintext OPFS workspace tier: it would falsify the "Ephemeral = page memory only" label and silently downgrade the encrypted local-device tier's advertised boundary. |
| **A4** | **POSIX sh Tier 1 (TypeScript)** | `no-posix-shell` | W8, W12 | The universal tier: lexer/parser/pipeline/builtins over `WorkspacePort` with real streaming pipes, globbing, redirection, exit codes. Two union edits in `runtime-registry.ts`, not one. **Must be a lazy chunk with its own `RELEASE_BUDGETS` entry** or `entryJavaScript` (384 KiB/110 KiB gzip) fails. Terminal wiring is a real refactor — `manager.ts` is typed end-to-end on WebContainer; extract a `TerminalEngine` interface first. Ship the honesty row ("POSIX sh subset — not Bash") enumerating job control, traps, arrays, process substitution, signals as unsupported. |
| **A5** | **Terminal ↔ page-runtime bridge** | `terminal-cannot-reach-page-runtimes` | A4 | Paths must live under `container.workdir` (`/home/.airship-bin` is wrong) with the control directory **outside** `airship-workspace` so the sync never adopts control files. `FileSystemAPI` has no `chmod` — use `spawn("chmod")` or an npm `bin` link. PATH must **prepend**, not replace, `WebContainer.path`. Coherence is mandatory: push container edits with `syncTerminalWorkspace` before dispatching, and remount after any writeback, or the mount goes stale and fails closed. Confused-deputy risk: any container process (an npm postinstall) can write a request file — bind requests to the foreground session and show the requesting command line in the approval. |
| **A6** | **Vector search off the main thread** | `webgpu-only-inside-onnx` | W1 | Step 1 is free and correctness-preserving: cache L2 norms at insert (single ingress at `flat-index.ts:7`) and compute the query norm once — ~3× fewer multiplies with bit-comparable results. **Do not** swap cosine for a bare dot product on the strength of `normalize: true` — `validateVectors` checks dimension and finiteness only, never unit norm. Step 2 moves scoring to a worker (tokens must ship too — lexical participates in the 0.72/0.28 blend). Step 3 is an optional WGSL kernel. Note `flat-index.ts` has **no test file today**. |
| **A7** | **Mid-conversation model switch** | `no-mid-conversation-switch` | W16, W20 | Bigger than the two files it names: the provider request is rebuilt **exclusively** from journal events, so a UI-only carry would be theater. Needs a `context.transferred` genesis event in `KNOWN_EVENT_TYPES` with its own audit arm, a `materializeMessages` prefix splice, `historyCopied` relaxed from the literal `false` to `"carried" | "none"`, and ancestor-provenance rendering. Requires its own **charter version bump** (queue behind W13's). Carrying provider A's outputs into provider B is a real cross-provider data transfer and must be **opt-in**, never the silent default. |
| **A8** | **Content-addressed dedup + benchmark harness** | `no-content-addressed-payload-dedup`, `no-storage-reduction-benchmark-harness` | A1, A2 | The missing lever behind the unproven 60–78% claim. Chunk-level CAS alone saves **compute and memory, not published bytes** — `codec.ts` emits one full record per chunk, so `StoredExpertBlock` needs a payload table + occurrence list. Cross-generation block reuse is **blocked** by `validateDescriptor`, which throws for any descriptor from an earlier generation; and there is **no delete** to build retention on (see A1). Bench lane: measure only what ships — drop the two "control has no implementation" lanes. Report per-workload median with p10/p90 against a committed corpus digest, and gate any percentage quoted in docs against `RESULTS.json`. |
| **A9** | **Memory graph participates in retrieval** | `memory-graph-never-influences-retrieval` | W11, W14 | 1,023 lines of derived relationship graph that contributes nothing to what the model sees. Three corrections: a bare `reranker` field is **silently stripped** by `canonicalGeneration`'s whitelist and would break `selectionDigest` verification on **every turn** — extend the schema first. Re-ranking at the federated seam can only permute ~8 already-clamped hits; over-fetch inside `ClientContextEngine.search` (limit 50) instead. Import from `../memory-graph/derive` **directly** — the barrel drags preact + the WebGL renderer into the per-turn path. |
| **A10** | **Passkey PRF unlock ceremony** | `no-unlock-ceremony-passkey-prf-absent` | W17 | Anyone who opens the browser profile gets the vault with no prompt. Traps: WebCrypto `unwrapKey` **cannot** produce an HKDF key — HKDF the PRF output into an AES-GCM key, decrypt a wrapped seed, then `WorkspaceRootKey.import`. There is **no stored seed** to wrap: it exists only transiently inside `WorkspaceRecoveryMaterial`, so the wrapper must be minted at enrollment/import time; an existing vault cannot retrofit silently (its key is non-extractable) and must require re-entering `airship-wrk-v1.`. `putIfAbsent` refuses overwrite, so enabling PRF is an explicit replace path. Safari needs transient user activation, so unlock cannot live in the boot effect. **Testable headlessly** via CDP `WebAuthn.addVirtualAuthenticator({hasPrf:true})` — see C6 for the residual hardware caveat. |

---

# CANNOT BUILD (or cannot be *proven*) without something the user supplies

Each entry states exactly what is missing. In every case the **code** may still be written; what cannot be done is the proof, or the capability itself.

### C1 — Live OpenAI / Anthropic / xAI gates
**Gap:** `no-live-cloud-provider-gate`. Three of five advertised providers have **never executed a real request**; any could be broken and every test would pass.
**Buildable now:** the harness — `src/inference/providers/browser-cloud.live.test.ts` (env-gated per vendor, mirroring `chutes/transport.live.test.ts:11-14`) plus `e2e/live-cloud-providers.spec.ts` + `playwright.live-cloud.config.ts` (traces/video **off** so memory-only credentials are never recorded). Wire as optional stages in `scripts/release-live.mjs`, not `release-gate.mjs`.
**User must supply:** `AIRSHIP_OPENAI_API_KEY`, `AIRSHIP_ANTHROPIC_API_KEY`, `AIRSHIP_XAI_API_KEY` (disposable, spend-capped) + a model id each.
**Note:** do **not** assert `access-control-allow-origin` on the response — it is not a CORS-safelisted response header, so browsers always return `null`, and Node/undici sends no Origin and issues no preflight. The successful authenticated streamed response from a real cross-origin page **is** the CORS proof.

### C2 — Live Google Drive acceptance
**Gap:** underlies `drive-default-is-dead-on-arrival` and `drive-vault-forgets-key-and-folder-on-reload`.
**Buildable now:** everything in W6 and W17, proven against the deterministic GIS boundary.
**User must supply:** a Google Cloud **OAuth Web client ID** with the Drive API enabled and the deployed origin registered, set as the `VITE_GOOGLE_CLIENT_ID` GitHub Actions **repository variable**; plus a consenting Google account for the live run. Until then the Pages build honestly defaults to Local Device.
**Also note:** GitHub Pages ignores `public/_headers` entirely, so COOP/COEP are not sent on the deployed site at all — the popup-blocking concern does not apply there, but it does apply to any host that honours `_headers`.

### C3 — Web search
**Gap:** `no-web-search`. A browser tab genuinely cannot bypass CORS without a backend; the project has correctly refused to pretend otherwise.
**Buildable now:** the whole `web_search` tool (W13) — Tavily is verified browser-reachable.
**User must supply:** a Tavily API key, held in page memory only. Grade it "Conditional — requires a user-supplied search key." Disclose that query text egresses to a non-TEE third party.

### C4 — Real `git clone` / `fetch` / `push` against github.com or gitlab.com
**Gap:** `csp-blocks-every-git-remote` (capability half).
**Physically unavailable:** GitHub grants **no CORS** on Git Smart HTTP endpoints regardless of what Airship's CSP allows, and shipping a corsProxy would require rewriting four standing "Airship never inserts a proxy" claims — a separate, reviewed product decision.
**Buildable now (W19):** truthful refusal, `permittedOrigins` in the capability record, and routing users to the snapshot importer that works.
**User must supply, if they want it at all:** a decision to run a CORS-enabling Git host (self-hosted GitLab/Gitea with permissive headers) **and** to add that exact origin to the CSP, **or** explicit approval to ship a proxy.

### C5 — Private / enterprise repository import
**Gap:** `import-drops-binaries-and-cannot-auth` (auth half). The binary half ships in W25.
**User must supply:** a GitHub PAT, injected at `registerNetworkTools` time — **never** in the tool `inputSchema` (a model-authored token would land in transcripts), never in the approval payload, never in the import manifest.
**Out of scope regardless:** GitHub Enterprise — the CSP is a static allowlist naming only `api.github.com` and `raw.githubusercontent.com`; a GHES host needs a per-deployment CSP edit.

### C6 — WebNN / NPU acceleration
**Gap:** `webnn-probed-never-used`. **Recommend: do not build.** Score ~0.5.
**Why:** `device: "webnn"` maps to WebNN **CPU** and would never touch the NPU that motivates the finding — `"webnn-npu"` is required. WebNN cannot execute the pack's q4f16 or int8-dynamic graphs, so a **new 48–96 MB fp32/fp16 artifact** must be pinned. Static shapes require `freeDimensionOverrides` + fixed-length tokenization, which conflicts with the policy-variable `embeddingBatchSize`. And the safety story is false: ORT's WebNN EP **silently partitions unsupported nodes back to CPU**, so session creation can succeed while nothing runs on the NPU — reporting `backend: "webnn"` would assert an acceleration the runtime cannot verify, which is exactly what the honesty contract forbids.
**User must supply:** a Windows/ChromeOS device with an NPU for any real verification, plus a decision to accept the artifact size.

### C7 — Rust Tier-2 shell (`airship-sh` busybox multicall) and in-browser compilation
**Physically impossible:** in-browser `rustc`. Keep `Unavailable`. (The exact rustc invocation is already recorded at `e2e/fixtures/rust-wasi-preview1.ts:3-4`.)
**Requires an out-of-browser toolchain:** Tier 2 needs `crates/airship-sh` **authored from scratch** (no such crate exists), a `scripts/build-airship-sh-wasm.sh` in CI, and — because a brush + uutils/coreutils multicall binary exceeds `WASI_PREVIEW1_MAX_ARTIFACT_BYTES` (4 MiB, enforced twice) — explicit raises of those pinned constants plus the stdin channel from W8.
**User must supply:** a decision to vendor MIT/Apache `brush` + `uutils/coreutils` under the existing pinning policy (recommended) vs. hand-writing a grammar, and CI runners with a Rust `wasm32-wasip1` toolchain.
**Also cannot be promoted:** the WASIX/Wasmer path. The `status 45` blocker is a third-party runtime bug; the repo's own recorded evidence shows 45 co-occurring with a demonstrably-executed wrapper and a successful control-directory writeback, and the 2026-07-23 rerun already applied the dependency-aware loader and absolute-DirectoryInit fixes. Keep it fail-closed at `unavailable` with 45 recorded as raw provider telemetry.

---

## Appendix A — Refuted; do not re-raise

Twenty-two items were adversarially refuted. The load-bearing ones an executing agent is most likely to re-derive:

- **jsh/WebContainer exit-status 45** is not mis-propagated Bash status and not a fixable exec bug — see C7.
- **`maxIndexingConcurrency` funnelling into one embedding worker** — the lanes overlap remote workspace reads (the dominant cost); the inference lever is `embeddingBatchSize`, and the number is never displayed. Capping it at 1 would be a regression.
- **WebCodecs / WebTransport in the prompt** — surfaced by `inspect_browser_capabilities`, explicitly disclaimed as "not an execution grant," and WebTransport is the browser half of a documented fail-closed transport gate. Deleting the entries would make the pin an unfaithful subset of two other views.
- **WebGPU should auto-default semantic embeddings** — deliberate, canon-recorded, and test-locked; auto-promotion would mean a 40–60 MB unrequested download and would make a failed promotion *sticky* (semantic is fail-closed with no hash fallback).
- **Approval "Allow once" is all-or-nothing** — `auto-approve` is a real graduated middle tier (per-call model review, human fallback), it is the default for the built-in coding profile, and read effects are auto-allowed in all modes. Do not build session-scoped grants; they contradict a recorded HIDES-POWER decision.
- **`execute_workspace_program` should be effect `"read"`** — would make the strictly *more* powerful tool the only code path with zero prompt.
- **Frozen arguments in the tool bridge / no `apply_patch` / 5-entry allowlist** — computed-argument read-compute-edit already ships via mounted-workspace runtimes with revision-checked writeback.
- **Range coalescing / four serial block reads** — the four reads are already concurrent on one HTTP/2 connection after one coalesced index download; the proposed change would break the ciphertext cache's stable per-block addressing.
- **Empty-`tools` payload 400s the activation probe** — the Responses API (not Chat Completions) documents `parallel_tool_calls` default `true` with no `tools` dependency and echoes exactly that shape.
- **Chutes PKCE "not configured"** — both Actions variables *are* set; the real (different) defect is that the configured client is the confidential localhost app, so the production redirect returns `invalid_redirect_uri`. Any guard must assert the client id **differs from** `CHUTES_LOCAL_REGISTRATION.clientId`.
- **Submodules / LFS / sparse checkout undeclared** — declared in the importer UI at the moment of use; the LFS fix is unbuildable under the no-wildcard CSP rule.
- **Trust-seal responsive dead bands, three profile switchers, missing onboarding** — all three UI claims were measurement artifacts; the desktop seal row, the responsive switcher *pair*, and the zero-setup `DemoInferenceTransport` onboarding path all exist and are test-locked.

## Appendix B — Wave schedule at a glance

```
WAVE 1  (5 agents, no cross-edits after W6→W3 handoff)
  agent A: W1  semantic boot race            → browser-runtime.ts, semantic-*.ts, main.tsx
  agent B: W2  git stat cache                → workspace-fs.ts            [1 file, ~6 lines]
  agent C: W6 → W3  vault default, then UX   → app.tsx (serialized), styles.css, approval-dock
  agent D: W4  read/grep paging              → workspace-tools.ts, content-codec.ts
  agent E: W7  git quick wins                → git/*, release-gate.mjs [queue pos 1]
  agent F: W11 memory ranking                → retrieval/, tools/memory*
  ── serialized close: MASTER_PROMPT_ACCEPTANCE.md merge ──

WAVE 2  (5 agents)
  W19 CSP/git honesty  → git/* (after W7)      | W5  semantic pack   → release-gate [pos 2]
  W10 accelerators     → browser-runtime (after W1), semantic-loader (after W5)
  W13 boundary+search  → OWNS CSP + the one charter bump
  W8  execution        → execution-tools.ts SOLE OWNER, release-gate [pos 3]
  W9  markdown/highlight | W14 lineage (after W11) | W25 import binaries | W20 chat visibility
  ── serialized close: ledger merge ──

WAVE 3  (4 agents)
  W18 git surface (after W7,W19) | W16 inference metadata | W17 drive keys (after W6)
  W12 jsh tool (after W8) | W15 compression | W23 subagent
  ── serialized close: ledger merge ──

AFTER   A1 → A2 → A3   (vault/FS chain, strictly serial on encrypted-workspace.ts)
        A4 → A5        (shell chain)
        A6, A7, A8, A9, A10  (independent)
```
