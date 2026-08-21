import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../../workspace/content-codec";
import {
  isLocalFolderMountPath,
  isWorkspaceControlPlanePath,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type WorkspacePort,
} from "../../workspace/contracts";
import { emitExecutionOutput, type ExecutionRequest, type ExecutionResult } from "../runtime-registry";
import {
  AIRSHIP_SH_ENGINE,
  AIRSHIP_SH_EXCLUDED_SEGMENTS,
  AIRSHIP_SH_MAX_FILES,
  AIRSHIP_SH_MAX_FILE_BYTES,
  AIRSHIP_SH_MAX_WORKSPACE_BYTES,
  AIRSHIP_SH_MAX_WORKSPACE_ERROR_CHARS,
} from "./contract";
import type { ShellFileEntry } from "./filesystem";
import { runShellScript } from "./run";

const WORKSPACE_ROOT = "/workspace";
const EXCLUDED = new Set<string>(AIRSHIP_SH_EXCLUDED_SEGMENTS);
/**
 * A folder attached from this device is not workspace state, in either direction.
 *
 * A snapshot/write-back tier is a copy: every listed file is read out of the
 * `WorkspacePort` and every changed file is written back through it, with no
 * approval request anywhere on that path — the tool broker reviewed the *call*,
 * whose arguments name `/workspace` and never the folder. `namesAttachedFolder`
 * in `src/approvals/modes.ts` therefore cannot see it, so a write-back rooted at
 * `/workspace` landed on the person's own disk under Auto Approve and Full
 * Access with nobody asked. The Terminal already refuses this for the same
 * reason (`ATTACHED_FOLDER_REFUSAL` in `src/terminal/workspace-sync.ts`); the
 * execution tiers now refuse it too.
 */
const ATTACHED_FOLDER_EXCLUSION =
  "This runtime does not carry the folder you attached from this device: it copies files and writes them back with"
  + " no approval request, and that folder is written in place. Nothing on your device was changed.";

type Snapshot = Readonly<{
  root: string;
  files: readonly Readonly<{ path: string; content: string; revision: string }>[];
}>;

let runCounter = 0;

/**
 * Executes one `airship-sh` script over the authoritative `WorkspacePort`.
 *
 * The transaction model is the one every other Airship runtime uses: capture a
 * bounded snapshot, run against an isolated projection, then adopt changes only
 * on an explicit `writeBack` after a successful exit, with per-file revision
 * CAS. The live workspace is never mutated while the script is running.
 */
export async function executeAirshipShellRequest(request: ExecutionRequest): Promise<ExecutionResult> {
  if (!request.code) throw new Error("airship-sh execution requires a script.");
  if (request.wasmBase64 || request.wasmPath) throw new Error("airship-sh runs shell source, not a WASI artifact.");
  if (request.workspaceRoot && !request.workspace) {
    throw new Error("airship-sh workspace execution requires both workspaceRoot and a bound Airship workspace.");
  }
  if (request.writeBack && !request.workspaceRoot) throw new Error("airship-sh writeback requires a workspaceRoot.");

  const snapshot = request.workspace && request.workspaceRoot
    ? await captureWorkspace(request.workspace, request.workspaceRoot)
    : undefined;
  runCounter += 1;

  const result = await runShellScript({
    script: request.code,
    mount: {
      root: snapshot?.root ?? WORKSPACE_ROOT,
      files: snapshot ? snapshot.files.map(toEntry) : [],
    },
    args: request.args ?? [],
    env: request.env ?? {},
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    runId: runCounter,
    onOutput: (chunk) => emitExecutionOutput(request.onOutput, chunk),
  });

  const workspace = snapshot && request.workspace
    ? await reconcileWorkspace(request.workspace, snapshot, result.files, request.writeBack === true, result.exitCode, result.emptyDirectories)
    : undefined;

  return {
    runtime: "airship-sh",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    provenance: {
      capabilityTier: "web-baseline",
      authority: "browser",
      engine: AIRSHIP_SH_ENGINE,
      artifactKind: "shell-script",
    },
    ...(workspace ? { workspace } : {}),
  };
}

function toEntry(file: Readonly<{ path: string; content: string; revision: string }>): ShellFileEntry {
  return Object.freeze({
    path: file.path,
    bytes: decodeWorkspaceBytes(file.content),
    revision: file.revision,
    updatedAt: new Date().toISOString(),
  });
}

async function captureWorkspace(workspace: WorkspacePort, rootInput: string): Promise<Snapshot> {
  const root = normalizeWorkspacePath(rootInput);
  const entries = (await workspace.list(root))
    .filter(({ path }) => path === root || path.startsWith(`${root}/`))
    .filter(({ path }) => !isWorkspaceControlPlanePath(path))
    // A folder attached from this device is not workspace state; see `egressRefusal`.
    .filter(({ path }) => !isLocalFolderMountPath(path))
    .filter(({ path }) => !relativeSegments(path, root).some((segment) => EXCLUDED.has(segment)));
  if (entries.length > AIRSHIP_SH_MAX_FILES) {
    throw new Error(`airship-sh workspace snapshot exceeds ${AIRSHIP_SH_MAX_FILES} files.`);
  }
  const files: Snapshot["files"][number][] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.path === root) continue;
    const file = await workspace.read(entry.path);
    if (!file || file.revision !== entry.revision) {
      throw new WorkspaceConflictError(`Workspace changed while mounting airship-sh: ${entry.path}`);
    }
    const size = workspaceContentByteLength(file.content);
    if (size > AIRSHIP_SH_MAX_FILE_BYTES) throw new Error(`airship-sh workspace file exceeds 512 KiB: ${entry.path}`);
    bytes += size;
    if (bytes > AIRSHIP_SH_MAX_WORKSPACE_BYTES) throw new Error("airship-sh workspace snapshot exceeds 4 MiB.");
    files.push(Object.freeze({ path: file.path, content: file.content, revision: file.revision }));
  }
  return Object.freeze({ root, files: Object.freeze(files) });
}

