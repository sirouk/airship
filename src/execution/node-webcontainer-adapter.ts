import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { JsonValue } from "../core/contracts";
import { sha256 } from "../core/hash";
import { randomUuid } from "../core/id";
import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import {
  isLocalFolderMountPath,
  isWorkspaceControlPlanePath,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type WorkspacePort,
} from "../workspace/contracts";
import { emitExecutionOutput, type ExecutionAdapter, type ExecutionRequest, type ExecutionResult } from "./runtime-registry";

const MAX_FILES = 2_048;
const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const OUTPUT_DRAIN_GRACE_MS = 1_000;
const MAX_CHANGES = 512;
const MAX_CHANGED_BYTES = 8 * 1_024 * 1_024;
const MAX_PAGE_PROJECTS = 8;
const EXCLUDED_SEGMENTS = new Set([".airship", ".git", "node_modules"]);
const COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type WebContainerLike = Pick<WebContainer, "export" | "fs" | "mount" | "spawn">;

type WorkspaceSnapshot = Readonly<{
  tree: FileSystemTree;
  files: ReadonlyMap<string, Readonly<{ content: string; revision: string }>>;
  bytes: number;
  digest: string;
}>;

type WorkspaceChange = Readonly<{
  path: string;
  kind: "create" | "modify" | "delete";
  size: number;
  content?: string;
  expectedRevision?: string;
}>;

type PageProject = {
  id: string;
  jobRoot: string;
  workspaceRoot: string;
  sourceFiles: Set<string>;
  lastUsed: number;
  owner: Map<string, PageProject>;
};

type PageProjectStore = {
  byWorkspace: WeakMap<WorkspacePort, Map<string, PageProject>>;
  projects: Set<PageProject>;
  sequence: number;
  hostValid: boolean;
  invalidateHost?: (reason: string) => Promise<void>;
};

type NodeWebContainerAdapterOptions = Readonly<{
  invalidateHost?: (reason: string) => Promise<void>;
}>;

class NodeProviderPhaseError extends Error {
  constructor(message: string, readonly causeValue: unknown) {
    super(message);
    this.name = "NodeProviderPhaseError";
  }
}

class NodeProcessTerminationUnconfirmedError extends Error {
  constructor(readonly causeValue: unknown) {
    super("The WebContainer process did not confirm termination; its host was invalidated.");
    this.name = "NodeProcessTerminationUnconfirmedError";
  }
}

export function createNodeWebContainerAdapter(
  container: WebContainerLike,
  options: NodeWebContainerAdapterOptions = {},
): ExecutionAdapter {
  const projects = createPageProjectStore(options.invalidateHost);
  let executionTail = Promise.resolve();
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
      detail: "StackBlitz WebContainer passed a real npm probe in this tab. Commands for the same Airship workspace root share one bounded page-lifetime project so installed dependencies survive sequential calls; node_modules remains ephemeral and source deltas return only when writeBack is explicitly enabled.",
    },
    execute(request) {
      const execution = executionTail.then(() => {
        if (!projects.hostValid) throw new Error("The WebContainer host was invalidated. Activate Node again before executing.");
        throwIfAborted(request.signal);
        return executeNodeProject(container, request, projects);
      });
      executionTail = execution.then(() => undefined, () => undefined);
      return execution;
    },
  };
}

