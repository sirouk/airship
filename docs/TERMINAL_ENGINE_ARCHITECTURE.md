# Browser terminal engine architecture

Status: evidence-gated design, reviewed 2026-07-23.

Airship must distinguish four things that terminal products often blur together:

1. a terminal renderer (xterm),
2. a command interpreter (jsh or Bash),
3. language/tool runtimes (Node, Python, Git), and
4. a durable filesystem or resumable machine.

A feature is shown as ready only after the current browser has booted it and a live probe has passed. Vendor documentation is useful evidence, but is not a successful Airship probe.

## Refresh reconstruction is not process resurrection

Terminal tab metadata is versioned inside the active Workspace control plane.
Airship stores at most a 64 KiB transcript tail and 64 KiB of recent command
history per tab, plus cwd, name, thread association, and terminal state. The
whole metadata document is capped at 2 MiB. With a configured Vault these bytes
cross the same client-encryption boundary as the rest of Workspace; Ephemeral
mode retains its page-lifetime semantics.

After refresh, xterm renders the recovered transcript and Airship automatically
starts a fresh WebContainer process in the recovered cwd. A visible marker says
where the prior page-owned process ended. The prior PID, memory, open pipes,
jobs, and uncommitted process state do not survive. This gives a useful,
honest resume experience without claiming VM checkpoint restoration.

## Chosen layers

| Layer | Engine | Honest capability | Persistence after refresh |
| --- | --- | --- | --- |
| Default project shell | StackBlitz WebContainer | Node, npm-family tools, interactive `jsh`, bounded Airship workspace mount | Encrypted workspace plus bounded transcript/history/cwd survive; a fresh process auto-starts |
| Python jobs | Pyodide | CPython-compatible Python jobs with a bounded workspace snapshot | Encrypted adopted file changes survive; interpreter restarts |
| POSIX shell candidate | Wasmer WASIX | Officially documented real Bash, core utilities, Web Streams PTY, and mounted directories | Mounted files can be checkpointed; no documented process restore |
| Full Linux candidate | v86 | 32-bit Linux VM, serial terminal, virtio 9p filesystem, machine save/restore | Potential machine-state restore when emulator and all image digests match |
| Licensed full Linux alternative | CheerpX | Linux binary execution, custom xterm console, browser-persistent overlay | Filesystem overlay persists; process-state restoration is not established |

No single runtime is currently entitled to claim Bash + Git + Python + Node. The product composes independently evidenced engines instead of pretending `jsh` is Bash or that a package named `git` exists.

## Why WASIX is next

Wasmer's official JS documentation demonstrates `@wasmer/sdk` with `sharrattj/bash`, stdin/stdout/stderr Web Streams, xterm, and mounted `Directory` objects. It is the smallest credible route to real Bash semantics because it does not boot an x86 guest.

It is not enabled as a ready runtime in this release. A fail-closed candidate
now implements the locked lazy pack, artifact pins, provider boundary, and live
probe; promotion still requires every remaining release and browser gate:

- lock and lazy-load `@wasmer/sdk@0.10.0`;
- pin `sharrattj/bash@1.0.18` plus its coreutils dependency to exact content-addressed WebC digests;
- record hashes, licenses, SBOM, and upstream source for every artifact;
- decide whether the Wasmer registry is install-time only or an allowed runtime origin;
- run a real-browser probe covering interactive editing, pipes, redirects, exit codes, signals, resize, UTF-8, workspace mutation, cancellation, and refresh;
- create a dedicated release chunk and cold-start/memory budgets;
- test Chrome, Edge, Firefox, Safari, iOS, and Android independently. Unsupported browsers must say so.

The current blocker is concrete and live-tested. Airship places the SDK in a
disposable Worker, intercepts and tracks its child Workers, resolves the exact
Bash package through its declared dependency graph, pins the Bash and
coreutils WebCs, guards registry/CDN fetches, separates bounded output through
nonce-bound control records, and proves real cancellation. Exit semantics are
not faithful: `false` and `exit 7` surfaced as 0 while raw SDK telemetry was 45;
a nested Bash also surfaced 45 for success in one run. Bidirectional workspace
semantics fail independently: known mounted input/output returned empty streams
and no visible output mutation. Activation explicitly probes `exit 7` and
rejects before registration; runtime inspection reports WASIX as unavailable
and no Bash tool is registered.
A 2026-07-23 retest corrected `DirectoryInit` to absolute paths and replaced
bare `fromFile()` loading with exact `fromRegistry()` dependency resolution.
The live defect remained, ruling out those two local integration mistakes as
the promotion blocker.
Wasmer registry dependency lookups were also intermittently unavailable. Exact
evidence and the opt-in command are in
`BROWSER_EXECUTION_PACKS.md`.

