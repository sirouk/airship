# Browser-native Git

**Status:** standards-compatible local Git foundation, 2026-07-22

Airship runs Git on the client with `isomorphic-git`. The Git engine reads and
writes through the same `WorkspacePort` used by Editor, Terminal, tools,
retrieval, and Vault migration. There is no second simulated repository and no
Airship Git proxy.

## Product truth

Each registered repository contains a conventional `.git` namespace with
loose objects or packfiles, refs, `HEAD`, config, and a binary `DIRC` index.
Repository metadata is catalogued at
`/workspace/.airship/browser-git-repositories.v1.json`. Both the catalog and
the repository `.git` files are hidden from ordinary Editor trees,
WebContainer execution snapshots, and model context, but they migrate with the
authoritative workspace. Terminal Git commands use the deterministic
`BrowserGitClient` bridge against those exact files; Airship does not copy
`.git` into WebContainer or create a second repository there.

The workspace boundary is string-valued, so opaque Git and binary worktree
bytes use a reversible, versioned base64 envelope. This is a storage encoding,
not a synthetic Git format: bytes presented to the Git engine remain the exact
Git bytes. Symlinks are currently rejected rather than emulated.

Ephemeral mode keeps this whole filesystem in page memory. An active
client-encrypted Vault persists the same files through its selected provider;
no detached Git checkpoint is exported. The legacy
`/workspace/.airship/git/` semantic checkpoint is ignored during migration.

## Architecture

```text
Editor + Source Control + terminal Git bridge + agent Git tools
                    |
             BrowserGitClient
       validation / locks / capability gates
                    |
          WorkspaceGitAdapter (lazy chunk)
                    |
              isomorphic-git
                    |
           WorkspaceGitFileSystem
                    |
    authoritative WorkspacePort selected by runtime
       |                                |
 page-memory Ephemeral        client-encrypted Vault
```

`src/git/types.ts` remains the library-neutral adapter waist. The Git engine,
its Buffer compatibility layer, and the filesystem bridge live in one lazy
browser-Git chunk; the baseline shell does not preload them. The release gate
allows exactly one optional Git chunk and budgets it independently.

## Implemented operations

- real status over HEAD, index, and worktree;
- bounded staged and working-tree diffs;
- stage, unstage, commit, create branch, and switch branch;
- full-history direct Smart HTTP clone and fetch when the remote permits it;
- direct Smart HTTP push after a separate identity/change-remote approval,
  including an optional page-memory-only credential callback and explicit
  unknown-outcome recovery;
- conventional linked-worktree create/list/remove with a real `.git` pointer,
  `.git/worktrees/<id>` administration records, an independent `HEAD` and
  binary index, and one physically shared object/ref/config namespace;
- public GitHub snapshot admission as a real local repository; and
- reload and Vault-transition reopening from the same `.git` files.

The Terminal route exposes a Shared Git command row for status, diff, add,
restore/reset, commit, branch/switch, remote inspection, fetch, push, clone, and
selected rev-parse queries. Local mutations and remote effects go through the
same approval policy as Editor. The adjacent interactive WebContainer remains
a real Node/jsh runtime, but its arbitrary process filesystem excludes `.git`:
this prevents unreviewed native mutations from bypassing Workspace CAS while
still giving terminal users authoritative Git operations and output.

The Source Control rail defaults to a path tree and projects the same files as
Editor. Historical `#sources` navigation resolves to Workspace Editor.

### Snapshot import is not clone

The public GitHub importer resolves and verifies a pinned host snapshot, writes
those exact bytes into Workspace, then initializes a genuine local repository.
It creates an empty root commit and leaves the admitted files visibly
untracked so the operator can review, stage, and commit them. It records the
source URL as `origin`, but it does **not** invent the upstream commit graph.
Use direct clone when upstream objects and history are required and the remote
supports browser CORS.

## Versions, concurrency, and migration

Every mutation carries the repository/worktree version the user reviewed. The
adapter derives that version from actual Workspace revisions, rejects a stale
operation, and allows only the explicitly projected file to change during an
Editor-to-Git handoff. `BrowserGitClient` serializes conflicting mutations in
the page. Workspace providers retain their own compare-and-swap contract.

