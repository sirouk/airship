# Browser-native coding execution

Status: implemented capability broker, streaming baseline executors, explicit
Python pack, and governed workspace programs, 2026-07-22.

## What ships now

Airship exposes one stable, browser-owned execution contract rather than
pretending that every device contains a Linux host.

| Runtime | Current state | Useful for | Boundary |
|---|---|---|---|
| JavaScript Worker | ready when disposable Workers are available | calculations, transformations, small scripts | 64 KiB source, 10 s maximum, terminated Worker, no DOM/network/storage binding |
| WASI Preview 1 (`browser_wasi_shim` 0.4.2) | ready when Worker + WebAssembly are available | precompiled command artifacts, including Rust built elsewhere for `wasm32-wasip1` | 4 MiB artifact; 64 MiB memory check; 10 s maximum; printable-ASCII argv, env, stdout/stderr, clock/random; optional 256-file, 4 MiB virtual-workspace snapshot with revision-checked writeback; no sockets, host filesystem, Bash, or compiler |
| Pyodide Python 314.0.2 | installable, then ready after a live probe | Python standard library, bounded workspace projects, args/env, streams, JSON-compatible results | locked same-origin npm assets; fresh disposable Worker; 64 KiB source, 10 s job, 256 KiB per stream; no packages or runtime network |
| Wasmer/WASIX | unavailable; research-only live promotion gate | possible future real WASIX Bash scripts | `@wasmer/sdk` 0.10.0, Bash 1.0.18, and coreutils 1.0.25 are pinned; separated output and Worker-tree cancellation work, but exit status and bidirectional mounted-workspace semantics do not, so no Bash tool is advertised |
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

Every runtime result names its capability tier, browser execution authority,
engine, and artifact kind. JavaScript, WASI, and Pyodide emit bounded stdout and
stderr chunks while running; WebContainer emits an honestly labeled combined
stream. Those chunks are page-memory presentation signals only. Cancellation
terminates the Worker or kills the WebContainer process, and the bounded final
result remains the durable authority even if a view unmounts or its observer
throws.

Capability tier is immutable session state, not a mutable page badge. A new
session derives `web-enhanced` only when an enhanced adapter is actually
`ready`. Activating Python or Node from a `web-baseline` conversation reports
`fork-required`; that existing conversation cannot execute the new adapter.
Creating or forking after activation pins the new exact tier without rewriting
the earlier journal or receipts.

The WASI runner executes a precompiled Preview 1 command artifact. A Rust
program compiled elsewhere for `wasm32-wasip1` can run there. An explicitly
selected workspace root can be projected into a bounded in-memory preopen;
successful changes use per-file revision checks before adoption, while failed,
aborted, and timed-out commands adopt nothing. Airship does not ship `rustc`,
Cargo, a Rust source compiler, Bash, sockets, host files, or an ambient persistent
guest filesystem in that tier. The separate WASIX Bash candidate remains non-ready until its
bidirectional workspace, subprocess-output, cancellation, and browser-matrix
gates pass below.

The pinned shim is the MIT/Apache-2.0 upstream implementation documented at
<https://github.com/bjorn3/browser_wasi_shim>. Its own contract is a subset of
WASI Preview 1, so Airship claims only the syscalls exercised by the Chromium
gate. Version 0.4.2 sizes argv by JavaScript code units; the adapter therefore
rejects non-ASCII argv instead of silently corrupting UTF-8.

## Governed workspace programs

`execute_workspace_program` is the narrow composition surface for multi-step
browser work. Its input contains JavaScript plus at most sixteen exact,
identifier-addressed calls to installed workspace read tools or `text_editor`.
The whole source and call manifest are bound into one ordinary `write` approval
before the Worker starts. Code can use `await airship.call("declared-id")`, but
it cannot change arguments, call an ID twice, discover another tool, or reach
network, DOM, storage, shell, or host APIs. Returned tool data is bounded to
512 KiB, and the result records which declared calls were completed, failed, or
unused.

The Worker drains every declared call it started, including a call the program
did not `await`, before emitting its terminal result. Abort or timeout terminates
the Worker and prevents a late tool result from changing that receipt. Workspace
operations are individually bounded, but `WorkspacePort` does not yet expose a
signal-aware transaction or atomic cancellation once one short operation has
entered its adapter; the result and per-file CAS remain the honest boundary.

`text_editor` itself is a bounded batch of exact creates and replacements. It
preflights unique paths and expected revisions, rejects ambiguous replacements,
then applies per-file revision CAS. This collapses coherent edits into one tool
call without inventing an ambient shell or bypassing the profile approval
policy. The current `WorkspacePort` still lacks a multi-file transaction, so a
late external race can produce an explicitly reported partial adoption.

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
files, 512 KiB per file, and 4 MiB total. The shared workspace byte codec
decodes opaque-byte envelopes before mounting and re-encodes returned bytes, so
binary files are never executed as their base64 transport text. A snippet runs with that root as
its working directory, or `sourcePath` executes a selected workspace `.py`
file. Outputs stay isolated unless `writeBack` is true; successful file changes
then use exact per-file revision CAS. Control-plane paths are excluded. Because
`WorkspacePort` has no multi-file transaction, a cross-device race late in a
multi-file adoption can produce a reported partial write before the conflict.
Interpreter and plaintext scratch state are never written to the selected Vault.