export async function executeNodeProject(
  container: WebContainerLike,
  request: ExecutionRequest,
  projects = createPageProjectStore(),
): Promise<ExecutionResult> {
  if (!request.workspace) throw new Error("Node project execution requires an Airship workspace binding.");
  throwIfAborted(request.signal);
  const deadline = Date.now() + request.timeoutMs;
  const workspaceRoot = normalizeWorkspacePath(request.workspaceRoot ?? "/workspace");
  const snapshot = await awaitExecutionPhase(
    snapshotWorkspace(request.workspace, workspaceRoot),
    deadline,
    request.signal,
    "workspace snapshot",
    false,
  );
  const command = request.command ?? (request.code ? "node" : undefined);
  if (!command || !COMMAND_PATTERN.test(command)) {
    throw new Error("Node execution requires a direct command name without slashes or shell metacharacters.");
  }
  const args = request.command
    ? [...(request.args ?? [])]
    : ["--input-type=module", "--eval", request.code!];
  let project: PageProject | undefined;
  try {
    assertOperationActive(deadline, request.signal, "project reconciliation");
    project = await awaitExecutionPhase(
      preparePageProject(container, projects, request.workspace, workspaceRoot, snapshot),
      deadline,
      request.signal,
      "project reconciliation",
      true,
    );
    const jobRoot = project.jobRoot;
    project.lastUsed = ++projects.sequence;
    assertOperationActive(deadline, request.signal, "process spawn");
    const process = await awaitExecutionPhase(
      container.spawn(command, args, {
        cwd: jobRoot,
        env: { ...request.env },
        terminal: { cols: 120, rows: 40 },
      }),
      deadline,
      request.signal,
      "process spawn",
      true,
    );
    const processResult = await waitForNodeProcess(
      process,
      remainingExecutionMs(deadline, request.signal, "process execution"),
      request.signal,
      request.onOutput,
    );
    assertOperationActive(deadline, request.signal, "workspace export");
    const exported = await awaitExecutionPhase(
      container.export(jobRoot, {
        format: "json",
        excludes: ["node_modules", "**/node_modules/**", ".git", "**/.git/**", ".airship", "**/.airship/**"],
      }),
      deadline,
      request.signal,
      "workspace export",
      true,
    );
    assertOperationActive(deadline, request.signal, "workspace reconciliation");
    const changes = collectWorkspaceChanges(snapshot, exported, workspaceRoot);
    assertOperationActive(deadline, request.signal, "workspace reconciliation");
    const adopted = request.writeBack === true && processResult.exitCode === 0 && changes.length > 0;
    if (adopted) {
      await awaitExecutionPhase(
        assertWorkspaceSnapshotCurrent(request.workspace, workspaceRoot, snapshot),
        deadline,
        request.signal,
        "workspace preflight",
        false,
      );
      assertOperationActive(deadline, request.signal, "workspace adoption");
      await adoptWorkspaceChanges(request.workspace, changes, deadline, request.signal);
    } else if (changes.length > 0) {
      assertOperationActive(deadline, request.signal, "unadopted output restoration");
      await awaitExecutionPhase(
        restoreAuthoritativeProjectState(container, project, snapshot, changes),
        deadline,
        request.signal,
        "unadopted output restoration",
        true,
      );
    }

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
        workspaceSnapshotDigest: snapshot.digest,
        runtimeProjectId: project.id,
        projectLifetime: "page",
        dependencyPersistence: "ephemeral-page",
        excludedPersistentPaths: ["node_modules"],
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
  } catch (error) {
    const fatal = error instanceof NodeProviderPhaseError
      || error instanceof NodeProcessTerminationUnconfirmedError;
    if (fatal) {
      await invalidatePageHost(projects, error instanceof Error ? error.message : "WebContainer provider failure.");
    } else if (project) {
      try {
        await discardPageProject(container, projects, project);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Node execution failed and its page-local project could not be discarded safely: ${project.id}`,
        );
      }
    }
    throw error;
  } finally {
    if (project && projects.projects.has(project)) project.lastUsed = ++projects.sequence;
  }
}

function createPageProjectStore(invalidateHost?: (reason: string) => Promise<void>): PageProjectStore {
  return {
    byWorkspace: new WeakMap(),
    projects: new Set(),
    sequence: 0,
    hostValid: true,
    ...(invalidateHost ? { invalidateHost } : {}),
  };
}

async function preparePageProject(
  container: WebContainerLike,
  store: PageProjectStore,
  workspace: WorkspacePort,
  workspaceRoot: string,
  snapshot: WorkspaceSnapshot,
): Promise<PageProject> {
  let roots = store.byWorkspace.get(workspace);
  if (!roots) {
    roots = new Map();
    store.byWorkspace.set(workspace, roots);
  }
  let project = roots.get(workspaceRoot);
  if (!project) {
    if (store.projects.size >= MAX_PAGE_PROJECTS) {
      const oldest = [...store.projects].sort((left, right) => left.lastUsed - right.lastUsed)[0]!;
      await discardPageProject(container, store, oldest);
    }
    // Job roots are `jobs/<id>` on a shared WebContainer FS; the local fallback
    // this replaces produced `<epoch>-<Math.random>` on LAN origins (npm run
    // dev:lan), where the browser omits the platform UUID API, so two jobs
    // started in the same millisecond collided on a Math.random draw instead of
    // on 122 crypto-random bits. core/id.ts is the module with a test pinning
    // that fallback's shape.
    const id = randomUuid();
    project = {
      id,
      jobRoot: `jobs/${id}`,
      workspaceRoot,
      sourceFiles: new Set(),
      lastUsed: ++store.sequence,
      owner: roots,
    };
    roots.set(workspaceRoot, project);
    store.projects.add(project);
    await container.fs.mkdir("jobs", { recursive: true });
    await container.fs.mkdir(project.jobRoot, { recursive: true });
  } else {
    // Airship remains the source authority. Remove files that disappeared
    // there; adopted outputs return through the next snapshot, unadopted
    // outputs are restored after their command, and node_modules alone stays
    // page-local so normal install → build/test workflows behave like one CLI.
    for (const relative of project.sourceFiles) {
      if (!snapshot.files.has(relative)) {
        await container.fs.rm(`${project.jobRoot}/${relative}`, { force: true, recursive: true });
      }
    }
  }
  await container.mount(snapshot.tree, { mountPoint: project.jobRoot });
  project.sourceFiles = new Set(snapshot.files.keys());
  return project;
}

async function restoreAuthoritativeProjectState(
  container: WebContainerLike,
  project: PageProject,
  snapshot: WorkspaceSnapshot,
  changes: readonly WorkspaceChange[],
): Promise<void> {
  const created = changes
    .filter(({ kind }) => kind === "create")
    .map(({ path }) => relativePath(path, project.workspaceRoot))
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const relative of created) {
    await container.fs.rm(`${project.jobRoot}/${relative}`, { force: true, recursive: true });
  }
  await container.mount(snapshot.tree, { mountPoint: project.jobRoot });
}

async function discardPageProject(
  container: WebContainerLike,
  store: PageProjectStore,
  project: PageProject,
): Promise<void> {
  await container.fs.rm(project.jobRoot, { force: true, recursive: true });
  project.owner.delete(project.workspaceRoot);
  store.projects.delete(project);
}

async function invalidatePageHost(store: PageProjectStore, reason: string): Promise<void> {
  if (!store.hostValid) return;
  store.hostValid = false;
  for (const project of store.projects) project.owner.delete(project.workspaceRoot);
  store.projects.clear();
  await store.invalidateHost?.(reason);
}

async function snapshotWorkspace(workspace: WorkspacePort, root: string): Promise<WorkspaceSnapshot> {
  const entries = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    // A folder attached from this device is not workspace state; see
    // `collectWorkspaceChanges`.
    .filter(({ path }) => !isLocalFolderMountPath(path))
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
    if (entry.size > MAX_FILE_BYTES) throw new Error(`Node workspace file exceeds 2 MiB: ${entry.path}`);
    const file = await workspace.readBounded?.(entry.path, MAX_FILE_BYTES + 1) ?? await workspace.read(entry.path);
    if (!file) throw new WorkspaceConflictError(`Workspace file disappeared while mounting: ${entry.path}`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`Node workspace file exceeds 2 MiB: ${entry.path}`);
    const mountedBytes = decodeWorkspaceBytes(file.content);
    const size = mountedBytes.byteLength;
    if (size > MAX_FILE_BYTES) throw new Error(`Node workspace file exceeds 2 MiB: ${entry.path}`);
    bytes += size;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Node workspace snapshot exceeds the 16 MiB input limit.");
    insertTreeFile(tree, relative.split("/"), mountedBytes);
    files.set(relative, { content: file.content, revision: file.revision });
  }
  const digest = await sha256(JSON.stringify({
    root,
    files: [...files.entries()]
      .map(([path, file]) => [path, file.revision] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  }));
  return { tree, files, bytes, digest };
}

async function assertWorkspaceSnapshotCurrent(
  workspace: WorkspacePort,
  root: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const current = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    .filter(({ path }) => !isLocalFolderMountPath(path))
    .filter(({ path }) => !relativeSegments(path, root).some((segment) => EXCLUDED_SEGMENTS.has(segment)))
    .map((entry) => [relativePath(entry.path, root), entry.revision] as const)
    .filter(([path]) => path.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const mounted = [...snapshot.files.entries()]
    .map(([path, file]) => [path, file.revision] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(current) !== JSON.stringify(mounted)) {
    throw new WorkspaceConflictError(
      `Node output for ${root} was derived from an older workspace snapshot; no changes were adopted.`,
    );
  }
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
    // Same rule, same reason as `ATTACHED_FOLDER_EXCLUSION` in the shell pack.
    // Nothing under the folder was mounted, so this can only be output the
    // process addressed *into* it, and it never reaches the port.
    if (isLocalFolderMountPath(normalizeWorkspacePath(`${root}/${relative}`))) {
      throw new Error(
        "This runtime does not carry the folder you attached from this device: it copies files and writes them back"
        + ` with no approval request, and that folder is written in place. Refused: ${root}/${relative}`,
      );
    }
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

async function adoptWorkspaceChanges(
  workspace: WorkspacePort,
  changes: readonly WorkspaceChange[],
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  for (const change of changes) {
    assertOperationActive(deadline, signal, "workspace adoption preflight");
    const current = await workspace.read(change.path);
    if (change.kind === "create") {
      if (current) throw new WorkspaceConflictError(`Node output conflicts with a newly created file: ${change.path}`);
    } else if (!current || current.revision !== change.expectedRevision) {
      throw new WorkspaceConflictError(`Node output is based on an older workspace revision: ${change.path}`);
    }
  }
  for (const change of changes) {
    assertOperationActive(deadline, signal, "workspace adoption");
    if (change.kind === "delete") {
      await workspace.remove(change.path, { expectedRevision: change.expectedRevision });
    } else {
      await workspace.write(change.path, change.content!, {
        expectedRevision: change.kind === "create" ? null : change.expectedRevision,
      });
    }
  }
}

function awaitExecutionPhase<T>(
  operation: Promise<T>,
  deadline: number,
  signal: AbortSignal,
  label: string,
  providerPhase: boolean,
): Promise<T> {
  const timeoutMs = remainingExecutionMs(deadline, signal, label);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        reject(providerPhase
          ? new NodeProviderPhaseError(`WebContainer ${label} did not complete safely.`, error)
          : error);
      } else {
        resolve(value as T);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`Node ${label} exceeded its execution deadline.`)),
      timeoutMs,
    );
    const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => finish(undefined, value), finish);
    if (signal.aborted) onAbort();
  });
}

function remainingExecutionMs(deadline: number, signal: AbortSignal, label: string): number {
  assertOperationActive(deadline, signal, label);
  return Math.max(1, deadline - Date.now());
}

function assertOperationActive(deadline: number, signal: AbortSignal, label: string): void {
  throwIfAborted(signal);
  if (Date.now() >= deadline) throw new Error(`Node ${label} exceeded its execution deadline.`);
}

export async function waitForNodeProcess(
  process: WebContainerProcess,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: ExecutionRequest["onOutput"],
): Promise<Readonly<{ exitCode: number; output: string; limitReason?: string }>> {
  const reader = process.output.getReader();
  let exitSettled = false;
  const observedExit = process.exit.then(
    (exitCode) => {
      exitSettled = true;
      return exitCode;
    },
    (error) => {
      exitSettled = true;
      throw error;
    },
  );
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
      const tail = output.slice(-1_024).trim();
      reject(new Error(
        `Node execution exceeded ${timeoutMs} ms.${tail ? ` Last output: ${JSON.stringify(tail)}` : ""}`,
      ));
    }, timeoutMs);
    onAbort = () => {
      process.kill();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    // Preserve trailing output after exit, but do not let a provider-owned
    // terminal stream that never emits EOF strand a completed npm process.
    // The overall execution deadline remains active throughout this drain.
    const completed = observedExit.then(async (exitCode) => {
      await Promise.race([
        outputTask,
        new Promise<void>((resolve) => setTimeout(resolve, OUTPUT_DRAIN_GRACE_MS)),
      ]);
      return exitCode;
    });
    const exitCode = await Promise.race([completed, interrupted]);
    return { exitCode, output, ...(limitReason ? { limitReason } : {}) };
  } catch (error) {
    try { process.kill(); } catch { /* The provider process may already be gone. */ }
    await Promise.race([
      observedExit.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, OUTPUT_DRAIN_GRACE_MS)),
    ]);
    if (!exitSettled) throw new NodeProcessTerminationUnconfirmedError(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    void outputTask.catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A provider-owned pending read may retain the lock. */ }
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
