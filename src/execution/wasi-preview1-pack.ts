import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import {
  isLocalFolderMountPath,
  isWorkspaceControlPlanePath,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type WorkspacePort,
} from "../workspace/contracts";
import { emitExecutionOutput, type ExecutionAdapter, type ExecutionRequest, type ExecutionResult } from "./runtime-registry";
import {
  BROWSER_WASI_SHIM_VERSION,
  WASI_PREVIEW1_EXCLUDED_SEGMENTS,
  WASI_PREVIEW1_MAX_ARTIFACT_BYTES,
  WASI_PREVIEW1_MAX_FILE_BYTES,
  WASI_PREVIEW1_MAX_FILES,
  WASI_PREVIEW1_MAX_WORKSPACE_BYTES,
  WASI_PREVIEW1_MAX_WORKSPACE_ERROR_CHARS,
} from "./wasi-preview1-contract";
import wasiWorkerUrl from "./wasi-preview1-worker.ts?worker&url";

const MAX_WASM_BASE64_CHARS = 5_600_000;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const WORKSPACE_ROOT = "/workspace";
const EXCLUDED_SEGMENTS = new Set<string>(WASI_PREVIEW1_EXCLUDED_SEGMENTS);

type WorkspaceFile = Readonly<{ path: string; content: string; revision?: string }>;
type WorkspaceSnapshot = Readonly<{ root: string; files: readonly WorkspaceFile[] }>;
type WorkerFile = Readonly<{ path: string; bytes: Uint8Array }>;
type WasiCompletion = ExecutionResult & Readonly<{
  workspaceFiles: readonly WorkerFile[];
  workspaceError?: string;
}>;

let trustedPolicy: Readonly<{ createScriptURL(value: string): unknown }> | undefined;

export function createWasiPreview1Adapter(): ExecutionAdapter {
  return {
    capability: {
      id: "wasi-preview1",
      label: `WebAssembly · WASI Preview 1 shim ${BROWSER_WASI_SHIM_VERSION}`,
      languages: ["compiled-wasm", "rust-wasm32-wasip1"],
      state: "ready",
      tier: "web-baseline",
      isolation: "disposable-worker",
      persistence: "workspace-checkpoint",
      commandInterface: "precompiled-wasi-command",
      shell: "none",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "terminate-worker",
      detail: "Runs precompiled WASI Preview 1 command artifacts, including Rust compiled elsewhere for wasm32-wasip1, in a disposable browser Worker with printable-ASCII argv, bounded streaming output, and an optional revision-checked virtual-workspace snapshot/writeback. The artifact is supplied as a workspace file path or inline base64; Airship does not compile it. It is not Bash, rustc, Cargo, a package manager, host filesystem access, or a socket/network runtime.",
    },
    async execute(request) {
      if (Boolean(request.wasmBase64) === Boolean(request.wasmPath)) {
        throw new Error("WASI execution requires exactly one of wasmBase64 or wasmPath.");
      }
      if (request.code || request.sourcePath) throw new Error("WASI executes a precompiled command artifact, not source code.");
      if (request.workspaceRoot && !request.workspace) {
        throw new Error("WASI workspace execution requires both workspaceRoot and a bound Airship workspace.");
      }
      if (request.wasmPath && !request.workspace) throw new Error("A WASI wasmPath artifact requires a bound Airship workspace.");
      if (request.workspace && !request.workspaceRoot && !request.wasmPath) {
        throw new Error("WASI received a bound workspace without a workspaceRoot or wasmPath.");
      }
      if (request.writeBack && !request.workspaceRoot) throw new Error("WASI writeback requires a workspaceRoot.");
      return executeWasiPreview1Request(request);
    },
  };
}

async function executeWasiPreview1Request(request: ExecutionRequest): Promise<ExecutionResult> {
  // The artifact is read OUTSIDE captureWorkspace on purpose. The mount budget
  // caps a mounted file at 512 KiB, while an artifact is separately bounded by
  // WASI_PREVIEW1_MAX_ARTIFACT_BYTES, so a 1 MiB command placed inside the
  // mounted root must not fail the run before it starts.
  const artifactPath = request.wasmPath ? normalizeWorkspacePath(request.wasmPath) : undefined;
  const wasm = artifactPath
    ? await readWorkspaceArtifact(request.workspace!, artifactPath)
    : decodeArtifactBase64(request.wasmBase64!);
  const snapshot = request.workspace && request.workspaceRoot
    ? await captureWorkspace(request.workspace, request.workspaceRoot, artifactPath)
    : undefined;
  const result = await runDisposableWasiBytes(
    wasm,
    request.args ?? [],
    request.env ?? {},
    request.timeoutMs,
    request.signal,
    request.onOutput,
    snapshot,
  );
  const workspace = snapshot && request.workspace
    ? result.workspaceError !== undefined
      ? unreconciledWorkspace(snapshot, request.writeBack === true, result.workspaceError)
      : await reconcileWorkspace(request.workspace, snapshot, result.workspaceFiles, request.writeBack === true, result.exitCode)
    : undefined;
  const { workspaceFiles: _workspaceFiles, workspaceError: _workspaceError, ...publicResult } = result;
  return { ...publicResult, ...(workspace ? { workspace } : {}) };
}

