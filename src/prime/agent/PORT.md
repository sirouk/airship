# src/prime/agent — port notes

Port of `prime-agent/packages/agent/` (the agent-loop layer) into airship as
`src/prime/agent/`, compiling against the already-ported streaming core at
`src/prime/ai/`. Semantics are 1:1 with upstream; this file documents what
changed, what did not, what was excluded, and the upstream quirks worth
knowing.

## Files

| file | upstream source | status |
|---|---|---|
| `types.ts` | `packages/agent/src/types.ts` | ported 1:1 (adapted for JsonSchema, see below) |
| `agent-loop.ts` | `packages/agent/src/agent-loop.ts` | ported 1:1 |
| `agent.ts` | `packages/agent/src/agent.ts` | ported 1:1 |
| `index.ts` | `packages/agent/src/index.ts` | ported, minus `proxy.js` |
| `agent-loop.test.ts` | `packages/agent/test/agent-loop.test.ts` | all 30 scenarios + 8 added error-encoding tests |
| `agent.test.ts` | `packages/agent/test/agent.test.ts` | all 24 scenarios + 1 added error-path test |
| `e2e.test.ts` | `packages/agent/test/e2e.test.ts` | all 10 scenarios |
| `test-utils/fixtures.ts` | per-file inline helpers upstream | shared; no behavior change |
| `test-utils/calculate.ts` | `packages/agent/test/utils/calculate.ts` | ported 1:1 (schema de-typeboxed) |

## Adaptations from upstream (all forced, all documented)

1. **TypeBox -> plain JSON Schema.** `Tool.parameters` in the ported ai layer
   is `JsonSchema = Record<string, unknown>`. Consequences:
   - `AgentTool<TParameters extends TSchema, TDetails>` becomes
     `AgentTool<TArguments, TDetails>`: the first generic now binds the
     *argument value type* directly (there is no `Static<>` to derive it from).
     `parameters` is inherited unchanged from the ported `Tool`.
   - Argument validation replaces typebox `Value.Convert` + `Value.Check` with
     `validateJson(tool.parameters, clonedArgs)` from `../ai/validate`.
     Fail-closed semantics are preserved: on failure the loop throws the
     upstream-shaped message
     ``Validation failed for tool "<name>":
  - <path: message errors>

Received arguments:
<json>``
     and encodes it as an **error tool result**, never a crash.
   - **Coercion is dropped.** Typebox's `Value.Convert` used to coerce
     argument values (e.g. `"5"` -> `5`) before the check; `validateJson`
     does not coerce. The `prepareArguments` hook is the designated repair
     seam and already runs *before* validation, so any host that relied on
     coercion must move that repair into `prepareArguments`. Upstream's own
     agent tests exercise exactly this order and pass unchanged.
2. **`AgentTool<any>` collections retained.** Exactly as upstream,
   `AgentState.tools`, `AgentContext.tools`, and the loop internals use
   `AgentTool<any>` so that typed `AgentTool<{value: string}, ...>`
   definitions remain assignable into tool lists under strict function
   variance. Event payloads (`tool_execution_*` `args`/`partialResult`/
   `result`) keep upstream's `any` for the same reason.
3. **Run-failure diagnostic shape.** The ported ai layer has
   `AssistantMessageDiagnostic { code, message, detail? }` while upstream
   pi-ai has `{ type, timestamp, error, details }` plus a
   `createAssistantMessageDiagnostic` helper that is not part of the ported
   ai surface. `agent.ts` maps the upstream call
   `createAssistantMessageDiagnostic("agent_lifecycle_failure", error, { source: "run_with_lifecycle" })`
   onto the ported shape (`code: "agent_lifecycle_failure"`, error message,
   stack as `detail`) via a local `createRunFailureDiagnostic`. Downstream
   policy keying on the diagnostic code string is unaffected.
4. **`streamSimple`** comes from `../ai/stream` (was `@earendil-works/pi-ai`);
   `EventStream` from `../ai/event-stream`; both have identical contracts.
5. **ThinkingLevel** stays the agent-side union including `"off"`; the
   `Agent` still maps `thinkingLevel === "off" -> reasoning: undefined`.
6. **No generated model catalog in tests.** Upstream tests call
   `getModel("openai", "gpt-4o-mini")`; the ported ai layer ships no model
   catalog, so the two affected tests use a local `createModel()` factory.
   The provider is never invoked in those paths (pre-aborted signal /
   value-only usage), so behavior is unchanged.

## Exclusions

- **`proxy.ts`** (367 lines): remote proxy streamFn that turns the agent into
  a daemon-backed client over HTTP/SSE. Out of scope for this layer; it is a
  transport concern for the daemon package, documented upstream as
  `packages/agent/src/proxy.ts`. Nothing in the ported files references it;
  `index.ts` does not re-export it.

## Browser adjustments

None. The files use only `structuredClone`, `queueMicrotask`, `setTimeout`,
`Date.now`, `Promise`, and `AbortSignal` — no `node:*`, no `process.env`, no
dynamic `import()`.

