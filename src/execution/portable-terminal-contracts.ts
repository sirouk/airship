import type { WorkspacePort } from "../workspace/contracts";

export type PortableTerminalEngineId =
  | "webcontainer-node"
  | "wasmer-wasix"
  | "v86-linux"
  | "cheerpx-linux";

export type TerminalFeatureId =
  | "bash"
  | "git"
  | "python"
  | "node"
  | "pty-stream"
  | "workspace-mount"
  | "network"
  | "filesystem-checkpoint"
  | "process-checkpoint";

export type TerminalFeatureSupport = "verified" | "documented" | "artifact-dependent" | "unsupported" | "unknown";

export type TerminalFeatureEvidence = Readonly<{
  feature: TerminalFeatureId;
  support: TerminalFeatureSupport;
  summary: string;
  source?: string;
}>;

export type RuntimeArtifactRequirement = Readonly<{
  id: string;
  version: string;
  kind: "npm-package" | "registry-package" | "guest-image" | "runtime-license";
  state: "locked" | "missing" | "license-required";
  locator: string;
  integrity?: string;
  license: string;
}>;

export type PortableTerminalCandidate = Readonly<{
  id: PortableTerminalEngineId;
  label: string;
  implementation: "active" | "candidate" | "blocked";
  executionModel: "wasm-runtime" | "x86-virtual-machine" | "x86-virtualization-service";
  processLifetime: "page" | "checkpointable" | "unknown";
  filesystemLifetime: "workspace-snapshot" | "browser-persistent-overlay" | "guest-dependent";
  browserSupport: string;
  coldStart: "small" | "medium" | "large" | "unknown";
  artifacts: readonly RuntimeArtifactRequirement[];
  evidence: readonly TerminalFeatureEvidence[];
  blocker?: string;
}>;

const WASMER_DOCS = "https://docs.wasmer.io/sdk/wasmer-js/";
const WASMER_XTERM_DOCS = "https://docs.wasmer.io/sdk/wasmer-js/tutorials/xterm-js/";
const WASMER_FS_DOCS = "https://docs.wasmer.io/sdk/wasmer-js/how-to/use-filesystem";
const V86_REPOSITORY = "https://github.com/copy/v86";
const V86_FILESYSTEM_DOCS = "https://github.com/copy/v86/blob/master/docs/filesystem.md";
const CHEERPX_DOCS = "https://cheerpx.io/docs/overview";
const CHEERPX_FILESYSTEM_DOCS = "https://cheerpx.io/docs/guides/File-System-support";
const CHEERPX_LICENSE = "https://cheerpx.io/docs/licensing";

/**
 * Product evidence, not runtime detection. "Documented" means the provider's
 * primary documentation describes the feature; it must never be rendered as
 * active until an Airship live probe upgrades it to "verified".
 */
