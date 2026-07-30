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
// One ceiling for every runtime's bounded collection diagnostic. The WASI
// contract owns the number so the Python and WASI paths cannot drift apart.
import { WASI_PREVIEW1_MAX_WORKSPACE_ERROR_CHARS as MAX_WORKSPACE_ERROR_CHARS } from "../execution/wasi-preview1-contract";

export { runDisposableWasi } from "../execution/wasi-preview1-pack";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;
const MAX_SHELL_SCRIPT_CHARS = 64 * 1_024;
/** A shell script does real multi-step work, so it gets a larger ceiling than a snippet. */
const MAX_SHELL_TIMEOUT_MS = 30_000;
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
const PYODIDE_ASSET_PATH = "/execution-packs/pyodide/";
const MAX_WORKSPACE_PROGRAM_CALLS = 16;
const MAX_WORKSPACE_PROGRAM_RESULT_BYTES = 512 * 1_024;
const WORKSPACE_PROGRAM_TOOL_EFFECTS = new Map<string, Tool["definition"]["effect"]>([
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

export function registerExecutionTools(registry: ToolRegistry, workspace?: WorkspacePort, hostRegistry?: ToolRegistry): void {
  const executeJavascript: Tool = {
    definition: {
      name: "execute_javascript",
      description: "Run bounded JavaScript in a disposable browser worker with no workspace, DOM, storage, or network binding; return or log the result.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
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
    },
  };
  registry.register(executeJavascript);
  registry.register({
    definition: {
      name: "execute_workspace_program",
      description: "Run bounded JavaScript that may invoke only exact predeclared workspace file calls in its approval-bound manifest. It exposes no ambient DOM, storage, network, shell, or undeclared tool access.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          calls: {
            type: "array",
            maxItems: MAX_WORKSPACE_PROGRAM_CALLS,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                tool: { type: "string", enum: [...WORKSPACE_PROGRAM_TOOL_EFFECTS.keys()] },
                arguments: { type: "object" },
              },
              required: ["id", "tool", "arguments"],
              additionalProperties: false,
            },
          },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["code", "calls"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      if (!hostRegistry) throw new Error("Workspace-program execution has no bound Airship tool registry.");
      const args = objectArguments(argumentsValue);
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
    },
  });
  registry.register({
    definition: {
      name: "install_execution_runtime",
      description: "Cold-start an optional browser runtime; it reports ready only after a real probe, then it is usable immediately in this conversation.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["python-pyodide", "node-webcontainer"] },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 30_000, description: "Bounds the whole activation, cold start included." },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const runtime = requiredString(args.runtime, "runtime");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_INSTALL_TIMEOUT_MS;
      if (runtime === "node-webcontainer") {
        const activated = await activateNodeRuntime(context.signal, timeoutMs);
        return activationResultForCurrentPage(activated, context);
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
    },
  });
  registry.register({
    definition: {
      name: "inspect_execution_runtimes",
      description: "Report the coding runtimes this browser can execute now, activate explicitly, or cannot provide in this release.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      const capabilities = getClientExecutionRuntime().capabilities();
      return {
        content: JSON.stringify(capabilities, null, 2),
        metadata: {
          capabilityTier: deriveBrowserExecutionTier(capabilities),
          ready: capabilities.filter(({ state }) => state === "ready").map(({ id }) => id),
        },
      };
    },
  });
  registry.register({
    definition: {
      name: "execute_code",
      description: "Execute one strictly typed browser job in a ready runtime: JavaScript source; a precompiled WASI Preview 1 command (including Rust compiled elsewhere for wasm32-wasip1) supplied as a workspace wasmPath or inline wasmBase64, with optional bounded workspace snapshot/writeback; or explicitly installed Pyodide Python. This is not Bash, rustc, Cargo, or host execution. Inspect runtimes first; Node projects use execute_node_project.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["javascript-worker", "wasi-preview1", "python-pyodide"] },
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          wasmBase64: { type: "string", minLength: 12, maxLength: MAX_WASM_BASE64_CHARS },
          wasmPath: { type: "string", minLength: 1, maxLength: 1_024 },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          sourcePath: { type: "string", minLength: 1, maxLength: 1_024 },
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000, description: "Bounds the job's own statements only. A python-pyodide cold start is bounded separately (up to 30 s) and reported as bootMs, so total wall clock can exceed this." },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
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
    },
  });
  registry.register({
    definition: EXECUTE_SHELL_DEFINITION,
    execute: (argumentsValue, context) => executeShellTool(objectArguments(argumentsValue), context, workspace),
  });
  registry.register({
    definition: {
      name: "deactivate_execution_runtime",
      description: "Terminate an optional runtime and release its in-tab processes and memory. The Workspace Terminal shares this runtime: any live terminal session is reconciled into the workspace and then stopped, and the reconciled paths are named in the result.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: { runtime: { type: "string", enum: ["node-webcontainer"] } },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    execute: (argumentsValue) => deactivateExecutionRuntime(
      requiredString(objectArguments(argumentsValue).runtime, "runtime") as ExecutionRuntimeId,
    ),
  });
  registry.register({
    definition: {
      name: "execute_node_project",
      description: "Spawn one finite Node/npm-family process in an activated in-browser WebContainer. Commands for the same workspace root reuse page-local dependencies, so install then build/test works in this conversation; use Workspace Terminal for a long-running dev server. node_modules is never persisted. No host Bash is involved; writeBack preflights the full source snapshot, then adopts revision-checked text changes.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          command: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
          writeBack: { type: "boolean" },
        },
        required: ["workspaceRoot", "command"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      if (!workspace) throw new Error("Node project execution has no workspace binding.");
      const args = objectArguments(argumentsValue);
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
    },
  });
}

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
      if (runtime === "wasix") throw new Error(wasixUnavailableDetail());
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
    case "execute_wasix_shell": {
      throw new Error(wasixUnavailableDetail());
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

/**
 * The one shell surface Airship can honestly offer on every browser.
 *
 * The description names the engine and its boundary in the same sentence, so a
 * model reading the manifest cannot conclude that Bash, a subprocess, or a host
 * filesystem is reachable. `effect` is `write` because an approved run with
 * `writeBack` adopts workspace files through the ordinary revision-checked
 * path; nothing here bypasses the approval gate.
 */
export const EXECUTE_SHELL_DEFINITION: Tool["definition"] = Object.freeze({
  name: "execute_shell",
  description:
    "Run one POSIX sh script in airship-sh, Airship's own in-browser shell interpreter, over a bounded snapshot of a "
    + "workspace directory. Real shell semantics: single/double/backslash quoting, $VAR and ${VAR:-x}/${VAR:=x}/"
    + "${VAR:?x}/${VAR:+x}/${VAR#p}/${VAR%p}/${#VAR}, $(...) and backticks, $((...)) arithmetic, tilde and IFS field "
    + "splitting, * ? [...] globbing against the real workspace, pipelines, ! && || ;, ( ) subshells, { } groups, "
    + "if/for/while/until/case, functions, > >> < 2> 2>&1 >& redirection, << and <<- here-documents, and utilities "
    + "including ls cat cp mv rm mkdir rmdir touch head tail wc grep sed sort uniq cut tr find basename dirname "
    + "realpath xargs env date seq diff stat du. It is NOT GNU Bash and has no subprocesses: no job control or `&`, "
    + "no signals other than trap EXIT, no arrays, no process substitution, no [[ ]], no host filesystem, no network, "
    + "and no git/python/node commands. Unsupported syntax is a parse error and an unimplemented utility flag is an "
    + "error, never a silent no-op. Files change only when writeBack is true and the script exits 0.",
  effect: "write",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", minLength: 1, maxLength: MAX_SHELL_SCRIPT_CHARS },
      workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
      args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
      env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
      writeBack: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 50, maximum: MAX_SHELL_TIMEOUT_MS },
    },
    required: ["script"],
    additionalProperties: false,
  },
}) as unknown as Tool["definition"];

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

