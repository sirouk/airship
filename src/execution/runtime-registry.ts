import type { JsonValue, ToolOutputChunk } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";

export type ExecutionRuntimeId =
  | "javascript-worker"
  | "wasi-preview1"
  | "python-pyodide"
  | "wasix"
  | "node-webcontainer"
  /** Airship's own POSIX-sh interpreter. Deliberately not named `bash`. */
  | "airship-sh";

export type ExecutionCapabilityState = "ready" | "installable" | "activating" | "failed" | "unavailable";

export type BrowserExecutionTier = "web-baseline" | "web-enhanced";

export type ExecutionOutputChunk = ToolOutputChunk;

export type ExecutionProvenance = Readonly<{
  capabilityTier: BrowserExecutionTier;
  authority: "browser";
  engine: string;
  /** A named delivery/egress provider is not the execution authority. */
  providerBoundary?: string;
  artifactKind: "source" | "shell-script" | "wasi-command" | "workspace-project";
}>;

export type ExecutionCapability = Readonly<{
  id: ExecutionRuntimeId;
  label: string;
  languages: readonly string[];
  state: ExecutionCapabilityState;
  tier: BrowserExecutionTier;
  /**
   * `in-page-interpreter` is a real, narrower isolation claim than a Worker:
   * the engine interprets the script on the page's own task queue. It is named
   * rather than borrowed from the Worker tiers because the boundary differs.
   */
  isolation: "disposable-worker" | "dedicated-worker" | "webcontainer" | "in-page-interpreter";
  persistence: "ephemeral" | "workspace-checkpoint";
  commandInterface:
    | "javascript-function"
    | "precompiled-wasi-command"
    | "python-job"
    | "bash-script"
    | "posix-sh-script"
    | "direct-process"
    | "unavailable";
  /** `airship-sh` is a POSIX-sh-compatible interpreter, never GNU Bash. */
  shell: "none" | "airship-sh" | "wasix-bash" | "webcontainer-jsh" | "unavailable";
  workspaceAccess: "none" | "bounded-snapshot-writeback" | "unavailable";
  output: "bounded-stream" | "unavailable";
  /**
   * `abort-interpreter` stops work by owning every interpreter step rather
   * than by killing a thread; it is distinguished from `terminate-worker` so a
   * reader is never told a thread was killed when none exists.
   */
  cancellation: "terminate-worker" | "terminate-worker-tree" | "kill-process" | "abort-interpreter" | "unavailable";
  detail: string;
}>;

export type ExecutionRequest = Readonly<{
  runtime: ExecutionRuntimeId;
  code?: string;
  wasmBase64?: string;
  /**
   * Workspace artifact channel. A model cannot emit megabytes of base64, so a
   * precompiled command is normally referenced by the workspace path that a
   * clone, download, or WebContainer writeback already placed there.
   */
  wasmPath?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  command?: string;
  sourcePath?: string;
  workspaceRoot?: string;
  workspace?: WorkspacePort;
  writeBack?: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Ephemeral live output. Durable tool results still contain the bounded final streams. */
  onOutput?: (chunk: ExecutionOutputChunk) => void;
}>;

export type ExecutionResult = Readonly<{
  runtime: ExecutionRuntimeId;
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: JsonValue;
  /**
   * Observed runtime cold start. It is reported separately because it is not
   * charged against the job's own `timeoutMs` budget.
   */
  bootMs?: number;
  provenance: ExecutionProvenance;
  workspace?: Readonly<{
    root: string;
    mountedFiles: number;
    changedPaths: readonly string[];
    writtenPaths: readonly string[];
    deletedPaths?: readonly string[];
    writeBackRequested: boolean;
    adopted: boolean;
    /** @deprecated Prefer writeBackRequested and adopted. */
    writeBack: boolean;
    /**
     * The command itself finished, but its generated files could not be
     * collected within the mount budget. No change list can be trusted and
     * nothing is adopted; the run is reported as an error rather than a
     * success whose artifacts silently vanished.
     */
    workspaceError?: string;
    /**
     * Paths the job produced that the egress guard refused to report or adopt
     * (control-plane, `.git`, `.airship`, `node_modules`). The run keeps its
     * exit code and streams — a refused write must not destroy a completed
     * run — but the refusal is named so nothing vanishes silently.
     */
    refusedPaths?: readonly string[];
    /** Bounded reason set for `refusedPaths`, sized like `workspaceError`. */
    refusalReason?: string;
  }>;
}>;

