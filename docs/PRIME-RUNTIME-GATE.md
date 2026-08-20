# PRIME runtime gate — selection contract (binding)

`src/load-agent-runtime.ts` is the single public seam for "run a turn".
The runtime selected for a turn resolves from journal records, never from a
manifest flag or a silent default flip. This document defines the explicit,
fail-closed selection between the stock Airship runtime (`airship-core`) and
the PRIME runtime (`prime`) so a session never silently changes engines.

## Selection model (implemented, W1)

1. `sessionRuntimeKind(events)` is the single rule: any `prime.*` journal
   record pins the session **prime**; ordinary turn/inference records without
   any `prime.*` record pin it **airship-core**; an empty (just-created)
   journal is **unpinned**. Both the current `prime.session.runtime.selected`
   marker and the historical `prime.session.runtime.seal` name are recognized
   on reads. Only the current marker is written.
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
3. An explicit selection that contradicts journal records is refused with
   the fork-the-session sentence, exactly the language class of the existing
   provider/tool-digest pins ("fork lineage invalid", "fork the session").
   Nothing silently re-engines: airship-core-pinned journals stay
   airship-core-driven until the user forks.
4. Before the gate the runner never wakes the other engine's bytes: both
   engines stay lazy chunks (`import()` inside the selected branch only;
   `runtime-*.js` stays out of every HTML modulepreload list).

## Selection-record invariants

- A fresh journal has no engine-selection record. Before its first turn, the
  status names only the default engine. A fresh Prime run writes exactly one
  `prime.session.runtime.selected` marker before the turn starts.
- The former event name is read-only compatibility for historical journals.
  It remains known to runtime classification, status derivation, and the
  session audit, but no current event constant or write path emits it.
- `getAgentRuntimeStatus` (`src/prime/runtime/agent-runtimes.ts`) derives the
  engine, record class, and fork remedy from the same gate. Its `recordType`
  is one of `selection-marker`, `legacy-selection-marker`, `prime-records`,
  `airship-history`, or `empty`. The current marker takes precedence if a
  journal contains both marker names.
- The lazy UI tag (`src/ui/agent-runtime-status.ts`) exposes the record class
  through `data-record`. It renders `engine: prime (default)` or, for a pinned
  session, `engine: prime (recorded selection — fork the session to switch)`
  (and the corresponding airship-core sentence). Its title describes only a
  stored engine selection. It does not present the marker as a security or
  integrity result. A loading journal renders nothing rather than guessing.
- `defaultEngine` is `prime`, matching the gate. Its colocated test pins the
  rendered line so the status authority cannot drift from selection routing.
- Availability posture stays airship-canonical: `prime` is offered where
  the session's transport/model resolve and is not silently synthesized
  under degraded conditions.

## Acceptance status — W1–W6 implemented

- [x] W1 — default-on gate: **landed**. The credential bridge is in
  (`runPrimeTurn` forwards the caller's transport, retry-wrapped), the
  unpinned branch selects prime for every transport including
  `airship-demo`, and journal pins plus fork-the-session refusals behave as
  specified (`src/load-agent-runtime.ts`). The test gap that let this branch
  narrow unnoticed is closed too: `src/load-agent-runtime.test.ts` now
  covers gate *selection* — default-on, the dead demo carve-out, engine
  invariance across four vendor transports, both pin directions, both
  refusal sentences, and an override an unpinned journal does not
  contradict — alongside explicit current-marker and historical-read cases.
  `runTurn` routing is asserted at the module boundary the gate crosses.
- [x] W2 — boundary semantics in the session authority:
  `turn.context.selected` (v2-required manifests), pinned
  `planContextCompression` with bytes/token calibration and the transport
  summarizer, live-environment snapshots, plan restatement after summary
  only, protocol-v1 gates byte-identical to core
  (`src/prime/runtime/session.ts`, `session-boundary.test.ts` 15 tests
  including two-engine byte-parity).
- [x] W3 — fork-context admission: v1 replay-only gate first, seed at
  events[1], digest check, `primeMaterializeForkOptions` byte-equal
  to core's literals; refusals byte-identical (`src/prime/runtime/
  fork-admission.ts`, 7 tests); session wiring at turn open feeds both
  `materializeMessages` sites and the compression closure
  (`session-fork.test.ts` 3 integration tests).
- [x] W4 — read-effect batch parallelism: `planPrimeToolBatches` /
  `executePrimeBatch` mirror `readEffectBatch` (allSettled, abort blocks
  starts never settlements), and the agent loop gained the mixed-step
  batched lane the session drives via `executionMode` declared from the
  registry effect vocabulary (`src/prime/agent/tool-batches.ts`,
  `agent-loop.ts`, `session-batches.test.ts` journal records).
- [x] W5 — conversation naming: the bounded deterministic first-prompt
  title from `src/core/conversation-title.ts` is applied locally. Naming makes
  no provider request, creates no inference-usage event, and cannot delay or
  consume the visible turn (`src/prime/runtime/runtime.ts` plus core tests).
- [x] W6 — runtime status authority + lazy UI tag (see above;
  `agent-runtimes.test.ts` and `agent-runtime-status.test.ts`).

## Follow-up seams (not gate blockers)

Host-scheduled heartbeat ticks, guided skill authoring, optional MCP transport,
and stock Pyodide engine selection remain explicit follow-up work in
`docs/PRIME-MILESTONES.md`. Provider authorization is not a hidden Prime
milestone: the stock static product exposes API-key setup, and the companion
extension may relay only authority an integration already obtained.

## Checks (run-book)

1. `npx tsc --noEmit` → 0 errors tree-wide.
2. `npx vitest run src/prime` → all passing; environment-qualified Pyodide
   cases skip unless their live flag and pinned pack are available.
3. `npm test` → 0 failed. (Counts are deliberately not quoted here: a
   run-book that names a tally goes stale the first time anyone adds a
   test, and the two frozen tallies this section used to carry were both
   wrong within days.)
4. `npm run build:static` → clean; `runtime-*.js` and
   `agent-runtime-status-*.js` lazy, zero eager HTML preload.
