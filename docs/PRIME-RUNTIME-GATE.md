# PRIME runtime gate — selection contract (binding)

`src/load-agent-runtime.ts` is the single public seam for "run a turn". This
document defines the explicit, fail-closed selection between the stock
Airship runtime (`airship-core`) and the PRIME runtime (`prime`) so a session
never silently changes engines.

## Selection model

1. A session mans its runtime **pinned in its SessionManifest**
   (`profile`/capability metadata, carrier-of-record for the provider/turn
   pins that already exist); the effective runtime for a turn is resolved
   from the manifest, not from the caller. Callers may still force
   `runtime` on `RunTurnOptions` for development/tests only.
2. A manifest pinned to runtime A refusing to run on runtime B names it and
   says "fork the session to use a different runtime" — identical language
   class as the existing provider/tool-digest pins.
3. Before the gate the runner never wakes the other engine's bytes: the
   lazy chunk-load discipline stays airship-canonical (`import()` at first
   use).
4. Availability of the PRIME runtime is reporter through the same honest-
   capability posture the execution packs use: it is offered when the
   session's transport and model resolve; it is NOT offered silently under
   degraded Jupyter-freeze conditions.

## API

```ts
export type AgentRuntimeKind = "airship-core" | "prime";

export async function runTurn(
  options: RunTurnOptions & { runtime?: AgentRuntimeKind },
): Promise<TurnResult>;

export async function primeRuntimeAvailable(options: {
  transport: InferenceTransport;
  tools: ToolRegistry;
}): Promise<{ ready: boolean; blocker?: { condition: string; remedy: string } }>;
```

`runTurn` branches to `import("./prime/runtime/session").runPrimeTurn`
when `options.runtime === "prime"` (or the manifest pin says so) and to
`import("./core/agent").runTurn` otherwise. `primeRuntimeAvailable` is the
preflight the capability view will read (fail-closed by connector-culture
clear constraints, never phantom).

## Transcript/evidence safety

- Both paths journal the SAME turn event types, so
  `materializeMessages`/`auditSessionHistory`/`Proof view` read a mixed
  history honestly — but a session does NOT mix them: the manifest pin
  refuses to flip mid-history.
- Kernel-internal effects land under `prime.kernel.tool.*`, never in the
  canonical lineage's tool-call identity; transcript materialization
  ignores them by construction.
- Hash chain integrity is shared: appended via `EventJournal.append` with
  the same digest formula.

## Migration acceptance (the checklist `runPrimeTurn` must pass before the
UI offers it broadly)

- [ ] Journal byte-parity per turn (request digest matches the runTurn
      formula reproduces stableStringify of the canonical wire state)
- [ ] Terminal-event guarantee under abort (never a turn without exactly
      one durable terminal; terminal appends are signal-neutral)
- [ ] Approval provenance parity (provenance on every tool.approved;
      denials counted as failed outcomes toward the guardrail)
- [ ] Repeated-identical-failure warn@2/stop@5 semantics identical to
      `core/agent.ts`
- [ ] Cancellation salvage honours `materializeMessages` rules
- [ ] Receipts: `createLocalReceipt`/`finalizeProviderReceipt` with the
      same bindings carrier
- [ ] Full-tree `npm test` keeps passing with runtime exercised on visits
      from e2e/live harness fixtures
