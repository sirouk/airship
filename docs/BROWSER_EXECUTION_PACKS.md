# Browser-native coding execution

Status: implemented capability broker, baseline executors, and explicit Python
pack, 2026-07-19.

## What ships now

Airship exposes one stable, browser-owned execution contract rather than
pretending that every device contains a Linux host.

| Runtime | Current state | Useful for | Boundary |
|---|---|---|---|
| JavaScript Worker | ready when disposable Workers are available | calculations, transformations, small scripts | 64 KiB source, 10 s maximum, terminated Worker, no DOM/network/storage binding |
| compact WASI Preview 1 | ready when Worker + WebAssembly are available | precompiled Rust/C/C++/Go/Zig command artifacts | 4 MiB artifact, 64 MiB initial memory check, 10 s maximum, args/env/stdout/stderr/clock/random, no filesystem or sockets |
| Pyodide Python 314.0.2 | installable, then ready after a live probe | Python standard library, bounded workspace projects, args/env, streams, JSON-compatible results | locked same-origin npm assets; fresh disposable Worker; 64 KiB source, 10 s job, 256 KiB per stream; no packages or runtime network |
| Wasmer/WASIX | unavailable in this release | future packaged Python/Ruby/PHP/shell and portable CLI programs | no installer or adapter is shipped; it is never advertised as executable |
| Node WebContainer 1.6.4 | explicitly activatable or unavailable | real Node/npm/pnpm/yarn project commands | StackBlitz runtime delivery, cross-origin isolation, provider terms/licensing, network approval, and browser suspension apply |

The Workspace Terminal uses the same singleton WebContainer host through a
route-lazy xterm.js renderer. xterm.js is a terminal emulator, not a shell. The
actual interactive process is WebContainer `jsh`; Airship never labels it as
host Bash, SSH, or access to the user's device filesystem.

The agent can call `inspect_execution_runtimes` before choosing an implementation.
`execute_code` dispatches only to a registered `ready` adapter. The legacy
`execute_javascript` tool remains for stable sessions. Optional labels never
become phantom executable capabilities. The user or agent must call
`install_execution_runtime` with `python-pyodide`; Airship initializes and runs
a version probe before registering the adapter.

## Pack ABI

`src/execution/runtime-registry.ts` is deliberately smaller than any language
runtime. A pack is a lazy module that implements `ExecutionAdapter`, reports a
fixed capability identity, and registers through `installExecutionAdapter()`.
The adapter receives the abort signal, timeout, source/artifact, arguments, and
environment. It returns the runtime identity, exit code, bounded streams, and an
optional JSON value. The existing tool approval and receipt path encloses the
adapter; adding a pack does not create an invisible second agent loop.

Pack assets must be version-pinned and served from Airship's static origin (or
another explicitly enabled provider origin) with a digest manifest. Loading a
pack is an explicit cold-start state: downloading, verifying, initializing,
ready, degraded, or failed. It is never added to the startup bundle and a warm
cache result is not presented as first-run latency.

## Python pack implementation

The universal Python pack is Pyodide 314.0.2 in a module Worker. Pyodide's
official guide runs `runPythonAsync` in a Worker specifically to keep synchronous
Python from blocking the interface:
<https://pyodide.org/en/stable/usage/webworker.html>.

The exact npm dependency is copied at build time into
`/execution-packs/pyodide/`, and every served byte is SHA-256 recorded in the
release manifest. The explicit installer initializes CPython, executes a
version probe, and only then registers the adapter as ready. Every job gets a
new Worker and interpreter. Worker termination is the hard cancellation and
timeout boundary. `loadPackagesFromImports` is never called; after bootstrap,
fetch, XHR, sockets, nested Workers, caches, and IndexedDB are removed. The
versioned service-worker cache makes the pack available offline after its first
successful activation and is purged atomically on a shell-version upgrade.

