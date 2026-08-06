# PRIME SESSION AUTHORITY — Implementation Spec (binding)

Deliverables in this order: `src/prime/runtime/session.ts` (the authority), `src/prime/runtime/runtime.ts` (facade), `src/prime/runtime/session.test.ts` (vitest colocated, in-memory journal fake), `src/prime/runtime/runtime.test.ts`, and a `src/prime/runtime/PORT.md`. Read these FIRST and treat them as law:

- /root/pa-audit/airship-integration-map.md §1, §5, §9.1, §9.3 — journaling vocabulary, receipts, compatibility checklist.
- /root/prime-agent-trans/src/core/agent.ts (exact shapes of turn drafts; runTurn pipeline; cancelledTurnSalvage; materializeMessages; boundToolResultContent (export at line 886); TASK_PLAN_NOTE_EVENT_TYPE; reserveToolCallBatch semantics: operation-id validity (non-empty, ≤512, no control chars), uniqueness PER SESSION, 64 tool calls/step, 4 MiB assistant chars, 100_000 step events, 256 approval tickets, reservedIds; readEffectBatch: consecutive effect:"read" calls run read-parallel, others sequential).
- /root/prime-agent-trans/src/core/contracts.ts (AgentSignal; CanonicalMessage; ToolCall; ToolContext; ApprovalPolicy; SessionManifest (+V2 fields); InferenceTransport/Request/Event; SecurityPosture; BrowserExecutionTier).
- /root/prime-agent-trans/src/core/journal.ts (EventJournal semantics: per-session in-page append queue; signal-neutral terminal appends).
- /root/prime-agent-trans/src/receipts/types.ts (createLocalReceipt, finalizeProviderReceipt(receipt, providerId, requestDigest, responseDigest)).
- /root/prime-agent-trans/src/core/hash.ts (sha256, stableStringify), /root/prime-agent-trans/src/core/id.ts (randomUuid).
- /root/prime-agent-trans/src/tools/registry.ts (ToolRegistry.review/executeApproved/validate + review ticket semantics) — route EVERY effect through these; and approvalProvenance(policy, context) from src/approvals/modes.ts.
- /root/prime-agent-trans/src/prime/agent/*: the ported prime-agent loop packages/agent fidelity — its API: class Agent(ported options incl. streamFn, beforeToolCall, afterToolCall, convertToLlm, transformContext, getSystemPrompt/getApiKey, shouldStopAfterTurn/shouldStopBeforeTurn/getContinuationMessages, toolExecution), events: AgentEvent vocabulary identical to upstream ("agent_start","agent_end","turn_start","turn_end","message_start","message_update","message_end","tool_execution_start","tool_execution_update","tool_execution_end"), subscribe(listener) → unsubscribe; prompt(input: string | AgentMessage | AgentMessage[], images?); waitForIdle(); abort(); steer/followUp are queues (session "steers as next turn": do not rely on mid-turn text injection); state.messages mirrors the transcript; `signal` per active run; convertToLlm may be async and is called immediately before each provider stream request (that call point is where your turns attach inference.started).
- Streams contract: /root/prime-agent-trans/src/prime/ai/* and /root/prime-agent-trans/src/prime/transport-adapter.ts (createTransportForPrimeModel(model, transport, options?) returns a StreamFn-compatible function with out-channel getLastReceipt — verify its export surface; published by sibling transport child).
- Kernel contracts: /root/prime-agent-trans/src/prime/kernel/* (PrimeKernelHost, KernelToolBridge(registry, approvalPolicy, journal, sessionId, turnId, signal, capabilityTier), PRIME_KERNEL_TOOL_EVENT_TYPES, kernelOperationId); workerFactory injection seam for tests; budgets on construction; onEvent surface; exec(spec, listener?) → queue serialized; cancel(jobId, reason); killWorker(reason) → crashed outcome; restart(); state names via description().
- /root/pa-audit/prime-agent-port-manifest.md §2.1 (loop pseudocode), §3.1 (kernel/int contract), invariant lists (esp. 2,4,16,17,18,19,20,21,22,23,24,25,26,27,29,30).

You also may not edit files outside `src/prime/runtime/` and `src/prime/index.ts` for landing (adds exports). Style: airship (2-space; double quotes; no enums; Readonly<>/as const Object.freeze; MAX_/DEFAULT_ constants at module tops; fail-closed sentence errors; why-comments; no node:* APIs; no dynamic import() for types; isolatedModules-safe types; no `any` unless inevitable).

## `PrimeAgentSession` (src/prime/runtime/session.ts)

Exact public surface:

\`\`\`ts
export type PrimeTurnOutcome = "completed" | "failed" | "cancelled";

export type PrimeTurnResult = Readonly<{
  turnId: string;
  outcome: PrimeTurnOutcome;
  text?: string;              // final assistant text when completed
  error?: string;             // when failed
  reason?: string;            // when cancelled
  receipt?: ConversationReceipt;  // on completed
  events: DurableEvent[];     // full journal read after settle
}>;

export type PrimeSessionOptions = Readonly<{
  sessionId: string;
  manifest: SessionManifest;          // produced by airship side; prime does not invent one
  journal: EventJournal;
  registry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  model: Model<Api>;
  streamFn?: StreamFn;                // override; absent ⇒ adapter from transport, else prime ai registry streamSimple
  transport?: InferenceTransport;     // airship side; adapted via ../transport-adapter when supplied
  onReceipt?: (receipt: ConversationReceipt) => void;  // adapter out-channel hook
  onSignal?: (signal: AgentSignal) => void;            // text-delta/status/tool-output from airship types
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getSystemPrompt?: () => string | Promise<string>;    // default: manifest.systemPromptDigest-bound composer assistant layer (documented)
  maxSteps?: number;                                    // default PRIME_DEFAULT_MAX_STEPS
  kernelBudgets?: Partial<KernelBudgets>;
  kernelWorkerFactory?: () => Worker;                   // test seam
  signal?: AbortSignal;                                // external host cancel
}>;

export class PrimeAgentSession {
  constructor(options: PrimeSessionOptions);
  readonly id: string;
  readonly manifest: SessionManifest;
  readonly kernelHost: PrimeKernelHost;
  readonly kernelBridge: KernelToolBridge;
  readonly agent: Agent;                                  // adapted agent (for tests/seams)
  getUsageTotals(): Usage;                               // sums journaled inference.usage payloads
  getActiveTurnId(): string | undefined;
  prompt(content: string, images?: readonly CanonicalImageInput[]): Promise<PrimeTurnResult>;
  abortTurn(reason?: string): Promise<void>;             // cooperative + hard; idempotent
  dispose(reason: string): Promise<void>;                // abort + kernel terminate + final flush idempotent
}
\`\`\`

## Behavior the session must implement (all of it; cite line/section in PORT.md)

1. **Concurrency**: turns are serialized per session (prompt during active turn → descriptive Error naming active turnId + remediation "wait, or steer/follow-up as next turn"). prompt creates turnId = randomUuid.
2. **Turn open**: append turn.requested {content, images?(Json)}. Images go in payload exactly like runTurn (canonicalImageInputs mapping).
3. **Journal→LLM parity**: install `convertToLlm` on the agent that: reads journal events FOR THIS SESSION (memory-cached; refresh incrementally afterSequence), runs airship's materializeMessages(events, materializeOptions) EXACTLY as core/agent.ts does it (options {allowSelectedContext per manifest V2 turnContext required/default policy — replicate what core/agent.ts passes in its own call sites}), maps canonical → assistant-visible prime Message[] faithfully (user→user with string content or text/images parts; assistant with text+toolCall blocks arguments parsed records; tool→toolResult with toolCallId/isError per canonical flags; toolName recovered per canonical lookup; orphan proceed per materialize behavior), and RETURNS those. This function is the provider-input authority. 
4. **Per-step inference.started**: exactly once per provider request: requestId=randomUuid (reject if in reservedOperationIds), idempotencyKey = `${sessionId}:${turnId}:${step}` (step counter starting 0 within turn), requestDigest = sha256(stableStringify({model: manifest.model, systemPromptDigest: manifest.systemPromptDigest, messages, tools: manifest.tools, idempotencyKey})) computed over the SAME canonical message list just built (wire-format byte parity), then append inference.started {step, providerId: transportId-or-registry-provider (document when absent: providerId = \<manifest.providerId\> with adapter bridged id), model: manifest.model, posture, requestDigest, idempotencyKey} — match core/agent.ts field names exactly.
5. **Streaming mapping**: per message_update forward signal text-delta {turnId, text} via onSignal; count step events (100_000 cap); on reasoning phases forward status reasoning; usage events → inference.usage drafts appended (payload = usage Json as transport reports; when streamFn yields prime Usage instead, record under fields input/output/cacheRead/cacheWrite — document). No premature journaling of assistant partial states.
6. **Assistant completion**: on message_end(assistant) with stopReason === "toolUse": validate (calls ≤ 64; per-call op id rules; assistant text ≤ 4 MiB); reserve op ids (session-scoped uniqueness; duplicates → turn.failed naming invariant reproduction, after appending assistant.completed w/o tool.requested? — EXACT airship semantics from core/agent.ts reserveToolCallBatch: mismatches raise BEFORE drafting the batch; mirror behavior: on invalid id(s) throw with the same message text pattern, then terminal records follow as per cancellations (turn.failed with caption). Append [assistant.completed {role:"assistant", finishReason:"tool-calls", ...message-canonical}, ×n tool.requested {call}] in ONE batch, in content order. Canonical assistant.message content = text content; toolCalls = port-mapped ToolCall[]; per-call payload exactly {call}.
7. **Review/execute wiring**: install beforeToolCall: op id check + ToolContext {sessionId, turnId, operationId: call.id, signal: current run signal, capabilityTier: manifest.capabilityTier, onOutput: forward tool-output via onSignal}. registry.review(...) returns allow → append tool.approved {callId, name, approval: provenance ?? null}; denied/expired → append tool.denied {callId, name, approval, content: "Permission denied for ${name}.${guardrailNote}"} — guardrail note appended AFTER provenance capture; the exact airship suffix composition from core/agent.ts (noteFailedOutcome names: repeated-identical-failure counter → warn@2 inline suffix, stop@5 → after the error append, mark the turn for terminal failed naming the guardrail; counter keyed (name, toolArgumentsDigest, errorText) — airship key composition derivable from core/agent.ts; MIRROR IT EXACTLY). On review throw → append tool.failed {callId, name, content: errorMessage + note} and return block {block: true, reason: contentText}. Do not execute; agent loop emits the error result set against the blocked call.
8. **Result recording**: on message_end(toolResult) — DO NOT duplicate journaling for denied/review-failed calls (track those op ids): append tool.resulted {callId, name, content: boundToolResultContent(content, remainingToolOutputBytes) + guardrailNote, isError, metadata: truncated-marker + contextBudgetTruncated + original/retained bytes exactly as core/agent.ts} — import boundToolResultContent from ../../core/agent. Track remainingToolOutputBytes per turn: derived per step from pinned contextWindowTokens (manifest.contextPolicy) and byte-per-token projection (default 3.6, calibration deferred — document) with RESERVED_RESPONSE_TOKENS=1_024; on █ over-ceiling before a step → terminal failed naming the pinned ceiling with "start a new turn" remediation text similar in spirit to core/agent.ts.
9. **Usage**: inference.usage appended per successful assistant-message (from its usage): payload mirrors core/agent usage Json fields (providerId, model, input/output/cacheRead/cacheWrite token keys naming from core/agent.ts lines around 442-452 — match exactly); session accumulates usageTotals.
10. **Turn settle**: agent_end with last assistant stop==="stop" → append assistant.completed (finishReason:"stop", receipt: finalizeProviderReceipt(providerReceipt, providerId, requestDigest, responseDigest)?? provider receipts surface via adapter getLastReceipt/onReceipt; absent → createLocalReceipt({sessionId, turnId, provider, model, requestDigest, responseDigest})) — responseDigest = sha256(final text) — then turn.completed {receiptId}. Local receipts name provider/model from manifest bindings. stopReason==="error" → turn.failed {error: errorMessage + guardrail notes} (no assistant.completed). "aborted" → turn.cancelled {reason}. End of run never without exactly one terminal.
11. **Returns**: PrimeTurnResult outcomes — completed=+{text, receipt}, failed=+{error}, cancelled=+{reason}; all with events = journal read post-settle.
12. **Turn cancel semantics**: abortTurn(reason) is cooperative + hard: agent.abort() (loop-level), kernel jobs: cancel active + terminate persistent worker only when jobs do not resolve after PRIME_TERMINATE_GRACE_MS (default 500 ms — constant), journal turn.cancelled with reason, cancelled-turn salvage per materialize rules stays intact (journal shapes unchanged so existing salvage works). Terminal never abortered: terminal appends are signal-neutral.
13. **Kernel integration**: execKernelPath — the session lazily boots its kernel exec host on first kernel use (tool is elsewhere); the tool bridge shares the session's turnId-fn + active run signal; kernel event streams to journal drafts under prime.kernel.job.* (bounded payloads: valueJson bounded 64 KiB chars tail-cut with marker; streams bounded 256 KiB per stream head-cut with marker); kernel crash/reset recorded + named event to transcript notice (prime.notice) including namespace-reset consequence text.
14. **Guards session-wide**: maxSteps default 32 (err at cap with naming guard) — step = each assistant stream round-trip; count step-event up to 100_000 with fail-closed; 4 MiB assistant text cap; 64 calls/step; idem/reserved operation id checks.
15. **Dispose**: abort + kernel terminate + idempotent Promise resolution even if run was already idle; terminal only if a turn is still open (abort-recorded).
16. **Steering workflow**: expose steer(content) — queue for the NEXT turn (each is its own turn.requested): processed once current run settles; followUp(content) — post-turn; entries are journaled as ordinary turn.requested. Do not bypass.
17. **System prompt**: the session resolves systemPrompt via options.getSystemPrompt() default(): manifest.systemPromptDigest-derived cached composer: reads manifest.systemPrompt? — check fields: SessionManifest contains systemPromptDigest + systemPrompt (plain); default returns manifest.systemPrompt verbatim with digest purity check sha256(systemPrompt)===systemPromptDigest (fail-closed, sentence naming tamper).
18. **Test seam**: kernelWorkerFactory; streamFn override friendly w/ faux provider (../ai/providers/faux has port); in-memory journal fake using airship MemoryJournalBackend class from src/core/memory-journal.ts (check name; else write minimal in-file fake following JournalBackend semantics + per-session CAS) serializing append queue as journal does, so tests exercise conflicts.

## `PrimeRuntime` (src/prime/runtime/runtime.ts)

Public facade the embedders consume:

\`\`\`ts
export type PrimeRuntimeOptions = /* ManifestDeps */ & { factory?: (sessionOptions: PrimeSessionOptions) => PrimeAgentSession; };

