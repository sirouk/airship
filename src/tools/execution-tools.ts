import { objectArguments, requiredString } from "./schema";
import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import {
  ClientExecutionRuntime,
  deriveBrowserExecutionTier,
  emitExecutionOutput,
  type ExecutionAdapter,
  type ExecutionCapability,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRuntimeId,
} from "../execution/runtime-registry";
import type { ToolRegistry } from "./registry";
import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, type WorkspacePort } from "../workspace/contracts";
import { sha256 } from "../core/hash";
import { createWasiPreview1Adapter } from "../execution/wasi-preview1-pack";
import { createAirshipShellAdapter } from "../execution/shell/adapter";
import { disposableWorkerIsolationPreludeSource } from "../execution/disposable-worker-isolation-source";
import { PrimeKernelHost } from "../prime/kernel/kernel-host";
import type { KernelBridgeCallRequest, KernelBridgeCallResult, KernelJobEvent } from "../prime/kernel/kernel-contract";
// One ceiling for every runtime's bounded collection diagnostic. The WASI
// contract owns the number so the Python and WASI paths cannot drift apart.
import { WASI_PREVIEW1_MAX_WORKSPACE_ERROR_CHARS as MAX_WORKSPACE_ERROR_CHARS } from "../execution/wasi-preview1-contract";

export { runDisposableWasi } from "../execution/wasi-preview1-pack";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;
/**
 * A shell script does real multi-step work, so it gets a larger ceiling than a
 * snippet. Exported because the schema the model actually reads lives in
 * `execution-tool-proxies.ts`, and the number it publishes has to be pinned to
 * the number this module enforces rather than transcribed alongside it.
 */
export const MAX_SHELL_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const MAX_EXECUTION_VALUE_BYTES = 512 * 1_024;
const MAX_PYTHON_WORKSPACE_FILES = 256;
const MAX_PYTHON_WORKSPACE_FILE_BYTES = 512 * 1_024;
const MAX_PYTHON_WORKSPACE_BYTES = 4 * 1_024 * 1_024;
const PYTHON_WORKSPACE_EXCLUDED_SEGMENTS = new Set([".airship", ".git", "node_modules"]);
const WORKER_POLICY_NAME = "airship-worker";
const PYODIDE_VERSION = "314.0.2";
/** Vite owns the canonical root/subpath deployment prefix at build time. */
const PYODIDE_DEPLOYMENT_BASE = import.meta.env.BASE_URL;
const PYODIDE_PACK_RELATIVE_PATH = "execution-packs/pyodide/";
const MAX_WORKSPACE_PROGRAM_CALLS = 16;
const MAX_WORKSPACE_PROGRAM_RESULT_BYTES = 512 * 1_024;
/**
 * The exact workspace calls a manifest-bound program may declare, and the
 * effect each one is held to. Enforced here, published as an enum by
 * `execution-tool-proxies.ts`; exported so a test can hold those two to each
 * other rather than let the advertised surface drift from the enforced one.
 */
export const WORKSPACE_PROGRAM_TOOL_EFFECTS = new Map<string, Tool["definition"]["effect"]>([
  ["list_files", "read"],
  ["read_file", "read"],
  ["stat_path", "read"],
  ["search_text", "read"],
  ["text_editor", "write"],
]);

type TrustedWorkerPolicy = Readonly<{
  createScriptURL(value: string): unknown;
}>;

type TrustedTypesFactory = Readonly<{
  createPolicy(
    name: string,
    rules: Readonly<{ createScriptURL(value: string): string }>,
  ): TrustedWorkerPolicy;
}>;

let workerPolicy: TrustedWorkerPolicy | undefined;
let clientRuntime: ClientExecutionRuntime | undefined;
let pyodideInstall: Promise<void> | undefined;
let nodePack: Promise<typeof import("../execution/node-webcontainer-pack")> | undefined;
let nodePackLifecycleBound = false;

/** Entry point used by the lightweight schemas in the baseline tool bundle. */
export async function executeExecutionTool(
  name: string,
  argumentsValue: JsonValue,
  context: ToolContext,
  workspace?: WorkspacePort,
  hostRegistry?: ToolRegistry,
): Promise<ToolExecutionResult> {
  const args = objectArguments(argumentsValue);
  switch (name) {
    case "execute_javascript": {
      const code = requiredString(args.code, "code");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      const result = await runDisposableWorker(code, timeoutMs, context.signal, context.onOutput);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: {
          timeoutMs,
          logs: result.logs.length,
          capabilityTier: "web-baseline",
          authority: "browser",
          engine: "disposable-javascript-worker",
        },
      };
    }
    case "execute_workspace_program": {
      if (!hostRegistry) throw new Error("Workspace-program execution has no bound Airship tool registry.");
      const code = requiredString(args.code, "code");
      const calls = workspaceProgramCalls(args.calls, hostRegistry);
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      const result = await runDisposableWorkspaceProgram(code, calls, hostRegistry, timeoutMs, context);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: {
          capabilityTier: "web-baseline",
          authority: "browser",
          engine: "manifest-bound-workspace-worker",
          declaredCalls: calls.length,
          completedCalls: result.calls.filter(({ status }) => status === "completed").length,
        },
        isError: result.calls.some(({ status, isError }) => status === "failed" || isError),
      };
    }
    case "install_execution_runtime": {
      const runtime = requiredString(args.runtime, "runtime");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_INSTALL_TIMEOUT_MS;
      if (runtime === "node-webcontainer") {
        return activationResultForCurrentPage(await activateNodeRuntime(context.signal, timeoutMs), context);
      }
      if (runtime !== "python-pyodide") throw new Error(`${runtime} cannot be installed by this Airship release.`);
      await installPyodideExecutionRuntime(timeoutMs, context.signal);
      const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === runtime);
      return activationResultForCurrentPage({
        content: JSON.stringify(capability, null, 2),
        metadata: {
          runtime,
          state: capability?.state ?? "unavailable",
          version: PYODIDE_VERSION,
          capabilityTier: deriveBrowserExecutionTier(getClientExecutionRuntime().capabilities()),
        },
      }, context);
    }
    case "inspect_execution_runtimes": {
      const capabilities = getClientExecutionRuntime().capabilities();
      return {
        content: JSON.stringify(capabilities, null, 2),
        metadata: {
          capabilityTier: deriveBrowserExecutionTier(capabilities),
          ready: capabilities.filter(({ state }) => state === "ready").map(({ id }) => id),
        },
      };
    }
    case "execute_code": {
      const runtime = requiredString(args.runtime, "runtime") as ExecutionRuntimeId;
      validateExecuteCodeArguments(runtime, args);
      const workspaceRoot = typeof args.workspaceRoot === "string" ? normalizeWorkspacePath(args.workspaceRoot) : undefined;
      const sourcePath = typeof args.sourcePath === "string" ? normalizeWorkspacePath(args.sourcePath) : undefined;
      const wasmPath = typeof args.wasmPath === "string" ? normalizeWorkspacePath(args.wasmPath) : undefined;
      if (sourcePath && runtime !== "python-pyodide") throw new Error("sourcePath is available only for Pyodide Python source.");
      if ((sourcePath || args.writeBack === true) && !workspaceRoot) throw new Error("sourcePath and writeBack require a workspaceRoot.");
      if (workspaceRoot && !workspace) throw new Error("Workspace-mounted execute_code has no bound Airship workspace.");
      if (wasmPath && !workspace) throw new Error("A wasmPath command artifact has no bound Airship workspace.");
      if (sourcePath && args.code !== undefined) throw new Error("Use either Python code or sourcePath, not both.");
      const request: ExecutionRequest = {
        runtime,
        ...(typeof args.code === "string" ? { code: args.code } : {}),
        ...(typeof args.wasmBase64 === "string" ? { wasmBase64: args.wasmBase64 } : {}),
        ...(wasmPath ? { wasmPath } : {}),
        args: stringArray(args.args, "args"),
        env: stringRecord(args.env, "env"),
        // A wasmPath artifact needs the workspace binding even when no
        // subtree is mounted for the command to read or write.
        ...(workspaceRoot ? { workspaceRoot, workspace } : wasmPath ? { workspace } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        writeBack: args.writeBack === true,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
        signal: context.signal,
        onOutput: context.onOutput,
      };
      const result = await getClientExecutionRuntime().execute(request);
      const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === result.runtime);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: {
          runtime: result.runtime,
          exitCode: result.exitCode,
          isolation: capability?.isolation ?? "unknown",
          persistence: capability?.persistence ?? "unknown",
          commandInterface: capability?.commandInterface ?? "unavailable",
          shell: capability?.shell ?? "unavailable",
          workspaceAccess: capability?.workspaceAccess ?? "unavailable",
          capabilityTier: result.provenance.capabilityTier,
          authority: result.provenance.authority,
          engine: result.provenance.engine,
          ...(typeof result.bootMs === "number" ? { bootMs: result.bootMs } : {}),
          ...(result.workspace?.workspaceError ? { workspaceError: result.workspace.workspaceError } : {}),
          ...(result.workspace?.refusedPaths?.length ? { refusedPaths: [...result.workspace.refusedPaths] } : {}),
        },
        // A run whose generated files could not be collected, or whose writes
        // the egress guard refused, is not a clean success even when the
        // command itself exited zero.
        isError: result.exitCode !== 0
          || Boolean(result.workspace?.workspaceError)
          || Boolean(result.workspace?.refusedPaths?.length),
      };
    }
    case "execute_shell": {
      return executeShellTool(args, context, workspace);
    }
    case "deactivate_execution_runtime": {
      return deactivateExecutionRuntime(requiredString(args.runtime, "runtime") as ExecutionRuntimeId);
    }
    case "execute_node_project": {
      if (!workspace) throw new Error("Node project execution has no workspace binding.");
      const request: ExecutionRequest = {
        runtime: "node-webcontainer",
        workspace,
        workspaceRoot: normalizeWorkspacePath(requiredString(args.workspaceRoot, "workspaceRoot")),
        command: requiredString(args.command, "command"),
        args: stringArray(args.args, "args"),
        env: stringRecord(args.env, "env"),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000,
        writeBack: args.writeBack === true,
        signal: context.signal,
        onOutput: context.onOutput,
      };
      const result = await getClientExecutionRuntime().execute(request);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: {
          runtime: result.runtime,
          exitCode: result.exitCode,
          provider: "StackBlitz WebContainers",
          capabilityTier: result.provenance.capabilityTier,
          authority: result.provenance.authority,
          engine: result.provenance.engine,
          commandInterface: "direct-process",
          shell: "none",
          workspaceAccess: "bounded-snapshot-writeback",
        },
        isError: result.exitCode !== 0,
      };
    }
    default:
      throw new Error(`Unknown execution tool: ${name}`);
  }
}