async function reconcileWorkspace(
  workspace: WorkspacePort,
  snapshot: Snapshot,
  returnedFiles: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  writeBackRequested: boolean,
  exitCode: number,
  emptyDirectories: readonly string[],
): Promise<NonNullable<ExecutionResult["workspace"]>> {
  const original = new Map(snapshot.files.map((file) => [file.path, file]));
  const returned = new Map<string, string>();
  const refused = new Map<string, string>();
  let returnedBytes = 0;
  for (const file of returnedFiles) {
    const path = normalizeWorkspacePath(file.path);
    // A path outside the mounted root cannot come from the interpreter: its
    // filesystem refuses writes elsewhere. Seeing one means the collector is
    // broken, so it fails the whole run rather than being refused per file.
    if (path !== snapshot.root && !path.startsWith(`${snapshot.root}/`)) {
      throw new Error(`airship-sh returned a path outside its workspace root: ${path}`);
    }
    const refusal = egressRefusal(path, snapshot.root);
    if (refusal) {
      refused.set(path, refusal);
      continue;
    }
    if (file.bytes.byteLength > AIRSHIP_SH_MAX_FILE_BYTES) {
      throw new Error(`airship-sh output file exceeds 512 KiB: ${path}`);
    }
    returnedBytes += file.bytes.byteLength;
    if (returnedBytes > AIRSHIP_SH_MAX_WORKSPACE_BYTES) throw new Error("airship-sh workspace output exceeds 4 MiB.");
    if (returned.has(path)) throw new Error(`airship-sh returned duplicate normalized workspace path: ${path}`);
    returned.set(path, encodeWorkspaceBytes(file.bytes));
  }
  const changed = [...returned]
    .filter(([path, content]) => original.get(path)?.content !== content)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const deleted = snapshot.files
    .filter(({ path }) => !returned.has(path) && !refused.has(path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const refusedPaths = [...refused.keys()].sort();
  const changedPaths = [...changed.map(([path]) => path), ...deleted.map(({ path }) => path)].sort();
  const writtenPaths: string[] = [];
  const deletedPaths: string[] = [];
  if (writeBackRequested && exitCode === 0) {
    // Preflight every target before the first mutation, then keep exact CAS on
    // each write. `WorkspacePort` has no multi-file transaction, so a late
    // cross-device race can still produce a clearly reported partial adoption.
    for (const [path] of changed) {
      const expected = original.get(path)?.revision;
      const current = await workspace.read(path);
      if (expected ? current?.revision !== expected : current !== undefined) {
        throw new WorkspaceConflictError(`airship-sh writeback conflicted at ${path}.`);
      }
    }
    for (const file of deleted) {
      if ((await workspace.read(file.path))?.revision !== file.revision) {
        throw new WorkspaceConflictError(`airship-sh deletion conflicted at ${file.path}.`);
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
  const emptyDirectoryNote = emptyDirectories.length > 0
    ? `airship-sh created ${emptyDirectories.length} empty directory path(s) that a file-only workspace cannot store: ${emptyDirectories
        .slice(0, 8)
        .join(", ")}`
    : undefined;
  const refusalReason = [
    ...(refused.size > 0 ? [[...new Set(refused.values())].join(" ")] : []),
    ...(emptyDirectoryNote ? [emptyDirectoryNote] : []),
  ].join(" ").slice(0, AIRSHIP_SH_MAX_WORKSPACE_ERROR_CHARS);
  return {
    root: snapshot.root,
    mountedFiles: snapshot.files.length,
    changedPaths,
    writtenPaths,
    deletedPaths,
    writeBackRequested,
    adopted: writeBackRequested && exitCode === 0 && changedPaths.length > 0,
    writeBack: writeBackRequested,
    ...(refusedPaths.length > 0 ? { refusedPaths } : {}),
    ...(refusalReason.length > 0 ? { refusalReason } : {}),
  };
}

function relativeSegments(path: string, root: string): string[] {
  if (path === root) return [];
  const relative = path.slice(root.length + 1);
  return relative ? relative.split("/") : [];
}

function egressRefusal(path: string, root: string): string | undefined {
  if (isLocalFolderMountPath(path)) return `${ATTACHED_FOLDER_EXCLUSION} Refused: ${path}`;
  if (isWorkspaceControlPlanePath(path)) return `airship-sh workspace excludes control-plane path: ${path}`;
  const excluded = relativeSegments(path, root).find((segment) => EXCLUDED.has(segment));
  return excluded ? `airship-sh workspace excludes the ${excluded} path segment.` : undefined;
}
