import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { JsonValue } from "../core/contracts";
import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import { emitExecutionOutput, type ExecutionAdapter, type ExecutionRequest, type ExecutionResult } from "./runtime-registry";

const MAX_FILES = 2_048;
const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const MAX_CHANGES = 512;
const MAX_CHANGED_BYTES = 8 * 1_024 * 1_024;
const EXCLUDED_SEGMENTS = new Set([".airship", ".git", "node_modules"]);
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type WebContainerLike = Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;

type WorkspaceSnapshot = Readonly<{
  tree: FileSystemTree;
  files: ReadonlyMap<string, Readonly<{ content: string; revision: string }>>;
  bytes: number;
}>;

type WorkspaceChange = Readonly<{
  path: string;
  kind: "create" | "modify" | "delete";
  size: number;
  content?: string;
  expectedRevision?: string;
}>;

export function createNodeWebContainerAdapter(container: WebContainerLike): ExecutionAdapter {
  return {
    capability: {
      id: "node-webcontainer",
      label: "Node.js · WebContainer",
      languages: ["javascript", "typescript", "node", "npm", "pnpm", "yarn"],
      state: "ready",
      tier: "web-enhanced",
      isolation: "webcontainer",
      persistence: "workspace-checkpoint",
      commandInterface: "direct-process",
      shell: "webcontainer-jsh",
      workspaceAccess: "bounded-snapshot-writeback",
      output: "bounded-stream",
      cancellation: "kill-process",
      detail: "StackBlitz WebContainer is active in this tab. Commands run against an isolated workspace snapshot; source deltas return to Airship only when writeBack is explicitly enabled.",
    },
    async execute(request) {
      return executeNodeProject(container, request);
    },
  };
}