/**
 * Deactivation is not the execution runtime's business alone.
 *
 * The WebContainer instance this tears down is *shared*: Workspace Terminal
 * mounts the same instance, and everything typed into a terminal lives only in
 * that mount until it is reconciled back into the workspace. Tearing the
 * instance down first destroyed that work with no trace — the lifecycle event
 * that tells the terminal it lost its host is published after the instance is
 * already gone, far too late for anything to be saved. So the terminal holding
 * that instance is quiesced (stopped, reconciled, unmounted) *before* the
 * runtime goes away, and the reconciled paths are named in the result so the
 * deactivation is auditable rather than merely quiet.
 *
 * The quiesce is addressed by *host authority*, not by this tool's workspace
 * handle. The workspace a tool sees is the context runtime's observation facade
 * (and a `GitSynchronizedWorkspace` around it when Git is bound), never the raw
 * provider object the Terminal route keys its manager by, so a workspace-keyed
 * lookup would miss in the real app and quietly reconcile nothing. Addressing
 * the holder of the shared instance also gates the work correctly: when no
 * terminal ever mounted it, there is nothing to stop and this costs nothing.
 *
 * A reconciliation failure does not hide behind a success: quiesce has already
 * released the terminal's authority by the time it throws, so the runtime is
 * still torn down, but the result is an error naming what could not be saved.
 */
async function deactivateExecutionRuntime(runtimeId: ExecutionRuntimeId): Promise<ToolExecutionResult> {
  if (runtimeId !== "node-webcontainer") throw new Error(`${runtimeId} cannot be deactivated by this Airship release.`);
  let reconciledPaths: readonly string[] = [];
  let reconcileError: string | undefined;
  let terminalHeldRuntime = false;
  try {
    const manager = await import("../terminal/manager");
    // Asked before the quiesce, because the quiesce is what makes it false.
    terminalHeldRuntime = manager.browserTerminalHoldsSharedRuntime();
    reconciledPaths = await manager.quiesceBrowserTerminalHost(
      "The shared browser runtime is being deactivated; terminal work was reconciled first.",
    );
  } catch (error) {
    reconcileError = error instanceof Error ? error.message : String(error);
  }
  // `nodePack` records only whether *this* module ever ran a job; the Terminal
  // route boots the very same instance through its own dynamic import. Gating
  // the teardown on it alone meant a deactivation requested while only a
  // terminal held the container stopped and reconciled that terminal, tore
  // nothing down, and still reported the runtime released — the destructive
  // half of the operation without the half that was asked for.
  if (nodePack || terminalHeldRuntime) {
    nodePack ??= import("../execution/node-webcontainer-pack");
    await (await nodePack).deactivateNodeWebContainer();
  }
  getClientExecutionRuntime().unregister(runtimeId);
  getClientExecutionRuntime().clearOptionalState(runtimeId);
  return {
    content: JSON.stringify(
      {
        capability: getClientExecutionRuntime().capabilities().find(({ id }) => id === runtimeId) ?? null,
        reconciledTerminalPaths: [...reconciledPaths],
        ...(reconcileError ? { terminalReconcileError: reconcileError } : {}),
      },
      null,
      2,
    ),
    metadata: {
      runtime: runtimeId,
      reconciledTerminalPaths: [...reconciledPaths],
      ...(reconcileError ? { terminalReconcileError: reconcileError } : {}),
    },
    ...(reconcileError ? { isError: true } : {}),
  };
}

/** Optional same-origin packs call this only after their pinned assets load. */
export function installExecutionAdapter(adapter: ExecutionAdapter): void {
  getClientExecutionRuntime().register(adapter);
}

async function executeShellTool(
  args: Record<string, JsonValue>,
  context: ToolContext,
  workspace?: WorkspacePort,
): Promise<ToolExecutionResult> {
  const script = requiredString(args.script, "script");
  const workspaceRoot = typeof args.workspaceRoot === "string" ? normalizeWorkspacePath(args.workspaceRoot) : undefined;
  if (args.writeBack === true && !workspaceRoot) throw new Error("execute_shell writeBack requires a workspaceRoot.");
  if (workspaceRoot && !workspace) throw new Error("Workspace-mounted execute_shell has no bound Airship workspace.");
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_SHELL_TIMEOUT_MS;
  if (timeoutMs > MAX_SHELL_TIMEOUT_MS) throw new Error(`execute_shell timeoutMs cannot exceed ${MAX_SHELL_TIMEOUT_MS}.`);
  const request: ExecutionRequest = {
    runtime: "airship-sh",
    code: script,
    args: stringArray(args.args, "args"),
    env: stringRecord(args.env, "env"),
    ...(workspaceRoot ? { workspaceRoot, workspace } : {}),
    writeBack: args.writeBack === true,
    timeoutMs,
    signal: context.signal,
    onOutput: context.onOutput,
  };
  const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === "airship-sh");
  const result = await getClientExecutionRuntime().execute(request);
  return {
    content: JSON.stringify(result, null, 2),
    metadata: {
      runtime: result.runtime,
      exitCode: result.exitCode,
      isolation: capability?.isolation ?? "unknown",
      persistence: capability?.persistence ?? "unknown",
      commandInterface: capability?.commandInterface ?? "unavailable",
      shell: capability?.shell ?? "unavailable",
      workspaceAccess: capability?.workspaceAccess ?? "unavailable",
      capabilityTier: result.provenance.capabilityTier,
      authority: result.provenance.authority,
      engine: result.provenance.engine,
      ...(result.workspace?.refusedPaths?.length ? { refusedPaths: [...result.workspace.refusedPaths] } : {}),
    },
    // A refused write is not a clean success, even when the script exited zero.
    isError: result.exitCode !== 0 || Boolean(result.workspace?.refusedPaths?.length),
  };
}