Python can mount an explicitly selected `/workspace/...` subtree: at most 256
UTF-8 files, 512 KiB per file, and 4 MiB total. A snippet runs with that root as
its working directory, or `sourcePath` executes a selected workspace `.py`
file. Outputs stay isolated unless `writeBack` is true; successful text changes
then use exact per-file revision CAS. Control-plane paths are excluded. Because
`WorkspacePort` has no multi-file transaction, a cross-device race late in a
multi-file adoption can produce a reported partial write before the conflict.
Interpreter and plaintext scratch state are never written to S3.

For fuller CLI compatibility, the Wasmer SDK can run WASIX packages, mount
virtual directories, and launch packaged Python 3.12. Those are documented
features of the browser SDK, not functionality Airship must reproduce:
<https://docs.wasmer.io/sdk/wasmer-js/> and
<https://docs.wasmer.io/sdk/wasmer-js/how-to/use-filesystem>.
That is a researched future adapter, not an installable Airship capability in
this release.

## Node and npm projects — implemented optional pack

WebContainers are the credible browser-only route to Node, npm, child processes,
and localhost development servers. Airship now pins `@webcontainer/api` 1.6.4
in a second-level dynamic pack. `inspect_execution_runtimes` reports the pack as
installable or unavailable; it does not fetch the WebContainer client.
`install_execution_runtime({ runtime: "node-webcontainer" })` is a separately
approved network operation that cold-loads the pack, boots one instance, and
promotes the capability to ready only after boot succeeds. Deactivation tears
down the instance and releases its in-tab processes and memory.

`execute_node_project` mounts a selected Airship workspace directory into a
unique scratch directory, directly spawns one command without an intermediary
shell, bounds input/output/time, exports a text-only delta, and removes the
scratch directory. `writeBack: false` only reports the delta. `writeBack: true`
preflights every source revision and adopts at most 512 changes / 8 MiB; a
concurrent edit fails rather than being overwritten. `.git`, `.airship`, and
`node_modules` are never copied back. Package-manager networking remains visible
because the tool is classified as a network effect.

The host must use HTTPS (loopback is accepted), COOP `same-origin`, COEP
`credentialless`, SharedArrayBuffer, Worker, and WebAssembly. Airship's static
headers enable this posture and its CSP permits only the StackBlitz headless
frame. The integration must still pass the runtime's documented browser-support
gate: <https://developer.stackblitz.com/platform/webcontainers/browser-support>.

The hidden StackBlitz frame also needs the embedding origin to establish its
runtime channel. Airship therefore uses a page referrer policy of `origin`, not
`no-referrer`: StackBlitz receives the scheme/host/port but never the Airship
route, query, fragment, workspace path, or conversation content. A live
Chromium regression test guards boot because suppressing that origin causes the
provider frame to remain unresolved until Airship's bounded timeout.

This is not the universal tier. Cross-origin isolation and SharedArrayBuffer are
required for the intended experience, and Safari/mobile/browser-policy support
must be determined by a live probe. When the gate fails, Airship reports the pack
as unavailable and offers WASI/Python/JavaScript or a separately receipted native
or confidential executor. No Airship proxy is introduced to make npm appear to
work.

The compute is local, but the integration is not fully offline or
provider-independent: the published client boots StackBlitz-hosted runtime
infrastructure and package installation reaches package registries. The
WebContainer documentation states that commercial for-profit production use
requires a license/API arrangement. Airship does not embed an API key or describe
this provider dependency as an Airship backend.

The current project pack uses this implemented sequence:

1. capture a bounded, per-file revisioned workspace snapshot;
2. mount only that selected subtree in a unique scratch directory;
3. execute one direct command through the existing network-effect approval path;
4. bound runtime, combined process output, and exported text changes;
5. return the delta without mutation, or preflight every source revision and
   adopt it only after a successful command when `writeBack` is explicit;
6. delete the disposable scratch directory.

WebContainer output is a combined terminal stream; Airship does not fabricate a
separate stderr channel. Browser suspension can interrupt work and there is no
durable paused-task state machine in this milestone. A native companion or
confidential remote executor would be a different future capability tier.

## Workspace Terminal