For fuller CLI compatibility, the Wasmer SDK can run WASIX packages and mount
virtual directories. Airship now ships that integration only as an explicit,
fail-closed promotion candidate. It is not added to the session capability tier
unless command, Worker-tree cancellation, bidirectional workspace, and
subprocess-output probes all pass.

## WASIX Bash promotion candidate

The candidate locks `@wasmer/sdk` 0.10.0 and resolves exact Bash 1.0.18 through
`fromRegistry()` so its declared coreutils dependency is not discarded. It
admits only the pinned Bash and coreutils 1.0.25 metadata, atom signatures, and
content-addressed WebC digests. Its fetch guard allows the same-origin SDK
assets, one Wasmer registry POST shape, and the two exact CDN URLs; it does not
expose ambient guest fetch or a WASIX network gateway. Registry/CDN delivery is
therefore an explicit provider boundary, not the execution authority.

Each job gets a disposable outer Worker. The Worker replaces its nested Worker
constructor before loading the SDK, tracks every SDK child Worker, and
terminates the set before acknowledging cancellation. Activation runs a real
Bash marker, starts and cancels an infinite Bash loop, requires an explicit
`exit 7` with separated stdout/stderr, and checks bidirectional mounted bytes.
The capability becomes ready only if every probe passes and cancellation
observes at least one SDK child Worker. A missing acknowledgment fails closed
and the outer Worker is terminated after one second.

Workspace admission uses the shared opaque-byte codec: 256 files, 512 KiB per
file, 4 MiB total, and 512 directory entries on return. `.git`, `.airship`, `node_modules`,
and all Airship control-plane paths are excluded on both ingress and egress.
Successful explicit writeback preflights source revisions and uses per-file CAS.
It is deliberately not described as an atomic multi-file transaction; a late
race can report a partial adoption. Binary outputs round-trip through the same
reversible envelope instead of being dropped or decoded as UTF-8.
Stdout and stderr each have a 256 KiB streaming/final-result budget.

Current live Chromium evidence on 2026-07-22 is a **no-go**, not a simulated
success. A dedicated outer Worker runs pinned real Bash, separates bounded
stdout/stderr through nonce-bound control records, and proves that cancellation
terminates the SDK child-Worker tree. That control channel is not a valid exit
status oracle: both `false` and `exit 7` were observed as status 0 while the raw
SDK `Output.code` was 45. Spawning a nested Bash instead produced 45 for
`exit 7` and intermittently for success. Airship records the SDK code as
provider telemetry; it does not normalize 45 into success.

The mounted-workspace probe is independently non-conforming. With known input
and a pre-created output, the script's stdout/stderr were empty and the output
mutation was not surfaced by the SDK `Directory`, so nothing could be adopted.
Activation's explicit `exit 7` probe rejects before registration; the mounted
workspace defect is also reproduced independently by the same live diagnostic.
The public runtime remains `unavailable`. Intermittent dependency-registry
failures likewise remain provider failures, not local execution results.

The 2026-07-23 rerun also corrected every `DirectoryInit` key to the SDK's
documented absolute spelling and changed the loader from a bare Bash
`fromFile()` to dependency-aware exact `fromRegistry()`. The same status and
mounted-writeback failures reproduced. Those integration corrections remain in
the candidate, but they do not justify promotion.

The opt-in live gate is:

```text
AIRSHIP_LIVE_WASIX=1 npx playwright test e2e/browser-worker.spec.ts \
  --project=desktop-chromium --grep "pinned WASIX candidate records its live no-go"
```

Promotion requires a faithful Bash child exit, correctly separated
streamed output, byte-identical bidirectional workspace access, writeback, and
tracked child-Worker cancellation in the same run.
Nothing in this pack claims Git, a Rust compiler, Cargo, a package manager,
guest sockets, host files, process resume, or offline availability.

## BrowserPod 2.14 and CheerpX evaluation — not promoted

BrowserPod is a technically credible future shell candidate, but it is not an
Airship execution pack. The 2026-07-23 audit used the published
`browserpod@2.14.0` package and current official documentation. BrowserPod 2.0
added real browser-side Bash, Git, curl, BusyBox-style utilities, and Node;
2.9/2.10 describe preliminary Rust support. The current changelog does not
record a Python release, so Airship does not infer one from the product
roadmap. These are useful capabilities, but they do not override the pack
contract or product boundary.

Promotion is a **NO-GO** for the current release:

- `BrowserPod.boot()` requires a BrowserPod API key. The provider explicitly
  says that the secret is ultimately available to client JavaScript, identifies
  the application, and tracks usage. There is no documented public-client OAuth
  or short-lived delegated-token flow. Airship will not embed a shared metered
  key, add another long-lived credential field, or silently put that key in a
  static bundle.
- Boot is a billed control-plane operation: ten tokens are charged per start
  and again for each additional hour. Personal and Pro plans are both metered;
  commercial use requires Pro, while self-hosting requires Enterprise. This is
  a separately billed proprietary service, not a dependency Airship can add as
  a universal browser capability.
