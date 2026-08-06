# PRIME runtime — remaining milestones (post landing state)

The milestone account after the current landing state (all suites green;
session authority in flight). Every item names its next event explicitly,
so the runner never invents resumes.

## M6.1 — Session authority finish (running now)
Deliver `src/prime/runtime/session.ts` (turn bridge: jounal-parity convert,
airship vocabulary, guardrails, receipts, kernel wiring) + `runtime.ts`
(facade) + their tests per `SRC_PRIME_SPEC.md`. Acceptance: byte-parity
tests green, terminal guarantee under abort green.

## M6.2 — Runtime gate (after 6.1)
Implement `docs/PRIME-RUNTIME-GATE.md` in `src/load-agent-runtime.ts` +
session manifest pin + `inspect_agent_runtimes`-style capability surface so
the deck can report runtime state honestly (like `inspect_execution_runtimes`
does for workers). UI plumbing lands after the acceptance checklist.

## M6.3 — System-prompt integration
Compose `getSystemPrompt` in the session from `src/prime/system-prompt.ts`
fragments (runtime facts + harness prompt-notes + project instructions +
capability inventory + continuation policy) with the content-addressed
cache the composer exposes, instead of the manifest default verbatim prompt.

## M6.4 — Compaction trigger
Port the threshold state machine (`input+output ≥ contextWindow - reserve`
pre-turn, keepRecentTokens 20k) into the session's `shouldStopAfterTurn`
seam, reusing `src/core/context-compressor.ts` as the summarizer (its
context-policy pinner is manifest-authoritative). Compact events are
prime events; canonical context at the next step keeps the
`context.summary.updated` shape so fork-context still works.

## M6.5 — Goals + heartbeat tick scheduler
Goal accounting (input+output counted per non-error assistant) and due
heartbeats as journaled `prime.heartbeat.due` events, driven by a page-
lifetime timer seam the host owns. The data-plane CRUD tools already ship;
this adds the scheduler.

## M6.6 — OAuth-family providers via bridge
Bring the anthropic-oauth/codex/copilot surfaces through
`src/inference/bridge/` (extension companion), since browser-side OAuth
flows land where device codes + PKCE live.

## M6.7 — Fork-context admission
Adopt `src/core/fork-context.ts` lineage-sealed sessions in the session
authority (resume v2 semantics: lineage pinned, seed verified, then fork).

## M6.8 — MCP transport seam
Optional: MCP-streamable-HTTP clients for desktop-adjacent providers
(sockets-free) gated on extension bridge.

## Seams already named, deliberately not on this list
- kernel namespace snapshot/restore (dill) — restore seam deferred (named
  in the kernel capability record)
- skill-creator tool (upstream CLI-side builder) — deferred; SKILL.md +
  SKILL prompt blocks land in skills.ts
- `export-html` semantic if session export is wanted later
