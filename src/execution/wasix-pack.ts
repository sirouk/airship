import type { JsonValue } from "../core/contracts";
import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import { emitExecutionOutput, type ExecutionAdapter, type ExecutionRequest, type ExecutionResult } from "./runtime-registry";
import {
  WASMER_SDK_VERSION,
  WASIX_BASH_SPEC,
  WASIX_BASH_WEBC_SHA256,
  WASIX_COREUTILS_SPEC,
  WASIX_COREUTILS_WEBC_SHA256,
  WASIX_EXCLUDED_SEGMENTS,
  WASIX_MAX_FILE_BYTES,
  WASIX_MAX_FILES,
  WASIX_MAX_WORKSPACE_BYTES,
} from "./wasix-contract";
import wasixWorkerUrl from "./wasix-worker.ts?worker&url";

const EXCLUDED_SEGMENTS = new Set<string>(WASIX_EXCLUDED_SEGMENTS);
const CANCEL_ACK_TIMEOUT_MS = 1_000;

type WorkspaceFile = Readonly<{ path: string; content: string; revision?: string }>;
type WorkspaceSnapshot = Readonly<{ root: string; files: readonly WorkspaceFile[] }>;
type WorkerCompletion = Readonly<{
  exitCode: number;
  providerExitCode: number;
  stdout: string;
  stderr: string;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>;

type WorkerMessage =
  | Readonly<{ type: "phase"; phase: string }>
  | Readonly<{ type: "output"; stream: "stdout" | "stderr"; text: string }>
  | Readonly<{ type: "completed"; exitCode: number; providerExitCode: number; stdout: string; stderr: string; files: readonly Readonly<{ path: string; bytes: Uint8Array }>[] }>
  | Readonly<{ type: "failed"; error: string }>
  | Readonly<{ type: "worker-tree-stopped"; reason: "cancelled" | "completed" | "failed"; workers: number }>;

let trustedPolicy: Readonly<{ createScriptURL(value: string): unknown }> | undefined;

export async function activateWasixExecutionAdapter(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ExecutionAdapter> {
  assertWasixBrowserSupport();
  const started = performance.now();
  const probe = await runWasixWorker({
    runtime: "wasix",
    code: "printf 'airship-wasix-ready\\n'",
    timeoutMs,
    signal,
  });
  if (probe.exitCode !== 0 || probe.stdout !== "airship-wasix-ready\n") {
    throw new Error(`Pinned WASIX Bash did not pass its command probe: ${JSON.stringify({
      exitCode: probe.exitCode,
      stdout: probe.stdout,
      stderr: probe.stderr,
    })}`);
  }

  const remaining = Math.max(1_000, timeoutMs - (performance.now() - started));
  const cancellation = new AbortController();
  const forwardAbort = () => cancellation.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  let markerSeen = false;
  try {
    await runWasixWorker({
      runtime: "wasix",
      code: "printf 'airship-wasix-cancel-ready\\n'; while :; do :; done",
      timeoutMs: remaining,
      signal: cancellation.signal,
      onOutput(chunk) {
        if (chunk.text.includes("airship-wasix-cancel-ready")) {
          markerSeen = true;
          cancellation.abort(new DOMException("WASIX cancellation probe", "AbortError"));
        }
      },
    }, undefined, true);
    throw new Error("WASIX cancellation probe unexpectedly completed.");
  } catch (error) {
    if (!markerSeen || !(error instanceof DOMException) || error.name !== "AbortError") throw error;
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }

  const failureProbe = await runWasixWorker({
    runtime: "wasix",
    code: "printf 'airship-wasix-failure-stdout\\n'; printf 'airship-wasix-failure-stderr\\n' >&2; exit 7",
    timeoutMs: Math.max(1_000, timeoutMs - (performance.now() - started)),
    signal,
  });
  if (
    failureProbe.exitCode !== 7
    || failureProbe.stdout !== "airship-wasix-failure-stdout\n"
    || failureProbe.stderr !== "airship-wasix-failure-stderr\n"
  ) {
    throw new Error(`Pinned WASIX Bash did not pass its nonzero exit-status probe: ${JSON.stringify({
      exitCode: failureProbe.exitCode,
      providerExitCode: failureProbe.providerExitCode,
      stdout: failureProbe.stdout,
      stderr: failureProbe.stderr,
    })}`);
  }

  const mountProbe = await runWasixWorker({
    runtime: "wasix",
    code: "IFS= read -r value < input.txt; printf '%s\\n' \"$value\" > output.txt; printf 'airship-wasix-workspace-ready\\n'",
    timeoutMs: Math.max(1_000, timeoutMs - (performance.now() - started)),
    signal,
  }, {
    root: "/workspace",
    files: [
      { path: "/workspace/input.txt", content: "airship-mounted-input\n" },
      { path: "/workspace/output.txt", content: "" },
    ],
  });
  const copied = mountProbe.files.find(({ path }) => path === "output.txt");
  const copiedContent = copied ? new TextDecoder().decode(copied.bytes) : undefined;
  if (
    mountProbe.exitCode !== 0
    || mountProbe.stdout !== "airship-wasix-workspace-ready\n"
    || copiedContent !== "airship-mounted-input\n"
  ) {
    throw new Error(
      `Pinned WASIX Bash did not pass the bidirectional workspace/output probe; the pack remains unavailable: ${JSON.stringify({
        exitCode: mountProbe.exitCode,
        providerExitCode: mountProbe.providerExitCode,
        stdout: mountProbe.stdout,
        stderr: mountProbe.stderr,
        returnedFiles: mountProbe.files.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength })),
        copiedContent,
      })}`,
    );
  }

  return createWasixAdapter();
}

export function createWasixAdapter(): ExecutionAdapter {
  return {
    capability: {
      id: "wasix",
      label: `Bash · Wasmer WASIX ${WASMER_SDK_VERSION}`,
      languages: ["bash", "shell"],
      state: "ready",
      tier: "web-enhanced",
      isolation: "dedicated-worker",
      persistence: "workspace-checkpoint",
      commandInterface: "bash-script",
      shell: "wasix-bash",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "terminate-worker-tree",
      detail: `Real Bash ${WASIX_BASH_SPEC} executes in a disposable, child-Worker-tracked Wasmer SDK runtime. Its declared ${WASIX_COREUTILS_SPEC} dependency is artifact-pinned, but broad external-command coverage is not implied. Content-addressed WebC bytes and dependency metadata are SHA-256 pinned and verified on every online job. No Git, Rust compiler, package manager, sockets, host files, or offline promise is implied.`,
    },
    async execute(request) {
      return executeWasixRequest(request);
    },
  };
}

async function executeWasixRequest(request: ExecutionRequest): Promise<ExecutionResult> {
  if (!request.code?.trim()) throw new Error("WASIX Bash execution requires a script.");
  const snapshot = request.workspace && request.workspaceRoot
    ? await captureWorkspace(request.workspace, request.workspaceRoot)
    : undefined;
  const completion = await runWasixWorker(request, snapshot);
  const workspaceResult = snapshot && request.workspace
    ? await reconcileWorkspace(request.workspace, snapshot, completion.files, request.writeBack === true, completion.exitCode)
    : undefined;
  return {
    runtime: "wasix",
    exitCode: completion.exitCode,
    stdout: completion.stdout,
    stderr: completion.stderr,
    provenance: {
      capabilityTier: "web-enhanced",
      authority: "browser",
      engine: `wasmer-wasix-${WASMER_SDK_VERSION}`,
      providerBoundary: "Wasmer registry metadata and content-addressed CDN artifact delivery; guest networking disabled",
      artifactKind: "shell-script",
    },
    value: {
      shell: "bash",
      sdk: `@wasmer/sdk@${WASMER_SDK_VERSION}`,
      packages: [
        { spec: WASIX_BASH_SPEC, sha256: WASIX_BASH_WEBC_SHA256 },
        { spec: WASIX_COREUTILS_SPEC, sha256: WASIX_COREUTILS_WEBC_SHA256 },
      ],
      onlinePack: true,
      guestNetwork: false,
      providerRuntimeExitCode: completion.providerExitCode,
    } satisfies JsonValue,
    ...(workspaceResult ? { workspace: workspaceResult } : {}),
  };
}

async function runWasixWorker(
  request: ExecutionRequest,
  snapshot?: WorkspaceSnapshot,
  requireTrackedWorkersOnCancel = false,
): Promise<WorkerCompletion> {
  assertWasixBrowserSupport();
  const worker = new Worker(trustedWasixWorkerUrl(wasixWorkerUrl) as string, {
    type: "module",
    name: "airship-wasix-job",
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminal: WorkerCompletion | Error | undefined;
    let stopping: unknown;
    let lastPhase = "worker-created";
    let cancelFallback: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (cancelFallback) clearTimeout(cancelFallback);
      request.signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const finish = (error?: unknown, value?: WorkerCompletion) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };
    const requestStop = (reason: unknown) => {
      if (settled || stopping !== undefined) return;
      stopping = reason;
      worker.postMessage({ type: "cancel" });
      cancelFallback = setTimeout(() => {
        finish(new Error("WASIX runtime did not confirm termination of its tracked Worker tree."));
      }, CANCEL_ACK_TIMEOUT_MS);
    };
    const timer = setTimeout(
      () => requestStop(new Error(`WASIX Bash execution exceeded ${request.timeoutMs} ms. Last confirmed phase: ${lastPhase}.`)),
      request.timeoutMs,
    );
    const onAbort = () => requestStop(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "WASIX execution Worker failed."));
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "phase") {
        lastPhase = message.phase;
        return;
      }
      if (message.type === "output") {
        emitExecutionOutput(request.onOutput, { stream: message.stream, text: message.text });
        return;
      }
      if (message.type === "completed") {
        terminal = {
          exitCode: message.exitCode,
          providerExitCode: message.providerExitCode,
          stdout: message.stdout,
          stderr: message.stderr,
          files: message.files,
        };
        return;
      }
      if (message.type === "failed") {
        terminal = new Error(message.error);
        return;
      }
      if (message.type === "worker-tree-stopped") {
        if (stopping !== undefined && requireTrackedWorkersOnCancel && message.workers < 1) {
          finish(new Error("WASIX cancellation probe did not observe an SDK child Worker to terminate."));
        }
        else if (stopping !== undefined) finish(stopping);
        else if (terminal instanceof Error) finish(terminal);
        else if (terminal) finish(undefined, terminal);
        else finish(new Error(`WASIX Worker stopped without a terminal result (${message.reason}).`));
      }
    };
    if (request.signal.aborted) onAbort();
    else worker.postMessage({
      type: "run",
      script: request.code,
      args: [...(request.args ?? [])],
      env: { ...request.env },
      ...(snapshot ? {
        workspaceRoot: snapshot.root,
        files: snapshot.files.map(({ path, content }) => ({ path: relativePath(path, snapshot.root), bytes: decodeWorkspaceBytes(content) })),
      } : { files: [] }),
    });
  });
}