- The npm package is a 3 KiB proprietary loader, not a self-contained runtime.
  Its entry point constructs a dynamic import with `new Function()` and loads
  `https://rt.browserpod.io/2.14.0/browserpod.js`. That conflicts with Airship's
  no-`unsafe-eval`, same-origin/script-digest release policy; the runtime itself
  is neither shipped nor digest-bound by the npm artifact.
- The published 2.14 type contract exposes an empty `Process` handle, and
  `run()` resolves only after exit. It documents no `kill`, abort, signal, or
  trustworthy numeric exit-status API. The filesystem API exposes create/open
  handles but no directory walk or bounded change-set export. A terminal
  control-string wrapper would not prove child exit, hard cancellation, or a
  complete byte-safe delta, so it cannot satisfy `ExecutionAdapter`.
- BrowserPod's optional `storageKey` persists a second runtime filesystem in
  origin-scoped IndexedDB. Airship would require ephemeral mode plus an
  explicitly bounded snapshot/delta bridge; it will not treat that opaque
  provider disk as the encrypted Workspace or Vault.
- No BrowserPod key was available for a reproducible live-browser promotion
  gate. In accordance with the capability policy, documentation and package
  metadata are evidence for a candidate and its boundary, not evidence that a
  live adapter works.

The direct CheerpX path does not cure those constraints. CheerpX 1.2.8 can run
32-bit x86 Linux entirely in-browser, stream an ext2 image, return a command
status, and maintain a local overlay. It is nevertheless proprietary. Its
Community License permits CDN use for personal/FOSS/evaluation and certain
one-person-company uses; ordinary business use, redistribution/OEM, and
self-hosting require a commercial license. The documented `Linux.run()` API
also returns only when the process terminates and exposes no hard-cancel handle.
A full Debian image would add a large external disk-image boundary, and the
current BrowserPod roadmap describes CheerpX-backed Linux-class workloads as a
later milestone rather than BrowserPod 2.14's execution engine.

Reconsider this lane only when there is an acceptable redistribution/commercial
license (or an open implementation), a credentialless or user-delegated
short-lived boot flow with no second bill, a content-addressable runtime/image
delivery option compatible with Airship CSP, and a live browser gate proving
exact exit status, separated bounded output, hard cancellation, and
revision-checked bidirectional Workspace reconciliation. Official evidence:
<https://browserpod.io/docs/more/changelog>,
<https://browserpod.io/docs/reference/BrowserPod/boot>,
<https://browserpod.io/docs/understanding-browserpod/api-key>,
<https://browserpod.io/docs/more/licensing>,
<https://browserpod.io/pricing-policy/>, and
<https://cheerpx.io/docs/licensing>.

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
shell, bounds input/output/time, exports a byte-safe delta, and removes the
scratch directory. `writeBack: false` only reports the delta. `writeBack: true`
preflights every source revision and adopts at most 512 changes / 8 MiB; a
concurrent edit fails rather than being overwritten. `.git`, `.airship`, and
`node_modules` are never copied back. Package-manager networking remains visible
because the tool is classified as a network effect. Host activation and
teardown advance a monotonic lifecycle generation; terminal sessions holding
an older generation become restart-required and reacquire/remount instead of
retaining a torn-down host.

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

## Paired executor boundary

The browser packs remain browser-authority adapters. They are not widened to
pretend that a remote Linux process has the same provenance. The separate
compute-continuum planner can resolve a prepared job to a browser adapter or,
later, a separately attested executor before spawn.

The browser-only placement, isolated job-transition skeleton, and digest-linked
structural stream-validation foundation is implemented, but the skeleton is not
an authority boundary, no remote adapter is registered, and no plain record can
authorize one. Remote execution therefore remains
unavailable in capability reports. A future executor receives an
immutable selected snapshot and returns a copy-on-write delta; it never receives
the active `WorkspacePort`, Vault/root key, or provider credentials. See
[`COMPUTE_CONTINUUM.md`](COMPUTE_CONTINUUM.md).

## Capability result and future receipt

Current tool results bind the capability tier, browser authority, engine,
runtime ID, exit code, bounded output, selected workspace root, change list,
writeback request, and whether adoption actually happened. A future
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
capability truthfulness, bounded WebContainer boot, streaming, cancellation,
manifest-bound workspace composition, failed-command non-adoption, dispatch,
and unavailable packs. Chromium coverage runs JavaScript, a real Rust-produced
WASI command covering two output streams, exact exit 23, workspace
input/output/writeback, failed-command non-adoption, and hard cancellation, plus
a real Pyodide install and Python standard-library workspace jobs
under the production Trusted Types policy. WebContainer boot is
provider- and environment-dependent; it is ready only after the live activation
probe succeeds. Package failure, memory pressure, and broader browser/device
coverage remain promotion gates.

Optional pack JavaScript/WASM, the pinned WASI Worker, and language distributions have their own budgets.
They have separate blocking budgets and are never module-preloaded; the baseline
226 KiB application-JavaScript gate remains blocking.