function wasixUnavailableDetail(): string {
  return "WASIX Bash is not promoted in this release: the pinned browser pack could not preserve nonzero Bash status or bidirectional mounted-workspace mutations. Use Node WebContainer for Node/npm projects or Pyodide for Python; full browser Bash and a Rust compiler remain unavailable.";
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

async function runDisposableWorkspaceProgram(
  code: string,
  calls: readonly WorkspaceProgramCall[],
  registry: ToolRegistry,
  timeoutMs: number,
  context: ToolContext,
): Promise<Readonly<{ value: JsonValue; stdout: string; stderr: string; calls: readonly WorkspaceProgramCallTrace[] }>> {
  if (!supportsDisposableWorkers()) throw new Error("Disposable workspace-program workers are unavailable in this environment.");
  if (!code.trim() || code.length > MAX_CODE_CHARS) throw new Error("Workspace-program source must be between 1 and 64 KiB.");
  const url = URL.createObjectURL(new Blob([workspaceProgramWorkerSource(code)], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedWorkerUrl(url) as string, { name: "airship-workspace-program" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  const declared = new Map(calls.map((call) => [call.id, call]));
  const used = new Set<string>();
  const traces = new Map<string, WorkspaceProgramCallTrace>();
  let returnedBytes = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: Readonly<{ value: JsonValue; stdout: string; stderr: string }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(Object.freeze({
        ...value!,
        calls: Object.freeze(calls.map((call) => traces.get(call.id) ?? Object.freeze({ id: call.id, tool: call.tool, status: "unused" as const }))),
      }));
    };
    const timer = setTimeout(() => finish(new Error(`Workspace program exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(context.signal.reason ?? new DOMException("Aborted", "AbortError"));
    context.signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Workspace program worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        finish(new Error("Workspace program worker returned malformed output."));
        return;
      }
      const message = event.data as Record<string, unknown>;
      if (message.type === "output") {
        const stream = message.stream === "stderr" ? "stderr" : "stdout";
        if (typeof message.text === "string") emitExecutionOutput(context.onOutput, { stream, text: message.text.slice(0, 4_097) });
        return;
      }
      if (message.type === "tool-call") {
        const requestId = typeof message.requestId === "number" && Number.isSafeInteger(message.requestId) ? message.requestId : undefined;
        const id = typeof message.id === "string" ? message.id : "";
        const call = declared.get(id);
        if (requestId === undefined || !call || used.has(id)) {
          worker.postMessage({ type: "tool-result", requestId, ok: false, error: "Tool call was not uniquely predeclared in the approved manifest." });
          return;
        }
        used.add(id);
        const tool = registry.get(call.tool)!;
        void (async () => tool.execute(structuredClone(call.arguments), {
          ...context,
          operationId: `declared:${await sha256(`${context.operationId}:${id}`)}`,
        }))().then((result) => {
          if (settled) return;
          const bytes = new TextEncoder().encode(result.content).byteLength;
          returnedBytes += bytes;
          if (returnedBytes > MAX_WORKSPACE_PROGRAM_RESULT_BYTES) {
            throw new Error("Declared workspace-tool results exceeded the 512 KiB program budget.");
          }
          traces.set(id, Object.freeze({
            id,
            tool: call.tool,
            status: "completed",
            isError: result.isError ?? false,
            ...(result.metadata !== undefined ? { metadata: structuredClone(result.metadata) } : {}),
          }));
          worker.postMessage({
            type: "tool-result",
            requestId,
            ok: true,
            result: { content: result.content, metadata: result.metadata ?? null, isError: result.isError ?? false },
          });
        }).catch((error) => {
          if (settled) return;
          const summary = error instanceof Error ? error.message : String(error);
          traces.set(id, Object.freeze({ id, tool: call.tool, status: "failed" }));
          worker.postMessage({ type: "tool-result", requestId, ok: false, error: summary.slice(0, 2_048) });
        });
        return;
      }
      if (message.ok !== true) {
        finish(new Error(typeof message.error === "string" ? message.error : "Workspace program execution failed."));
        return;
      }
      finish(undefined, {
        value: parseWorkerJsonValue(message.valueJson),
        stdout: typeof message.stdout === "string" ? message.stdout.slice(0, MAX_OUTPUT_CHARS) : "",
        stderr: typeof message.stderr === "string" ? message.stderr.slice(0, MAX_OUTPUT_CHARS) : "",
      });
    };
    if (context.signal.aborted) onAbort();
  });
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
  if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Disposable browser workers are unavailable in this environment.");
  }
  const source = workerSource(code);
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedWorkerUrl(url) as string, { name: "airship-disposable-executor" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: { value: JsonValue; logs: string[]; errors: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`JavaScript execution exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Disposable JavaScript worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new Error("Disposable JavaScript worker returned malformed output."));
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.type === "output") {
        const stream = record.stream === "stderr" ? "stderr" : "stdout";
        if (typeof record.text === "string") emitExecutionOutput(onOutput, { stream, text: record.text.slice(0, 4_097) });
        return;
      }
      if (record.ok !== true) {
        finish(new Error(typeof record.error === "string" ? record.error : "Disposable JavaScript execution failed."));
        return;
      }
      finish(undefined, {
        value: parseWorkerJsonValue(record.valueJson),
        logs: Array.isArray(record.logs) ? record.logs.filter((item): item is string => typeof item === "string").slice(0, 200) : [],
        errors: Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string").slice(0, 200) : [],
      });
    };
    if (signal.aborted) onAbort();
  });
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
 * Egress twin of the mount filter above. WASI and WASIX already refuse to
 * adopt control-plane paths; Python must not be the one runtime through which
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
  const assetBase = new URL(PYODIDE_ASSET_PATH, globalThis.location.href).href;
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

function workspaceProgramWorkerSource(code: string): string {
  return `"use strict";
const __post = globalThis.postMessage.bind(globalThis);
const __stdout = [], __stderr = [], __pending = new Map(), __inflight = new Set(); let __request = 0, __outputChars = 0;
const __render = value => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } };
const __serializeValue = value => {
  let encoded;
  try { encoded = JSON.stringify(value === undefined ? null : value); }
  catch { encoded = JSON.stringify(String(value)); }
  if (new TextEncoder().encode(encoded).byteLength <= ${MAX_EXECUTION_VALUE_BYTES}) return encoded;
  return JSON.stringify({ airshipValue:"truncated", limitBytes:${MAX_EXECUTION_VALUE_BYTES} });
};
const __emit = (stream, target, values) => {
  if (__outputChars >= ${MAX_OUTPUT_CHARS}) return;
  const remaining = ${MAX_OUTPUT_CHARS} - __outputChars;
  if (remaining <= 1) return;
  const body = values.map(__render).join(" ").slice(0, Math.min(4096, remaining - 1));
  if (!body) return;
  const text = body + "\\n";
  target.push(text);
  __outputChars += text.length;
  __post({ type:"output", stream, text });
};
console.log = (...values) => __emit("stdout", __stdout, values);
console.info = console.log;
console.warn = (...values) => __emit("stderr", __stderr, values);
console.error = (...values) => __emit("stderr", __stderr, values);
for (const name of ["fetch", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
  try { Object.defineProperty(globalThis, name, { value:undefined, configurable:false, writable:false }); } catch {}
}
try { Object.defineProperty(globalThis, "postMessage", { value:undefined, configurable:false, writable:false }); } catch {}
Object.defineProperty(globalThis, "airship", { configurable:false, writable:false, value:Object.freeze({
  call(id) {
    if (typeof id !== "string") return Promise.reject(new TypeError("airship.call requires a declared call ID."));
    const requestId = ++__request;
    __post({ type:"tool-call", requestId, id });
    const call = new Promise((resolve, reject) => __pending.set(requestId, { resolve, reject }));
    __inflight.add(call);
    void call.then(() => __inflight.delete(call), () => __inflight.delete(call));
    return call;
  }
}) });
self.onmessage = ({ data }) => {
  if (!data || data.type !== "tool-result" || !Number.isSafeInteger(data.requestId)) return;
  const pending = __pending.get(data.requestId);
  if (!pending) return;
  __pending.delete(data.requestId);
  if (data.ok === true) pending.resolve(data.result);
  else pending.reject(new Error(typeof data.error === "string" ? data.error : "Declared Airship tool failed."));
};
Promise.resolve().then(async () => {
  const value = await (async (__post, __stdout, __stderr, __pending, __inflight, __request, __outputChars, __render, __emit, __serializeValue) => {
${code}
  })(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  while (__inflight.size > 0) {
    const results = await Promise.allSettled([...__inflight]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  __post({ ok:true, valueJson:__serializeValue(value), stdout:__stdout.join(""), stderr:__stderr.join("") });
}).catch(error => __post({ ok:false, error:String(error && error.stack || error), stdout:__stdout.join(""), stderr:__stderr.join("") }));`;
}

function workerSource(code: string): string {
  return `"use strict";
const __post = globalThis.postMessage.bind(globalThis);
const __logs = [];
const __errors = [];
let __outputChars = 0;
const __render = value => {
  try { return typeof value === "string" ? value : JSON.stringify(value); }
  catch { return String(value); }
};
const __serializeValue = value => {
  let encoded;
  try { encoded = JSON.stringify(value === undefined ? null : value); }
  catch { encoded = JSON.stringify(String(value)); }
  if (new TextEncoder().encode(encoded).byteLength <= ${MAX_EXECUTION_VALUE_BYTES}) return encoded;
  return JSON.stringify({ airshipValue:"truncated", limitBytes:${MAX_EXECUTION_VALUE_BYTES} });
};
const __emit = (stream, target, values) => {
  if (target.length >= 200 || __outputChars >= ${MAX_OUTPUT_CHARS}) return;
  const remaining = ${MAX_OUTPUT_CHARS} - __outputChars;
  if (remaining <= 1) return;
  const text = values.map(__render).join(" ").slice(0, Math.min(4096, remaining - 1));
  if (!text) return;
  target.push(text);
  __outputChars += text.length + 1;
  __post({ type:"output", stream, text:text + "\\n" });
};
console.log = (...values) => __emit("stdout", __logs, values);
console.info = console.log;
console.warn = (...values) => __emit("stderr", __errors, values);
console.error = (...values) => __emit("stderr", __errors, values);
for (const name of ["fetch", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
}
try { Object.defineProperty(globalThis, "postMessage", { value:undefined, configurable:false, writable:false }); } catch {}
Promise.resolve().then(async () => {
  const value = await (async (__post, __logs, __errors, __outputChars, __render, __emit, __serializeValue) => {
${code}
  })(undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  __post({ ok: true, valueJson: __serializeValue(value), logs: __logs, errors: __errors });
}).catch(error => __post({ ok: false, error: String(error && error.stack || error), logs: __logs, errors: __errors }));`;
}

function pyodideWorkerSource(assetBase: string): string {
  return `"use strict";
const __post = globalThis.postMessage.bind(globalThis);
const PYODIDE_MODULE = ${JSON.stringify(new URL("pyodide.mjs", assetBase).href)};
const PYODIDE_BASE = ${JSON.stringify(assetBase)};
const LIMIT = ${MAX_OUTPUT_CHARS};
const boundedAppend = (current, value) => {
  if (current.length >= LIMIT) return current;
  const addition = String(value) + "\\n";
  return (current + addition).slice(0, LIMIT);
};
const jsonValue = value => {
  let converted = value;
  try {
    if (value && typeof value.toJs === "function") converted = value.toJs();
    let encoded = JSON.stringify(converted === undefined ? null : converted);
    if (encoded === undefined) encoded = "null";
    if (new TextEncoder().encode(encoded).byteLength <= ${MAX_EXECUTION_VALUE_BYTES}) return encoded;
    return JSON.stringify({ airshipValue:"truncated", limitBytes:${MAX_EXECUTION_VALUE_BYTES} });
  } catch { return JSON.stringify(String(converted)); }
  finally { try { if (value && typeof value.destroy === "function") value.destroy(); } catch {} }
};
const mountWorkspace = (pyodide, data) => {
  if (!data.workspaceRoot) return;
  pyodide.FS.mkdirTree(data.workspaceRoot);
  for (const file of Array.isArray(data.workspaceFiles) ? data.workspaceFiles : []) {
    const slash = file.path.lastIndexOf("/");
    pyodide.FS.mkdirTree(file.path.slice(0, slash) || "/workspace");
    if (!(file.bytes instanceof Uint8Array)) throw new Error("Python workspace input was not byte-safe.");
    pyodide.FS.writeFile(file.path, file.bytes);
  }
  pyodide.FS.chdir(data.workspaceRoot);
};
const collectWorkspace = (pyodide, root) => {
  if (!root) return undefined;
  const files = []; let total = 0;
  const visit = directory => {
    for (const name of pyodide.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = directory === "/" ? "/" + name : directory + "/" + name;
      const stat = pyodide.FS.stat(path);
      if (pyodide.FS.isDir(stat.mode)) { visit(path); continue; }
      if (!pyodide.FS.isFile(stat.mode)) continue;
      const bytes = pyodide.FS.readFile(path);
      if (bytes.byteLength > ${MAX_PYTHON_WORKSPACE_FILE_BYTES}) throw new Error("Python generated a file over 512 KiB: " + path);
      total += bytes.byteLength;
      if (files.length >= ${MAX_PYTHON_WORKSPACE_FILES} || total > ${MAX_PYTHON_WORKSPACE_BYTES}) throw new Error("Python workspace output exceeded its mount budget.");
      files.push({ path, bytes });
    }
  };
  visit(root);
  return files;
};
self.onmessage = async ({ data }) => {
  let pyodide;
  try {
    const module = await import(PYODIDE_MODULE);
    pyodide = await module.loadPyodide({ indexURL: PYODIDE_BASE, fullStdLib: false });
  } catch (error) {
    __post({ ok:false, error:"Pyodide initialization failed: " + String(error && error.message || error) });
    return;
  }
  // The interpreter exists; the host now starts charging the job's own budget.
  __post({ type:"ready" });
  let stdout = "", stderr = "";
  pyodide.setStdout({ batched: value => { const next=boundedAppend(stdout,value), accepted=next.slice(stdout.length); stdout=next; if(accepted) __post({ type:"output", stream:"stdout", text:accepted }); } });
  pyodide.setStderr({ batched: value => { const next=boundedAppend(stderr,value), accepted=next.slice(stderr.length); stderr=next; if(accepted) __post({ type:"output", stream:"stderr", text:accepted }); } });
  try { pyodide.setStdin({ stdin: () => null }); } catch {}
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  try { Object.defineProperty(globalThis, "postMessage", { value:undefined, configurable:false, writable:false }); } catch {}
  mountWorkspace(pyodide, data);
  let exitCode = 0, value = null;
  try {
    const argv = ["airship.py", ...(Array.isArray(data.args) ? data.args : [])];
    const environment = data.env && typeof data.env === "object" ? data.env : {};
    await pyodide.runPythonAsync(
      "import os, sys\\n" +
      "sys.argv = " + JSON.stringify(argv) + "\\n" +
      "os.environ.update(" + JSON.stringify(environment) + ")",
    );
    const executionSource = data.sourcePath
      ? pyodide.FS.readFile(data.sourcePath, { encoding:"utf8" })
      : String(data.code || "");
    value = jsonValue(await pyodide.runPythonAsync(executionSource, { filename:data.sourcePath || "<airship>" }));
  } catch (error) {
    exitCode = 1;
    const next = boundedAppend(stderr, String(error && error.message || error));
    const accepted = next.slice(stderr.length);
    stderr = next;
    if (accepted) __post({ type:"output", stream:"stderr", text:accepted });
  }
  let workspaceFiles, workspaceError;
  try {
    workspaceFiles = collectWorkspace(pyodide, data.workspaceRoot);
  } catch (error) {
    // The run itself finished. Report the collection failure as a field and
    // omit workspaceFiles entirely: an empty list would be read as "the job
    // deleted every mounted file".
    workspaceError = "Python workspace collection failed: " + String(error && error.message || error);
  }
  __post({ ok:true, exitCode, stdout, stderr, valueJson:value, ...(workspaceError ? { workspaceError } : { workspaceFiles }) });
};`;
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