/**
 * Low-level base64 command runner retained for the browser execution gate.
 * Product calls should use the registered adapter so the workspace artifact
 * channel and workspace adoption are recorded.
 */
export async function runDisposableWasi(
  wasmBase64: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: ExecutionRequest["onOutput"],
  workspace?: WorkspaceSnapshot,
): Promise<WasiCompletion> {
  return runDisposableWasiBytes(decodeArtifactBase64(wasmBase64), args, env, timeoutMs, signal, onOutput, workspace);
}

async function runDisposableWasiBytes(
  wasm: Uint8Array,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: ExecutionRequest["onOutput"],
  workspace?: WorkspaceSnapshot,
): Promise<WasiCompletion> {
  assertBrowserSupport();
  validateInvocation(wasm, args, env);
  const worker = new Worker(trustedWasiWorkerUrl(wasiWorkerUrl) as string, {
    type: "module",
    name: "airship-wasi-preview1",
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: WasiCompletion) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`WASI execution exceeded ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "Disposable WASI Worker failed."));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        finish(new Error("Disposable WASI Worker returned malformed output."));
        return;
      }
      const message = event.data as Record<string, unknown>;
      if (message.type === "output") {
        const stream = message.stream === "stderr" ? "stderr" : "stdout";
        if (typeof message.text === "string") emitExecutionOutput(onOutput, { stream, text: message.text.slice(0, 65_536) });
        return;
      }
      if (message.type === "failed") {
        finish(new Error(typeof message.error === "string" ? message.error : "Disposable WASI execution failed."));
        return;
      }
      if (message.type !== "completed") {
        finish(new Error("Disposable WASI Worker returned an unknown terminal message."));
        return;
      }
      // A completed run keeps its exit code and streams even when the guest's
      // generated files could not be collected. Only a mounted run may return
      // files at all, so an unmounted payload carrying them is malformed.
      const workspaceError = typeof message.workspaceError === "string"
        ? message.workspaceError.slice(0, WASI_PREVIEW1_MAX_WORKSPACE_ERROR_CHARS)
        : undefined;
      let workspaceFiles: readonly WorkerFile[] = [];
      if (!workspace) {
        if (message.files !== undefined || workspaceError !== undefined) {
          finish(new Error("Disposable WASI Worker returned workspace state for an unmounted run."));
          return;
        }
      } else if (workspaceError === undefined) {
        try { workspaceFiles = parseWorkerFiles(message.files); }
        catch (error) { finish(error); return; }
      }
      finish(undefined, {
        runtime: "wasi-preview1",
        exitCode: typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode) ? message.exitCode : 1,
        stdout: typeof message.stdout === "string" ? message.stdout.slice(0, MAX_OUTPUT_CHARS) : "",
        stderr: typeof message.stderr === "string" ? message.stderr.slice(0, MAX_OUTPUT_CHARS) : "",
        provenance: {
          capabilityTier: "web-baseline",
          authority: "browser",
          engine: `browser-wasi-shim-${BROWSER_WASI_SHIM_VERSION}-worker`,
          artifactKind: "wasi-command",
        },
        workspaceFiles,
        ...(workspaceError !== undefined ? { workspaceError } : {}),
      });
    };
    if (signal.aborted) onAbort();
    else worker.postMessage({
      type: "run",
      wasm,
      args: [...args],
      env: { ...env },
      files: workspace?.files.map(({ path, content }) => ({
        path: relativePath(path, workspace.root),
        bytes: decodeWorkspaceBytes(content),
      })) ?? [],
      collectWorkspace: workspace !== undefined,
    });
  });
}

/**
 * Reads the command artifact through the same control-plane and excluded
 * segment guards as a mount, so `.airship`, `.git`, and `node_modules` are not
 * reachable as an execution channel either.
 */
async function readWorkspaceArtifact(workspace: WorkspacePort, path: string): Promise<Uint8Array> {
  assertAllowedWorkspacePath(path, WORKSPACE_ROOT);
  const file = await workspace.read(path);
  if (!file) throw new Error(`The WASI command artifact is not in the workspace: ${path}`);
  const bytes = decodeWorkspaceBytes(file.content);
  if (bytes.byteLength === 0) throw new Error(`The WASI command artifact is empty: ${path}`);
  return bytes;
}

async function captureWorkspace(
  workspace: WorkspacePort,
  rootInput: string,
  artifactPath?: string,
): Promise<WorkspaceSnapshot> {
  const root = normalizeWorkspacePath(rootInput);
  const entries = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    // A folder attached from this device is not workspace state; see
    // `assertAllowedWorkspacePath`.
    .filter(({ path }) => !isLocalFolderMountPath(path))
    // The artifact is already loaded through its own 4 MiB budget. Leaving it
    // in the mount would re-apply the 512 KiB per-file mount cap to the very
    // binary being executed and would offer it back for writeback.
    .filter(({ path }) => path !== artifactPath)
    .filter(({ path }) => !relativeSegments(path, root).some((segment) => EXCLUDED_SEGMENTS.has(segment)));
  if (entries.length > WASI_PREVIEW1_MAX_FILES) throw new Error(`WASI workspace snapshot exceeds ${WASI_PREVIEW1_MAX_FILES} files.`);
  const files: WorkspaceFile[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.path === root) continue;
    const file = await workspace.read(entry.path);
    if (!file || file.revision !== entry.revision) throw new WorkspaceConflictError(`Workspace changed while mounting WASI: ${entry.path}`);
    const size = workspaceContentByteLength(file.content);
    if (size > WASI_PREVIEW1_MAX_FILE_BYTES) throw new Error(`WASI workspace file exceeds 512 KiB: ${entry.path}`);
    bytes += size;
    if (bytes > WASI_PREVIEW1_MAX_WORKSPACE_BYTES) throw new Error("WASI workspace snapshot exceeds 4 MiB.");
    files.push({ path: file.path, content: file.content, revision: file.revision });
  }
  return { root, files };
}

async function reconcileWorkspace(
  workspace: WorkspacePort,
  snapshot: WorkspaceSnapshot,
  returnedFiles: readonly WorkerFile[],
  writeBackRequested: boolean,
  exitCode: number,
): Promise<NonNullable<ExecutionResult["workspace"]>> {
  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  const returned = new Map<string, string>();
  let returnedBytes = 0;
  for (const file of returnedFiles) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\")) throw new Error("WASI returned an invalid workspace-relative path.");
    if (file.bytes.byteLength > WASI_PREVIEW1_MAX_FILE_BYTES) throw new Error(`WASI output file exceeds 512 KiB: ${file.path}`);
    returnedBytes += file.bytes.byteLength;
    if (returnedBytes > WASI_PREVIEW1_MAX_WORKSPACE_BYTES) throw new Error("WASI workspace output exceeds 4 MiB.");
    const path = normalizeWorkspacePath(`${snapshot.root}/${file.path}`);
    assertAllowedWorkspacePath(path, snapshot.root);
    if (path === snapshot.root || !path.startsWith(`${snapshot.root}/`)) throw new Error("WASI returned a path outside its workspace root.");
    if (returned.has(path)) throw new Error(`WASI returned duplicate normalized workspace path: ${path}`);
    returned.set(path, encodeWorkspaceBytes(file.bytes));
  }
  const changed = [...returned]
    .filter(([path, content]) => original.get(path)?.content !== content)
    .sort(([left], [right]) => left.localeCompare(right));
  const deleted = snapshot.files.filter(({ path }) => !returned.has(path)).sort((left, right) => left.path.localeCompare(right.path));
  const changedPaths = [...changed.map(([path]) => path), ...deleted.map(({ path }) => path)].sort();
  const writtenPaths: string[] = [];
  const deletedPaths: string[] = [];
  if (writeBackRequested && exitCode === 0) {
    for (const [path] of changed) {
      const expected = original.get(path)?.revision;
      const current = await workspace.read(path);
      if (expected ? current?.revision !== expected : current !== undefined) throw new WorkspaceConflictError(`WASI writeback conflicted at ${path}.`);
    }
    for (const file of deleted) {
      if ((await workspace.read(file.path))?.revision !== file.revision) throw new WorkspaceConflictError(`WASI deletion conflicted at ${file.path}.`);
    }
    for (const [path, content] of changed) {
      await workspace.write(path, content, { expectedRevision: original.get(path)?.revision ?? null });
      writtenPaths.push(path);
    }
    for (const file of deleted) {
      await workspace.remove(file.path, { expectedRevision: file.revision });
      deletedPaths.push(file.path);
    }
  }
  return {
    root: snapshot.root,
    mountedFiles: snapshot.files.length,
    changedPaths,
    writtenPaths,
    deletedPaths,
    writeBackRequested,
    adopted: writeBackRequested && exitCode === 0 && changedPaths.length > 0,
    writeBack: writeBackRequested,
  };
}

/**
 * The command ran, but its change set is unknown. Nothing is adopted and no
 * path is reported as changed or deleted, because an incomplete collection
 * cannot distinguish "not produced" from "not collected".
 */
function unreconciledWorkspace(
  snapshot: WorkspaceSnapshot,
  writeBackRequested: boolean,
  workspaceError: string,
): NonNullable<ExecutionResult["workspace"]> {
  return {
    root: snapshot.root,
    mountedFiles: snapshot.files.length,
    changedPaths: [],
    writtenPaths: [],
    deletedPaths: [],
    writeBackRequested,
    adopted: false,
    writeBack: writeBackRequested,
    workspaceError,
  };
}

function parseWorkerFiles(value: unknown): readonly WorkerFile[] {
  if (!Array.isArray(value) || value.length > WASI_PREVIEW1_MAX_FILES) throw new Error("WASI Worker returned an invalid workspace file list.");
  let total = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("WASI Worker returned an invalid workspace file.");
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || !(record.bytes instanceof Uint8Array)) throw new Error("WASI Worker returned an invalid workspace file payload.");
    if (record.bytes.byteLength > WASI_PREVIEW1_MAX_FILE_BYTES) throw new Error(`WASI output file exceeds 512 KiB: ${record.path}`);
    total += record.bytes.byteLength;
    if (total > WASI_PREVIEW1_MAX_WORKSPACE_BYTES) throw new Error("WASI workspace output exceeds 4 MiB.");
    return Object.freeze({ path: record.path, bytes: record.bytes });
  });
}

function decodeArtifactBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length > MAX_WASM_BASE64_CHARS) {
    throw new Error("wasmBase64 is malformed or exceeds the 4 MiB artifact limit.");
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("The WASI command artifact is not valid base64."); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validateInvocation(wasm: Uint8Array, args: readonly string[], env: Readonly<Record<string, string>>): void {
  if (wasm.byteLength === 0 || wasm.byteLength > WASI_PREVIEW1_MAX_ARTIFACT_BYTES) {
    throw new Error("The WASI command artifact is empty or exceeds the 4 MiB artifact limit.");
  }
  // browser_wasi_shim 0.4.2 sizes argv by JavaScript code units. Keep this
  // exact adapter ASCII-only until the pinned shim fixes its UTF-8 sizing.
  if (args.length > 64 || args.some((value) => value.length > 4_096 || !/^[\x20-\x7e]*$/u.test(value))) {
    throw new Error("WASI arguments must be printable ASCII and stay within the 64-item/4-KiB budget.");
  }
  const entries = Object.entries(env);
  if (entries.length > 64 || entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(key) || value.length > 4_096)) {
    throw new Error("WASI environment exceeds the 64-entry/4-KiB budget.");
  }
}

function assertBrowserSupport(): void {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    throw new Error("Disposable WASI Preview 1 Workers are unavailable in this environment.");
  }
}

function trustedWasiWorkerUrl(value: string): unknown {
  const expected = new URL(wasiWorkerUrl, globalThis.location.href).href;
  const url = new URL(value, globalThis.location.href);
  if (url.href !== expected || url.origin !== globalThis.location.origin) throw new TypeError("WASI Worker must be the pinned same-origin release asset.");
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown } };
  }).trustedTypes;
  if (!factory) return url.href;
  trustedPolicy ??= factory.createPolicy("airship-wasi-preview1-worker", {
    createScriptURL(candidate) {
      const candidateUrl = new URL(candidate, globalThis.location.href);
      if (candidateUrl.href !== expected || candidateUrl.origin !== globalThis.location.origin) {
        throw new TypeError("WASI Worker must be the pinned same-origin release asset.");
      }
      return candidateUrl.href;
    },
  });
  return trustedPolicy.createScriptURL(url.href);
}

function relativePath(path: string, root: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function relativeSegments(path: string, root: string): string[] {
  const relative = relativePath(path, root);
  return relative ? relative.split("/") : [];
}

function assertAllowedWorkspacePath(path: string, root: string): void {
  // Same rule, same reason as `ATTACHED_FOLDER_EXCLUSION` in the shell pack: a
  // write-back rooted at /workspace would land on the person's own disk with no
  // approval request, because the reviewed arguments never named the folder.
  if (isLocalFolderMountPath(path)) {
    throw new Error(
      "This runtime does not carry the folder you attached from this device: it copies files and writes them back"
      + ` with no approval request, and that folder is written in place. Refused: ${path}`,
    );
  }
  if (isWorkspaceControlPlanePath(path)) throw new Error(`WASI workspace excludes control-plane path: ${path}`);
  const excluded = relativeSegments(path, root).find((segment) => EXCLUDED_SEGMENTS.has(segment));
  if (excluded) throw new Error(`WASI workspace excludes the ${excluded} path segment.`);
}
