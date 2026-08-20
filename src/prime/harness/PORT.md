# PORT.md — continual harness (src/prime/harness)

Upstream source of truth: `packages/coding-agent/src/core/refinement/refinement.ts`
and kernel-side `prime-agent-runtime/src/rlm/harness.py` (manifest §3.4,
SEMANTIC INVARIANT 30).

## Ported 1:1

- **State model**: kinds `prompt|memory|skill|subagent` with the same record
  vocabulary (id/title/content/path/scope/reference/arguments/metadata/
  source/version). Skill contract `{type:"python", import, callable|call_pattern}`
  with upstream alias tolerance (`python_import`, `call_pattern`).
- **Prompts, byte-verbatim**: `REFINEMENT_SYSTEM_PROMPT`,
  `AUTO_REFINE_REVIEW_SYSTEM_PROMPT`, both scope-policy paragraphs, trailer
  lines, and `TRUNCATED_JSON_ERROR` — copied exactly from `refinement.ts` and
  parity-checked.
- **Projection**: `formatHarnessStateForPrompt` with the exact caps
  (6 entries/kind, 5 refinement events, 180-char bodies) and copy;
  `overviewForPrompt` (40/240) and `historyForPrompt` (last 20) for planning.
- **Refine pipeline order**: review gate → plan → validate → apply; plan/apply
  split with plan-time optimistic baseline ("entry changed during refinement
  planning"); same-key edit chains; create/update/delete with full
  before/after snapshots; rollback replays recorded snapshots and is itself a
  recorded refinement; `local:` / `global:` id-prefix tolerance; slug id
  derivation (80 chars); scope-read-only (global entries invisible to local
  refinement); snapshot/restore/snapshotId.

## Deliberately strengthened (atomicity semantics)

- **All-or-nothing apply**: upstream marks invalid edits `applied:false` and
  applies the rest; the port validates ALL edits first and rejects the whole
  proposal with a named `ValidationIssue` list (`HarnessApplyRejectedError`) —
  no partial multi-entry apply.
- Rollback restores recorded snapshots byte-exact and **refuses on drift**
  (`OptimisticConcurrencyError`) instead of stomping newer writes.

## Deferred

- **Kernel-side `harness.py` IPC seam**: the host-side adapter that lets the
  RLM kernel call `rlm.harness.*` into `Harness` is left open; the system
  prompt projection defaults `includeIpythonExamples`/`includeRefineExamples`
  OFF until it lands.
- **LLM transport**: planner calls the injected `HarnessCompletionClient`;
  bridging it to airship's `InferenceTransport` is host-side.
- **IndexedDB adapter runtime test**: `IndexedDbHarnessKvAdapter` is the
  thin IDB wrapper; the Node test environment has no IDB, so it
  is covered via the shared base-class suite on the in-memory adapter and a
  `HarnessKvAdapter` seam for fakes.

## Deferred forever

- **Atomic tmp+rename file semantics** → replaced by store-level atomicity:
  one atomic KV batch per mutation (cas expectations per record), which is the
  honest on-device equivalent.
- **Global store on device = IndexedDB** (`airship-prime-harness-v1`, one `kv`
  object store, per-entry/per-event records) instead of
  `~/.prime/agent/harness/harness_state.json`; no `/workspace/.airship`
  control-plane drop (integration map §5/§9.1).

## Wire deviations (type-level only)

- `created_at`/`updated_at` ISO strings → `createdAt`/`updatedAt` epoch ms.
- `scope` required on entries (upstream optional-with-fallback).
