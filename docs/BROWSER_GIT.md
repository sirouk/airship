# Browser-native Git foundation

Status: executable local and encrypted-cloud foundation, 2026-07-19. Ephemeral mode uses the in-memory adapter. Vault mode can bind the versioned encrypted-workspace adapter. An OPFS/File System Access adapter and a general remote adapter are not yet installed.

## Product truth

Airship can run Git’s local control plane in the client. A browser can own a virtual object database, index, checkout, branches, commits, status, and diffs without an Airship application server. A browser cannot universally speak authenticated Git Smart HTTP to arbitrary origins: the remote must allow the production origin through CORS, or the host must expose a browser-safe provider API. Airship does not conceal this boundary with an undeclared proxy.

The implemented reference path proves:

- immutable repository and worktree snapshots;
- the two Git change planes (HEAD → index and index → working tree);
- bounded local diff, stage, unstage, commit, branch, branch switch, worktree create, and worktree remove semantics;
- compare-before-mutate worktree/repository generations;
- one writer per repository scope in a `BrowserGitClient` instance;
- cancellation before an adapter’s commit point;
- effect/risk/destination descriptors suitable for Airship’s approval broker;
- portable path/ref validation and explicit limits; and
- reload-durable, content-addressed encrypted workspace checkpoints with an atomic head; and
- fail-closed clone/fetch/push capability reporting.
- one atomic public-GitHub snapshot admission path shared by the agent tool and
  Sources UI, so imported bytes cannot appear in Workspace without the matching
  browser-Git repository; and
- remembered page selection so an admitted repository remains visible across
  route changes and encrypted-vault reload adoption.

It does **not** yet prove OPFS persistence, Smart HTTP interoperability, packfile hardening, merge/rebase, signing, LFS, or submodules. Those remain release gates, not implied features.

## Components

```text
SourcesView
  |
  +-- exact GitOperation + GitOperationDescriptor --> ApprovalBroker
  |
  +-- BrowserGitClient
        |  validates, freezes, capability-gates, single-writer locks
        |
        +-- BrowserGitAdapter
              +-- MemoryGitAdapter                 implemented; reload loses state
              +-- EncryptedWorkspaceGitAdapter     implemented; encrypted vault durability
              +-- isomorphic-git + OPFS adapter    next local durable adapter
              +-- File System Access adapter       explicit user-authorized host folder
              +-- host-provider API adapter        direct, scoped, host-specific
              +-- direct Smart HTTP adapter        only for CORS-enabled remotes
```

`src/git/types.ts` is the adapter waist. It is deliberately library-neutral: isomorphic-git, a WASM engine, or a provider API can satisfy it without leaking library-specific filesystem handles or credentials into the UI. An adapter publishes a capability report covering storage durability, remote transport, credential persistence, and each operation. Every unavailable operation must include a reason.

## Version and cancellation contract

Every local mutation contains `expectedWorktreeVersion`; repository-wide mutations contain `expectedRepositoryVersion`. The adapter compares that value at the durable mutation boundary. A mismatch is `GitVersionConflictError`, forcing a new status/diff and approval. This is what binds the operation the person reviewed to the state actually changed.

`BrowserGitClient` allows concurrent reads but admits one mutating operation per worktree, with repository-wide operations excluding all worktree writers. The lock is an in-page coordinator. `EncryptedWorkspaceGitAdapter` adds a cross-instance CAS checkpoint: it refreshes before an operation, applies the mutation to an isolated clone, writes immutable objects, and publishes exactly one versioned head. A losing writer never replaces its live state and receives `GitCheckpointConflictError`. A future OPFS adapter still needs Web Locks plus fencing.

An abort observed before dispatch fails without mutation. After dispatch, the adapter owns the commit point. A remote adapter must distinguish `not-committed`, `committed`, and `unknown`; it must never report an unproved rollback or automatically retry an unknown push.

## Approval integration

`describeGitOperation()` returns:

- the broker effect (`read`, `write`, `network`, or `identity`);
- a product risk (`observe`, `change-local`, `communicate`, or `change-remote`);
- the repository/worktree resource;
- the remote destination when applicable;
- whether data leaves the device; and
- a deeply frozen, redaction-safe copy of the exact operation arguments, including the expected generation.

`SourcesView` requires a fail-closed `review` callback. An application bridge can turn the descriptor into an approval-broker request:

```ts
const review: SourcesReview = (operation, descriptor) => broker.request(
  {
    name: `git.${operation.kind}`,
    description: descriptor.summary,
    effect: descriptor.brokerEffect,
    inputSchema: {},
  },
  descriptor.arguments,
  { sessionId, turnId, operationId, signal },
);
```

For a production grant, the executor must additionally bind and atomically consume the canonical argument digest. A local commit and a push are always two approvals. Force push remains explicit in both the descriptor and operation; the supplied Sources UI does not expose it.

## Local adapter sequence

The next production *device-local* adapter should compose isomorphic-git (or a conformant successor) behind `BrowserGitAdapter`:

1. Keep the Git directory and ordinary browser worktree in OPFS. OPFS availability is a capability, not a baseline assumption.
2. Run repository scans, hashing, pack parsing, and diff work in a dedicated module worker.
3. Use Web Locks plus a fenced repository generation. Flush filesystem writes before publishing the new generation.
4. Treat File System Access handles as separately authorized capabilities. Persisting a handle does not prove that permission remains granted; re-check it.
5. Enforce Airship’s validation and resource limits before passing paths/refs/objects to the engine.
6. Encrypt immutable Git objects and small checkout/index manifests before optional S3 checkpointing. Acknowledged cloud durability requires object commit plus head CAS, not merely an OPFS write.