export async function executeNodeProject(
  container: WebContainerLike,
  request: ExecutionRequest,
): Promise<ExecutionResult> {
  if (!request.workspace) throw new Error("Node project execution requires an Airship workspace binding.");
  const workspaceRoot = normalizeWorkspacePath(request.workspaceRoot ?? "/workspace");
  const snapshot = await snapshotWorkspace(request.workspace, workspaceRoot);
  const command = request.command ?? (request.code ? "node" : undefined);
  if (!command || !COMMAND_PATTERN.test(command)) {
    throw new Error("Node execution requires a direct command name without slashes or shell metacharacters.");
  }
  const args = request.command
    ? [...(request.args ?? [])]
    : ["--input-type=module", "--eval", request.code!];
  const jobId = createJobId();
  const jobRoot = `jobs/${jobId}`;
  await container.fs.mkdir("jobs", { recursive: true });
  await container.fs.mkdir(jobRoot, { recursive: true });
  await container.mount(snapshot.tree, { mountPoint: jobRoot });

  try {
    const process = await container.spawn(command, args, {
      cwd: jobRoot,
      env: { ...request.env },
      terminal: { cols: 120, rows: 40 },
    });
    const processResult = await waitForProcess(process, request.timeoutMs, request.signal, request.onOutput);
    const exported = await container.export(jobRoot, {
      format: "json",
      excludes: ["node_modules", "**/node_modules/**", ".git", "**/.git/**", ".airship", "**/.airship/**"],
    });
    const changes = collectWorkspaceChanges(snapshot, exported, workspaceRoot);
    const adopted = request.writeBack === true && processResult.exitCode === 0 && changes.length > 0;
    if (adopted) await adoptWorkspaceChanges(request.workspace, changes);

    return {
      runtime: "node-webcontainer",
      exitCode: processResult.exitCode,
      stdout: processResult.output,
      stderr: processResult.limitReason ?? "",
      provenance: {
        capabilityTier: "web-enhanced",
        authority: "browser",
        engine: "stackblitz-webcontainer",
        providerBoundary: "StackBlitz runtime delivery and command-dependent package/network egress",
        artifactKind: "workspace-project",
      },
      value: {
        provider: "StackBlitz WebContainers",
        browserCompute: true,
        remoteRuntimeDelivery: true,
        workspaceRoot,
        mountedFiles: snapshot.files.size,
        mountedBytes: snapshot.bytes,
        writeBackRequested: request.writeBack === true,
        adopted,
        outputStream: "combined",
        changes: changes.map(({ content: _content, expectedRevision: _revision, ...change }) => change),
      } satisfies JsonValue,
      workspace: {
        root: workspaceRoot,
        mountedFiles: snapshot.files.size,
        changedPaths: changes.map(({ path }) => path),
        writtenPaths: adopted
          ? changes.filter(({ kind }) => kind !== "delete").map(({ path }) => path)
          : [],
        deletedPaths: adopted
          ? changes.filter(({ kind }) => kind === "delete").map(({ path }) => path)
          : [],
        writeBackRequested: request.writeBack === true,
        adopted,
        writeBack: request.writeBack === true,
      },
    };
  } finally {
    await container.fs.rm(jobRoot, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function snapshotWorkspace(workspace: WorkspacePort, root: string): Promise<WorkspaceSnapshot> {
  const entries = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    .filter(({ path }) => !relativeSegments(path, root).some((segment) => EXCLUDED_SEGMENTS.has(segment)));
  if (entries.length > MAX_FILES) throw new Error(`Node workspace snapshot exceeds ${MAX_FILES} files.`);
  const declaredBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (declaredBytes > MAX_INPUT_BYTES) throw new Error("Node workspace snapshot exceeds the 16 MiB input limit.");

  const tree: FileSystemTree = Object.create(null) as FileSystemTree;
  const files = new Map<string, Readonly<{ content: string; revision: string }>>();
  let bytes = 0;
  for (const entry of entries) {
    const relative = relativePath(entry.path, root);
    if (!relative) continue;
    const file = await workspace.readBounded?.(entry.path, MAX_FILE_BYTES + 1) ?? await workspace.read(entry.path);
    if (!file) throw new WorkspaceConflictError(`Workspace file disappeared while mounting: ${entry.path}`);
    const mountedBytes = decodeWorkspaceBytes(file.content);
    const size = mountedBytes.byteLength;
    if (size > MAX_FILE_BYTES) throw new Error(`Node workspace file exceeds 2 MiB: ${entry.path}`);
    bytes += size;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Node workspace snapshot exceeds the 16 MiB input limit.");
    insertTreeFile(tree, relative.split("/"), mountedBytes);
    files.set(relative, { content: file.content, revision: file.revision });
  }
  return { tree, files, bytes };
}

function collectWorkspaceChanges(
  snapshot: WorkspaceSnapshot,
  tree: FileSystemTree,
  root: string,
): WorkspaceChange[] {
  const exported = new Map<string, string>();
  flattenTree(tree, [], exported);
  const changes: WorkspaceChange[] = [];
  let changedBytes = 0;
  for (const [relative, content] of exported) {
    if (relative.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    const original = snapshot.files.get(relative);
    if (original?.content === content) continue;
    const size = workspaceContentByteLength(content);
    changedBytes += size;
    changes.push({
      path: normalizeWorkspacePath(`${root}/${relative}`),
      kind: original ? "modify" : "create",
      size,
      content,
      ...(original ? { expectedRevision: original.revision } : {}),
    });
  }
  for (const [relative, original] of snapshot.files) {
    if (exported.has(relative)) continue;
    changes.push({
      path: normalizeWorkspacePath(`${root}/${relative}`),
      kind: "delete",
      size: 0,
      expectedRevision: original.revision,
    });
  }
  if (changes.length > MAX_CHANGES) throw new Error(`Node output exceeds ${MAX_CHANGES} workspace changes.`);
  if (changedBytes > MAX_CHANGED_BYTES) throw new Error("Node output exceeds the 8 MiB workspace-delta limit.");
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

async function adoptWorkspaceChanges(workspace: WorkspacePort, changes: readonly WorkspaceChange[]): Promise<void> {
  for (const change of changes) {
    const current = await workspace.read(change.path);
    if (change.kind === "create") {
      if (current) throw new WorkspaceConflictError(`Node output conflicts with a newly created file: ${change.path}`);
    } else if (!current || current.revision !== change.expectedRevision) {
      throw new WorkspaceConflictError(`Node output is based on an older workspace revision: ${change.path}`);
    }
  }
  for (const change of changes) {
    if (change.kind === "delete") {
      await workspace.remove(change.path, { expectedRevision: change.expectedRevision });
    } else {
      await workspace.write(change.path, change.content!, {
        expectedRevision: change.kind === "create" ? null : change.expectedRevision,
      });
    }
  }
}

async function waitForProcess(
  process: WebContainerProcess,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: ExecutionRequest["onOutput"],
): Promise<Readonly<{ exitCode: number; output: string; limitReason?: string }>> {
  const reader = process.output.getReader();
  let output = "";
  let limitReason: string | undefined;
  const outputTask = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (output.length + chunk.value.length > MAX_OUTPUT_CHARS) {
        const accepted = chunk.value.slice(0, Math.max(0, MAX_OUTPUT_CHARS - output.length));
        output += accepted;
        if (accepted) emitExecutionOutput(onOutput, { stream: "combined", text: accepted });
        limitReason = "Process output exceeded 256 KiB and was terminated.";
        process.kill();
        return;
      }
      output += chunk.value;
      emitExecutionOutput(onOutput, { stream: "combined", text: chunk.value });
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      process.kill();
      reject(new Error(`Node execution exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    onAbort = () => {
      process.kill();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    // Process exit and stream EOF are one terminal condition. Some providers
    // resolve `exit` before the output stream closes; waiting for output after
    // winning a race against the timeout would otherwise hang forever.
    const completed = Promise.all([process.exit, outputTask]).then(([exitCode]) => exitCode);
    const exitCode = await Promise.race([completed, interrupted]);
    return { exitCode, output, ...(limitReason ? { limitReason } : {}) };
  } catch (error) {
    try { process.kill(); } catch { /* The provider process may already be gone. */ }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    await outputTask.catch(() => undefined);
    reader.releaseLock();
  }
}

function insertTreeFile(tree: FileSystemTree, segments: readonly string[], content: string | Uint8Array): void {
  if (segments.length === 0) throw new Error("Cannot mount an empty workspace path.");
  let cursor = tree;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const current = cursor[segment];
    if (current && !("directory" in current)) throw new Error(`Workspace path collides with a file: ${segments.join("/")}`);
    if (!current) cursor[segment] = { directory: Object.create(null) as FileSystemTree };
    cursor = (cursor[segment] as { directory: FileSystemTree }).directory;
  }
  cursor[segments.at(-1)!] = { file: { contents: content } };
}

function flattenTree(tree: FileSystemTree, prefix: readonly string[], output: Map<string, string>): void {
  for (const [name, node] of Object.entries(tree)) {
    const path = [...prefix, name];
    if ("directory" in node) {
      flattenTree(node.directory, path, output);
      continue;
    }
    if (!("contents" in node.file)) throw new Error(`Node output contains an unsupported symlink: ${path.join("/")}`);
    const content = typeof node.file.contents === "string"
      ? node.file.contents
      : encodeWorkspaceBytes(node.file.contents);
    output.set(path.join("/"), content);
  }
}

function relativePath(path: string, root: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function relativeSegments(path: string, root: string): string[] {
  const relative = relativePath(path, root);
  return relative ? relative.split("/") : [];
}

function createJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
