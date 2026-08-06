# Browser-native Git

**Status:** standards-compatible local Git foundation with one Terminal command surface, 2026-08-05

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
- bounded history reads: `log` (optionally depth-limited, revision-scoped, or
  following one path) and `show`, which renders a commit against its first
  parent — or against the empty tree for a root commit;
- lightweight and annotated tags: create, list, and delete real `refs/tags`
  entries and real tag objects;
- stash push/apply/pop/drop/clear/list over the conventional `refs/stash` and
  `logs/refs/stash` records;
- conflict-free merge — fast-forward or a real merge commit — followed by the
  checkout that makes the worktree and index agree with the new `HEAD`;
- discard-changes and reset: restore named paths from the index or from `HEAD`,
  and `--soft`/`--mixed`/`--hard` reset of the current branch;
- remote management: attach, repoint, and detach a remote in both `.git/config`
  and the repository catalog;
- full-history direct Smart HTTP clone and fetch when this build's own
  Content-Security-Policy permits the origin *and* the remote permits it;
- direct Smart HTTP push after a separate identity/change-remote approval,
  including an optional page-memory-only credential callback and explicit
  unknown-outcome recovery;
- conventional linked-worktree create/list/remove with a real `.git` pointer,
  `.git/worktrees/<id>` administration records, an independent `HEAD` and
  binary index, and one physically shared object/ref/config namespace;
- public GitHub snapshot admission as a real local repository; and
- reload and Vault-transition reopening from the same `.git` files.

Deliberately **not** implemented, and reported as such rather than approximated:
rebase, cherry-pick, revert, blame, bisect, submodules, notes, and interactive
conflict resolution. `isomorphic-git` exports `cherryPick` but no `rebase` or
`revert`; a conflicting merge is aborted with the conflicting path list instead
of writing conflict markers, because `statusMatrix` has no stage-2/stage-3
representation to surface a conflicted path honestly.

Because a stash entry is a real commit, `isomorphic-git` resolves its identity
from `user.name`/`user.email` in the repository config, exactly as Git does. The
adapter therefore publishes the reviewed request author into `.git/config`
before writing the stash commit.

The Terminal is the one Git command surface. A person types `git status`,
`git diff`, `git add`, `git commit`, `git stash`, `git worktree`, or another
supported command at the ordinary prompt. Once jsh submits that standalone
`git …` line, Airship claims its terminal audit identity exactly once and runs
the same text through `BrowserGitClient` against the repository containing that
tab's working directory. `git help` lists the exact set, including what is
absent. Local mutations and remote effects still go through Editor's approval
policy: `runTerminalGitBridge` (`src/ui/terminal-view.tsx`) requires the review
callback the bridge itself accepts optionally.

Compound shell lines are not sideband-routed. Operators or substitutions such
as `&&`, `;`, pipes, redirects, `$()` and backticks can cause jsh effects even
when its missing `git` command fails; presenting BrowserGitClient as the author
of the whole line would conceal that shell work.

The answer is appended to the retained transcript under the visible heading
`Airship Browser Git · … · BrowserGitClient, not jsh`. This is a labelled
application sideband, not forged PTY output. BrowserGitClient output is stripped
of terminal control sequences before xterm receives it, the audit record points
back to the exact submitted-input record, and restored input from a prior page
is never replayed. The route and Workspace dock share the same manager-owned
claim, so two mounted presentations cannot execute one mutation twice.