export class PrimeRuntime {
  constructor(options: /* journal, registry, approvalPolicy, manifestFactory(model) => SessionManifest deps, modelSelector */ );
  attachSession(options): Promise<PrimeAgentSession>;    // manifest supplied → session
  createSession(options): Promise<PrimeAgentSession>;    // new manifest via airship createSessionManifest parity (providerId/model/tools digests/protocol v2 per airship session-manifest module) — read src/core/session-manifest.ts to mirror EXACT digest semantics
  listSessions(): SessionRecord[];
  prompt(sessionId, content, images?): Promise<PrimeTurnResult>;
  abortTurn(sessionId, reason?): Promise<void>;
  dispose(): Promise<void>;
}
\`\`\`

Session creation must use airship's own createSessionManifest path semantics from core/session-manifest.ts (protocol v2, pin providerId/model/tools/toolManifestDigest/systemPrompt + digest) — mirror its semantics faithfully by importing the exported creator (check src/core/session-manifest.ts exports; if createSessionManifest is only re-exported through core/agent.ts, import from that module directly).

## Test requirements (vitest colocated; memory-backed; no browsers)

Cover and print pass/fail counts + names in reply:
1. converts ↔ canonical byte parity per turn (t1): run a scripted faux provider (two steps: tool call then final) asserting requestDigest reproduces exactly core/agent.ts formula — compute expected digest in-test from journal replay; fail on drift.
2. approval deny path journal shape equals airship's (denied + content + provenance null-when-absent; transcript has an error toolResult; repeat counter increments; stop@5 ends turn + terminal failed named guardrail).
3. review allow path: approved + resulted drafts in order, bounded content marking contextBudgetTruncated when oversized with original/retained bytes.
4. cancel → turn.cancelled terminal, salvage invariants (journal keeps productive steps; terminal append was signal-neutral), prompt guarantees turn settled even when aborted mid-tool.
5. max-steps cap aborts turn with named guard; 64-call cap breach names invariant; 100k step-event cap; 4MiB text cap (mock a bloated assistant via faux script).
6. kernel bridge wiring: a scripted faux answer calls execute_code → kernel runs job with pat.call back into a stub registry tool expecting approval-bound call with operation identity `prime-kernel:<jobId>:<seq>` present in journaled prime.kernel.tool.* evidence.
7. precision: two concurrent prompts reject second with the serialization error; after first settles, second prompt succeeds.
8. turn.requested images pass-through; final receipt digest chain: bindings.requestDigest matches inference.started.requestDigest of the FINAL step? — RULE: requestDigest of the receipt = the digest of the request that produced the FINAL answer (match core/agent.ts — verify in code exactly which requestDigest airship attaches; mirror that exact rule and document).

## PORT.md (short)
port mapping table (loop features → airship mittels), the exact lossy notes, the refusal semantics, remaining seams (transformContext pruning MNA, compaction hook MNA, harness checkpoint MNA, refinement checkpoint MNA, fork-context admission) with next-milestone IDs.

RULES: airship style per §8; ONLY src/prime/runtime/*.ts + src/prime/index.ts additions; strict TS vs root tsconfig; `cd /root/prime-agent-trans && npx tsc --noEmit 2>&1 | grep 'prime/runtime'` zero; `npx vitest run src/prime/runtime --maxWorkers=2` green. Reply: files, tests passed/failed, deviations & why, next seams.
