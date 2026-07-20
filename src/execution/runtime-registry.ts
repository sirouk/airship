import type { JsonValue } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";

export type ExecutionRuntimeId =
  | "javascript-worker"
  | "wasi-preview1"
  | "python-pyodide"
  | "wasix"
  | "node-webcontainer";

export type ExecutionCapabilityState = "ready" | "installable" | "activating" | "failed" | "unavailable";

export type ExecutionCapability = Readonly<{
  id: ExecutionRuntimeId;
  label: string;
  languages: readonly string[];
  state: ExecutionCapabilityState;
  isolation: "disposable-worker" | "dedicated-worker" | "webcontainer";
  persistence: "ephemeral" | "workspace-checkpoint";
  detail: string;
}>;

export type ExecutionRequest = Readonly<{
  runtime: ExecutionRuntimeId;
  code?: string;
  wasmBase64?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  command?: string;
  sourcePath?: string;
  workspaceRoot?: string;
  workspace?: WorkspacePort;
  writeBack?: boolean;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export type ExecutionResult = Readonly<{
  runtime: ExecutionRuntimeId;
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: JsonValue;
  workspace?: Readonly<{
    root: string;
    mountedFiles: number;
    changedPaths: readonly string[];
    writtenPaths: readonly string[];
    deletedPaths?: readonly string[];
    writeBack: boolean;
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
    isolation: "disposable-worker",
    persistence: "ephemeral",
    detail: "Optional pinned Pyodide pack; explicit cold install, fresh interpreter per job, bounded virtual workspace snapshots with optional revision-checked text writeback, standard library only, and no runtime network binding.",
  },
  {
    id: "wasix",
    label: "WASIX toolchains",
    languages: ["python", "ruby", "php", "bash", "compiled-wasm"],
    state: "unavailable",
    isolation: "dedicated-worker",
    persistence: "workspace-checkpoint",
    detail: "Real WASIX Bash is documented upstream but is not bundled or installable here. Airship still needs pinned SDK/package artifacts, licenses, registry-origin policy, and a live browser probe; Git and Node are not assumed.",
  },
  {
    id: "node-webcontainer",
    label: "Node.js · WebContainer",
    languages: ["javascript", "typescript", "node", "npm"],
    state: "installable",
    isolation: "webcontainer",
    persistence: "workspace-checkpoint",
    detail: "Cold-loaded StackBlitz WebContainer pack; browser compute is local, while runtime delivery and npm egress use third-party services. Requires explicit activation, cross-origin isolation, SharedArrayBuffer, compatible hosting, and production licensing where applicable.",
  },
]);

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
    return result;
  }

  private resolveOptionalState(capability: ExecutionCapability): ExecutionCapability {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
      return { ...capability, state: "unavailable", detail: `${capability.detail} This browser has no Worker/WebAssembly runtime.` };
    }
    if (capability.id === "node-webcontainer") {
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
