# src/prime/kernel — pyodide engine port notes

Port of prime-agent's IPython kernel semantics (port-manifest §3.1,
semantic invariant 24) onto a persistent in-worker CPython (pyodide pack,
pinned `314.0.2`), re-hosted inside airship as the second engine of the
prime kernel. The baseline `javascript` engine (kernel-host.ts +
kernel-worker-source.ts) predates this file, is untouched behaviorally,
and stays the reference for everything the two engines share.

## Files

| file | role | upstream anchor |
|---|---|---|
| `pyodide-worker-source.ts` | worker runtime generator (`pyodideKernelWorkerSource(budgets, assetBase)`) | CPython cell loop of `kernel/index.ts` + `tools/ipython.ts` RLM bootstrap |
| `pyodide-engine.ts` | `PyodideKernelEngine`: dedicated worker lifecycle for the pyodide engine | `KernelManager` (ZMQ host) |
| `engines.ts` | `createKernelEngine(kind, opts)` engine selection + shared `PrimeKernelEngine` interface | n/a (upstream has exactly one engine) |
| `kernel-contract.ts` (+) | additive: `ready` carries optional `bootMs`/`version`; new `boot-failed` worker frame; `KernelEngineDescription` capability record | ExecuteResult shape honesty |
| `kernel-host.ts` (+) | additive only: `describe()` and the `kernelTrustedWorkerUrl` export alias | n/a |
| `pyodide-engine.test.ts` | scripted-worker lane (always on) + live pinned-pack lane (`PRIME_PYODIDE_LIVE=1`) | kernel driver tests |

## Design decisions

1. **Separate adapter, not an engine flag.** `PrimeKernelHost` keeps its
   exact code paths (its tests lock them); `PyodideKernelEngine` mirrors
   its public surface — `start/exec/cancel/terminate/restart/onEvent/
   description` plus `describe()` — with the pyodide deltas written out in
   full. `engines.ts` is the one place a session picks the interpreter; the
   switch is exhaustive, so a new `KernelEngine` kind fails at compile time.
   JavaScript behavior is byte-identical: the only edits to kernel-host.ts
   are the additive `describe()` and an export alias of the existing
   trusted-worker policy, neither reachable from javascript execution paths.

2. **Ready probe mirrors airship's pyodide pattern exactly.** Module
   worker from a freshly minted blob URL under the same blob-only
   TrustedTypes policy, `loadPyodide({ indexURL, fullStdLib: false })`
   from the same-origin pinned pack at `/execution-packs/pyodide/` (served
   by `scripts/pyodide-assets.ts`, which already refuses a mismatched
   node_modules/pyodide). The ready frame posts once CPython, the ambient
   removals, and the namespace bootstrap all exist, carrying `bootMs` and
   the runtime `version`; the engine fails closed if that version is not
   the pin (deployment skew is named, never booted through).
   `loadPackagesFromImports` is NEVER called — the pack is the entire
   supply chain.

3. **Persistent namespace via one globals dict.** The worker creates a
   single Python dict at boot (`pyodide.toPy({})`) and passes it as
   `globals` to every job's `runPythonAsync` (locals default to the same
   dict). That is the port of the Jupyter model of "execute in the kernel's
   module namespace" (invariant 24's serialized execution queue over one
   interpreter): top-level assignments in one job are visible as names in
   the next. The bootstrap — the minimal analog of upstream's
   `buildRlmBootstrapCode` — runs inside that dict once: `import pat`,
   `_pat_version = "pyodide-kernel-v1"`, `__name__ = "__main__"`.

   **Namespace-persistence guarantee, in one sentence:** inside one worker
   generation, every name a job binds at top level persists verbatim into
   every later job (values are ordinary live Python objects, not
   copies); the namespace is destroyed — and the destruction is reported,
   never hidden — by restart, crash, cancel-escalation past the grace
   window, or wall-clock escalation, each of which increments the
   generation counter.

4. **Tool bridge = `pat.call(tool, argsJson)`.** Registered via
   `registerJsModule("pat", …)`; Python code does
   `import json; await pat.call("read_file", json.dumps({…}))` and gets
   JSON text back, or a `JsException` carrying the host's rejection. This
   maps upstream's typed `host_request(type, payload)` comm channel onto
   the existing kernel bridge frames (`bridge-request`/`bridge-response`,
   seq-countered, payload-capped per call by `maxBridgePayloadBytes`,
   counted per job by `maxBridgeCallsPerJob`). Round-trips work mid-await
   (the JS promise is resolved by the host's bridge-response while the
   Python coroutine is suspended), and unresolved calls drain with a named
   rejection when the job ends. `pat.progress(text)` writes to stdout;
   `pat.sleep(ms)` is the cooperative cancellation checkpoint. The
   eleven-line bootstrap is deliberately minimal: no `print_to` helper —
   stdout is the rendered path and `pat.progress` covers annotations.

