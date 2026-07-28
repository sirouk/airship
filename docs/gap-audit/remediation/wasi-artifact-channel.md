# Verifier report — wasi-artifact-channel

**honest=True**

## Verdict

HONEST AND SUBSTANTIVE — every load-bearing claim independently reproduced.

SCOPE: clean. Only the 8 declared files plus 3 declared new test files. No stubs, no commented-out code, no deleted or weakened tests. The single line deleted from e2e/browser-worker.spec.ts is `test.setTimeout(90_000)` raised to 150_000, which the report discloses and justifies (the gate now boots six interpreters).

IMPLEMENTATION MATCHES CLAIMS. Spot-verified in the diff:
- src/execution/wasi-preview1-pack.ts:52-54 exactly-one-of via `Boolean(wasmBase64) === Boolean(wasmPath)`; :75-77 the artifact is genuinely read OUTSIDE captureWorkspace; :215-224 readWorkspaceArtifact really calls the existing assertAllowedWorkspacePath (pack.ts:412) so `.git`/`.airship`/`node_modules` are refused; :239 `.filter(({path}) => path !== artifactPath)` genuinely excludes the artifact from its own mount; :166-179 the unmounted-run rejection is real.
- src/execution/wasi-preview1-worker.ts: `decodeArtifact` is actually deleted (not stubbed), RunMessage carries `wasm: Uint8Array`, and the `files` key is genuinely OMITTED (not `[]`) on collection failure — and `collectFiles` returning an empty array still posts `{files: []}` because `[]` is truthy, so the omission is precise rather than accidental.
- src/execution/wasi-preview1-pack.ts:105-115 `runDisposableWasi(wasmBase64, ...)` really is retained as a thin delegator; e2e/browser-worker.spec.ts:60 still calls it and still passes.
- src/tools/execution-tools.ts:1125-1131 the `ready` branch really does sit BEFORE the `ok !== true` check, so it is not swallowed; :1058 the Python egress guard is real and is applied while building `returned` (:946-955), so it fires with writeBack false.

TESTS ARE REAL, NOT TAUTOLOGICAL. The unit tests mock only the Worker boundary (unavoidable in Node) and exercise the real adapter/tool logic. HEAD CONTROL RUN REPRODUCED: I created a worktree at HEAD (ad5cda8), copied the 3 new test files in, and got `14 failed | 6 skipped (20)` with exactly the failure messages the report cites ('WASI Preview 1 execution requires a precompiled wasmBase64 command artifact', Pyodide setup failing). Against the change: 20/20 pass.

CHECKS RERUN BY ME:
- `npm test`: 179 files, 1076 passed | 1 skipped. Passes.
- `npx vitest run src/execution src/tools`: 24 files, 131 passed.
- `npx playwright test e2e/browser-worker.spec.ts --project=desktop-chromium --grep-invert WASIX`: 9/9 passed (17.9 s), including the new wasmPath gate (real Rust wasip1 fixture, mountedFiles:1) and the Pyodide gate asserting `bootMs > 0`, the real 600 KiB overflow (`isError true`, exitCode 0, stdout 'ok', zero writes), and the real `os.makedirs('.git')` egress refusal. These e2e claims are NOT fabricated. I did not reproduce the transient failure the report honestly volunteered.
- `npx tsc --noEmit`: does not pass repo-wide, exactly as the report's `typecheckPassed: false` states; no error is in this package's files.

The `notDone` and `outOfScopeNeeded` entries are accurate: docs/CANON.md:532 is genuinely still un-updated, src/execution/workspace-egress.ts genuinely does not exist, and the three duplicate guard definitions are genuinely still three (wasi-preview1-pack.ts:412, wasix-pack.ts:419, execution-tools.ts:1057).

Residual issues are the two model-facing timeout-contract gaps listed above — the `install_execution_runtime` one is an undisclosed behaviour change and should be fixed or documented before release.

## Issues

### 1.

VERIFIED-NOT-AN-ISSUE (scope): `git status --short` shows exactly the 8 declared scope files modified (docs/BROWSER_EXECUTION_PACKS.md, e2e/browser-worker.spec.ts, src/execution/{runtime-registry,wasi-preview1-contract,wasi-preview1-pack,wasi-preview1-worker}.ts, src/tools/{execution-tools,execution-tool-proxies}.ts) plus 3 new test files. No out-of-scope edits are attributable to this agent; the other ~80 dirty files belong to concurrent agents (provider fabric, git, storage, UI).

### 2.

MINOR SCOPE NIT: the 3 new test files (src/execution/wasi-preview1-pack.test.ts, src/tools/execution-tools.artifact.test.ts, src/tools/execution-tools.python.test.ts) are outside the declared 8-file scope. They are declared in the report's `changed` list, so this is disclosed, not hidden.

### 3.

CONFIRMED REGRESSION, UNDISCLOSED: src/tools/execution-tools.ts:1105-1108 hardcodes the boot timer to DEFAULT_INSTALL_TIMEOUT_MS (30 s) and ignores the caller's `timeoutMs` for the boot phase. `install_execution_runtime` (schema at src/tools/execution-tools.ts:153, `timeoutMs` minimum 1_000, maximum 30_000) does essentially nothing BUT boot, so a model that calls `install_execution_runtime {timeoutMs: 1000}` now waits up to ~31 s instead of failing at 1 s. The tool's model-facing schema/description still advertises `timeoutMs` as the bound. The report's summary and notDone do not mention this side effect.

### 4.

MODEL-FACING CONTRACT GAP: `execute_code`'s schema still advertises `timeoutMs: {maximum: 10_000}` (src/tools/execution-tools.ts:216 and the mirrored copy in src/tools/execution-tool-proxies.ts), but a python-pyodide job can now consume up to ~40 s wall clock (30 s boot + 10 s job). The split is documented in docs/BROWSER_EXECUTION_PACKS.md and in the report summary, but nothing the model actually reads (tool description or schema) says the 10 s bound excludes interpreter boot.

### 5.

INTERNAL INCONSISTENCY (low): the new Python egress guard (src/tools/execution-tools.ts:1052-1060, applied at :946-955) THROWS and discards the entire run — exit code, stdout, and stderr are lost — when a job creates a `.git`/`.airship`/`node_modules` path. That contradicts the principle the same change introduces two functions earlier for collection overflow ('a completed run keeps its exit code and streams'). It matches the pre-existing WASI behaviour in reconcileWorkspace, so it is defensible, but the report describes both behaviours as if they were the same contract.

### 6.

DUPLICATION (cosmetic, self-disclosed shape): src/tools/execution-tools.ts:26 defines a local `MAX_WORKSPACE_ERROR_CHARS = 512` instead of importing the new `WASI_PREVIEW1_MAX_WORKSPACE_ERROR_CHARS` from src/execution/wasi-preview1-contract.ts:8, so the two 512-char ceilings can drift.

### 7.

TYPECHECK, REPORT DRIFT (not attributable): the report says `npx tsc --noEmit` shows 'exactly one error'. It now shows 9: 8 in src/tools/federated-memory.ts (105,159,168 — `Cannot find name 'rankProfileMemories'/'profileLineage'/'workspaceLineage'`, from another agent's in-flight src/retrieval/memory-ranking.ts + tool-lineage.ts) and 1 in src/ui/sources-view.tsx:607. ZERO errors in any file in this package's scope. `typecheckPassed: false` was reported correctly.
