import { randomUuid } from "../core/id";
import { workspaceContentByteLength } from "./content-codec";
import {
  WorkspaceConflictError,
  normalizeWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspacePort,
} from "./contracts";

export class MemoryWorkspace implements WorkspacePort {
  protected readonly files = new Map<string, WorkspaceFile>();

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const file = this.files.get(normalizeWorkspacePath(path));
    return file ? structuredClone(file) : undefined;
  }

  async readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Workspace read bound must be a positive integer.");
    const file = this.files.get(normalizeWorkspacePath(path));
    if (!file) return undefined;
    const bytes = new TextEncoder().encode(file.content);
    if (bytes.byteLength <= maxBytes) return structuredClone(file);
    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
    return structuredClone({ ...file, content });
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const prefix = normalizeWorkspacePath(path);
    return [...this.files.values()]
      .filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`))
      .map(({ content: _content, ...entry }) => structuredClone(entry))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async write(
    path: string,
    content: string,
    options: { expectedRevision?: string | null } = {},
  ): Promise<WorkspaceFile> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/workspace") throw new Error("Cannot write to the workspace root.");
    const current = this.files.get(normalized);
    checkRevision(current, options.expectedRevision);
    const file: WorkspaceFile = {
      path: normalized,
      content,
      revision: randomUuid(),
      updatedAt: new Date().toISOString(),
      size: new TextEncoder().encode(content).byteLength,
      // The envelope is what storage holds; the decoded length is what the
      // person and the agent tools are both entitled to see.
      contentByteLength: workspaceContentByteLength(content),
    };
    this.files.set(normalized, file);
    return structuredClone(file);
  }

  async remove(path: string, options: { expectedRevision?: string } = {}): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const current = this.files.get(normalized);
    if (!current) return;
    checkRevision(current, options.expectedRevision);
    this.files.delete(normalized);
  }
}

export function checkRevision(file: WorkspaceFile | undefined, expectedRevision: string | null | undefined): void {
  if (expectedRevision === undefined) return;
  if (expectedRevision === null && file) throw new WorkspaceConflictError("The file already exists.");
  if (typeof expectedRevision === "string" && file?.revision !== expectedRevision) {
    throw new WorkspaceConflictError();
  }
}
