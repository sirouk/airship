# Airship architecture

This document describes the current simplified runtime shape. See
[`CANON.md`](CANON.md) for product scope.

## System view

```text
+-------------------- user device --------------------+
| PWA shell (Preact UI)                               |
|   | navigation, approvals, sessions, workspace      |
|   v                                                 |
| Agent runtime                                       |
|   |-- append-only journal                           |
|   |-- tool registry + approval policy               |
|   |-- context/memory planner                        |
|   |-- PRIME runtime                                 |
|   |-- model override + concurrency control          |
|   |                                                 |
|   +--> Inference fabric --> remote providers / loopback models
|   +--> Vault/storage --> OPFS / IndexedDB / Drive
|        +--> lab-only adapter --> S3 (VITE_AIRSHIP_ENABLE_LOCAL_LAB=1)
|   +--> Workspace -----> files, editor, Git, terminal, one granted device folder
|   +--> Execution -----> JS workers / WASI / Pyodide / optional packs
|   +--> Extension -----> optional fixed-host relay or acceleration
+-----------------------------------------------------+
```

## Main runtime layers

### UI shell

The UI presents sessions, providers, workspace, memory, vault, and profile
surfaces. Navigation and composition remain responsive even when one session is
busy.

### Agent runtime

The runtime owns session creation, prompt assembly, provider/model provenance,
turn execution, tool orchestration, approvals, cancellation, and journaling.
It is the authority for what happened in a conversation.

### Inference fabric

The inference fabric manages page-memory provider credentials, connected model
catalogs, and transport adapters. It supports:

- OpenAI
- Anthropic
- xAI
- Chutes as an ordinary OpenAI-compatible provider
- custom OpenAI-compatible endpoints
- local Ollama and LM Studio providers

The fabric records the provider, connection generation, selected model, and
transport boundary used for each turn.

### Storage and vault

Airship separates the working set from durable storage authority.

- **Ephemeral mode** keeps state in page memory only. One non-content line per
  conversation stays in `localStorage` so a return can report what was not kept.
- **Local Device** uses encrypted OPFS/IndexedDB.
- **Google Drive** receives ciphertext, and is offered only when the build
  carries a deployable Google OAuth Web client ID.
- The **S3-compatible** adapter is imported only in a
  `VITE_AIRSHIP_ENABLE_LOCAL_LAB=1` build; the release gate refuses a stock
  artifact that contains it. The **Walrus** immutable-blob transport is present
  in the repository but is not imported by any product path.
- A folder the user opens on this device is a workspace tier, not a Vault. Its
  files stay where they are, in the clear.

Mutable heads and immutable encrypted objects are distinct concerns. Durable
storage success does not imply any stronger inference claim.

### Workspace and execution

The workspace exposes file operations, editor state, terminal actions, and
browser Git through typed contracts. Execution packs remain sandboxed and
capability-gated.

`MountedLocalFolderWorkspace` composes one granted device directory onto the
profile workspace at `/workspace/local`. Paths under that mount are the only
ones served from the real filesystem; every other path stays in the browser.
The Terminal refuses the mount, and every non-read effect naming it is reviewed
in every approval mode.

### PRIME

PRIME is the default engine for recursive agent work. It provides a persistent
kernel, subagents, and explicit tool and budget controls inside the browser
runtime.

Model-written JavaScript runs in one dedicated, content-hashed same-origin
worker. The document CSP never grants `unsafe-eval`; only that worker response
gets the minimal policy required for its REPL, while network, nested-worker, and
dynamic-import sources remain closed. A controlling service worker applies the
same response policy on headerless static hosts. The controller lives in a
private closure, removes ambient storage and communication channels before a
cell runs, authenticates each generation with a random capability, and treats
host-side frame, job, sequence, call, and payload validation as authoritative.
A policy mismatch fails before the worker is constructed.

## Turn lifecycle

1. Select the target session.
2. Read its pinned prompt/tool/profile context and current model override.
3. Append the user turn request.
4. Resolve the active provider connection and model for the next turn.
5. Stream inference events into the append-only journal.
6. Persist tool requests, approvals, executions, and results as distinct events.
7. Append the turn completion or failure.

A later model change affects the next turn only. It does not rewrite prior
turn provenance.

## Transport boundaries

Airship documents only two inference boundaries:

- `provider-tls` for remote providers;
- `loopback-local` for exact local loopback providers.

The runtime does not manufacture stronger claims on top of ordinary remote API
traffic.

## Extension boundary

The optional companion extension may help with reachability or local
acceleration. It is never the source of truth for session state, and it does
not turn a provider connection into a stronger trust tier.