async function activateNodeRuntime(signal: AbortSignal, timeoutMs: number): Promise<ToolExecutionResult> {
  const runtimeId: ExecutionRuntimeId = "node-webcontainer";
  const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === runtimeId);
  if (!capability) throw new Error(`Unknown optional runtime: ${runtimeId}`);
  if (capability.state === "ready") {
    const evidence = nodePack ? (await nodePack).getNodeWebContainerActivationEvidence() : undefined;
    return {
      content: JSON.stringify(capability, null, 2),
      metadata: {
        runtime: runtimeId,
        state: "ready",
        alreadyReady: true,
        ...(evidence ?? {}),
      },
    };
  }
  if (capability.state === "unavailable") throw new Error(capability.detail);
  getClientExecutionRuntime().setOptionalState(runtimeId, "activating", "Loading StackBlitz WebContainers.");
  try {
    const startedAt = Date.now();
    nodePack ??= import("../execution/node-webcontainer-pack");
    const pack = await awaitActivationPhase(nodePack, timeoutMs, signal, "Node runtime pack load");
    bindNodePackLifecycle(pack);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs < 1) throw new Error(`Node runtime activation exceeded ${timeoutMs} ms while loading its pack.`);
    const adapter = await pack.activateNodeWebContainer(signal, remainingMs);
    if (!getClientExecutionRuntime().capabilities().some(({ id, state }) => id === runtimeId && state === "ready")) {
      getClientExecutionRuntime().register(adapter);
    }
    return {
      content: JSON.stringify(adapter.capability, null, 2),
      metadata: {
        runtime: runtimeId,
        provider: "StackBlitz WebContainers",
        browserCompute: true,
        remoteRuntimeDelivery: true,
        alreadyReady: false,
        ...(pack.getNodeWebContainerActivationEvidence() ?? {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown WebContainer activation failure.";
    if (!getClientExecutionRuntime().capabilities().some(({ id, state }) => id === runtimeId && state === "ready")) {
      getClientExecutionRuntime().setOptionalState(runtimeId, "failed", message);
    }
    throw error;
  }
}

function bindNodePackLifecycle(pack: typeof import("../execution/node-webcontainer-pack")): void {
  if (nodePackLifecycleBound) return;
  nodePackLifecycleBound = true;
  pack.subscribeNodeWebContainerLifecycle((event) => {
    if (event.state !== "inactive") return;
    const runtime = getClientExecutionRuntime();
    runtime.unregister("node-webcontainer");
    runtime.setOptionalState(
      "node-webcontainer",
      "failed",
      "The WebContainer host stopped or could not prove process termination. Activate Node again before executing.",
    );
  });
}

export function getClientExecutionRuntime(): ClientExecutionRuntime {
  if (clientRuntime) return clientRuntime;
  clientRuntime = new ClientExecutionRuntime();
  // airship-sh is the universal tier: a TypeScript interpreter needs no Worker,
  // no WebAssembly, and no cross-origin isolation, so it registers before the
  // Worker-dependent adapters and remains available where they are not.
  clientRuntime.register(createAirshipShellAdapter());
  if (supportsDisposableWorkers()) {
    clientRuntime.register({
      capability: {
        id: "javascript-worker",
        label: "JavaScript · disposable Worker",
        languages: ["javascript"],
        state: "ready",
        tier: "web-baseline",
        isolation: "disposable-worker",
        persistence: "ephemeral",
        commandInterface: "javascript-function",
        shell: "none",
        workspaceAccess: "none",
        output: "bounded-stream",
        cancellation: "terminate-worker",
        detail: "Bounded evaluation with no DOM, storage, workspace, or network binding.",
      },
      async execute(request) {
        if (!request.code) throw new Error("JavaScript execution requires code.");
        const result = await runDisposableWorker(request.code, request.timeoutMs, request.signal, request.onOutput);
        return {
          runtime: "javascript-worker",
          exitCode: 0,
          stdout: result.logs.join("\n"),
          stderr: result.errors.join("\n"),
          value: result.value,
          provenance: {
            capabilityTier: "web-baseline",
            authority: "browser",
            engine: "disposable-javascript-worker",
            artifactKind: "source",
          },
        };
      },
    });
    if (typeof WebAssembly !== "undefined") clientRuntime.register(createWasiPreview1Adapter());
  }
  return clientRuntime;
}

/** Exact page-lifetime tier used when a new session pins its runtime manifest. */
export function getCurrentBrowserExecutionTier() {
  return deriveBrowserExecutionTier(getClientExecutionRuntime().capabilities());
}

/** Exact page-lifetime capability records for non-agent presentation surfaces. */
export function inspectCurrentBrowserExecutionCapabilities(): readonly ExecutionCapability[] {
  return Object.freeze(getClientExecutionRuntime().capabilities());
}

/**
 * Install is deliberately explicit and fail-closed. A label becomes `ready`
 * only after the exact pinned distribution has initialized and executed a
 * probe in the same disposable-worker path used by real jobs.
 */
export async function installPyodideExecutionRuntime(
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const runtime = getClientExecutionRuntime();
  if (runtime.capabilities().some(({ id, state }) => id === "python-pyodide" && state === "ready")) return;
  if (!supportsDisposableWorkers() || typeof WebAssembly === "undefined") {
    throw new Error("Pyodide requires browser Workers and WebAssembly.");
  }
  runtime.setOptionalState(
    "python-pyodide",
    "activating",
    `Loading the pinned Pyodide ${PYODIDE_VERSION} same-origin pack and running its interpreter probe.`,
  );
  pyodideInstall ??= (async () => {
    // This tool does nothing but cold-start an interpreter, so the caller's
    // timeoutMs has to bound the boot as well as the one-line probe that
    // follows it. The boot timer names boot as the culprit; the deadline
    // signal is what makes timeoutMs a ceiling on the whole activation rather
    // than on each phase separately.
    const deadline = activationDeadline(timeoutMs, signal, `Pyodide ${PYODIDE_VERSION} activation exceeded ${timeoutMs} ms.`);
    let probe: PyodideWorkerResult;
    try {
      probe = await runDisposablePyodide(
        "import sys\nprint(f'{sys.version_info.major}.{sys.version_info.minor}')",
        [],
        {},
        timeoutMs,
        deadline.signal,
        { bootTimeoutMs: timeoutMs },
      );
    } finally {
      deadline.release();
    }
    if (probe.exitCode !== 0 || !/^3\.\d+/u.test(probe.stdout.trim())) {
      throw new Error(`Pyodide ${PYODIDE_VERSION} did not pass its interpreter probe.`);
    }
    runtime.register({
      capability: {
        id: "python-pyodide",
        label: `Python · Pyodide ${PYODIDE_VERSION}`,
        languages: ["python"],
        state: "ready",
        tier: "web-enhanced",
        isolation: "disposable-worker",
        persistence: "ephemeral",
        commandInterface: "python-job",
        shell: "none",
        workspaceAccess: "bounded-snapshot-writeback",
        output: "bounded-stream",
        cancellation: "terminate-worker",
        detail: "Fresh in-browser CPython interpreter per job with a bounded virtual workspace snapshot and optional revision-checked text writeback; standard library only, bounded output, hard termination, and no DOM, storage, sockets, package installation, or runtime network binding.",
      },
      async execute(request) {
        if (!request.code && !request.sourcePath) throw new Error("Python execution requires code or sourcePath.");
        return executePythonRequest(request);
      },
    });
  })();
  try {
    await pyodideInstall;
  } catch (error) {
    pyodideInstall = undefined;
    runtime.setOptionalState(
      "python-pyodide",
      "failed",
      error instanceof Error ? error.message : `Pyodide ${PYODIDE_VERSION} activation failed.`,
    );
    throw error;
  }
}

/**
 * A caller signal plus a wall-clock ceiling, as one signal.
 *
 * AbortSignal.any is not assumed here because the worker path must keep
 * working in the same environments the rest of this module supports; the timer
 * and the listener are both released by `release()` so a fast activation
 * leaves nothing armed.
 */
function activationDeadline(
  timeoutMs: number,
  signal: AbortSignal,
  message: string,
): Readonly<{ signal: AbortSignal; release: () => void }> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    },
  });
}

