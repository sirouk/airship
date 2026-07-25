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
    setMessages([]);
  }}
  onOpenProof={(id) => openProofFor(id)}
/>
```

`onResume` is only enabled when provider, model, posture, tool manifest, workspace (when supplied), and every profile digest match. A structurally unfinished session or any binding drift requires a fork. A structurally suspect session is blocked from normal resume.

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

The source transcript is not copied, summarized, or rewritten. The returned `historyCopied: false` field and the UI state this explicitly. A future protocol can resolve ancestor transcripts for conversational branching without invalidating source receipts.

## Posture and proof language

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
