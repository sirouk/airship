# PRIME runtime gate — selection contract (binding)

`src/load-agent-runtime.ts` is the single public seam for "run a turn",
and the runtime selected for that turn resolves from **journal evidence**,
never from a manifest flag or a silent default flip. This document defines
the explicit, fail-closed selection between the stock Airship runtime
(`airship-core`) and the PRIME runtime (`prime`) so a session never
silently changes engines.

## Selection model (implemented, W1)

1. `sessionRuntimeKind(events)` is the single rule: any `prime.*` journal
   evidence (including the `prime.session.runtime.seal` evidence the prime
   runtime writes on session start) pins the session **prime**; ordinary
   turn/inference evidence without any prime.\* pins it **airship-core**;
   an empty (just-created) journal is **unpinned**.
2. Selection: an explicit `runtime` option wins; otherwise the journal pin
   wins; otherwise an unpinned session starts **prime**. The transport is
   not consulted: `runPrimeTurn` forwards it to the session authority, which
   bridges it through `transport-adapter.ts`, so the ported provider
   registry is never asked to resolve a credential the caller already holds.
   That is the credential bridge this rule waited on, and it applies to
   `airship-demo` exactly as it does to a vendor transport — the demo
   carve-out is gone, and a first-run visitor gets prime like everyone else.
   Retry parity comes with it: the forwarded transport is wrapped in
   `withInferenceRetry(options.transport, options.retry)`, matching what
   `core/agent.ts` does before its own loop sees it.
3. An explicit selection that contradicts journal evidence is refused with
   the fork-the-session sentence, exactly the language class of the existing
   provider/tool-digest pins ("fork lineage invalid", "fork the session").
   Nothing silently re-engines: airship-core-pinned journals stay
   airship-core-driven until the user forks.
4. Before the gate the runner never wakes the other engine's bytes: both
   engines stay lazy chunks (`import()` inside the selected branch only;
   `runtime-*.js` stays out of every HTML modulepreload list).

## Evidence and honesty invariants

- Engine claims are always derivable from the journal alone (the audit
  contract): sessions with fresh journals claim nothing until the first
  turn; prime-pinned sessions carry the seal event from the first prime
  turn onward.
- `getAgentRuntimeStatus` (`src/prime/runtime/agent-runtimes.ts`) derives
  the honest engine/evidence/fork-remedy strings from the same gate,
  single-source: pinned engine, `evidenceType` ∈
  {"seal", "prime-events", "airship-history", "empty"}, `canForkSwitch`,
  and the gate's own refusal vocabulary for the remedy text. The lazy UI
  tag (`src/ui/agent-runtime-status.ts`) renders "engine: prime (default)",
  "engine: prime (pinned by journal evidence — fork the session to
  switch)" or the airship-core sentence; a loading journal renders nothing
  rather than a wrong-engine claim.

  Correction, recorded because the earlier revision of this paragraph
  asserted it without checking: `defaultEngine` in
  `src/prime/runtime/agent-runtimes.ts` was still the literal
  `"airship-core"` for some time after the gate began defaulting to prime.
  The status authority and the gate therefore disagreed — an unpinned
  session read "engine: airship-core (default)", ran prime, and flipped to
  "prime (pinned by journal evidence)" after its first turn, which is
  exactly the flips-under-the-reader defect this section claimed had been
  closed. The literal is `"prime"` now and its colocated test pins the
  rendered line, which is what should have carried the claim in the first
  place.
- Availability posture stays airship-canonical: `prime` is offered where
  the session's transport/model resolve and is not silently synthesized
  under degraded conditions.

## Acceptance status — W2–W6 green, full-tree verified (2026-08-06); W1 deferred

- [x] W1 — default-on gate: **landed**. The credential bridge is in
  (`runPrimeTurn` forwards the caller's transport, retry-wrapped), the
  unpinned branch selects prime for every transport including
  `airship-demo`, and journal pins plus fork-the-session refusals behave as
  specified (`src/load-agent-runtime.ts`). The test gap that let this branch
  narrow unnoticed is closed too: `src/load-agent-runtime.test.ts` now
  covers gate *selection* — default-on, the dead demo carve-out, engine
  invariance across four vendor transports, both pin directions, both
  refusal sentences, and an override an unpinned journal does not
  contradict — alongside the original `sessionRuntimeKind` classification
  tests. 12 tests, and `runTurn` routing is asserted at the module boundary
  the gate actually crosses.
- [x] W2 — boundary semantics in the session authority:
  `turn.context.selected` (v2-required manifests), pinned
  `planContextCompression` with bytes/token calibration and the transport
  summarizer, live-environment snapshots, plan restatement after summary
  only, protocol-v1 gates byte-identical to core
  (`src/prime/runtime/session.ts`, `session-boundary.test.ts` 15 tests
  including two-engine byte-parity).
- [x] W3 — fork-context admission: v1 replay-only gate first, seed at
  events[1], digest verification, `primeMaterializeForkOptions` byte-equal
  to core's literals; refusals byte-identical (`src/prime/runtime/
  fork-admission.ts`, 7 tests); session wiring at turn open feeds both
  `materializeMessages` sites and the compression closure
  (`session-fork.test.ts` 3 integration tests).
- [x] W4 — read-effect batch parallelism: `planPrimeToolBatches` /
  `executePrimeBatch` mirror `readEffectBatch` (allSettled, abort blocks
  starts never settlements), and the agent loop gained the mixed-step
  batched lane the session drives via `executionMode` declared from the
  registry effect vocabulary (`src/prime/agent/tool-batches.ts`,
  `agent-loop.ts`, `session-batches.test.ts` journal-level evidence).
- [x] W5 — conversation naming: heuristic rename on first prompt,
  fire-and-forget paid model naming journaled as `conversation.named` +
  `inference.usage` under `naming-*` identities, receipt finalized byte-
  bound to the request digest, final rename best-effort
  (`src/prime/runtime/naming.ts` + `runtime.ts` wiring, `naming.test.ts`
  12 tests, race-hardened by journal polling).
- [x] W6 — runtime status authority + lazy UI tag (see above;
  `agent-runtimes.ts` 9 tests).

## Remaining seams (milestones, not gate blockers)

- M6.5 goals/heartbeat tick scheduler and M6.8 skill-creator CLI are
  milestone work (`docs/PRIME-MILESTONES.md`).
- OAuth-family provider surfaces and the MCP seam remain milestone work;
  the acceptance list above stays the permit-to-merge accounting for
  anything touching engine selection.

## Verification (run-book)

1. `npx tsc --noEmit` → 0 errors tree-wide.
2. `npx vitest run src/prime` → all passing, pyodide lane skipped; the
   pre-existing t7 timing flake is the only intermittent.
3. `npm test` → 0 failed. (Counts are deliberately not quoted here: a
   run-book that names a tally goes stale the first time anyone adds a
   test, and the two frozen tallies this section used to carry were both
   wrong within days.)
4. `npm run build:static` → clean; `runtime-*.js` and
   `agent-runtime-status-*.js` lazy, zero eager HTML preload.
