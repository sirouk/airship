# Browser terminal engine architecture

Status: evidence-gated design, reviewed 2026-07-19.

Airship must distinguish four things that terminal products often blur together:

1. a terminal renderer (xterm),
2. a command interpreter (jsh or Bash),
3. language/tool runtimes (Node, Python, Git), and
4. a durable filesystem or resumable machine.

A feature is shown as ready only after the current browser has booted it and a live probe has passed. Vendor documentation is useful evidence, but is not a successful Airship probe.

## Chosen layers

| Layer | Engine | Honest capability | Persistence after refresh |
| --- | --- | --- | --- |
| Default project shell | StackBlitz WebContainer | Node, npm-family tools, interactive `jsh`, bounded Airship workspace mount | Encrypted workspace files survive; processes restart |
| Python jobs | Pyodide | CPython-compatible Python jobs with a bounded workspace snapshot | Encrypted adopted file changes survive; interpreter restarts |
| POSIX shell candidate | Wasmer WASIX | Officially documented real Bash, core utilities, Web Streams PTY, and mounted directories | Mounted files can be checkpointed; no documented process restore |
| Full Linux candidate | v86 | 32-bit Linux VM, serial terminal, virtio 9p filesystem, machine save/restore | Potential machine-state restore when emulator and all image digests match |
| Licensed full Linux alternative | CheerpX | Linux binary execution, custom xterm console, browser-persistent overlay | Filesystem overlay persists; process-state restoration is not established |

No single runtime is currently entitled to claim Bash + Git + Python + Node. The product composes independently evidenced engines instead of pretending `jsh` is Bash or that a package named `git` exists.

## Why WASIX is next

Wasmer's official JS documentation demonstrates `@wasmer/sdk` with `sharrattj/bash`, stdin/stdout/stderr Web Streams, xterm, and mounted `Directory` objects. It is the smallest credible route to real Bash semantics because it does not boot an x86 guest.

It is not enabled in this release. Activation requires all of the following:

- lock and lazy-load `@wasmer/sdk@0.10.0`;
- vendor `sharrattj/bash@1.0.18` plus dependencies as immutable release artifacts;
- record hashes, licenses, SBOM, and upstream source for every artifact;
- decide whether the Wasmer registry is install-time only or an allowed runtime origin;
- run a real-browser probe covering interactive editing, pipes, redirects, exit codes, signals, resize, UTF-8, workspace mutation, cancellation, and refresh;
- create a dedicated release chunk and cold-start/memory budgets;
- test Chrome, Edge, Firefox, Safari, iOS, and Android independently. Unsupported browsers must say so.

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

The browser runtime never receives S3 credentials. It receives a bounded `WorkspacePort` view. Runtime output is compared with the mounted base revision and adopted using revision checks. Airship control-plane paths, `.git`, and dependency caches remain excluded unless a dedicated adapter owns them.

A runtime checkpoint contains only metadata and references to already encrypted objects. Compatibility binds:

- engine ID and exact version,
- a digest over every runtime/guest artifact,
- the workspace base revision,
- checkpoint kind (`filesystem` or `machine-state`).

Mismatch fails closed. A filesystem checkpoint restores files and starts a new process. Only a provider with evidenced machine-state support may claim that a running process resumes.

OPFS or IndexedDB can be used as an encrypted local cache. Encrypted S3-compatible storage remains the durable authority. Neither cache is described as a plaintext workspace or an invisible backend.

## Mobile posture

Mobile uses the same capability contract, not the same promise. Node/WebContainer, SharedArrayBuffer, memory limits, background eviction, and full VM runtimes vary substantially by browser and OS. Airship must probe the actual device, show a precise reason when an engine is unavailable, and fall back to the editor, Git adapter, workspace tools, JavaScript worker, or Pyodide instead of showing a dead terminal.