`#terminal` is a disclosure beneath Workspace alongside Files and Sources. It
uses the official scoped `@xterm/xterm` 6.0.0 renderer plus
`@xterm/addon-fit` 0.11.0. Both packages are MIT licensed and upstream from the
xterm.js project used by Visual Studio Code: <https://github.com/xtermjs/xterm.js>.
No VS Code workbench source, Monaco bundle, host bridge, or unscoped legacy
`xterm` package is copied into Airship. The terminal route is its own lazy
JavaScript/CSS pack and is forbidden from initial preload by the release gate.
xterm computes canvas, viewport, and helper-textarea geometry with element-level
styles, so the production style policy permits inline styles while script
execution remains nonce-free and restricted to same-origin files. A production
Chromium check fails on any xterm CSP console error.

One page owns at most eight terminal tabs. Each tab records a name, associated
conversation thread, current workspace path, bounded command history, and
process status. The real process and its output buffer stay in page memory.
Closing a tab kills its process; reload converts any persisted running claim to
`restart-required`. This is intentionally different from a backend terminal
multiplexer, which Airship does not have.

Before the first terminal process starts, Airship mounts a bounded snapshot of
the active Workspace into `/airship-workspace`. `.git`, `.airship`, and
`node_modules` are excluded. Explicit sync and normal process exit export a
bounded text delta and adopt it through exact Workspace revisions; a concurrent
edit is reported instead of overwritten. In vault mode, tab metadata and
adopted files travel through the existing client-side encrypted Workspace
adapter. Plaintext process memory and terminal output are never made durable.

The WebContainer client package is MIT, but the runtime is a hosted StackBlitz
service and commercial production use requires the provider's API-key/license
arrangement: <https://webcontainers.io/enterprise>. Airship must keep the
provider boundary and browser cookie/service-worker requirements visible; the
official troubleshooting guidance notes that third-party storage blocking can
prevent boot: <https://webcontainers.io/guides/troubleshooting>.

## Workspace transaction model

Language runtimes do not mutate the live workspace while executing. A job gets
a bounded snapshot plus a scratch filesystem. When it exits, Airship computes a
bounded create/change/delete set. Explicit writeback preflights all affected
per-file revisions and then uses revision CAS for each mutation. Because the
current `WorkspacePort` has no multi-file transaction, a late competing writer
can still cause a clearly reported partial adoption; Airship does not yet retain
that result as a branchable patch.

This makes ephemeral execution useful with either storage mode:

- **Ephemeral:** inputs and outputs disappear on reload unless the user commits
  or exports them.
- **Vault:** adopted workspace changes flow through the encrypted workspace
  adapter. Interpreters and plaintext scratch directories remain disposable;
  execution-specific durable receipts and dependency caches are not implemented.

## Capability result and future receipt

Current tool results bind the runtime ID, exit code, bounded output, selected
workspace root, change list, and whether adoption actually happened. A future
durable execution receipt should additionally bind:

```text
runtime ID + runtime/artifact digest + browser capability probe
+ input workspace/Git head + selected mounts
+ command/source digest + arguments + declared environment keys
+ network/package grant + approval provenance
+ stdout/stderr/exit code + output delta/head
+ started/finished time + cancellation/suspension state
```

That future receipt could prove what Airship asked a local runtime to do and
what files it adopted. Current tool results are not signed attestations, and a
browser Worker is neither a TEE nor evidence that arbitrary code is trustworthy.

## Tests and release gates

The current implementation has unit coverage for adapter registration,
capability truthfulness, bounded WebContainer boot, failed-command non-adoption,
dispatch, and unavailable packs. Chromium coverage runs JavaScript, a real
minimal WASI command, and a real Pyodide install plus Python standard-library
workspace jobs under the production Trusted Types policy. WebContainer boot is
provider- and environment-dependent; it is ready only after the live activation
probe succeeds. Package failure, memory pressure, and broader browser/device
coverage remain promotion gates.

Optional pack JavaScript/WASM and language distributions have their own budgets.
They have separate blocking budgets and are never module-preloaded; the baseline
226 KiB application-JavaScript gate remains blocking.