async function captureWorkspace(workspace: WorkspacePort, rootInput: string): Promise<WorkspaceSnapshot> {
  const root = normalizeWorkspacePath(rootInput);
  assertAllowedWorkspacePath(root, "/workspace");
  const listed = await workspace.list(root);
  if (listed.some(({ path }) => path === root)) {
    throw new Error("WASIX workspaceRoot must identify a directory, not a file.");
  }
  const entries = listed
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    .filter(({ path }) => !relativeSegments(path, root).some((segment) => EXCLUDED_SEGMENTS.has(segment)));
  if (entries.length > WASIX_MAX_FILES) throw new Error(`WASIX workspace snapshot exceeds ${WASIX_MAX_FILES} files.`);
  const files: WorkspaceFile[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const file = await workspace.read(entry.path);
    if (!file || file.revision !== entry.revision) throw new WorkspaceConflictError(`Workspace changed while mounting WASIX: ${entry.path}`);
    const size = workspaceContentByteLength(file.content);
    if (size > WASIX_MAX_FILE_BYTES) throw new Error(`WASIX workspace file exceeds 512 KiB: ${entry.path}`);
    bytes += size;
    if (bytes > WASIX_MAX_WORKSPACE_BYTES) throw new Error("WASIX workspace snapshot exceeds 4 MiB.");
    files.push({ path: file.path, content: file.content, revision: file.revision });
  }
  return { root, files };
}