export const PORTABLE_TERMINAL_CANDIDATES: readonly PortableTerminalCandidate[] = Object.freeze([
  {
    id: "webcontainer-node",
    label: "Node.js · WebContainer",
    implementation: "active",
    executionModel: "wasm-runtime",
    processLifetime: "page",
    filesystemLifetime: "workspace-snapshot",
    browserSupport: "Chromium-class cross-origin-isolated browser; provider compatibility probe decides at activation.",
    coldStart: "medium",
    artifacts: [{
      id: "@webcontainer/api",
      version: "1.6.4",
      kind: "npm-package",
      state: "locked",
      locator: "npm:@webcontainer/api@1.6.4",
      integrity: "package-lock.json",
      license: "provider terms apply",
    }],
    evidence: [
      { feature: "node", support: "verified", summary: "Airship has a live-tested Node/npm adapter and interactive jsh terminal." },
      { feature: "pty-stream", support: "verified", summary: "The active adapter streams terminal bytes to the route-lazy xterm surface." },
      { feature: "workspace-mount", support: "verified", summary: "A bounded workspace snapshot is mounted and revision-checked deltas may be adopted." },
      { feature: "filesystem-checkpoint", support: "verified", summary: "Workspace files persist through Airship's encrypted workspace; runtime-private files do not." },
      { feature: "bash", support: "unsupported", summary: "WebContainer jsh is not host Bash and Airship does not claim Bash semantics." },
      { feature: "git", support: "artifact-dependent", summary: "Airship's isomorphic Git adapter is separate from a POSIX git CLI." },
      { feature: "python", support: "unsupported", summary: "Python is provided by the separate Pyodide execution pack." },
      { feature: "process-checkpoint", support: "unsupported", summary: "Processes restart after a page refresh." },
      { feature: "network", support: "documented", summary: "Package egress is provider-mediated and remains subject to browser/provider policy." },
    ],
  },
  {
    id: "wasmer-wasix",
    label: "Bash · Wasmer WASIX",
    implementation: "blocked",
    executionModel: "wasm-runtime",
    processLifetime: "page",
    filesystemLifetime: "workspace-snapshot",
    browserSupport: "Modern cross-origin-isolated browsers with Worker, WebAssembly, and SharedArrayBuffer.",
    coldStart: "medium",
    artifacts: [
      {
        id: "@wasmer/sdk",
        version: "0.10.0",
        kind: "npm-package",
        state: "missing",
        locator: "npm:@wasmer/sdk@0.10.0",
        license: "MIT",
      },
      {
        id: "sharrattj/bash",
        version: "1.0.18",
        kind: "registry-package",
        state: "missing",
        locator: "wasmer:sharrattj/bash@1.0.18",
        license: "must be captured with the vendored artifact",
      },
    ],
    evidence: [
      { feature: "bash", support: "documented", summary: "Wasmer documents an interactive WASIX Bash and core-utilities terminal.", source: WASMER_XTERM_DOCS },
      { feature: "pty-stream", support: "documented", summary: "stdin, stdout, and stderr are Web Streams and are wired to xterm in the official tutorial.", source: WASMER_XTERM_DOCS },
      { feature: "workspace-mount", support: "documented", summary: "Wasmer Directory mounts allow bidirectional file access while a WASIX process runs.", source: WASMER_FS_DOCS },
      { feature: "python", support: "documented", summary: "The official SDK guide runs python/python@3.12 from the registry.", source: WASMER_DOCS },
      { feature: "git", support: "unknown", summary: "No pinned, licensed Git WASIX artifact has passed an Airship live probe." },
      { feature: "node", support: "unknown", summary: "No pinned Node WASIX artifact has passed an Airship live probe." },
      { feature: "filesystem-checkpoint", support: "artifact-dependent", summary: "Airship can checkpoint mounted workspace files, not the running WASIX process." },
      { feature: "process-checkpoint", support: "unsupported", summary: "The official SDK contract does not establish process snapshot/restore." },
      { feature: "network", support: "artifact-dependent", summary: "Registry fetching requires registry.wasmer.io; guest networking needs a separately reviewed policy." },
    ],
    blocker: "Vendor the exact SDK and Bash package with integrity and license metadata, add the registry-origin policy, then pass a real-browser Bash/PTY/workspace probe before activation is advertised.",
  },
  {
    id: "v86-linux",
    label: "Linux VM · v86",
    implementation: "blocked",
    executionModel: "x86-virtual-machine",
    processLifetime: "checkpointable",
    filesystemLifetime: "guest-dependent",
    browserSupport: "WebAssembly browsers; v86 documents one CPU and no x86-64 guest support.",
    coldStart: "large",
    artifacts: [
      { id: "v86", version: "0.5.424", kind: "npm-package", state: "missing", locator: "npm:v86@0.5.424", license: "BSD-2-Clause" },
      { id: "airship-linux-i686", version: "unselected", kind: "guest-image", state: "missing", locator: "release artifact required", license: "kernel, distribution, and package notices required" },
    ],
    evidence: [
      { feature: "bash", support: "artifact-dependent", summary: "A real Bash depends on the selected Linux guest image.", source: V86_REPOSITORY },
      { feature: "git", support: "artifact-dependent", summary: "Git depends on the selected 32-bit Linux guest image.", source: V86_REPOSITORY },
      { feature: "python", support: "artifact-dependent", summary: "Python depends on the selected 32-bit Linux guest image.", source: V86_REPOSITORY },
      { feature: "node", support: "artifact-dependent", summary: "Node depends on a compatible 32-bit guest package and is not assumed." },
      { feature: "pty-stream", support: "documented", summary: "The emulator exposes serial terminal events suitable for a terminal frontend.", source: V86_REPOSITORY },
      { feature: "workspace-mount", support: "documented", summary: "v86 supports a virtio 9p filesystem and a JavaScript request handler.", source: V86_FILESYSTEM_DOCS },
      { feature: "filesystem-checkpoint", support: "documented", summary: "9p state can be host-managed, but must be synchronized with machine save states.", source: V86_FILESYSTEM_DOCS },
      { feature: "process-checkpoint", support: "documented", summary: "v86 exposes machine save/restore; compatibility must be bound to exact emulator and image digests.", source: V86_REPOSITORY },
      { feature: "network", support: "artifact-dependent", summary: "Guest networking requires an explicit proxy/provider and cannot be treated as direct browser egress." },
    ],
    blocker: "Select and reproducibly build a redistributable i686 guest image, publish its digest/SBOM/notices, and pass cold-start, memory, mobile, PTY, networking, and save/restore probes.",
  },
  {
    id: "cheerpx-linux",
    label: "Linux · CheerpX",
    implementation: "blocked",
    executionModel: "x86-virtualization-service",
    processLifetime: "unknown",
    filesystemLifetime: "browser-persistent-overlay",
    browserSupport: "Modern browsers supported by the vendor runtime; exact production matrix requires vendor confirmation.",
    coldStart: "unknown",
    artifacts: [
      { id: "@leaningtech/cheerpx", version: "1.3.5", kind: "npm-package", state: "license-required", locator: "npm:@leaningtech/cheerpx@1.3.5", license: "CheerpX commercial license required for company production/self-hosting" },
      { id: "airship-cheerpx-linux", version: "unselected", kind: "guest-image", state: "missing", locator: "release artifact required", license: "guest notices required" },
    ],
    evidence: [
      { feature: "bash", support: "artifact-dependent", summary: "CheerpX runs Linux binaries, but Bash depends on the selected disk image.", source: CHEERPX_DOCS },
      { feature: "git", support: "artifact-dependent", summary: "Git depends on the selected disk image." },
      { feature: "python", support: "artifact-dependent", summary: "Python depends on the selected disk image." },
      { feature: "node", support: "artifact-dependent", summary: "Node depends on the selected disk image and compatibility probe." },
      { feature: "pty-stream", support: "documented", summary: "The vendor documents a custom console integration and uses xterm in WebVM.", source: "https://cheerpx.io/docs/guides/input-output" },
      { feature: "workspace-mount", support: "documented", summary: "DataDevice and browser-backed devices exchange files with the guest.", source: CHEERPX_FILESYSTEM_DOCS },
      { feature: "filesystem-checkpoint", support: "documented", summary: "IDBDevice and OverlayDevice persist a writable browser overlay.", source: CHEERPX_FILESYSTEM_DOCS },
      { feature: "process-checkpoint", support: "unknown", summary: "Airship found no primary contract for restoring a running CheerpX process after refresh." },
      { feature: "network", support: "documented", summary: "CheerpX documents networking, subject to its runtime and proxy boundary.", source: CHEERPX_DOCS },
    ],
    blocker: `Obtain production/self-hosting rights (${CHEERPX_LICENSE}), pin the runtime and guest image, then pass the same browser evidence suite as every other engine.`,
  },
]);

