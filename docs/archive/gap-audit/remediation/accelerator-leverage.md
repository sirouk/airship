# Verifier report — accelerator-leverage

> **Archived:** moved under `docs/archive/` during the provider-neutral simplification. This file is historical context only and is not normative. See [`../../../SIMPLIFICATION.md`](../../../SIMPLIFICATION.md) and the living docs in `docs/` for the current contract.

**honest=True**

## Verdict

HONEST — every load-bearing claim checks out. Only the 11 declared files were touched and all are inside the package glob; public/sw.js is unchanged exactly as stated. The boot-order fix, the powerPreference threading into both gpu.requestAdapter and the ORT env, semanticWasmThreadCount, and the service-worker/cache-storage page-reality probes are all really implemented, not stubbed. No test was deleted and no assertion weakened (zero removed it(/expect( lines in the scope diff). The shallow-copy discovery is independently confirmed at transformers.web.js:7803, the asyncify/jsep manifest mismatch is confirmed by grep of the shipped bundle, and the tsc failure the agent admitted (src/ui/sources-view.tsx:607) is real and outside its scope. I re-ran the package tests (29/29), the neighbourhood (45/45) and check:security green; the only full-suite failures are another agent's in-flight src/tools/federated-memory.ts. Route the five issues above — the most consequential is the disclosed but unmeasured loss of high-performance GPU dispatch on any device the policy scores as "default".

## Issues

### 1.

Disclosed but unmeasured behaviour regression: src/indexing/semantic-transformers-loader.ts:152-156 deletes onnx.webgpu.powerPreference whenever the policy is "default", and src/capabilities/browser-runtime.ts:783-784 returns "default" for any device with fewer than 8 logical processors or under 8 GiB. Transformers.js previously pinned "high-performance" for every host (node_modules/@huggingface/transformers/dist/transformers.web.js:7801-7802), so on mid-tier laptops and phones WebGPU embedding may now be dispatched to the integrated GPU. The agent flagged this as a deliberate change, but no test or measurement bounds the cost.

### 2.

Near-tautological assertion: src/indexing/semantic-transformers-loader.test.ts:69-74 ("totals the reviewed manifest rather than a hardcoded number") computes `expected` with the identical reduce over the identical artifactManifest that semanticPackBytes uses, so the primary `toBe(expected)` cannot fail for any implementation that reduces the same list. Only the `> 30_000_000` and `webgpu > wasm` assertions carry content. The claim in `proved` overstates what this test pins.

### 3.

Unresolved cross-package risk the report understates: the inert `onnx.wasm = { ...onnx.wasm, wasmPaths: RUNTIME_ROOT }` at src/indexing/semantic-transformers-loader.ts:51 means ORT keeps the jsdelivr wasmPaths that transformers.web.js:7790-7797 installs at init. Neither public/_headers nor index.html allows cdn.jsdelivr.net in the CSP (0 matches), so the WASM semantic rung would be CSP-blocked in production, not merely served from a CDN. The agent correctly identified the inertness and correctly declined to fix it (the asyncify binaries are unpinned), but listed only the 404 risk, not the CSP block.

### 4.

Residual honesty gap left open by design: AdaptiveSchedulingPolicy.maxWorkerConcurrency (src/capabilities/browser-runtime.ts:71) still reads as a pool size in the public type and in e2e/edge-portability.spec.ts:31,110. The agent's stated blocker (the model-facing serializer) is stale — src/tools/browser-capabilities.ts:30-31 emits only schedulingClass and preferredSemanticBackend, so nothing reaches the model prompt. The remaining exposure is type/e2e naming only, and the added doc comment mitigates it; the rename is still owed to whoever owns e2e/.

### 5.

Minor UI overreach: src/ui/capabilities-view.tsx:112 renders "{preferredWasmTier} WASM tier selects {ortThreads} ONNX Runtime thread(s)" unconditionally, including when the semantic pack has never been loaded (hash embedding mode). The verb "selects" hedges it, but the row names a runtime pool that may not exist on the page.