async function reconcileWorkspace(
  workspace: WorkspacePort,
  snapshot: WorkspaceSnapshot,
  returnedFiles: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  writeBackRequested: boolean,
  exitCode: number,
): Promise<NonNullable<ExecutionResult["workspace"]>> {
  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  if (returnedFiles.length > WASIX_MAX_FILES) throw new Error(`WASIX workspace output exceeds ${WASIX_MAX_FILES} files.`);
  const returned = new Map<string, string>();
  let returnedBytes = 0;
  for (const file of returnedFiles) {
    if (!file.path || file.path.startsWith("/")) throw new Error("WASIX returned an invalid workspace-relative path.");
    if (!(file.bytes instanceof Uint8Array)) throw new Error("WASIX returned an invalid workspace file payload.");
    if (file.bytes.byteLength > WASIX_MAX_FILE_BYTES) throw new Error(`WASIX output file exceeds 512 KiB: ${file.path}`);
    returnedBytes += file.bytes.byteLength;
    if (returnedBytes > WASIX_MAX_WORKSPACE_BYTES) throw new Error("WASIX workspace output exceeds 4 MiB.");
    const path = normalizeWorkspacePath(`${snapshot.root}/${file.path}`);
    assertAllowedWorkspacePath(path, snapshot.root);
    if (path === snapshot.root || !path.startsWith(`${snapshot.root}/`)) {
      throw new Error("WASIX returned a path outside its mounted workspace root.");
    }
    if (returned.has(path)) throw new Error(`WASIX returned duplicate normalized workspace path: ${path}`);
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
      if (expected ? current?.revision !== expected : current !== undefined) {
        throw new WorkspaceConflictError(`WASIX writeback conflicted at ${path}.`);
      }
    }
    for (const file of deleted) {
      if ((await workspace.read(file.path))?.revision !== file.revision) {
        throw new WorkspaceConflictError(`WASIX deletion conflicted at ${file.path}.`);
      }
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

function assertWasixBrowserSupport(): void {
  if (
    typeof Worker === "undefined"
    || typeof WebAssembly === "undefined"
    || typeof SharedArrayBuffer === "undefined"
    || !globalThis.crossOriginIsolated
  ) {
    throw new Error("WASIX Bash requires a cross-origin-isolated browser with Worker, WebAssembly, and SharedArrayBuffer.");
  }
}

function trustedWasixWorkerUrl(value: string): unknown {
  const url = new URL(value, globalThis.location.href);
  if (url.origin !== globalThis.location.origin) throw new TypeError("WASIX Worker must be a same-origin release asset.");
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown } };
  }).trustedTypes;
  if (!factory) return value;
  trustedPolicy ??= factory.createPolicy("airship-wasix-worker", {
    createScriptURL(candidate) {
      const url = new URL(candidate, globalThis.location.href);
      if (url.origin !== globalThis.location.origin) throw new TypeError("WASIX Worker must be a same-origin release asset.");
      return candidate;
    },
  });
  return trustedPolicy.createScriptURL(value);
}

function relativePath(path: string, root: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function relativeSegments(path: string, root: string): string[] {
  const relative = relativePath(path, root);
  return relative ? relative.split("/") : [];
}

function assertAllowedWorkspacePath(path: string, root: string): void {
  if (isWorkspaceControlPlanePath(path)) throw new Error(`WASIX workspace excludes control-plane path: ${path}`);
  const excluded = relativeSegments(path, root).find((segment) => EXCLUDED_SEGMENTS.has(segment));
  if (excluded) throw new Error(`WASIX workspace excludes the ${excluded} path segment.`);
}
