import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import {
  ClientExecutionRuntime,
  type ExecutionAdapter,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRuntimeId,
} from "../execution/runtime-registry";
import type { ToolRegistry } from "./registry";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, type WorkspacePort } from "../workspace/contracts";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const MAX_PYTHON_WORKSPACE_FILES = 256;
const MAX_PYTHON_WORKSPACE_FILE_BYTES = 512 * 1_024;
const MAX_PYTHON_WORKSPACE_BYTES = 4 * 1_024 * 1_024;
const WORKER_POLICY_NAME = "airship-worker";
const PYODIDE_VERSION = "314.0.2";
const PYODIDE_ASSET_PATH = "/execution-packs/pyodide/";

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

export function registerExecutionTools(registry: ToolRegistry, workspace?: WorkspacePort): void {
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
      const code = stringArgument(args.code, "code");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      const result = await runDisposableWorker(code, timeoutMs, context.signal);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: { timeoutMs, logs: result.logs.length },
      };
    },
  };
  registry.register(executeJavascript);
  registry.register({
    definition: {
      name: "install_execution_runtime",
      description: "Cold-start an optional browser runtime; it reports ready only after a real probe.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["python-pyodide", "node-webcontainer"] },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 30_000 },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const runtime = stringArgument(args.runtime, "runtime");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_INSTALL_TIMEOUT_MS;
      if (runtime === "node-webcontainer") return activateNodeRuntime(context.signal, timeoutMs);
      if (runtime !== "python-pyodide") throw new Error(`${runtime} cannot be installed by this Airship release.`);
      await installPyodideExecutionRuntime(timeoutMs, context.signal);
      const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === runtime);
      return {
        content: JSON.stringify(capability, null, 2),
        metadata: { runtime, state: capability?.state ?? "unavailable", version: PYODIDE_VERSION },
      };
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
      return { content: JSON.stringify(getClientExecutionRuntime().capabilities(), null, 2) };
    },
  });
  registry.register({
    definition: {
      name: "execute_code",
      description: "Execute code in a ready client-side runtime. JavaScript Worker and compact WASI Preview 1 are built in; install Python explicitly first. Node/npm projects use the separately activated execute_node_project path.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["javascript-worker", "wasi-preview1", "python-pyodide"] },
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          wasmBase64: { type: "string", minLength: 12, maxLength: MAX_WASM_BASE64_CHARS },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          sourcePath: { type: "string", minLength: 1, maxLength: 1_024 },
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const runtime = stringArgument(args.runtime, "runtime") as ExecutionRuntimeId;
      const workspaceRoot = typeof args.workspaceRoot === "string" ? normalizeWorkspacePath(args.workspaceRoot) : undefined;
      const sourcePath = typeof args.sourcePath === "string" ? normalizeWorkspacePath(args.sourcePath) : undefined;
      if ((workspaceRoot || sourcePath || args.writeBack === true) && runtime !== "python-pyodide") {
        throw new Error("Workspace-mounted execute_code is currently available only for python-pyodide.");
      }
      if ((sourcePath || args.writeBack === true) && !workspaceRoot) {
        throw new Error("Python sourcePath and writeBack require a workspaceRoot.");
      }
      if (sourcePath && args.code !== undefined) throw new Error("Use either Python code or sourcePath, not both.");
      const request: ExecutionRequest = {
        runtime,
        ...(typeof args.code === "string" ? { code: args.code } : {}),
        ...(typeof args.wasmBase64 === "string" ? { wasmBase64: args.wasmBase64 } : {}),
        args: stringArray(args.args, "args"),
        env: stringRecord(args.env, "env"),
        ...(workspaceRoot ? { workspaceRoot, workspace } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        writeBack: args.writeBack === true,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
        signal: context.signal,
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
        },
        isError: result.exitCode !== 0,
      };
    },
  });
  registry.register({
    definition: {
      name: "deactivate_execution_runtime",
      description: "Terminate an optional runtime and release its in-tab processes and memory.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: { runtime: { type: "string", enum: ["node-webcontainer"] } },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const args = objectArguments(argumentsValue);
      const runtimeId = stringArgument(args.runtime, "runtime") as ExecutionRuntimeId;
      if (nodePack) await (await nodePack).deactivateNodeWebContainer();
      getClientExecutionRuntime().unregister(runtimeId);
      getClientExecutionRuntime().clearOptionalState(runtimeId);
      return {
        content: JSON.stringify(
          getClientExecutionRuntime().capabilities().find(({ id }) => id === runtimeId),
          null,
          2,
        ),
      };
    },
  });
  registry.register({
    definition: {
      name: "execute_node_project",
      description: "Run a direct Node/npm command in the in-browser WebContainer on a bounded workspace snapshot; writeBack adopts revision-checked text changes.",
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
        workspaceRoot: normalizeWorkspacePath(stringArgument(args.workspaceRoot, "workspaceRoot")),
        command: stringArgument(args.command, "command"),
        args: stringArray(args.args, "args"),
        env: stringRecord(args.env, "env"),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000,
        writeBack: args.writeBack === true,
        signal: context.signal,
      };
      const result = await getClientExecutionRuntime().execute(request);
      return {
        content: JSON.stringify(result, null, 2),
        metadata: { runtime: result.runtime, exitCode: result.exitCode, provider: "StackBlitz WebContainers" },
        isError: result.exitCode !== 0,
      };
    },
  });
}