export interface ExecutionAdapter {
  readonly capability: ExecutionCapability;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

const OPTIONAL_CAPABILITIES: readonly ExecutionCapability[] = Object.freeze([
  {
    id: "python-pyodide",
    label: "Python · Pyodide",
    languages: ["python"],
    state: "installable",
    tier: "web-enhanced",
    isolation: "disposable-worker",
    persistence: "ephemeral",
    commandInterface: "python-job",
    shell: "none",
    workspaceAccess: "bounded-snapshot-writeback",
    output: "bounded-stream",
    cancellation: "terminate-worker",
    detail: "Optional pinned Pyodide pack; explicit cold install, fresh interpreter per job, bounded virtual workspace snapshots with optional revision-checked text writeback, standard library only, and no runtime network binding.",
  },
  {
    id: "wasix",
    label: "Bash · Wasmer WASIX",
    languages: ["bash", "shell"],
    state: "unavailable",
    tier: "web-enhanced",
    isolation: "dedicated-worker",
    persistence: "ephemeral",
    commandInterface: "unavailable",
    shell: "unavailable",
    workspaceAccess: "unavailable",
    output: "unavailable",
    cancellation: "unavailable",
    detail: "Not promoted: the pinned @wasmer/sdk 0.10.0 browser probe separated output and proved Worker-tree cancellation, but did not preserve nonzero Bash status or bidirectional mounted-workspace mutations. Use Node WebContainer for Node/npm projects or Pyodide for Python. Full browser Bash, Git inside WASIX, and a Rust compiler remain unavailable.",
  },
  {
    id: "node-webcontainer",
    label: "Node.js · WebContainer",
    languages: ["javascript", "typescript", "node", "npm"],
    state: "installable",
    tier: "web-enhanced",
    isolation: "webcontainer",
    persistence: "workspace-checkpoint",
    commandInterface: "direct-process",
    shell: "webcontainer-jsh",
    workspaceAccess: "bounded-snapshot-writeback",
    output: "bounded-stream",
    cancellation: "kill-process",
    detail: "Cold-loaded StackBlitz WebContainer pack; browser compute is local, while runtime delivery and npm egress use third-party services. Requires explicit activation, cross-origin isolation, SharedArrayBuffer, compatible hosting, and production licensing where applicable.",
  },
]);

/** Labels for cold or future packs never promote a session capability tier. */
export function deriveBrowserExecutionTier(
  capabilities: readonly Pick<ExecutionCapability, "state" | "tier">[],
): BrowserExecutionTier {
  return capabilities.some(({ state, tier }) => state === "ready" && tier === "web-enhanced")
    ? "web-enhanced"
    : "web-baseline";
}

/** A presentation observer can never poison, delay, or change execution. */
export function emitExecutionOutput(
  observer: ExecutionRequest["onOutput"],
  chunk: ExecutionOutputChunk,
): void {
  try {
    observer?.(Object.freeze({ ...chunk }));
  } catch {
    // Output projection is deliberately non-authoritative. The bounded final
    // ExecutionResult remains the source of truth even when a view unmounts.
  }
}

/**
 * Small capability broker shared by the agent tools and future runtime packs.
 * Optional packs register adapters after an explicit lazy import; the stable
 * tool contract and capability receipt do not change when a pack is installed.
 */
export class ClientExecutionRuntime {
  private readonly adapters = new Map<ExecutionRuntimeId, ExecutionAdapter>();
  private readonly optionalStates = new Map<ExecutionRuntimeId, ExecutionCapability>();

  constructor(private readonly optional = OPTIONAL_CAPABILITIES) {}

  register(adapter: ExecutionAdapter): void {
    if (this.adapters.has(adapter.capability.id)) throw new Error(`Execution runtime already registered: ${adapter.capability.id}`);
    if (adapter.capability.state !== "ready") throw new Error("A registered execution adapter must report ready.");
    this.adapters.set(adapter.capability.id, adapter);
    this.optionalStates.delete(adapter.capability.id);
  }

  unregister(id: ExecutionRuntimeId): void {
    this.adapters.delete(id);
  }

  setOptionalState(id: ExecutionRuntimeId, state: ExecutionCapabilityState, detail: string): void {
    if (this.adapters.has(id)) throw new Error(`Cannot replace a ready execution runtime state: ${id}`);
    const capability = this.optional.find((candidate) => candidate.id === id);
    if (!capability) throw new Error(`Unknown optional execution runtime: ${id}`);
    if (state === "ready") throw new Error("A ready execution runtime requires a registered adapter.");
    this.optionalStates.set(id, { ...capability, state, detail });
  }

  clearOptionalState(id: ExecutionRuntimeId): void {
    this.optionalStates.delete(id);
  }

  capabilities(): ExecutionCapability[] {
    const result = [...this.adapters.values()].map(({ capability }) => structuredClone(capability));
    for (const capability of this.optional) {
      if (!this.adapters.has(capability.id)) {
        result.push(structuredClone(this.optionalStates.get(capability.id) ?? this.resolveOptionalState(capability)));
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    const adapter = this.adapters.get(request.runtime);
    if (!adapter) {
      const capability = this.capabilities().find(({ id }) => id === request.runtime);
      if (capability?.state === "installable") {
        throw new Error(`${capability.label} is an optional execution pack and has not been activated.`);
      }
      if (capability?.state === "activating") throw new Error(`${capability.label} is still activating.`);
      if (capability?.state === "failed") throw new Error(`${capability.label} activation failed. ${capability.detail}`);
      throw new Error(`${capability?.label ?? request.runtime} is unavailable on this device.`);
    }
    const result = await adapter.execute(request);
    if (result.runtime !== request.runtime) throw new Error("Execution adapter returned a mismatched runtime identity.");
    if (result.provenance.capabilityTier !== adapter.capability.tier || result.provenance.authority !== "browser") {
      throw new Error("Execution adapter returned provenance that does not match its registered capability tier.");
    }
    return result;
  }

  private resolveOptionalState(capability: ExecutionCapability): ExecutionCapability {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
      return { ...capability, state: "unavailable", detail: `${capability.detail} This browser has no Worker/WebAssembly runtime.` };
    }
    if (capability.id === "node-webcontainer" || capability.id === "wasix") {
      if (typeof document === "undefined") {
        return { ...capability, state: "unavailable", detail: `${capability.detail} This environment has no browser document.` };
      }
      if (globalThis.isSecureContext === false) {
        return { ...capability, state: "unavailable", detail: `${capability.detail} HTTPS or a loopback secure context is required.` };
      }
      if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
        return { ...capability, state: "unavailable", detail: `${capability.detail} This page is not cross-origin isolated.` };
      }
    }
    return { ...capability };
  }
}