There is intentionally no native Git binary in the WebContainer. WebContainer
is an in-browser Node.js runtime whose processes are started through its custom
`jsh`; its documented execution boundary is JavaScript and WebAssembly, and
native C++ binaries/addons must be ported to WebAssembly. More importantly for
Airship, exposing `.git` to any guest Git implementation would create an
unreviewed writer outside `WorkspacePort` CAS and the shared approval policy.
The mount therefore continues to exclude `.git`; a WASM Git port would not make
that second authority safe. See the upstream [WebContainer API](https://webcontainers.io/api),
[interactive terminal tutorial](https://webcontainers.io/tutorial/7-add-interactivity),
and [native-binary troubleshooting boundary](https://webcontainers.io/guides/troubleshooting).

### Ignore rules

`.gitignore` and `.git/info/exclude` are honoured by the engine itself:
`statusMatrix` drops untracked-and-ignored rows and `add` skips them. Airship
does not add a second ignore engine on top, so Git's own rules hold — including
the rule that a file under an excluded directory cannot be re-included by a
later negation. Three consequences are made explicit rather than left to be
inferred from an empty status:

- staging an ignored, untracked path fails with `path-ignored`, naming the rule,
  instead of the misleading "has no unstaged change"; passing `force` stages it
  and the approval summary says so;
- a path that was tracked before the pattern was added keeps reporting
  modifications, because Git only applies ignore rules to untracked paths; and
- a seeded or migrated file the repository's own rules exclude stays in the
  workspace but never enters the index. Initialization counts those files and
  names them in a `console.warn`, so the omission is legible in devtools rather
  than inferred from an empty status; it does not yet reach the UI, the mutation
  result, or the approval record.

The in-memory reference adapter has no ignore engine at all and does not pretend
to: it reports every untracked path. `src/git/gitignore.test.ts` pins both
contracts.

The Source Control rail defaults to a path tree and projects the same files as
Editor. Historical `#sources` navigation resolves to Workspace Editor.

### Snapshot import is not clone

The public GitHub importer resolves and verifies a pinned host snapshot, writes
those exact bytes into Workspace, then initializes a genuine local repository
whose first commit contains that complete snapshot. The worktree starts clean:
HEAD, the index, and the admitted files agree. It records the source URL as
`origin`, but it does **not** invent the upstream commit graph.
Use direct clone when upstream objects and history are required — but read the
Content-Security-Policy section below first: on this build the importer is the
only working path to a public GitHub repository.

The imported files are now an ordinary local baseline: edit one and Source
Control reports a real modification against the pinned snapshot. A fresh
repository therefore has no synthetic first-use additions to stage. The source
URL and pinned commit remain in the import receipt; upstream history is still
not manufactured.

The converse claim needs the adapter's cooperation, so the adapter contract
carries it: `stage`, `unstage`, and `restore` must admit or refuse every path
they were given *before* their first write. `types.ts` enumerates the codes that
pre-flight can raise — `not-found`, `version-conflict`, `validation`,
`path-ignored`, `path-not-tracked`, `detached-head` — and a failure carrying one
of them on the *first* chunk provably changed nothing, so `BrowserGitClient`
surfaces it verbatim instead of masking it as `partial-mutation`. Every other
code, and every failure once an earlier chunk has committed, keeps the
conservative partial framing. That is why the workspace adapter scans the whole
path set first rather than deciding each path as it writes it: a mid-set refusal
after a sibling had already been added would turn the verbatim code into a false
"nothing happened" claim.

## Versions, concurrency, and migration

Every mutation carries the repository/worktree version the user reviewed. The
adapter derives that version from actual Workspace revisions, rejects a stale
operation, and allows only the explicitly projected file to change during an
Editor-to-Git handoff. `BrowserGitClient` serializes conflicting mutations in
the page. Workspace providers retain their own compare-and-swap contract.

Git's index caches a stat per tracked file and treats a file as unchanged when
mode, size, uid, gid, inode and *whole-second* mtime all match. A browser
workspace has no real inodes, and agent tool loops and editor autosave routinely
rewrite a file to a same-length value inside one second — which would make that
edit invisible to status, diff, stage, and commit. `WorkspaceGitFileSystem`
therefore projects the WorkspacePort revision, which every port implementation
mints fresh on every write, into the reported inode. A no-op rewrite costs one
re-hash; a real rewrite can never be missed.

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

### This build's Content-Security-Policy is the first gate, before CORS

Airship ships a strict `connect-src` allowlist of exact origins in both
`index.html` and `public/_headers`. It names `https://api.github.com` and
`https://raw.githubusercontent.com` — GitHub's REST API and raw-file CDN, the
two hosts the snapshot importer uses. **Neither serves Git Smart HTTP**, and
neither `https://github.com` nor `https://gitlab.com` is on the list. There is
no wildcard and no scheme-wide grant.

So on this build, direct `clone`, `fetch`, and `push` can reach only origins in
`GIT_REMOTE_CONNECT_ORIGINS` (`src/git/validation.ts`, currently empty) plus the
page's own origin, which `connect-src 'self'` permits. A Git remote served
beside Airship works; public GitHub and GitLab do not, and no CORS configuration
on their side would change that.

The adapter checks this before it calls the transport, and fails with
`remote-origin-not-permitted`, naming Airship's own policy and pointing at the
snapshot importer. This matters because a CSP block and a remote CORS refusal
are indistinguishable to page JavaScript — both surface as
`TypeError: Failed to fetch` — so without the check Airship would confidently
blame a remote for its own decision. `capabilities.remote.permittedOrigins`
carries the same list to the UI, the terminal, and the agent, and
`src/git/validation.test.ts` pins the constant against both shipped policy
documents so the two cannot drift.

The capability record reports the same limit rather than a flat boolean:
`features.clone`, `features.fetch`, and `features.push` are available only while
at least one origin is permitted, and their `reason` names exactly which origins
the claim covers — the page's own origin on this build, plus whatever a
deployment adds to `connect-src` and `GIT_REMOTE_CONNECT_ORIGINS`. In a host
with no document origin nothing is reachable, so the three verbs report
`available: false` and the client refuses them before dispatch instead of
letting each call fail at the transport.

Operators who need direct Git over the network must add that Git host to
`connect-src` in **both** `index.html` and `public/_headers` (they are compared
for equality by `scripts/check-static-security.mjs`) and to
`GIT_REMOTE_CONNECT_ORIGINS`. The host must still grant CORS.

### What a permitted remote must additionally do

Clone and fetch use Git Smart HTTP directly from the browser. A permitted target
must:

- use HTTPS;
- expose the required endpoints and response headers to the Airship origin
  (unless it *is* the Airship origin, where no CORS grant is needed);
- allow preflight and streaming behavior used by the Git engine; and
- provide any required authorization through a reviewed credential adapter.

Failure reports the target origin and distinguishes the same-origin case from
the cross-origin CORS boundary. Airship
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
- `src/git/history.test.ts` verifies `log` against the real commit chain and the
  loose objects that back it, path-scoped history, `show` against a first parent
  and against the empty tree, patch-count truncation, and real lightweight and
  annotated tag refs.
- `src/git/recovery-verbs.test.ts` verifies stash push/list/pop against
  `refs/stash`, fast-forward and true merge commits with the worktree
  materialized, conflict abort leaving the worktree byte-identical,
  `--ff-only` refusal, dirty-worktree refusal, restore from index and from
  `HEAD`, and soft/mixed/hard reset.
- `src/git/remote-config.test.ts` verifies that a remote change lands in both
  `.git/config` and the catalog, survives reopening, and fails closed on
  duplicates, unknown remotes, credential-bearing URLs, and stale versions.
- `src/git/gitignore.test.ts` pins the ignore contract for both adapters.
- `src/git/terminal-commands.test.ts` proves terminal commands read and mutate
  the same client/repository as source control, route push through identity
  approval, honor approval denial, list/add/remove linked worktrees, drive the
  history/tag/stash/merge/restore/remote verbs through the approval broker in
  order, and refuse an unreachable clone before prompting for approval.
- `src/vault/runtime-adoption.test.ts` verifies that real `.git` state and the
  registry migrate while the legacy detached checkpoint does not.
- `e2e/github-import.spec.ts` exercises import, Editor visibility, Source
  Control, stage, commit, hidden metadata, reload, and agent use in the local
  browser lab.
- `scripts/release-gate.test.mjs` prevents the optional Git pack from leaking
  into baseline or preload paths.