type WorkspaceProgramCall = Readonly<{
  id: string;
  tool: string;
  arguments: JsonValue;
}>;

type WorkspaceProgramCallTrace = Readonly<{
  id: string;
  tool: string;
  status: "unused" | "completed" | "failed";
  isError?: boolean;
  metadata?: JsonValue;
}>;

function workspaceProgramCalls(value: JsonValue | undefined, registry: ToolRegistry): readonly WorkspaceProgramCall[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_PROGRAM_CALLS) {
    throw new Error(`calls must be an array of at most ${MAX_WORKSPACE_PROGRAM_CALLS} predeclared operations.`);
  }
  const calls: WorkspaceProgramCall[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const record = objectArguments(raw);
    const id = requiredString(record.id, `calls[${index}].id`);
    const toolName = requiredString(record.tool, `calls[${index}].tool`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id) || ids.has(id)) throw new Error(`calls[${index}].id must be unique and identifier-safe.`);
    const expectedEffect = WORKSPACE_PROGRAM_TOOL_EFFECTS.get(toolName);
    if (!expectedEffect) throw new Error(`Workspace programs cannot invoke ${toolName}.`);
    const tool = registry.get(toolName);
    if (!tool || tool.definition.effect !== expectedEffect) {
      throw new Error(`Workspace program tool is not installed with its exact ${expectedEffect} capability: ${toolName}`);
    }
    const callArguments = objectArguments(record.arguments) as JsonValue;
    registry.validateArguments(toolName, callArguments);
    ids.add(id);
    calls.push(Object.freeze({ id, tool: toolName, arguments: structuredClone(callArguments) }));
  }
  return Object.freeze(calls);
}

function workspaceProgramJobSource(code: string): string {
  return disposableJavascriptJobSource(`
const __airshipParse = JSON.parse.bind(JSON);
const __airshipBridgeCall = Object.freeze(pat.call.bind(pat));
const __airshipCall = Object.freeze(async (id) => {
  if (typeof id !== "string" || !id) throw new TypeError("airship.call requires a declared call id.");
  const reply = await __airshipBridgeCall("__airship_workspace_call", { id });
  return __airshipParse(reply.content);
});
const __airshipCapability = Object.freeze({ call: __airshipCall });
const __airshipProgramValue = await (async (airship) => {
${code}
})(__airshipCapability);
await __airshipBridgeCall("__airship_workspace_finalize", {});
return __airshipProgramValue;
`);
}

