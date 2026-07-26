# Verifier report — git-verbs

**honest=True**

## Verdict

HONEST, with real residual defects. Every verb the report claims (log, show, tag lightweight+annotated, stash push/apply/pop/drop/clear/list, merge with post-merge checkout, restore, reset soft/mixed/hard, remote add/set-url/remove, terminal `git worktree`) is genuinely implemented over stock isomorphic-git - no stubs, no commented-out code, no deleted or weakened tests. The four claimed bug fixes are real and load-bearing: the ino projection in workspace-fs.ts:282-295 matters because isomorphic-git's compareStats (node_modules/isomorphic-git/index.cjs:960) really does compare ino; the old terminal `case \"worktree\"` really did throw a false 'unavailable' while features.worktree.available was true; the CSP pre-flight really runs before git.clone and before the approval prompt (proved by spy call-count and review-call-count assertions); statusEntries really went from one git.walk per changed path to one for all. The five new test files exercise real .git bytes (loose object paths, refs/tags files, refs/stash, .git/config, merge parent lists) and are not mocked around the thing they claim to prove; the only mocks are git.clone/git.push transport stubs where a transport stub is the point. Checks claimed as passing do pass: `npx tsc --noEmit` exits 0 with zero output; the package suite is 11 files / 83 tests; the full suite is 183 files / 1130 passed + 1 skipped (report said 1125 - the delta is other agents' concurrently added tests, not a discrepancy in this package). The single out-of-scope edit was disclosed accurately and is one fail-closed hunk. Not-done items (finding #4 durable half, #9 import, #11 simulated-git removal, cherry-pick, conflicted status, UI surfaces) are stated plainly and match the tree. Deductions are for defects the report did not surface: the untracked-file deletion in restore, the restore path-bound mismatch that makes one test title broader than what it proves, the error-code masking in chunkedPathMutation, and two assertions that are currently vacuous.

## Issues

### 1.

CORRECTNESS (data loss): src/git/workspace-adapter.ts:847-851 - restore with source 'stage' on an UNTRACKED path deletes it from the workspace. An untracked file has a status entry (worktree: added) so it passes the `${path} has no change to discard` guard at line 829, has no index plane, and falls into the `workspace.remove` branch. Real Git refuses this (`pathspec did not match any file known to git`). Reachable from the terminal as `git restore <new-file>` (terminal-commands.ts maps bare `git restore` to source=stage) and from git_change action=restore. No test in src/git/recovery-verbs.test.ts or gitignore.test.ts covers restoring an untracked path.

### 2.

CONTRACT MISMATCH: the report claims 'the advertised paths.maxItems now equals the runtime bound', but that is only true for stage/unstage. src/tools/git-tools.ts:79 advertises maxItems = GIT_LIMITS.maxPathsPerRequest (4096) for the shared `paths` property, and src/git/operations.ts:181 normalizes `restore` at maxPathsPerRequest, yet src/git/workspace-adapter.ts:826 validates restore at the default maxPathsPerOperation (512) and restore is NOT routed through chunkedPathMutation. A 513-path restore is accepted by schema and normalization and then rejected at the adapter with 'Select between 1 and 512 paths.' The test src/tools/git-tools.test.ts:37-43 ('advertises a path bound the runtime actually accepts') only inspects the schema constant and never exercises restore at that size, so its title overstates what it proves.

### 3.

ERROR-CODE MASKING: src/git/client.ts:265-269 - chunkedPathMutation wraps ANY chunk failure in GitPartialMutationError, including a failure on the very first chunk. A >512-path stage that fails the optimistic-concurrency fence now surfaces as code 'partial-mutation' with completedPaths: 0 instead of 'version-conflict', so any caller matching on the concurrency code (UI retry, tool-layer rebase) misclassifies it, and the message literally reads 'Those 0 paths are already changed and were not rolled back.'

### 4.

CAPABILITY LABEL vs RUNTIME: src/git/workspace-adapter.ts:1571-1573 still reports features.clone/fetch/push = { available: true } on a build where gitRemoteConnectOrigins() can only ever contain the page's own origin (GIT_REMOTE_CONNECT_ORIGINS is empty and the shipped connect-src names no Git Smart HTTP host). Every clone/fetch/push against any real remote fails closed with remote-origin-not-permitted, so the boolean the UI and `git help` gate on claims an availability the runtime never grants. The mitigation (permittedOrigins + the detail string) is honest, but the boolean itself is not - a caller that only reads features.clone.available is still misled.

### 5.

VACUOUS ASSERTION: src/git/validation.test.ts:38 - `for (const origin of GIT_REMOTE_CONNECT_ORIGINS) expect(sources).toContain(origin)` iterates an empty frozen array, so the 'subset of both connect-src directives' pin the report advertises executes zero assertions today. The only live drift checks in that test are the two `not.toContain` lines. Same shape at src/tools/git-tools.test.ts:117: `expect(capabilities.remote.permittedOrigins).not.toContain('https://github.com')` is trivially true because under Node the array is always [].

### 6.

WEAK PIN: src/git/validation.test.ts never asserts that `'self'` is present in the shipped connect-src, yet src/git/validation.ts:47-50 unconditionally treats location.origin as permitted. If `'self'` were dropped from connect-src, gitRemoteConnectOrigins() would keep claiming the page origin is reachable and the pin would not fire.

### 7.

OVERSTATED WORD: docs/BROWSER_GIT.md says a seed file excluded by the repository's own ignore rules 'is announced when the repository is initialized rather than silently swallowed', but the implementation at src/git/workspace-adapter.ts:1000-1002 is a bare console.warn to devtools. Nothing reaches the UI, the mutation result, or the approval record.

### 8.

MEASUREMENT CLAIM DOES NOT REPRODUCE: the report states the statusEntries single-walk change 'cut a 520-file stage+commit from ~48s to ~9.4s in the test'. On this machine the test 'stages one reviewed request that covers more paths than a single adapter call may carry' runs in 1476ms. The optimization is real (git.walk went from one call per changed path to one call for all of them - old code at HEAD:src/git/workspace-adapter.ts:990-997 vs new at :1372-1387), but the quoted after-number is not what the suite produces.

### 9.

DISCLOSED OUT-OF-SCOPE EDIT (verified as described, no issue found): src/ui/sources-view.tsx:616-624 replaces the `case "status"/"diff"` throw with a fail-closed `default:` throwing code 'not-a-source-control-mutation'. Diff is 5 insertions / 3 deletions, exactly one hunk, and no other file outside src/git/**, src/tools/git-tools.ts, docs/BROWSER_GIT.md was touched by this package. No remaining reference to the old 'not-a-mutation' code exists anywhere in src/.