One test-only note: `test-utils/calculate.ts` evaluates expressions with
`new Function` (identical to upstream's test util). It ships only in tests;
airship's CSP (`no unsafe-eval`) is unaffected because the file is never part
of the app bundle.

## Hook contracts preserved (quoted from upstream doc comments)

- StreamFn: "Must not throw or return a rejected promise for request/model/runtime failures. … Failures must be encoded in the returned stream via protocol events and a final AssistantMessage with stopReason 'error' or 'aborted' and errorMessage."
- convertToLlm: "Contract: must not throw or reject. Return a safe fallback value instead. Throwing interrupts the low-level agent loop without producing a normal event sequence."
- transformContext: "Contract: must not throw or reject. Return the original messages or another safe fallback value instead."
- getSystemPrompt: "Resolves the system prompt immediately before each LLM call." (re-read every turn, after the async getApiKey resolution — the golden test pins this ordering)
- getApiKey: "Contract: must not throw or reject. Return undefined when no key is available." (resolved per turn, `?? config.apiKey` fallback — OAuth-refresh safe)
- shouldStopAfterTurn: "Called after each turn fully completes and `turn_end` has been emitted. … Contract: must not throw or reject."
- shouldStopBeforeTurn: "Called synchronously after a completed turn and before polling work for another turn. … The hook is never checked before the initial assistant turn."
- getSteeringMessages: "Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first. … Contract: must not throw or reject. Return [] when no steering messages are available." (also polled once *before* the first turn)
- getFollowUpMessages: "Called when the agent has no more tool calls and no steering messages. … Contract: must not throw or reject."
- getContinuationMessages: "Called after follow-up messages have been polled and none are available. … Explicit follow-up messages always take precedence over continuation messages."
- beforeToolCall: "Called before a tool is executed, after arguments have been validated. Return `{ block: true }` to prevent execution. The loop emits an error tool result instead."
- afterToolCall: "Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted. … Any omitted fields keep their original values. No deep merge is performed."
- terminate hint: "Early termination only happens when every finalized tool result in the batch sets this to true." (unanimous, and auto-error results count)
- subscribe/agent_end: "`agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()` listeners for that event are still part of run settlement. The agent becomes idle only after those listeners finish."

**Violation behavior (verified by tests, matches upstream branches):** a
*throwing* `beforeToolCall` or `prepareArguments` is caught inside
`prepareToolCall` and becomes an error tool result (the loop survives —
"hooks must not throw" is a documented contract, not an enforced one). A
throwing `afterToolCall` becomes an error tool result. A throwing
`convertToLlm`/`transformContext`/turn-poll escapes `runLoop` and surfaces
via `endAgentStreamOnError` (stream ends with `[]`, no `agent_end`) — unless
routed through `Agent.runWithLifecycle`, which synthesizes a failed assistant
turn (`stopReason: "error"`, `agent_lifecycle_failure` diagnostic,
message_start/end + agent_end) so UI consumers always see terminal events. A
throwing **event listener** escapes the same way (see "commit only a prefix"
and "preserve the original failure" tests).

## Upstream quirks kept deliberately

1. `Agent.continue()` checks `lastMessage.role === "custom"` via a
   string-typed alias because `CustomAgentMessages` is an empty interface by
   default; custom-typed tails fall back to queued batches, otherwise
   `runAgentLoopContinue` accepts them ("caller responsibility" — convertToLlm
  decides their fate).
2. The `beforeToolCall` hook may **mutate the validated args object** and the
   mutated values reach `execute` without revalidation (pinned by
   "should execute mutated beforeToolCall args without revalidation").
3. `tool_execution_start` is emitted **before** validation, with the *raw*
   model-supplied arguments — so observers see attempted calls even when
   validation fails and `execute` never runs.
4. `runAgentLoop`'s initial steering poll happens *before* the first turn
   ("user may have typed while waiting"); with a pre-aborted signal the poll
   is skipped entirely (`pollMessagesUnlessAborted`) and the stream ends
   empty with no `agent_end`.
5. Synthetic aborted assistant messages **deep-clone** the last partial's
   content and usage, so later mutation of the provider's partial object
   cannot leak into the transcript (pinned by the "freeze" test).
6. `response.result()` is authoritative at `done|error`: the loop awaits it
   and reconciles, even replacing the streamed partial — and it is *not*
   awaited once abort wins the race ("should not wait for a pending terminal
   result after abort").
7. `pendingToolCalls` and `streamingMessage` are exposure-only state: they
   reset in `finishRun()` regardless of how the run ended.
8. `Agent.prompt()`/`continue()` while active **throw** (concurrency is
   queue-only via steer/followUp), and a second `runWithLifecycle` entry
   throws a distinct "Agent is already processing."
9. Sequential batches stop skipping *remaining* tool calls after abort
   (orphaned tool calls are expected to be healed later by
   transformMessages on the next provider pass — the healing lives in the ai
   layer, not here).

## Event-order guarantees asserted by the golden tests

Turn lifecycle (sequential, single tool), exact sequence:
`agent_start, turn_start, message_start(user), message_end(user),
message_start(assistant), message_end(assistant), tool_execution_start,
tool_execution_end, message_start(toolResult), message_end(toolResult),
turn_end, agent_end`.

Parallel twin: `tool_execution_end` ids in **completion order**
(`["tool-2", "tool-1"]`) while `message_end(toolResult)` ids and
`turn_end.toolResults` ids stay in **assistant source order**
(`["tool-1", "tool-2"]`). Steering events always land after the full tool
batch; `agent_end` is emitted exactly once and last, even on error and abort
paths.