/** Entry point used by the lightweight schemas in the baseline tool bundle. */
export function executeExecutionTool(
  name: string,
  argumentsValue: JsonValue,
  context: ToolContext,
  workspace?: WorkspacePort,
): Promise<ToolExecutionResult> {
  const tools = new Map<string, Tool>();
  registerExecutionTools({ register(tool) { tools.set(tool.definition.name, tool); } } as ToolRegistry, workspace);
  const tool = tools.get(name);
  if (!tool) throw new Error(`Unknown execution tool: ${name}`);
  return tool.execute(argumentsValue, context);
}

/** Optional same-origin packs call this only after their pinned assets load. */
export function installExecutionAdapter(adapter: ExecutionAdapter): void {
  getClientExecutionRuntime().register(adapter);
}

async function activateNodeRuntime(signal: AbortSignal, timeoutMs: number): Promise<ToolExecutionResult> {
  const runtimeId: ExecutionRuntimeId = "node-webcontainer";
  const capability = getClientExecutionRuntime().capabilities().find(({ id }) => id === runtimeId);
  if (!capability) throw new Error(`Unknown optional runtime: ${runtimeId}`);
  if (capability.state === "ready") return { content: JSON.stringify(capability, null, 2) };
  if (capability.state === "unavailable") throw new Error(capability.detail);
  getClientExecutionRuntime().setOptionalState(runtimeId, "activating", "Loading StackBlitz WebContainers.");
  try {
    nodePack ??= import("../execution/node-webcontainer-pack");
    const adapter = await (await nodePack).activateNodeWebContainer(signal, timeoutMs);
    if (!getClientExecutionRuntime().capabilities().some(({ id, state }) => id === runtimeId && state === "ready")) {
      getClientExecutionRuntime().register(adapter);
    }
    return {
      content: JSON.stringify(adapter.capability, null, 2),
      metadata: { runtime: runtimeId, provider: "StackBlitz WebContainers", browserCompute: true, remoteRuntimeDelivery: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown WebContainer activation failure.";
    if (!getClientExecutionRuntime().capabilities().some(({ id, state }) => id === runtimeId && state === "ready")) {
      getClientExecutionRuntime().setOptionalState(runtimeId, "failed", message);
    }
    throw error;
  }
}

export function getClientExecutionRuntime(): ClientExecutionRuntime {
  if (clientRuntime) return clientRuntime;
  clientRuntime = new ClientExecutionRuntime();
  if (supportsDisposableWorkers()) {
    clientRuntime.register({
      capability: {
        id: "javascript-worker",
        label: "JavaScript · disposable Worker",
        languages: ["javascript"],
        state: "ready",
        isolation: "disposable-worker",
        persistence: "ephemeral",
        detail: "Bounded evaluation with no DOM, storage, workspace, or network binding.",
      },
      async execute(request) {
        if (!request.code) throw new Error("JavaScript execution requires code.");
        const result = await runDisposableWorker(request.code, request.timeoutMs, request.signal);
        return {
          runtime: "javascript-worker",
          exitCode: 0,
          stdout: result.logs.join("\n"),
          stderr: "",
          value: result.value,
        };
      },
    });
    if (typeof WebAssembly !== "undefined") {
      clientRuntime.register({
        capability: {
          id: "wasi-preview1",
          label: "WebAssembly · compact WASI Preview 1",
          languages: ["compiled-wasm"],
          state: "ready",
          isolation: "disposable-worker",
          persistence: "ephemeral",
          detail: "Runs a base64 command module with args, env, clock, random, stdout, and stderr; no sockets or mounted filesystem.",
        },
        async execute(request) {
          if (!request.wasmBase64) throw new Error("WASI execution requires wasmBase64.");
          return runDisposableWasi(request.wasmBase64, request.args ?? [], request.env ?? {}, request.timeoutMs, request.signal);
        },
      });
    }
  }
  return clientRuntime;
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
    const probe = await runDisposablePyodide(
      "import sys\nprint(f'{sys.version_info.major}.{sys.version_info.minor}')",
      [],
      {},
      timeoutMs,
      signal,
    );
    if (probe.exitCode !== 0 || !/^3\.\d+/u.test(probe.stdout.trim())) {
      throw new Error(`Pyodide ${PYODIDE_VERSION} did not pass its interpreter probe.`);
    }
    runtime.register({
      capability: {
        id: "python-pyodide",
        label: `Python · Pyodide ${PYODIDE_VERSION}`,
        languages: ["python"],
        state: "ready",
        isolation: "disposable-worker",
        persistence: "ephemeral",
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

export async function runDisposableWorker(code: string, timeoutMs: number, signal: AbortSignal): Promise<{
  value: JsonValue;
  logs: string[];
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
    const finish = (error?: unknown, value?: { value: JsonValue; logs: string[] }) => {
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
      if (record.ok !== true) {
        finish(new Error(typeof record.error === "string" ? record.error : "Disposable JavaScript execution failed."));
        return;
      }
      finish(undefined, {
        value: jsonSafe(record.value),
        logs: Array.isArray(record.logs) ? record.logs.filter((item): item is string => typeof item === "string").slice(0, 200) : [],
      });
    };
    if (signal.aborted) onAbort();
  });
}

export async function runDisposableWasi(
  wasmBase64: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  if (!supportsDisposableWorkers() || typeof WebAssembly === "undefined") {
    throw new Error("Disposable WASI workers are unavailable in this environment.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(wasmBase64) || wasmBase64.length > MAX_WASM_BASE64_CHARS) {
    throw new Error("wasmBase64 is malformed or exceeds the 4 MiB artifact limit.");
  }
  const url = URL.createObjectURL(new Blob([wasiWorkerSource()], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedWorkerUrl(url) as string, { name: "airship-wasi-preview1" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: ExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`WASI execution exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Disposable WASI worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        finish(new Error("Disposable WASI worker returned malformed output."));
        return;
      }
      const message = event.data as Record<string, unknown>;
      if (message.ok !== true) {
        finish(new Error(typeof message.error === "string" ? message.error : "Disposable WASI execution failed."));
        return;
      }
      finish(undefined, {
        runtime: "wasi-preview1",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : 1,
        stdout: typeof message.stdout === "string" ? message.stdout : "",
        stderr: typeof message.stderr === "string" ? message.stderr : "",
      });
    };
    if (signal.aborted) onAbort();
    else worker.postMessage({ wasmBase64, args: [...args], env: { ...env } });
  });
}

type PythonWorkspaceFile = Readonly<{ path: string; content: string; revision?: string }>;
type PythonWorkspaceSnapshot = Readonly<{
  root: string;
  files: readonly PythonWorkspaceFile[];
}>;
type PyodideWorkerResult = ExecutionResult & Readonly<{ workspaceFiles?: readonly PythonWorkspaceFile[] }>;

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
    snapshot,
    request.sourcePath,
  );
  if (!snapshot || !request.workspace) return result;

  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  const returned = new Map((result.workspaceFiles ?? []).map((file) => [file.path, file]));
  const changed = [...returned.values()]
    .filter((file) => original.get(file.path)?.content !== file.content)
    .sort((left, right) => left.path.localeCompare(right.path));
  const deleted = snapshot.files
    .filter((file) => !returned.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
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
  const { workspaceFiles: _workspaceFiles, ...publicResult } = result;
  return {
    ...publicResult,
    workspace: {
      root: snapshot.root,
      mountedFiles: snapshot.files.length,
      changedPaths,
      writtenPaths,
      deletedPaths,
      writeBack: request.writeBack === true,
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
  const entries = (await workspace.list(root)).filter(({ path }) => !isWorkspaceControlPlanePath(path));
  if (entries.length > MAX_PYTHON_WORKSPACE_FILES) {
    throw new Error(`Python workspace mount exceeds ${MAX_PYTHON_WORKSPACE_FILES} files.`);
  }
  const files: PythonWorkspaceFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.size > MAX_PYTHON_WORKSPACE_FILE_BYTES) {
      throw new Error(`Python workspace file exceeds 512 KiB: ${entry.path}`);
    }
    const file = await workspace.read(entry.path);
    if (!file) throw new Error(`Python workspace file disappeared during snapshot: ${entry.path}`);
    const bytes = new TextEncoder().encode(file.content).byteLength;
    totalBytes += bytes;
    if (totalBytes > MAX_PYTHON_WORKSPACE_BYTES) throw new Error("Python workspace mount exceeds 4 MiB.");
    files.push({ path: file.path, content: file.content, revision: file.revision });
  }
  if (sourcePath && !files.some(({ path }) => path === sourcePath)) {
    throw new Error(`Python source file is not present in the workspace snapshot: ${sourcePath}`);
  }
  return { root, files };
}

export async function runDisposablePyodide(
  code: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  workspace?: PythonWorkspaceSnapshot,
  sourcePath?: string,
): Promise<PyodideWorkerResult> {
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
    const timer = setTimeout(() => finish(new Error(`Python execution exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Disposable Pyodide worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        finish(new Error("Disposable Pyodide worker returned malformed output."));
        return;
      }
      const message = event.data as Record<string, unknown>;
      if (message.ok !== true) {
        finish(new Error(typeof message.error === "string" ? message.error : "Disposable Pyodide initialization failed."));
        return;
      }
      const workspaceFiles = Array.isArray(message.workspaceFiles)
        ? message.workspaceFiles.filter(isPythonWorkspaceFile).slice(0, MAX_PYTHON_WORKSPACE_FILES)
        : undefined;
      finish(undefined, {
        runtime: "python-pyodide",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : 1,
        stdout: typeof message.stdout === "string" ? message.stdout.slice(0, MAX_OUTPUT_CHARS) : "",
        stderr: typeof message.stderr === "string" ? message.stderr.slice(0, MAX_OUTPUT_CHARS) : "",
        value: jsonSafe(message.value),
        ...(workspaceFiles ? { workspaceFiles } : {}),
      });
    };
    if (signal.aborted) onAbort();
    else worker.postMessage({
      code,
      args: [...args],
      env: { ...env },
      ...(workspace ? { workspaceRoot: workspace.root, workspaceFiles: workspace.files.map(({ path, content }) => ({ path, content })) } : {}),
      ...(sourcePath ? { sourcePath } : {}),
    });
  });
}

function isPythonWorkspaceFile(value: unknown): value is PythonWorkspaceFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.content === "string";
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

function workerSource(code: string): string {
  return `"use strict";
const __logs = [];
const __render = value => {
  try { return typeof value === "string" ? value : JSON.stringify(value); }
  catch { return String(value); }
};
console.log = (...values) => { if (__logs.length < 200) __logs.push(values.map(__render).join(" ").slice(0, 4096)); };
console.info = console.log;
console.warn = console.log;
console.error = console.log;
for (const name of ["fetch", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
}
Promise.resolve().then(async () => {
  const value = await (async () => {
${code}
  })();
  postMessage({ ok: true, value: value === undefined ? null : value, logs: __logs });
}).catch(error => postMessage({ ok: false, error: String(error && error.stack || error), logs: __logs }));`;
}

function wasiWorkerSource(): string {
  return `"use strict";
const LIMIT = 262144;
const encode = new TextEncoder();
const decode = new TextDecoder();
self.onmessage = async ({ data }) => {
  let stdout = "", stderr = "", memory, instance, exitCode = 0;
  const append = (fd, bytes) => {
    const text = decode.decode(bytes);
    if (fd === 1) stdout = (stdout + text).slice(0, LIMIT);
    if (fd === 2) stderr = (stderr + text).slice(0, LIMIT);
  };
  const view = () => {
    if (!memory) throw new Error("WASI command did not export memory.");
    return new DataView(memory.buffer);
  };
  const writeStrings = (values, pointers, buffer) => {
    const dataView = view();
    let cursor = buffer;
    values.forEach((value, index) => {
      const bytes = encode.encode(value + "\\0");
      dataView.setUint32(pointers + index * 4, cursor, true);
      new Uint8Array(memory.buffer, cursor, bytes.length).set(bytes);
      cursor += bytes.length;
    });
  };
  const argv = ["airship-wasi", ...(Array.isArray(data.args) ? data.args : [])];
  const environ = Object.entries(data.env || {}).map(([key, value]) => key + "=" + value);
  const wasi = {
    args_sizes_get(argc, size) { const v=view(); v.setUint32(argc, argv.length, true); v.setUint32(size, argv.reduce((n,s)=>n+encode.encode(s).length+1,0), true); return 0; },
    args_get(pointers, buffer) { writeStrings(argv, pointers, buffer); return 0; },
    environ_sizes_get(count, size) { const v=view(); v.setUint32(count, environ.length, true); v.setUint32(size, environ.reduce((n,s)=>n+encode.encode(s).length+1,0), true); return 0; },
    environ_get(pointers, buffer) { writeStrings(environ, pointers, buffer); return 0; },
    fd_write(fd, iovs, length, written) {
      const v=view(); let total=0;
      for (let i=0;i<length;i+=1) { const pointer=v.getUint32(iovs+i*8,true), size=v.getUint32(iovs+i*8+4,true); append(fd,new Uint8Array(memory.buffer,pointer,size)); total+=size; }
      v.setUint32(written,total,true); return fd === 1 || fd === 2 ? 0 : 8;
    },
    fd_close() { return 0; }, fd_fdstat_get() { return 0; }, fd_seek() { return 70; },
    clock_time_get(_clock, _precision, time) { const now=BigInt(Date.now())*1000000n; view().setBigUint64(time,now,true); return 0; },
    random_get(pointer, length) { crypto.getRandomValues(new Uint8Array(memory.buffer,pointer,length)); return 0; },
    proc_exit(code) { const error=new Error("WASI_EXIT"); error.exitCode=code; throw error; },
  };
  const imports = new Proxy(wasi, { get(target, name) { return target[name] || (() => 52); } });
  try {
    const binary = Uint8Array.from(atob(data.wasmBase64), value => value.charCodeAt(0));
    if (binary.byteLength > 4194304 || !WebAssembly.validate(binary)) throw new Error("Invalid or oversized WebAssembly artifact.");
    const result = await WebAssembly.instantiate(binary, { wasi_snapshot_preview1: imports, wasi_unstable: imports });
    instance = result.instance; memory = instance.exports.memory;
    if (memory && memory.buffer.byteLength > 67108864) throw new Error("WASI initial memory exceeds 64 MiB.");
    const start = instance.exports._start || instance.exports._initialize;
    if (typeof start !== "function") throw new Error("WASI command must export _start or _initialize.");
    try { start(); } catch (error) { if (error && error.message === "WASI_EXIT") exitCode=error.exitCode; else throw error; }
    postMessage({ ok:true, exitCode, stdout, stderr });
  } catch (error) { postMessage({ ok:false, error:String(error && error.stack || error) }); }
};`;
}

function pyodideWorkerSource(assetBase: string): string {
  return `"use strict";
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
    const encoded = JSON.stringify(converted === undefined ? null : converted);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch { return String(converted); }
  finally { try { if (value && typeof value.destroy === "function") value.destroy(); } catch {} }
};
const mountWorkspace = (pyodide, data) => {
  if (!data.workspaceRoot) return;
  pyodide.FS.mkdirTree(data.workspaceRoot);
  for (const file of Array.isArray(data.workspaceFiles) ? data.workspaceFiles : []) {
    const slash = file.path.lastIndexOf("/");
    pyodide.FS.mkdirTree(file.path.slice(0, slash) || "/workspace");
    pyodide.FS.writeFile(file.path, file.content, { encoding:"utf8" });
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
      let content;
      try { content = new TextDecoder("utf-8", { fatal:true }).decode(bytes); } catch { continue; }
      total += bytes.byteLength;
      if (files.length >= ${MAX_PYTHON_WORKSPACE_FILES} || total > ${MAX_PYTHON_WORKSPACE_BYTES}) throw new Error("Python workspace output exceeded its mount budget.");
      files.push({ path, content });
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
    postMessage({ ok:false, error:"Pyodide initialization failed: " + String(error && error.message || error) });
    return;
  }
  let stdout = "", stderr = "";
  pyodide.setStdout({ batched: value => { stdout = boundedAppend(stdout, value); } });
  pyodide.setStderr({ batched: value => { stderr = boundedAppend(stderr, value); } });
  try { pyodide.setStdin({ stdin: () => null }); } catch {}
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts", "Worker", "SharedWorker"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
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
    stderr = boundedAppend(stderr, String(error && error.message || error));
  }
  try {
    postMessage({ ok:true, exitCode, stdout, stderr, value, workspaceFiles:collectWorkspace(pyodide, data.workspaceRoot) });
  } catch (error) {
    postMessage({ ok:false, error:"Python workspace collection failed: " + String(error && error.message || error) });
  }
};`;
}

function supportsDisposableWorkers(): boolean {
  return typeof Worker !== "undefined" && typeof URL.createObjectURL === "function";
}

function jsonSafe(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value === undefined ? null : value);
    if (serialized === undefined) return null;
    return JSON.parse(serialized) as JsonValue;
  } catch {
    return String(value);
  }
}

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
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
