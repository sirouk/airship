# Terminal engine architecture

Airship exposes two browser-owned shell surfaces. Neither is host Bash, SSH, or
access to the device filesystem.

## Universal agent shell

`airship-sh` is Airship's bounded POSIX-sh-compatible interpreter over the
selected `WorkspacePort`. It supplies pipelines, redirection, expansion,
control flow, workspace utilities, streaming output, exit codes, and explicit
budgets without downloading an external runtime. It does not claim GNU Bash
extensions or host process access.

## Interactive Workspace Terminal

The optional Workspace Terminal uses one page-local StackBlitz WebContainer.
Each tab owns an interactive `jsh` PTY. The host projects the selected workspace
into the container and applies bounded, revision-checked writeback. Browser Git
remains a separate attributed sideband because the WebContainer projection does
not make `.git` its authority.

WebContainer activation requires a supported browser, a secure cross-origin-
isolated page, runtime delivery from the declared provider, and applicable
provider terms. If activation fails, Airship reports the blocker and does not
show a fake terminal.

## Invariants

- Terminal processes never receive provider or Vault credentials.
- Workspace and control-plane paths remain separate.
- Output is bounded before it enters durable run records.
- Stop targets the selected process or tab, not unrelated conversations.
- Runtime identity and producing boundary are stated in tool results.
- Unsupported shell engines are absent rather than listed as placeholders.