Linked worktrees close the one gap between isomorphic-git's `.git`-file
discovery and Git's layout rules. The filesystem adapter interprets the
conventional `commondir` record: per-worktree `HEAD`, index, in-progress state,
and `logs/HEAD` remain in the linked administration directory, while objects,
refs, config, packed refs, and common logs resolve to the primary `.git`
directory. It does not copy or reconcile those namespaces. A branch may be
checked out by only one registered worktree, creation requires an empty safe
Workspace destination, and removal refuses a dirty or primary checkout.
When an imported repository is nested inside the registered root Workspace
repository, its linked checkout may use another safe path in that same
Workspace container. Airship records an owner-qualified exclude in the
container repository and omits every nested repository worktree from its
version projection, so the linked checkout neither pollutes root status nor
weakens overlap checks against unrelated repositories.

Vault transitions copy normal files, the repository catalog, and every `.git`
file through `WorkspacePort`. Adoption happens only after the target can reopen
and verify each registered `HEAD` and index. The old lossy checkpoint is not
copied and `WorkspaceGitAdapter.exportCheckpoint()` fails closed by design.

This is not yet a cross-tab filesystem transaction. A future worker/OPFS tier
should add Web Locks or equivalent durable writer fencing before advertising
safe concurrent repository mutation across tabs.

## Remote contract

Clone and fetch use Git Smart HTTP directly from the browser. The target must:

- use HTTPS;
- expose the required endpoints and response headers to the Airship origin;
- allow preflight and streaming behavior used by the Git engine; and
- provide any required authorization through a future reviewed credential
  adapter.

Failure reports the target origin and the CORS/credential boundary. Airship
does not route through an undeclared backend. Push uses the same direct Smart
HTTP client. A remote that permits anonymous writes needs no credential;
otherwise the embedding integration must supply the adapter's scoped
page-memory credential callback. Credentials are returned only to
`isomorphic-git`'s challenge callback and are never included in Git operation
arguments, approval receipts, Git config, Workspace, terminal history, or
Vault. The default Airship surface does not manufacture or persist a Git-host
token.

Push is never folded into commit and always receives its own identity approval.
Non-force is the default. If the network ends without a verified terminal
response, Airship reports `push-outcome-unknown`: the remote may have accepted
the ref, so the operator must fetch before retrying. It does not claim that a
remote mutation rolled back.

Host-specific APIs may be added behind a separate adapter. A provider content
API must never be labeled a Git push unless it preserves parent/ref
preconditions, commit identity, conflicts, and the returned object identity.

## Hostile input and present limits

The adapter rejects traversal, backslashes, control characters, `.git`
worktree materialization, non-NFC names, Windows device names, trailing dot or
space segments, case-fold collisions, malformed refs, credential-bearing
remote URLs, non-HTTPS remotes, and oversized operation inputs. It bounds file,
seed, selection, message, and rendered-diff sizes.

Before arbitrary hostile remote clone can be called production-hardened, add a
corpus and explicit limits for pack/object count, inflated bytes, delta depth,
compression ratio, malformed indexes, ref collisions, submodules, attributes,
filters, alternates, shallow/promisor state, and checkout CPU/memory. Current
direct clone is therefore a conditional interoperability capability, not a
claim that every public repository is safe or browser-compatible.

## Executable evidence

- `src/git/workspace-adapter.test.ts` verifies real `HEAD`, refs, objects, a
  binary `DIRC` index, stage/commit behavior, snapshot admission, reopen, and
  fail-closed direct transport errors, accepted credentialed push, credential
  non-persistence, unknown push outcomes, and linked-worktree metadata,
  shared-object/ref behavior, branch isolation, reload, and removal.
- `src/git/terminal-commands.test.ts` proves terminal commands read and mutate
  the same client/repository as source control, route push through identity
  approval, and honor approval denial.
- `src/vault/runtime-adoption.test.ts` verifies that real `.git` state and the
  registry migrate while the legacy detached checkpoint does not.
- `e2e/github-import.spec.ts` exercises import, Editor visibility, Source
  Control, stage, commit, hidden metadata, reload, and agent use in the local
  browser lab.
- `scripts/release-gate.test.mjs` prevents the optional Git pack from leaking
  into baseline or preload paths.
