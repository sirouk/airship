import type { WorkspaceFile, WorkspacePort } from "./contracts";
import { normalizeWorkspacePath } from "./contracts";

/**
 * Compare-and-swap move for virtual browser workspaces.
 *
 * The target is created first and rolled back if the source changed before its
 * removal. This never silently overwrites either side and works for page-memory
 * and client-encrypted S3 adapters through the same narrow port.
 */
export async function moveWorkspaceFile(
  workspace: WorkspacePort,
  sourcePath: string,
  targetPath: string,
): Promise<WorkspaceFile> {
  const source = normalizeWorkspacePath(sourcePath);
  const target = normalizeWorkspacePath(targetPath);
  if (source === "/workspace" || target === "/workspace") throw new Error("Workspace root cannot be moved or replaced.");
  if (source === target) throw new Error("Source and destination are the same file.");
  const file = await workspace.read(source);
  if (!file) throw new Error(`Workspace file does not exist: ${source}`);
  const created = await workspace.write(target, file.content, { expectedRevision: null });
  try {
    await workspace.remove(source, { expectedRevision: file.revision });
    return created;
  } catch (error) {
    try {
      await workspace.remove(target, { expectedRevision: created.revision });
    } catch {
      throw new Error("Workspace move conflicted and its target rollback also conflicted. Refresh before continuing.", { cause: error });
    }
    throw error;
  }
}
