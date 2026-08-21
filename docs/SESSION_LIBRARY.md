# Airship session library

The session library is a browser-native control surface over the active `EventJournal`. It does not contain credentials, does not imply that a journal is remotely synchronized, and does not mutate an existing session when the user changes provider, model, posture, tools, workspace, or profile.

## Modules

- `src/sessions/domain.ts` contains bounded materialization, structural history assessment, immutable pin extraction, runtime compatibility decisions, and metadata query/sort/filter functions.
- `src/sessions/library.ts` provides abort-aware list and inspect reads plus conflict-checked fork creation.
- `src/ui/sessions-view.tsx` is the reusable Preact surface; it owns its responsive styles in `sessions-view.css`.
- `src/core/contracts.ts` accepts historical protocol-v1 manifests for replay
  and emits protocol-v2 manifests for current work. V2 requires an explicit
  `turnContext` policy; v1 sessions must be forked before a new turn. Optional
  `securityPosture` and immediate `lineage` commitments remain readable on both
  supported versions.

## Host integration

Create one library for the same journal used by the active agent runtime:

```ts
const sessions = new SessionLibrary(runtime.journal);
```

Supply an exact active runtime identity. A tool-manifest digest is mandatory because `runTurn` also refuses to continue when the tool set changes.

```ts
const activeRuntime: ActiveSessionRuntime = {
  providerId: runtime.transport.id,
  model: runtime.model,
  posture: runtime.transport.posture,
  toolManifestDigest,
  workspaceId,
  profile: {
    profileId,
    profileRevision,
    themeDigest,
    skillSetDigest,
    resolutionDigest,
  },
};
```

Render the library and make activation an explicit host action:

```tsx
<SessionsView
  library={sessions}
  runtime={activeRuntime}
  activeSessionId={sessionId}
  forkManifest={freshManifestForTheActiveRuntime}
  onResume={async (detail) => {
    setSessionId(detail.session.id);
    setMessages(detail.transcript.messages);
  }}
  onForked={async (result) => {
    setSessionId(result.session.id);
    // The fork's own transcript is empty of turns; its inherited ancestor
    // context lives in the seed event and is materialized for the provider.
    setMessages([]);
  }}
  onOpenSessionDetails={(id) => openSessionDetailsFor(id)}
/>
```

`onResume` is only enabled when provider, model, posture, tool manifest, workspace (when supplied), and every profile digest match. A structurally unfinished session or any binding drift requires a fork. A structurally suspect session is blocked from normal resume.

A conversation whose record carries `importedAt` — it arrived in a work bundle — always requires a fork. `decideSessionResume` adds the `ARRIVED_IN_A_BUNDLE` reason, because that conversation's pinned instructions, model and tool set were composed on another device and were never agreed to here. Every message stays readable. The comparison deliberately omits `systemPromptDigest`, because connecting a provider legitimately moves the composed prompt for a *new* session; the fence is on where the record came from, not on what it says. See [`WORK_BUNDLE.md`](WORK_BUNDLE.md).

Pass a fresh `forkManifest` to move a branch onto the active runtime. If it is omitted, the library clones the source runtime configuration. In both cases it creates a new session ID and writes this immutable immediate-ancestor commitment into the new manifest:

```ts
{
  version: 1,
  kind: "fork",
  sourceSessionId,
  sourceHeadSequence,
  sourceHeadDigest,
  forkedAt,
}
```

The source journal is not copied, summarized, or rewritten — that is what the returned `historyCopied: false` field means, and no source receipt is invalidated. Conversational branching is nonetheless already shipped: the fork's first event after creation is a `session.fork.context.seeded` record (`FORK_CONTEXT_EVENT_TYPE` in `src/core/fork-context.ts`) carrying a digest-sealed copy of the ancestor's materialized provider messages up to the selected boundary. The result reports `contextSeeded: true` with `contextMessageCount`, `omittedContextMessages`, and `omittedContextImages`.

The seed is bounded, so a long ancestor is normally truncated rather than refused: at most `MAX_FORK_CONTEXT_MESSAGES` (256) messages and `MAX_FORK_CONTEXT_BYTES` (768 KiB) of canonical payload, dropped as whole turns from the oldest end so the seed is never a half-turn. When the single newest turn alone still does not fit, its images are stripped to keep the words. When even the stripped turn does not fit, `prepareForkContext` throws a `RangeError` and the fork is refused: the bound is never met by cutting inside a turn, so one pathological turn is the case truncation cannot serve. Whatever was left out is counted in the omission fields so the surface can say so. The seed is admitted into provider history only after its `contextDigest` is verified and its sealed scope matches the fork's own session ID and lineage; a seed that is tampered with, duplicated, or moved off the second event position is ignored entirely.

## Posture language

New session creation should pin the transport posture:

```ts
await createSessionManifest({
  // existing fields
  securityPosture: runtime.transport.posture,
});
```

Older sessions can only expose posture observed in `inference.started` events. The library labels this `event-observation`, not a manifest pin. Multiple observed postures without a manifest pin make the history suspect.

`assessSessionHistory` checks bounded shapes, sequence continuity, stored digest links, head agreement, timestamps, turn lifecycle, and manifest/event runtime bindings. It deliberately reports:

```text
scope: structural-linkage-only
digestRecomputed: false
authenticity: not-proven
```

Use `auditSessionHistory` for full event digest recomputation, protocol and receipt binding checks, and an optional independently trusted head. Neither local check establishes authenticity without that external trust anchor.

## Limits and safety

Default inspection limits are 20,000 events, 500 rendered user/assistant messages, 64 KiB per message, and 512 KiB total transcript text. The materializer renders no tool payloads, strips unsafe control characters, never uses HTML injection, and reports omitted material. List results expose only bounded metadata—not system prompts, tool schemas, or credentials.

Journal reads retry once if the head changes during inspection. A still-moving snapshot is marked unfinished, so the UI will not authorize resume. Fork cancellation is honored before mutation; after the journal mutation boundary, the committed identity is returned even if cancellation races, avoiding an ambiguous duplicate retry.