Git and Node remain unknown inside WASIX until separately pinned packages pass those probes. Python is vendor-documented but Airship already has a smaller Pyodide layer.

Primary sources:

- [Wasmer JS introduction](https://docs.wasmer.io/sdk/wasmer-js/)
- [Official WASIX Bash + xterm tutorial](https://docs.wasmer.io/sdk/wasmer-js/tutorials/xterm-js/)
- [Wasmer mounted filesystem API](https://docs.wasmer.io/sdk/wasmer-js/how-to/use-filesystem)
- [Wasmer cross-origin isolation requirements](https://docs.wasmer.io/sdk/wasmer-js/explainers/troubleshooting/)

## Why v86 is a power mode, not the default

v86 is BSD-2-Clause and exposes an authentic guest OS plus machine save/restore. Its 9p API can be backed by an Airship adapter, so a guest can see a segmented workspace while encrypted object storage remains the durable authority.

The cost is significant: v86 documents one CPU and no x86-64 support; a kernel/root filesystem and all userland packages must be selected, reproducibly built, licensed, hashed, and shipped; guest networking needs an explicit browser proxy boundary; machine checkpoints are large and inseparable from exact emulator/image compatibility.

The next acceptable artifact is therefore not “install v86.” It is a reproducible `airship-linux-i686` image release containing Bash, Git, Python, and a compatible Node build, accompanied by:

- emulator package/version/integrity;
- BIOS, kernel, initramfs/rootfs digests;
- source manifest, SBOM, and redistribution notices;
- compressed and warm-cache sizes;
- boot time and memory measurements by device class;
- a versioned checkpoint migration/discard policy.

Primary sources:

- [v86 repository and compatibility limits](https://github.com/copy/v86)
- [v86 virtio 9p filesystem contract](https://github.com/copy/v86/blob/master/docs/filesystem.md)

## Why CheerpX is not silently embedded

CheerpX documents x86 Linux execution, custom-console streaming suitable for xterm, and persistent IndexedDB overlays. Its community terms do not cover ordinary company production, redistribution, or self-hosting; those require a commercial license. Airship therefore records it as blocked, not installable.

Primary sources:

- [CheerpX overview](https://cheerpx.io/docs/overview)
- [CheerpX input/output and xterm integration](https://cheerpx.io/docs/guides/input-output)
- [CheerpX filesystems and persistent overlay](https://cheerpx.io/docs/guides/File-System-support)
- [CheerpX licensing](https://cheerpx.io/docs/licensing)

## Workspace and vault boundary

Language and terminal runtimes never receive Google Drive, S3, or other storage-provider credentials. They receive a bounded `WorkspacePort` view. The browser Vault adapter may hold short-lived provider authorization in memory, outside the mounted execution runtime. Runtime output is compared with the mounted base revision and adopted using revision checks. Airship control-plane paths, `.git`, and dependency caches remain excluded unless a dedicated adapter owns them.

A runtime checkpoint contains only metadata and references to already encrypted objects. Compatibility binds:

- engine ID and exact version,
- a digest over every runtime/guest artifact,
- the workspace base revision,
- checkpoint kind (`filesystem` or `machine-state`).

Mismatch fails closed. A filesystem checkpoint restores files and starts a new process. Only a provider with evidenced machine-state support may claim that a running process resumes.

OPFS or IndexedDB can be used as an encrypted local cache. The configured Google Drive or S3-compatible Vault provider remains the durable authority. Neither cache is described as a plaintext workspace or an invisible backend.

## Mobile posture

Mobile uses the same capability contract, not the same promise. Node/WebContainer, SharedArrayBuffer, memory limits, background eviction, and full VM runtimes vary substantially by browser and OS. Airship must probe the actual device, show a precise reason when an engine is unavailable, and fall back to the editor, Git adapter, workspace tools, JavaScript worker, or Pyodide instead of showing a dead terminal.
