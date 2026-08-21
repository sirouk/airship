# Browser Git contract

Airship includes a workspace-backed `isomorphic-git` adapter. It keeps Git
objects, refs, configuration, and the binary index in the active workspace.
There is no Airship Git proxy or hosted backend.

## Supported work

The adapter supports status, diff, stage, commit, branches, worktrees, history,
tags, stash, merge, remote configuration, and direct Smart HTTP clone, fetch,
and push when the remote boundary allows them. Operations use generation-bound
writes and bounded input sizes.

The GitHub snapshot importer is a separate path. It reads a repository tree at
one immutable commit through GitHub's API and raw-file endpoints. A snapshot is
not full Git history.

## Remote boundary

Provider endpoints and Git remotes are different authorities. The static CSP
allows user-configured HTTPS provider egress, but that does **not** authorize an
arbitrary repository host.

Direct Git uses its own exact-origin allowlist:

- the page's own origin is allowed when a document origin exists;
- `GIT_REMOTE_CONNECT_ORIGINS` adds reviewed cross-origin Git hosts;
- the stock list is empty;
- every other origin fails before a request is sent.

`git_inspect capabilities` reports the effective list. Recording a remote URL is
a local configuration write and remains possible even when fetch and push are
blocked for that origin.

A permitted cross-origin remote must also grant the Airship page origin through
CORS for Git Smart HTTP. Public `github.com` and `gitlab.com` Git endpoints do
not provide that browser contract. Use the GitHub snapshot importer when a
history-free source snapshot is sufficient.

## Credentials and push safety

Credentials come from an optional broker and remain in page memory. They are
not placed in remote URLs, workspace snapshots, logs, or durable records.
Without a broker, only anonymous-capable remotes can succeed.

Push requires explicit review. Non-fast-forward updates are rejected until the
remote is fetched and reconciled. If the final response is lost, Airship reports
an unknown outcome and does not retry automatically.

## Extending the allowlist

A deployment that needs direct cross-origin Git must build with the exact Git
origin in `GIT_REMOTE_CONNECT_ORIGINS`, verify the host's CORS behavior, and
re-run the Git and browser release gates. Do not infer Git authority from the
provider-oriented `connect-src https:` grant.