5. **Cancellation is cooperative-then-terminate, honestly named.** CPython
   cannot be interrupted mid-statement (no SharedArrayBuffer interrupt
   buffer in this pack), so `cancel` posts a flag the worker consults at
   every Python/JS boundary: pending `pat.call`s reject immediately,
   `pat.sleep` polls every 25 ms, and the flag is re-checked when the job
   settles. A job cancelled this way resolves `outcome: "cancelled"` with
   an error whose text starts **`cancelled-with-boundary:`** and states
   that CPython cannot interrupt a running statement; the worker and the
   namespace survive — cooperative cancel is not a kill. The host arms
   `PYODIDE_TERMINATE_GRACE_MS = 500` after every cooperative cancel
   (manual or wall-clock-driven); a job that outlives the grace is
   terminated, resolves `outcome: "crashed"`, and the error names both the
   escalation and the namespace reset. The four-member outcome vocabulary
   of `KernelJobResult` is unchanged; the boundary naming rides inside the
   `error` text.

6. **`bootMs` is stamped once per generation.** The first result resolved
   after a ready handshake carries `bootMs` (any outcome); later results in
   the same generation do not. `describe()` reports the generation's
   `bootMs`, the pin (`version`), and the worker-reported
   `runtimeVersion`.

7. **Errors render in the jupyter shape.** Pyodide's `PythonError` carries
   `type` (the Python exception name) and a message that already is the
   formatted traceback ending in `<Ename>: <evalue>`; the worker emits that
   body, appending a canonical `<ename>: <evalue>` tail line only if the
   body does not already end in one naming the exception. Tracebacks name
   cells `<prime-kernel>`.

## Budget & protocol inventory (unchanged from the contract)

Budgets are `KernelBudgets` (DEFAULT_KERNEL_BUDGETS): 256 Ki source chars,
5 min job wall clock (cancel-then-terminate through the grace ladder),
1 Mi chars per stream (live frames always emit, chunked ≤ 4096 chars; the
durable capture is what the budget binds), 1 MiB serialized value
(`{primeValue:"truncated", limitBytes}` marker), 1000 bridge calls/job,
1 MiB bridge payload, 64 queued jobs. Host→worker: init (unused by both
engines; budgets serialize into the template), exec, cancel,
bridge-response, terminate. Worker→host: ready (+bootMs/version),
boot-failed, stdout/stderr, bridge-request, finished.

## Honest deltas vs upstream IPython

- **Interrupt-free CPython.** Upstream interrupts the kernel over the ZMQ
  control channel (OS signal, mid-statement) and escalates to
  `KernelBusyAfterInterruptError`. This port's cooperative cancel only
  lands at statement/await boundaries; a pure-Python busy loop can be
  stopped only by terminating the worker (the named escalation above). A
  mid-statement flag check would require the SharedArrayBuffer interrupt
  machine; cross-origin isolation exists (COOP/COEP), so this is a
  deliberate later lift, not an impossibility.
- **Namespace snapshot/restore is deferred, explicitly.** Upstream
  dill-snapshots the namespace per variable with per-name skip reasons,
  debounced after each cell, and restores before the bootstrap with an
  `<ipython_state_restored>`/`<ipython_state>` note. This port ships the
  seam but not the snapshot: `describe().persistence` stays
  `"kernel-instance"`, and restart/reset is total and stated. A restore
  layer lands as a bootstrap-time mechanism (Python fetch of a manifest
  across the reviewed bridge) with a model-facing restored-state note —
  deliberately absent today rather than half-persisted.
- **No display_data MIME lifting.** Upstream lifts three vendor MIME tags
  out of iopub (diffs, 10MB-capped image attachments, agent messages).
  Here the equivalent effects cross the tool bridge as ordinary reviewed
  calls today; mapping `vnd.prime-agent.*` display kinds onto bridge call
  kinds is a named follow-up.
- **No stdin prompting, no `%%bash`, no module-wrap skill imports, no
  fork-server/boot-gate.** `input()` sees empty stdin (mirrors airship's
  disposable worker). Cell magics do not exist; bash belongs to the
  session's own tools. Workers have disposable economics, so the cold-
  start tricks upstream needed are absent by design; the documented cost
  is bootMs, reported.
- **Conversions.** The value channel JSON-serializes a `toJs()`-converted
  last-expression value; Python `None` under a key converts to `undefined`
  and drops from objects (pyodide's rule, inherited), unconvertible values
  degrade to `String()`. Upstream renders `repr` — the delta is cosmetic
  shape, not budget or honesty.
- **Carriage returns.** Streams are line-batched by pyodide; a `\r`-style
  in-place progress bar lands as lines, not as terminal carriage control.

## Live tests

Off by default (CI-safe, no network: the pack is read from
`node_modules/pyodide`, which `scripts/pyodide-assets.ts` already gates
against the pin):

    PRIME_PYODIDE_LIVE=1 npx vitest run src/prime/kernel/pyodide-engine.test.ts

The live lane runs node:worker_threads under a small parentPort↔self shim
passed through `ports.workerFactory` with a filesystem `assetBase`; the
message protocol, worker source, budgets, and ready handshake are the
shipped ones, not test doubles.
