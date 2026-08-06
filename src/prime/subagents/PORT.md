# Subagents / RLM recursion — port notes

Port of prime-agent `src/core/rlm-runtime.ts` + `_startRlmChildRun` (agent-session)
+ `src/core/agent-messages.ts` + `src/core/agent-observe.ts` (manifest §3.5,
semantic invariants 24–26) onto airship's single-process runtime. Codes against
the frozen contracts in `../runtime/types-prime.ts`.

## Ported 1:1

- **Admission-only spawn** (`rlm.run` semantics, invariant 25): validate →
  depth gate → sibling-global name reservation (catalog ∪ pending admissions)
  → model resolution → admission record → `subagent-admitted` → return handle.
  The factory is invoked *detached*; its answer is never awaited by spawn.
- **Kwargs rule**: options beyond `{name, model, depth}` fail with
  `Unsupported rlm.run kwargs: ...` as `TypeError`.
- **Name validation**: type/empty/≤64 + frozen `canonicalPrimeAgentName`
  charset; default name via frozen `deriveDefaultSubagentName`
  (`subagent-<slug≤40>-<8hex>`); child id `sub-<8hex>`; sessionPath
  `<owner.sessionPath>/<childId>`.
- **Depth gate**: `depth >= maxDepth` hard-fails with the upstream text
  `RLM recursion depth limit reached (RLM_DEPTH=…, RLM_MAX_DEPTH=…)`;
  precedence chat > global > env (`RLM_MAX_DEPTH`, digit-parse mirroring
  upstream `parseDepth`) > default 1; roots are depth 0.
- **Completion contract** (invariant 26): explicit parent-directed
  `route.send` → `subagent-reply` + terminal reason `replied`; silent loop end
  → synthesized `subagent-terminal` reason `completed_without_reply`,
  last-assistant-text preview bounded to 512 chars; assistant error/abort →
  `failed` (preview = error); stop → `stopped`.
- **Parent always hears finality**: for every non-reply terminal a
  fixed-text notice (`RLM child <name> (<id>) completed without sending a
  reply. Last assistant text: …` / `failed: …` / `was stopped: …`, upstream
  notice text) is delivered into the owner sink, bypassing rate limits
  (host plumbing, not conversation).
- **`[task from parent]

<prompt>`** task delivery as an agent_message with
  id `spawn:<childId>`.
- **Router bounds**: message cap 16,384 chars (upstream error text),
  token bucket 3 burst / 1s refill per sender (ported class incl. retryAfter),
  ≤20 undelivered per receiver with upstream capacity error text,
  receipts `{delivered, queued, messageId, reason?}`.
- **Nuclear family reach**: parent / siblings (roots share `parentId
  undefined`) / direct children; uncle/grandparent/grandchild fail with
  `Agent reach is limited to parent, siblings, and children` (+ named target
  and sender).
- **agent_observe**: bounded snapshots, clamps mirroring upstream
  (`limit` 1..50, `max_chars` 80..2000, defaults 8/800), registry re-clips
  content (fail-closed against sloppy backing stores), family-scoped.

## Adapted

- **Transport**: daemon/JSONL message bus collapses to this in-process
  registry + per-agent sink queues; the router is the frozen
  `PrimeAgentRouter` surface over the registry catalog.
- **Frozen runtime shape**: `PrimeAgentRuntime` has no sink/recorder/event
  surface, so the factory port returns a `PrimeAgentRuntimeBundle`
  `{runtime, sink, recorder?}`; completion detection subscribes the bundled
  `agent`'s settled `AgentEvent` stream and settles on the first `agent_end`,
  with a latched stop-request for bundles arriving after `stop()`.
- **Model resolution**: frozen handle requires `Model<Api>`, so explicit
  selectors go through an injected `PrimeSubagentModelResolver` (catalog
  authenticated by the session); no resolver + explicit selector is a
  fail-closed error; no selector inherits the owner model.
- **Status mapping**: frozen handle statuses `running/idle/stopped/failed` ←
  terminal reasons `replied/completed_without_reply → idle`, `failed →
  failed`, `stopped → stopped`; completed children stay listed until
  `reapCompleted()` drains them (best-effort `runtime.stop("reaped")`, count
  returned; running children never drained).
- **Usage attribution**: registry exposes `usageOf(handleId)` (live while
  running, latched at settle); the parent session folds it into its own
  account — per the verdict, the registry never writes the parent account.
- **Chat max-depth persistence**: `setRlmMaxDepth` writes the frozen harness
  store (`PrimeHarnessStore`) under reserved entry `subagent:max-depth`,
  kind `subagent`, scope `local` (update with optimistic `expectedVersion`
  when the entry exists, create otherwise); corrupt persisted values
  read as absent (cannot brick every spawn).
- **Rate-limit soft failure**: bucket exhaustion returns a soft
  `{delivered:false, queued:false, reason}` receipt, while capacity/size
  violations throw (mixed upstream behavior preserved; reason = named sender
  + computed retryAfter ms).
- **Env injection**: `env` is a constructor map (browser host has no
  `process.env`); clock and id-source injected for determinism.

## Deferred (parent-session / sibling slices)

- **Journal bridging**: registry persists evidence through the
  `PrimeAgentLedger` port (spawn/reply/terminal/message entries); a default
  `InMemoryPrimeAgentLedger` ships here. The session pipes these into
  `prime.subagent.spawned` / `prime.subagent.terminal` /
  `prime.agent_message.sent` journal drafts (`../runtime/prime-events.ts`).
- **Recorder backing**: `PrimeAgentRecorder` is synchronous/bounded; the
  session backs it with journal-scoped transcript reads later.
- **Cross-session catalog depth**: `attachNode()` exists for the session
  authority to wire the owner's own ancestors/sibling-roots; daemon-wide
  naming coordination is out of scope for this single-process slice.
- **`kernel-crash` event**: produced by the kernel-host slice, not this
  registry.
- **Multi-run follow-ups**: events after settlement still surface as
  `subagent-update` (subscription lives until reap); terminal fires once.

## Integration notes for the session authority

- `get(idOrName)` returns the child runtime only (the owning node's loop is
  host-owned and never appears through `get`).
- `route.recentMessages` scopes to owner ∪ owner's nuclear family.
- `setRlmMaxDepth` throws `RLM max depth must be a non-negative integer.`
  before touching the harness store.
- `OBSERVE_DEFAULT_LIMIT` / `OBSERVE_DEFAULT_MAX_CHARS` are re-exported here
  because `src/prime/tools/rlm-tools` binds them.