export type EncryptedCheckpointObject = Readonly<{
  key: string;
  etag: string;
  bytes: number;
  sha256: string;
}>;

export type TerminalCheckpoint = Readonly<{
  schema: "airship.terminal-checkpoint.v1";
  id: string;
  engine: PortableTerminalEngineId;
  engineVersion: string;
  artifactSetSha256: string;
  kind: "filesystem" | "machine-state";
  createdAt: string;
  workspaceRevision: string;
  encryptedObjects: readonly EncryptedCheckpointObject[];
}>;

export type CheckpointCompatibility = Readonly<{
  compatible: boolean;
  restores: "filesystem-only" | "machine-state" | "nothing";
  reason: string;
}>;

export function assessCheckpointCompatibility(
  checkpoint: TerminalCheckpoint,
  expected: Readonly<{
    engine: PortableTerminalEngineId;
    engineVersion: string;
    artifactSetSha256: string;
    workspaceRevision: string;
    supportsMachineState: boolean;
  }>,
): CheckpointCompatibility {
  assertCheckpoint(checkpoint);
  if (checkpoint.engine !== expected.engine) return incompatible("Checkpoint engine does not match the selected runtime.");
  if (checkpoint.engineVersion !== expected.engineVersion) return incompatible("Checkpoint runtime version changed.");
  if (checkpoint.artifactSetSha256 !== expected.artifactSetSha256) return incompatible("Checkpoint artifact set changed.");
  if (checkpoint.workspaceRevision !== expected.workspaceRevision) return incompatible("Checkpoint workspace revision is stale.");
  if (checkpoint.kind === "machine-state" && !expected.supportsMachineState) {
    return incompatible("This runtime cannot restore process state; restore the encrypted workspace and start a new process.");
  }
  return {
    compatible: true,
    restores: checkpoint.kind === "machine-state" ? "machine-state" : "filesystem-only",
    reason: checkpoint.kind === "machine-state"
      ? "Exact runtime, artifact set, and workspace revision match."
      : "Encrypted workspace state can be restored; terminal processes restart.",
  };
}