async function runDisposableWorkspaceProgram(
  code: string,
  calls: readonly WorkspaceProgramCall[],
  registry: ToolRegistry,
  timeoutMs: number,
  context: ToolContext,
): Promise<Readonly<{ value: JsonValue; stdout: string; stderr: string; calls: readonly WorkspaceProgramCallTrace[] }>> {
  if (typeof Worker === "undefined") {
    throw new Error("Disposable workspace-program workers are unavailable in this environment.");
  }
  if (!code.trim() || code.length > MAX_CODE_CHARS) {
    throw new Error("Workspace-program source must be between 1 and 64 KiB.");
  }
  if (context.signal.aborted) {
    throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const source = workspaceProgramJobSource(code);
  const declared = new Map(calls.map((call) => [call.id, call]));
  const used = new Set<string>();
  const traces = new Map<string, WorkspaceProgramCallTrace>();
  const pending = new Set<Promise<Readonly<{ content: string }>>>();
  const toolAbort = new AbortController();
  let returnedBytes = 0;
  let jobSucceeded = false;

  const executeDeclared = (id: string): Promise<Readonly<{ content: string }>> => {
    const call = declared.get(id);
    if (!call || used.has(id)) {
      return Promise.reject(new Error("Tool call was not uniquely predeclared in the approved manifest."));
    }
    used.add(id);
    const tool = registry.get(call.tool)!;
    const task = (async () => {
      try {
        const result = await tool.execute(structuredClone(call.arguments), {
          ...context,
          signal: toolAbort.signal,
          operationId: `declared:${await sha256(`${context.operationId}:${id}`)}`,
        });
        const bytes = new TextEncoder().encode(result.content).byteLength;
        returnedBytes += bytes;
        if (returnedBytes > MAX_WORKSPACE_PROGRAM_RESULT_BYTES) {
          throw new Error("Declared workspace-tool results exceeded the 512 KiB program budget.");
        }
        traces.set(id, Object.freeze({
          id,
          tool: call.tool,
          status: "completed" as const,
          isError: result.isError ?? false,
          ...(result.metadata !== undefined ? { metadata: structuredClone(result.metadata) } : {}),
        }));
        return Object.freeze({
          content: JSON.stringify({
            content: result.content,
            metadata: result.metadata ?? null,
            isError: result.isError ?? false,
          }),
        });
      } catch (error) {
        traces.set(id, Object.freeze({ id, tool: call.tool, status: "failed" as const }));
        throw error;
      }
    })();
    return task;
  };

  const host = new PrimeKernelHost({
    budgets: {
      maxSourceChars: source.length,
      maxJobWallMs: timeoutMs,
      maxStreamChars: MAX_OUTPUT_CHARS,
      maxValueBytes: MAX_EXECUTION_VALUE_BYTES,
      maxBridgeCallsPerJob: MAX_WORKSPACE_PROGRAM_CALLS + 1,
      maxBridgePayloadBytes: MAX_WORKSPACE_PROGRAM_RESULT_BYTES + 8_192,
      maxQueuedJobs: 1,
    },
    ports: {
      bridge: {
        async call(request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> {
          if (request.tool === "__airship_workspace_finalize") {
            const active = [...pending];
            const outcomes = await Promise.allSettled(active);
            pending.clear();
            const failed = outcomes.find((outcome) => outcome.status === "rejected");
            if (failed?.status === "rejected") {
              const summary = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
              return { seq: request.seq, ok: false, error: summary.slice(0, 2_048) || "Declared tool call failed." };
            }
            return { seq: request.seq, ok: true, content: "{}" };
          }
          if (
            request.tool !== "__airship_workspace_call"
            || !request.arguments
            || typeof request.arguments !== "object"
            || Array.isArray(request.arguments)
          ) {
            return { seq: request.seq, ok: false, error: "Only manifest-bound workspace calls are available." };
          }
          const id = typeof request.arguments.id === "string" ? request.arguments.id : "";
          const task = executeDeclared(id);
          pending.add(task);
          try {
            const result = await task;
            return { seq: request.seq, ok: true, content: result.content };
          } catch (error) {
            const summary = error instanceof Error ? error.message : String(error);
            return { seq: request.seq, ok: false, error: summary.slice(0, 2_048) || "Declared tool call failed." };
          }
        },
      },
    },
  });

  let completed = false;
  const onAbort = () => {
    if (!toolAbort.signal.aborted) toolAbort.abort(context.signal.reason);
    if (!completed) void host.terminate("Workspace program was aborted by its caller.");
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await host.exec(
      { code: source, timeoutMs, jobId: "airship-workspace-program", label: "execute_workspace_program" },
      (event: KernelJobEvent) => {
        if (event.type === "stdout") {
          emitExecutionOutput(context.onOutput, { stream: "stdout", text: `${event.text}\n` });
        } else if (event.type === "stderr") {
          emitExecutionOutput(context.onOutput, { stream: "stderr", text: `${event.text}\n` });
        }
      },
    );
    completed = true;
    if (context.signal.aborted) {
      throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (result.outcome !== "completed") {
      if (result.error?.includes("exceeded its wall-clock budget")) {
        throw new Error(`Workspace program exceeded ${timeoutMs} ms.`);
      }
      throw new Error(result.error ?? "Workspace program execution failed.");
    }
    jobSucceeded = true;
    return Object.freeze({
      value: parseWorkerJsonValue(result.valueJson),
      stdout: result.stdout ? `${result.stdout}\n` : "",
      stderr: result.stderr ? `${result.stderr}\n` : "",
      calls: Object.freeze(calls.map((call) => traces.get(call.id) ?? Object.freeze({
        id: call.id,
        tool: call.tool,
        status: "unused" as const,
      }))),
    });
  } catch (error) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    throw error;
  } finally {
    completed = true;
    context.signal.removeEventListener("abort", onAbort);
    if (!jobSucceeded && !toolAbort.signal.aborted) {
      toolAbort.abort(new DOMException("Workspace program ended before its declared calls drained.", "AbortError"));
    }
    if (pending.size > 0) {
      await Promise.allSettled([...pending]);
      pending.clear();
    }
    await host.terminate("Workspace program job complete.");
  }
}

function disposableJavascriptJobSource(code: string): string {
  return `
const __airshipRender = (value) => {
  try { return typeof value === "string" ? value : JSON.stringify(value); }
  catch { return String(value); }
};
let __airshipStdoutFrames = 0;
let __airshipStderrFrames = 0;
let __airshipOutputChars = 0;
const __airshipWrite = (stream, values) => {
  const frames = stream === "stderr" ? __airshipStderrFrames : __airshipStdoutFrames;
  if (frames >= 200 || __airshipOutputChars >= ${MAX_OUTPUT_CHARS}) return;
  const remaining = ${MAX_OUTPUT_CHARS} - __airshipOutputChars;
  if (remaining <= 1) return;
  const text = values.map(__airshipRender).join(" ").slice(0, Math.min(4_096, remaining - 1));
  if (!text) return;
  if (stream === "stderr") __airshipStderrFrames += 1;
  else __airshipStdoutFrames += 1;
  __airshipOutputChars += text.length + 1;
  if (stream === "stderr") pat.printerr(text);
  else pat.print(text);
};
Object.defineProperty(globalThis, "console", {
  configurable: false,
  writable: false,
  value: Object.freeze({
    log: (...values) => __airshipWrite("stdout", values),
    info: (...values) => __airshipWrite("stdout", values),
    warn: (...values) => __airshipWrite("stderr", values),
    error: (...values) => __airshipWrite("stderr", values),
  }),
});
${code}`;
}

export async function runDisposableWorker(
  code: string,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: ExecutionRequest["onOutput"],
): Promise<{
  value: JsonValue;
  logs: string[];
  errors: string[];
}> {
  if (typeof Worker === "undefined") {
    throw new Error("Disposable browser workers are unavailable in this environment.");
  }
  if (typeof code !== "string" || code.length > MAX_CODE_CHARS) {
    throw new Error("JavaScript source exceeds the 64 KiB execution budget.");
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

  const source = disposableJavascriptJobSource(code);
  const logs: string[] = [];
  const errors: string[] = [];
  const host = new PrimeKernelHost({
    budgets: {
      maxSourceChars: source.length,
      maxJobWallMs: timeoutMs,
      maxStreamChars: MAX_OUTPUT_CHARS,
      maxValueBytes: MAX_EXECUTION_VALUE_BYTES,
      maxBridgeCallsPerJob: 1,
      maxBridgePayloadBytes: 1_024,
      maxQueuedJobs: 1,
    },
    ports: {
      bridge: {
        async call(request: KernelBridgeCallRequest): Promise<KernelBridgeCallResult> {
          return { seq: request.seq, ok: false, error: "Disposable JavaScript has no host-tool bridge." };
        },
      },
    },
  });
  let completed = false;
  const onAbort = () => {
    if (!completed) void host.terminate("Disposable JavaScript was aborted by its caller.");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await host.exec(
      { code: source, timeoutMs, jobId: "airship-disposable-javascript", label: "execute_javascript" },
      (event: KernelJobEvent) => {
        if (event.type === "stdout" && logs.length < 200) {
          logs.push(event.text);
          emitExecutionOutput(onOutput, { stream: "stdout", text: `${event.text}\n` });
        } else if (event.type === "stderr" && errors.length < 200) {
          errors.push(event.text);
          emitExecutionOutput(onOutput, { stream: "stderr", text: `${event.text}\n` });
        }
      },
    );
    completed = true;
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (result.outcome !== "completed") {
      if (result.error?.includes("exceeded its wall-clock budget")) {
        throw new Error(`JavaScript execution exceeded ${timeoutMs} ms.`);
      }
      throw new Error(result.error ?? "Disposable JavaScript execution failed.");
    }
    return {
      value: parseWorkerJsonValue(result.valueJson),
      logs,
      errors,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    completed = true;
    signal.removeEventListener("abort", onAbort);
    await host.terminate("Disposable JavaScript job complete.");
  }
}

type PythonWorkspaceFile = Readonly<{ path: string; content: string; revision?: string }>;
type PythonWorkspaceSnapshot = Readonly<{
  root: string;
  files: readonly PythonWorkspaceFile[];
}>;
type PyodideWorkerResult = ExecutionResult & Readonly<{
  workspaceFiles?: readonly PythonWorkspaceFile[];
  workspaceError?: string;
}>;

async function executePythonRequest(request: ExecutionRequest): Promise<ExecutionResult> {
  const snapshot = request.workspace && request.workspaceRoot
    ? await capturePythonWorkspace(request.workspace, request.workspaceRoot, request.sourcePath)
    : undefined;
  const result = await runDisposablePyodide(
    request.code ?? "",
    request.args ?? [],
    request.env ?? {},
    request.timeoutMs,
    request.signal,
    { workspace: snapshot, sourcePath: request.sourcePath, onOutput: request.onOutput },
  );
  if (!snapshot || !request.workspace) {
    const { workspaceFiles: _files, workspaceError: _error, ...unmounted } = result;
    return unmounted;
  }
  if (result.workspaceError !== undefined) {
    // The interpreter finished, but its generated files could not be
    // collected. Nothing is adopted and no path may be reported as changed or
    // deleted, because an incomplete collection cannot distinguish "not
    // produced" from "not collected".
    const { workspaceFiles: _files, workspaceError: _error, ...publicResult } = result;
    return {
      ...publicResult,
      workspace: {
        root: snapshot.root,
        mountedFiles: snapshot.files.length,
        changedPaths: [],
        writtenPaths: [],
        deletedPaths: [],
        writeBackRequested: request.writeBack === true,
        adopted: false,
        writeBack: request.writeBack === true,
        workspaceError: result.workspaceError,
      },
    };
  }

  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  // Egress is guarded before any change list is computed, so a guest-created
  // .git/.airship/node_modules path is refused even when writeBack is false
  // and only changedPaths would have been reported back to the model.
  const returned = new Map<string, PythonWorkspaceFile>();
  const refused = new Map<string, string>();
  for (const file of result.workspaceFiles ?? []) {
    const path = normalizeWorkspacePath(file.path);
    // A path outside the mounted root cannot come from the guest: the worker's
    // collector only walks the root. It is a broken or tampered Worker
    // message, so it fails the whole run rather than being refused per file.
    if (!path.startsWith(`${snapshot.root}/`)) throw new Error(`Python returned a path outside its workspace root: ${path}`);
    const refusal = pythonEgressRefusal(path, snapshot.root);
    if (refusal) {
      // Refuse the write, keep the run: a completed job keeps its exit code
      // and streams, exactly as an over-budget collection does. The refusal is
      // reported as a bounded field so the model is told what was dropped.
      refused.set(path, refusal);
      continue;
    }
    if (returned.has(path)) throw new Error(`Python returned duplicate normalized workspace path: ${path}`);
    returned.set(path, { ...file, path });
  }
  const changed = [...returned.values()]
    .filter((file) => original.get(file.path)?.content !== file.content)
    .sort((left, right) => left.path.localeCompare(right.path));
  // A refused path is excluded from the deletion list as well. The mount
  // filter already keeps such paths out of the snapshot, so this is defense in
  // depth: a refusal must never be laundered into "the job deleted this file".
  const deleted = snapshot.files
    .filter((file) => !returned.has(file.path) && !refused.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const refusedPaths = [...refused.keys()].sort();
  const changedPaths = [...changed.map(({ path }) => path), ...deleted.map(({ path }) => path)].sort();
  const writtenPaths: string[] = [];
  const deletedPaths: string[] = [];
  if (request.writeBack && result.exitCode === 0) {
    // Preflight every target before the first mutation, then retain exact CAS
    // on every write. WorkspacePort has no multi-file transaction, so a later
    // cross-device race can still yield a clearly failed partial adoption.
    for (const file of changed) {
      const expected = original.get(file.path)?.revision;
      const current = await request.workspace.read(file.path);
      if (expected ? current?.revision !== expected : current !== undefined) {
        throw new Error(`Python writeback conflicted at ${file.path}.`);
      }
    }
    for (const file of deleted) {
      const current = await request.workspace.read(file.path);
      if (!current || current.revision !== file.revision) {
        throw new Error(`Python deletion conflicted at ${file.path}.`);
      }
    }
    for (const file of changed) {
      const expectedRevision = original.get(file.path)?.revision ?? null;
      await request.workspace.write(file.path, file.content, { expectedRevision });
      writtenPaths.push(file.path);
    }
    for (const file of deleted) {
      await request.workspace.remove(file.path, { expectedRevision: file.revision });
      deletedPaths.push(file.path);
    }
  }
  const { workspaceFiles: _workspaceFiles, workspaceError: _workspaceError, ...publicResult } = result;
  return {
    ...publicResult,
    workspace: {
      root: snapshot.root,
      mountedFiles: snapshot.files.length,
      changedPaths,
      writtenPaths,
      deletedPaths,
      writeBackRequested: request.writeBack === true,
      adopted: request.writeBack === true && result.exitCode === 0 && changedPaths.length > 0,
      writeBack: request.writeBack === true,
      ...(refusedPaths.length ? {
        refusedPaths,
        refusalReason: [...new Set(refused.values())].join(" ").slice(0, MAX_WORKSPACE_ERROR_CHARS),
      } : {}),
    },
  };
}

async function capturePythonWorkspace(
  workspace: WorkspacePort,
  rootInput: string,
  sourcePath?: string,
): Promise<PythonWorkspaceSnapshot> {
  const root = normalizeWorkspacePath(rootInput);
  if (sourcePath && sourcePath !== root && !sourcePath.startsWith(`${root}/`)) {
    throw new Error("Python sourcePath must stay inside workspaceRoot.");
  }
  const entries = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    .filter(({ path }) => !workspaceRelativeSegments(path, root).some((segment) => PYTHON_WORKSPACE_EXCLUDED_SEGMENTS.has(segment)));
  if (entries.length > MAX_PYTHON_WORKSPACE_FILES) {
    throw new Error(`Python workspace mount exceeds ${MAX_PYTHON_WORKSPACE_FILES} files.`);
  }
  const files: PythonWorkspaceFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const file = await workspace.read(entry.path);
    if (!file) throw new Error(`Python workspace file disappeared during snapshot: ${entry.path}`);
    if (file.revision !== entry.revision) throw new Error(`Python workspace changed during snapshot: ${entry.path}`);
    const bytes = workspaceContentByteLength(file.content);
    if (bytes > MAX_PYTHON_WORKSPACE_FILE_BYTES) {
      throw new Error(`Python workspace file exceeds 512 KiB: ${entry.path}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PYTHON_WORKSPACE_BYTES) throw new Error("Python workspace mount exceeds 4 MiB.");
    files.push({ path: file.path, content: file.content, revision: file.revision });
  }
  if (sourcePath && !files.some(({ path }) => path === sourcePath)) {
    throw new Error(`Python source file is not present in the workspace snapshot: ${sourcePath}`);
  }
  return { root, files };
}

function workspaceRelativeSegments(path: string, root: string): string[] {
  if (path === root) return [];
  return path.slice(root.length + 1).split("/");
}

/**
 * Egress twin of the mount filter above. WASI already refuses to adopt
 * control-plane paths; Python must not be the one runtime through which
 * a job can write the browser Git or terminal control plane.
 *
 * It returns a bounded reason instead of throwing: refusing one path must not
 * destroy a completed run's exit code and streams.
 */
function pythonEgressRefusal(path: string, root: string): string | undefined {
  if (isWorkspaceControlPlanePath(path)) return "Python workspace excludes control-plane paths.";
  const excluded = workspaceRelativeSegments(path, root).find((segment) => PYTHON_WORKSPACE_EXCLUDED_SEGMENTS.has(segment));
  return excluded ? `Python workspace excludes the ${excluded} path segment.` : undefined;
}

/**
 * Optional bindings for one Pyodide job.
 *
 * `bootTimeoutMs` is separate from the job's `timeoutMs` because a fresh
 * CPython cold start is not the caller's own statements. `execute_code` leaves
 * it at the install-sized default; `install_execution_runtime` passes its own
 * budget, because booting is the entire thing that tool does.
 */
type PyodideJobOptions = Readonly<{
  workspace?: PythonWorkspaceSnapshot;
  sourcePath?: string;
  onOutput?: ExecutionRequest["onOutput"];
  bootTimeoutMs?: number;
}>;

/**
 * Resolve the build-pinned pack against only the page's origin.
 *
 * `import.meta.env.BASE_URL` is Vite's canonical deployment path. Using the
 * current document URL as the path authority would make a deep route or a
 * caller-controlled `<base>` relevant, while accepting a caller-supplied URL
 * would turn runtime installation into a script-selection capability.
 */
function pinnedPyodideAssetBase(): string {
  const pageOrigin = globalThis.location?.origin;
  if (typeof pageOrigin !== "string" || pageOrigin === "null") {
    throw new Error("Disposable Pyodide needs a browser origin to pin its same-origin pack.");
  }
  if (
    typeof PYODIDE_DEPLOYMENT_BASE !== "string"
    || !PYODIDE_DEPLOYMENT_BASE.startsWith("/")
    || !PYODIDE_DEPLOYMENT_BASE.endsWith("/")
    || PYODIDE_DEPLOYMENT_BASE.includes("//")
    || PYODIDE_DEPLOYMENT_BASE.includes("?")
    || PYODIDE_DEPLOYMENT_BASE.includes("#")
  ) {
    throw new TypeError("Disposable Pyodide must use a valid Vite-pinned same-origin deployment base.");
  }

  const deploymentBase = new URL(PYODIDE_DEPLOYMENT_BASE, `${pageOrigin}/`);
  if (
    deploymentBase.origin !== pageOrigin
    || deploymentBase.pathname !== PYODIDE_DEPLOYMENT_BASE
    || deploymentBase.search
    || deploymentBase.hash
  ) {
    throw new TypeError("Disposable Pyodide must use a valid Vite-pinned same-origin deployment base.");
  }

  const assetBase = new URL(PYODIDE_PACK_RELATIVE_PATH, deploymentBase);
  if (assetBase.origin !== pageOrigin || assetBase.search || assetBase.hash) {
    throw new TypeError("Disposable Pyodide must use its Vite-pinned same-origin pack.");
  }
  return assetBase.href;
}

export async function runDisposablePyodide(
  code: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  options: PyodideJobOptions = {},
): Promise<PyodideWorkerResult> {
  const { workspace, sourcePath, onOutput } = options;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  if (!supportsDisposableWorkers() || typeof WebAssembly === "undefined") {
    throw new Error("Disposable Pyodide workers are unavailable in this environment.");
  }
  if ((!code.trim() && !sourcePath) || code.length > MAX_CODE_CHARS) throw new Error("Python source must be between 1 and 64 KiB, or select sourcePath.");
  if (args.length > 64 || args.some((value) => value.length > 4_096)) throw new Error("Python arguments exceed the execution budget.");
  const environmentEntries = Object.entries(env);
  if (environmentEntries.length > 64 || environmentEntries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(key) || value.length > 4_096)) {
    throw new Error("Python environment exceeds the execution budget.");
  }
  const assetBase = pinnedPyodideAssetBase();
  const url = URL.createObjectURL(new Blob([pyodideWorkerSource(assetBase)], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedWorkerUrl(url) as string, { name: "airship-python-pyodide", type: "module" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: PyodideWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value!);
    };
    // Every job boots a fresh CPython interpreter. That cold start is bounded
    // by its own budget so the caller's timeoutMs bounds the caller's own
    // statements instead of the pack's boot.
    const bootStarted = Date.now();
    let bootMs: number | undefined;
    let timer = setTimeout(
      () => finish(new Error(`Pyodide boot exceeded ${bootTimeoutMs} ms.`)),
      bootTimeoutMs,
    );
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Disposable Pyodide worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        finish(new Error("Disposable Pyodide worker returned malformed output."));
        return;
      }
      const message = event.data as Record<string, unknown>;
      if (message.type === "output") {
        const stream = message.stream === "stderr" ? "stderr" : "stdout";
        if (typeof message.text === "string") emitExecutionOutput(onOutput, { stream, text: message.text.slice(0, 65_536) });
        return;
      }
      if (message.type === "ready") {
        if (bootMs !== undefined) return;
        bootMs = Date.now() - bootStarted;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`Python execution exceeded ${timeoutMs} ms.`)), timeoutMs);
        return;
      }
      if (message.ok !== true) {
        finish(new Error(typeof message.error === "string" ? message.error : "Disposable Pyodide initialization failed."));
        return;
      }
      // A completed job keeps its own exit code and streams even when its
      // generated files exceeded the mount budget; the collection failure is
      // reported as a bounded field instead of erasing the run.
      const workspaceError = typeof message.workspaceError === "string"
        ? message.workspaceError.slice(0, MAX_WORKSPACE_ERROR_CHARS)
        : undefined;
      const workspaceFiles = workspaceError === undefined && Array.isArray(message.workspaceFiles)
        ? message.workspaceFiles
          .map(parsePythonWorkspaceFile)
          .filter((file): file is PythonWorkspaceFile => file !== undefined)
          .slice(0, MAX_PYTHON_WORKSPACE_FILES)
        : undefined;
      finish(undefined, {
        runtime: "python-pyodide",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : 1,
        stdout: typeof message.stdout === "string" ? message.stdout.slice(0, MAX_OUTPUT_CHARS) : "",
        stderr: typeof message.stderr === "string" ? message.stderr.slice(0, MAX_OUTPUT_CHARS) : "",
        value: parseWorkerJsonValue(message.valueJson),
        ...(bootMs !== undefined ? { bootMs } : {}),
        provenance: {
          capabilityTier: "web-enhanced",
          authority: "browser",
          engine: `pyodide-${PYODIDE_VERSION}-worker`,
          artifactKind: "source",
        },
        ...(workspaceFiles ? { workspaceFiles } : {}),
        ...(workspaceError !== undefined ? { workspaceError } : {}),
      });
    };
    if (signal.aborted) onAbort();
    else worker.postMessage({
      code,
      args: [...args],
      env: { ...env },
      ...(workspace ? {
        workspaceRoot: workspace.root,
        workspaceFiles: workspace.files.map(({ path, content }) => ({ path, bytes: decodeWorkspaceBytes(content) })),
      } : {}),
      ...(sourcePath ? { sourcePath } : {}),
    });
  });
}

function parsePythonWorkspaceFile(value: unknown): PythonWorkspaceFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !(record.bytes instanceof Uint8Array)) return undefined;
  if (record.bytes.byteLength > MAX_PYTHON_WORKSPACE_FILE_BYTES) return undefined;
  return { path: record.path, content: encodeWorkspaceBytes(record.bytes) };
}

/**
 * `require-trusted-types-for 'script'` also covers Worker constructors. The
 * policy accepts only a blob URL minted immediately above from Airship-owned
 * source; it is not a generic string-to-script escape hatch.
 */
function trustedWorkerUrl(url: string): unknown {
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (!factory) return url;
  workerPolicy ??= factory.createPolicy(WORKER_POLICY_NAME, {
    createScriptURL(value) {
      if (!value.startsWith("blob:")) throw new TypeError("Airship workers require a freshly minted blob URL.");
      return value;
    },
  });
  return workerPolicy.createScriptURL(url);
}

function pyodideWorkerSource(assetBase: string): string {
  return `"use strict";
(() => {
"use strict";
${disposableWorkerIsolationPreludeSource()}
const PYODIDE_MODULE = ${JSON.stringify(new URL("pyodide.mjs", assetBase).href)};
const PYODIDE_BASE = ${JSON.stringify(assetBase)};
const LIMIT = ${MAX_OUTPUT_CHARS};
const __String = String;
const __Uint8Array = Uint8Array;
const __jsonStringify = JSON.stringify.bind(JSON);
const __encode = TextEncoder.prototype.encode.bind(new TextEncoder());
const __stringSlice = Function.call.bind(String.prototype.slice);
const __arrayPush = Function.call.bind(Array.prototype.push);
const __arrayIsArray = Array.isArray.bind(Array);
let __started = false;

const boundedAppend = (current, value) => {
  if (current.length >= LIMIT) return current;
  const addition = __String(value) + "\\n";
  return __stringSlice(current + addition, 0, LIMIT);
};
const jsonValue = (value) => {
  let converted = value;
  try {
    if (value && typeof value.toJs === "function") converted = value.toJs();
    let encoded = __jsonStringify(converted === undefined ? null : converted);
    if (encoded === undefined) encoded = "null";
    if (__encode(encoded).byteLength <= ${MAX_EXECUTION_VALUE_BYTES}) return encoded;
    return __jsonStringify({ airshipValue: "truncated", limitBytes: ${MAX_EXECUTION_VALUE_BYTES} });
  } catch {
    return __jsonStringify(__String(converted));
  } finally {
    try { if (value && typeof value.destroy === "function") value.destroy(); } catch {}
  }
};

const run = async (data) => {
  let pyodide;
  try {
    const module = await import(PYODIDE_MODULE);
    pyodide = await module.loadPyodide({ indexURL: PYODIDE_BASE, fullStdLib: false });
    // Pyodide needs its pinned same-origin module and WASM during boot. From
    // this point forward, model Python receives no recoverable browser egress.
    __scrubAmbient();
  } catch (error) {
    __post({ ok: false, error: "Pyodide initialization failed: " + __String(error && error.message || error) });
    return;
  }

  const fs = pyodide.FS;
  const fsMkdirTree = fs.mkdirTree.bind(fs);
  const fsWriteFile = fs.writeFile.bind(fs);
  const fsReadFile = fs.readFile.bind(fs);
  const fsChdir = fs.chdir.bind(fs);
  const fsReaddir = fs.readdir.bind(fs);
  const fsStat = fs.stat.bind(fs);
  const fsIsDir = fs.isDir.bind(fs);
  const fsIsFile = fs.isFile.bind(fs);
  const runPythonAsync = pyodide.runPythonAsync.bind(pyodide);

  let stdout = "";
  let stderr = "";
  pyodide.setStdout({ batched: (value) => {
    const next = boundedAppend(stdout, value);
    const accepted = __stringSlice(next, stdout.length);
    stdout = next;
    if (accepted) __post({ type: "output", stream: "stdout", text: accepted });
  } });
  pyodide.setStderr({ batched: (value) => {
    const next = boundedAppend(stderr, value);
    const accepted = __stringSlice(next, stderr.length);
    stderr = next;
    if (accepted) __post({ type: "output", stream: "stderr", text: accepted });
  } });
  try { pyodide.setStdin({ stdin: () => null }); } catch {}
  __post({ type: "ready" });

  const mountWorkspace = () => {
    if (!data.workspaceRoot) return;
    fsMkdirTree(data.workspaceRoot);
    for (const file of __arrayIsArray(data.workspaceFiles) ? data.workspaceFiles : []) {
      const slash = file.path.lastIndexOf("/");
      fsMkdirTree(__stringSlice(file.path, 0, slash) || "/workspace");
      if (!(file.bytes instanceof __Uint8Array)) throw new Error("Python workspace input was not byte-safe.");
      fsWriteFile(file.path, file.bytes);
    }
    fsChdir(data.workspaceRoot);
  };
  const collectWorkspace = (root) => {
    if (!root) return undefined;
    const files = [];
    let total = 0;
    const visit = (directory) => {
      for (const name of fsReaddir(directory)) {
        if (name === "." || name === "..") continue;
        const path = directory === "/" ? "/" + name : directory + "/" + name;
        const stat = fsStat(path);
        if (fsIsDir(stat.mode)) { visit(path); continue; }
        if (!fsIsFile(stat.mode)) continue;
        const bytes = fsReadFile(path);
        if (bytes.byteLength > ${MAX_PYTHON_WORKSPACE_FILE_BYTES}) {
          throw new Error("Python generated a file over 512 KiB: " + path);
        }
        total += bytes.byteLength;
        if (files.length >= ${MAX_PYTHON_WORKSPACE_FILES} || total > ${MAX_PYTHON_WORKSPACE_BYTES}) {
          throw new Error("Python workspace output exceeded its mount budget.");
        }
        __arrayPush(files, { path, bytes });
      }
    };
    visit(root);
    return files;
  };

  try {
    mountWorkspace();
  } catch (error) {
    __post({ ok: false, error: "Python workspace mount failed: " + __String(error && error.message || error) });
    return;
  }

  let exitCode = 0;
  let value = null;
  try {
    const argv = ["airship.py", ...(__arrayIsArray(data.args) ? data.args : [])];
    const environment = data.env && typeof data.env === "object" ? data.env : {};
    await runPythonAsync(
      "import os, sys\\n" +
      "sys.argv = " + __jsonStringify(argv) + "\\n" +
      "os.environ.update(" + __jsonStringify(environment) + ")",
    );
    const executionSource = data.sourcePath
      ? fsReadFile(data.sourcePath, { encoding: "utf8" })
      : __String(data.code || "");
    value = jsonValue(await runPythonAsync(executionSource, { filename: data.sourcePath || "<airship>" }));
  } catch (error) {
    exitCode = 1;
    const next = boundedAppend(stderr, __String(error && error.message || error));
    const accepted = __stringSlice(next, stderr.length);
    stderr = next;
    if (accepted) __post({ type: "output", stream: "stderr", text: accepted });
  }

  let workspaceFiles;
  let workspaceError;
  try {
    workspaceFiles = collectWorkspace(data.workspaceRoot);
  } catch (error) {
    // A collection failure cannot be represented as an empty list: that would
    // falsely claim every mounted file was deleted.
    workspaceError = "Python workspace collection failed: " + __String(error && error.message || error);
  }
  __post({
    ok: true,
    exitCode,
    stdout,
    stderr,
    valueJson: value,
    ...(workspaceError ? { workspaceError } : { workspaceFiles }),
  });
};

const __onControllerMessage = (event) => {
  if (!event || event.isTrusted !== true || __started) return;
  __started = true;
  __unlisten("message", __onControllerMessage);
  // The one trusted job is now held in this closure. Hide every controller
  // entry before the first await can reach untrusted Python.
  __scrubController();
  void run(event.data);
};
__listen("message", __onControllerMessage);
})();`;
}

function supportsDisposableWorkers(): boolean {
  return typeof Worker !== "undefined" && typeof URL.createObjectURL === "function";
}

function activationResultForCurrentPage(result: ToolExecutionResult, context: ToolContext): ToolExecutionResult {
  const liveCapabilityTier = deriveBrowserExecutionTier(getClientExecutionRuntime().capabilities());
  let content = result.content;
  try {
    const capability = JSON.parse(result.content) as JsonValue;
    if (capability && typeof capability === "object" && !Array.isArray(capability)) {
      content = JSON.stringify({
        ...capability,
        usableNow: true,
        sessionCompatibility: "ready-in-current-session",
      }, null, 2);
    }
  } catch {
    // The activation result remains useful even if a future adapter uses text.
  }
  const metadata = result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
    ? result.metadata
    : {};
  return {
    ...result,
    content,
    metadata: {
      ...metadata,
      usableNow: true,
      requiresNewConversation: false,
      initialCapabilityTier: context.capabilityTier ?? "web-baseline",
      liveCapabilityTier,
      capabilityTier: liveCapabilityTier,
    },
  };
}

function awaitActivationPhase<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => finish(undefined, value), finish);
    if (signal.aborted) onAbort();
  });
}

function validateExecuteCodeArguments(runtime: ExecutionRuntimeId, args: Record<string, JsonValue>): void {
  const hasCode = typeof args.code === "string";
  const hasArtifact = typeof args.wasmBase64 === "string";
  const hasArtifactPath = typeof args.wasmPath === "string";
  const hasSourcePath = typeof args.sourcePath === "string";
  const hasWorkspace = typeof args.workspaceRoot === "string" || hasSourcePath || args.writeBack !== undefined;

  if (runtime === "javascript-worker") {
    if (!hasCode) throw new Error("JavaScript Worker execution requires code.");
    if (hasArtifact || hasArtifactPath || hasSourcePath || hasWorkspace || args.args !== undefined || args.env !== undefined) {
      throw new Error("JavaScript Worker accepts only code and timeoutMs; it has no argv, environment, workspace, or WASI artifact binding.");
    }
    return;
  }
  if (runtime === "wasi-preview1") {
    if (hasArtifact === hasArtifactPath) {
      throw new Error("WASI Preview 1 execution requires exactly one precompiled command artifact: wasmBase64 or a workspace wasmPath.");
    }
    if (hasCode || hasSourcePath) {
      throw new Error(
        "WASI Preview 1 accepts a precompiled command artifact, not source code, Bash, rustc, or Cargo; its bounded workspace mount is optional.",
      );
    }
    if (args.writeBack === true && typeof args.workspaceRoot !== "string") throw new Error("WASI writeBack requires a workspaceRoot.");
    return;
  }
  if (runtime === "python-pyodide") {
    if (hasArtifact || hasArtifactPath) throw new Error("Pyodide executes Python source, not a WASI artifact.");
    if (hasCode === hasSourcePath) throw new Error("Pyodide requires exactly one of code or sourcePath.");
    if ((hasSourcePath || args.writeBack === true) && typeof args.workspaceRoot !== "string") {
      throw new Error("Python sourcePath and writeBack require a workspaceRoot.");
    }
    return;
  }
  throw new Error(`${runtime} is not available through execute_code.`);
}

function parseWorkerJsonValue(value: unknown): JsonValue {
  if (typeof value !== "string") throw new Error("Execution worker did not return its bounded JSON value envelope.");
  if (new TextEncoder().encode(value).byteLength > MAX_EXECUTION_VALUE_BYTES) {
    throw new Error("Execution worker returned a value over the 512 KiB result budget.");
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new Error("Execution worker returned malformed JSON value data.");
  }
}

function stringArray(value: JsonValue | undefined, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must contain only strings.`);
  return value as string[];
}

function stringRecord(value: JsonValue | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  if (Object.values(value).some((item) => typeof item !== "string")) throw new Error(`${name} values must be strings.`);
  return value as Record<string, string>;
}