The in-memory and encrypted adapters expose version-fenced `writeWorkingFile`,
`removeWorkingFile`, and `moveWorkingFile` operations so Workspace Explorer and
Sources project the same worktree. The memory capability reports
`durable: false`. `EncryptedWorkspaceGitAdapter` accepts only a
`ClientEncryptedWorkspacePort`; a generic workspace, IndexedDB adapter, or host
filesystem cannot accidentally be labeled encrypted.

The UI currently composes a workspace mutation and a Git-checkpoint mutation
with preflight fencing and compensating rollback. Those two encrypted heads do
not share one atomic commit point. An ordinary rejected operation is rolled
back, but an ambiguous provider success or failed rollback is reported as an
error and requires refresh/repair; the UI must not call this a cross-head atomic
transaction. A future batch manifest or durable repair journal is required for
that stronger claim.

### Encrypted checkpoint protocol

The durable adapter stores immutable file contents by SHA-256 beneath `/workspace/.airship/git/objects/`, then advances `/workspace/.airship/git/head.v1.json` using `WorkspacePort.write(..., { expectedRevision })`. The head contains refs, commit metadata, index/checkouts, repository/worktree generations, object digests, a schema version, a monotonic checkpoint generation, and a canonical state digest. Reload verifies the head, every referenced object digest, every reconstructed commit ID, every ref, and all path/resource limits before admitting state.

Object writes can become unreachable when a tab loses the final CAS; that is safe opaque garbage and can be collected later. The adapter bounds head bytes, repository/commit/object/reference counts, tree entries, and individual file bytes. Its reserved control-plane path is excluded from automatic context indexing, so Git internals cannot become model context.

## Remote strategies

### Direct Git Smart HTTP

Use only when the remote advertises a browser-compatible CORS policy for the production origin and accepts a user-scoped, short-lived credential. Preflight, redirects, response headers, streaming bodies, and credential revocation need live conformance tests. Tokens remain in memory and must not appear in the URL, repository config, object store, logs, error messages, or service-worker cache.

### Host-provider API

GitHub/GitLab/other host APIs can be a separate adapter when their browser OAuth and repository APIs cover the requested semantics. A content API update is not silently labeled a Git push: the adapter must preserve parent/ref preconditions, commit authorship, conflicts, and result identity or expose a narrower capability.

### No transport

`MemoryGitAdapter` uses this posture. Clone/fetch/push throw `GitCapabilityError` before reaching the adapter. A configured remote URL is descriptive metadata, not proof that transport works.

## Hostile-repository gates

The current domain rejects parent/root/backslash/control paths, `.git` worktree materialization, non-NFC names, Windows device names, trailing dot/space segments, overlong paths, duplicate operation paths, case-fold collisions, malformed refs, credential-bearing remotes, and non-HTTPS remotes. It bounds selected paths, commit messages, files, seed file counts, and rendered diffs.

A production object/pack adapter must additionally test and bound:

- object count, total inflated bytes, delta depth, delta cycles, and compression ratio;
- duplicate paths after Unicode/case normalization;
- symlink, submodule, alternates, replace refs, hooks, attributes, and filter escape;
- ref collisions, symbolic-ref cycles, shallow/promisor state, and malformed indexes;
- diff/rename/merge CPU and memory budgets; and
- credentials or secret fixtures crossing a remote/indexing boundary.

Until that corpus passes, importing an arbitrary hostile repository is not a production capability.

## Reusable integration

```tsx
const adapter = await MemoryGitAdapter.create([{
  id: "airship",
  name: "Airship",
  files: { "README.md": "# Airship\n" },
}]);
const client = new BrowserGitClient(adapter);

<SourcesView
  client={client}
  author={{ name: "Operator", email: "operator@example.com" }}
  review={review}
/>
```

Vault mode changes only the adapter construction; Ephemeral mode keeps the code above:

```ts
const adapter = await EncryptedWorkspaceGitAdapter.create(encryptedObjectWorkspace, [{
  id: "airship",
  name: "Airship",
  files: { "README.md": "# Airship\n" },
}]);
const client = new BrowserGitClient(adapter);
```

`encryptedObjectWorkspace` must be the same `EncryptedObjectWorkspace` selected by the active vault runtime. Switching durability modes should construct the corresponding adapter rather than copying Git metadata into device plaintext storage.

The explicit mode-transition hooks preserve live state:

```ts
const durable = await EncryptedWorkspaceGitAdapter.createFromCheckpoint(
  ready.workspace,
  await ephemeralClient.exportCheckpoint(),
);

const ephemeral = await MemoryGitAdapter.restore(await durableClient.exportCheckpoint());
```

The application should replace its `BrowserGitClient` and tool registry only after the target adapter has committed successfully. A durable export carries its exact head revision, generation, and state digest through Memory mode. Returning to the same Vault advances that head only when the fence still matches. If another device changed the cloud checkpoint, the adapter raises `GitCheckpointConflictError`; the UI must present reconciliation instead of silently overwriting either side. A fresh page bootstrap has no durable base and loads the existing encrypted head as authoritative; it cannot replace it with sample state.

`SourcesView` supports repository/worktree selection, dual-plane status, staged and working diffs, stage/unstage, local commit, create/switch branch, and separately approved fetch/push controls. Disabled remote controls display the adapter’s actual reason. Its stylesheet includes narrow layouts, 44-pixel primary controls, focus-visible states, and forced-colors support.