export interface PortableTerminalSession {
  readonly engine: PortableTerminalEngineId;
  readonly workspace: WorkspacePort;
  write(input: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  onOutput(listener: (chunk: Uint8Array) => void): () => void;
  checkpoint(signal: AbortSignal): Promise<TerminalCheckpoint>;
  dispose(): Promise<void>;
}

export interface PortableTerminalProvider {
  readonly candidate: PortableTerminalCandidate;
  probe(signal: AbortSignal): Promise<readonly TerminalFeatureEvidence[]>;
  boot(request: Readonly<{
    workspace: WorkspacePort;
    columns: number;
    rows: number;
    signal: AbortSignal;
    checkpoint?: TerminalCheckpoint;
  }>): Promise<PortableTerminalSession>;
}

function assertCheckpoint(checkpoint: TerminalCheckpoint): void {
  if (checkpoint.schema !== "airship.terminal-checkpoint.v1") throw new Error("Unsupported terminal checkpoint schema.");
  if (!checkpoint.id || !checkpoint.engineVersion || !checkpoint.workspaceRevision) throw new Error("Terminal checkpoint identity is incomplete.");
  if (!/^sha256:[a-f0-9]{64}$/u.test(checkpoint.artifactSetSha256)) throw new Error("Terminal checkpoint artifact digest is invalid.");
  if (!Number.isFinite(Date.parse(checkpoint.createdAt))) throw new Error("Terminal checkpoint timestamp is invalid.");
  if (checkpoint.encryptedObjects.length === 0) throw new Error("Terminal checkpoint has no encrypted objects.");
  for (const object of checkpoint.encryptedObjects) {
    if (!object.key || !object.etag || !Number.isSafeInteger(object.bytes) || object.bytes < 1) throw new Error("Terminal checkpoint object is invalid.");
    if (!/^sha256:[a-f0-9]{64}$/u.test(object.sha256)) throw new Error("Terminal checkpoint object digest is invalid.");
  }
}

function incompatible(reason: string): CheckpointCompatibility {
  return { compatible: false, restores: "nothing", reason };
}
