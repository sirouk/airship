import type { BrowserGitClient } from "../git/client";
import type { GitMutationResult } from "../git/types";
import { validateBranchName } from "../git/validation";
import type { WorkspacePort } from "../workspace/contracts";
import {
  importGithubRepository,
  type RepositoryImportProgress,
  type RepositoryImportResult,
} from "./repository-import";

/**
 * One authoritative import transaction for both human and agent entry points.
 *
 * A GitHub snapshot is useful only if the workspace browser and Sources agree
 * that it exists. The public importer first commits a validated file snapshot;
 * this coordinator then admits those exact bytes to browser Git. A failed Git
 * admission removes the just-written files so the two projections cannot drift.
 */
export async function importAndAdmitGithubRepository(options: Readonly<{
  repository: string;
  ref?: string;
  destination?: string;
  maxFiles?: number;
  maxBytes?: number;
  workspace: WorkspacePort;
  git?: BrowserGitClient;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  onProgress?: (progress: RepositoryImportProgress) => void;
}>): Promise<Readonly<{
  import: RepositoryImportResult;
  git?: GitMutationResult;
  repositoryId?: string;
}>> {
  const imported = await importGithubRepository(options);
  if (!options.git) return Object.freeze({ import: imported });

  const entries = imported.committed;
  const files: Record<string, string> = {};
  try {
    for (const entry of entries) {
      const file = await options.workspace.read(entry.path);
      if (!file) throw new Error(`Imported workspace file disappeared before Git admission: ${entry.path}.`);
      if (file.revision !== entry.revision) {
        throw new Error(`Imported workspace file changed before Git admission: ${entry.path}.`);
      }
      files[entry.path.slice(imported.destination.length + 1)] = file.content;
    }
    const [owner, name] = imported.repository.split("/", 2) as [string, string];
    const repositoryId = snapshotRepositoryId(owner, name, imported.commit, imported.destination);
    const git = await options.git.importSnapshot({
      repositoryId,
      name: `${owner}/${name}`,
      destination: imported.destination,
      sourceUrl: `https://github.com/${owner}/${name}`,
      defaultBranch: safeImportedBranch(imported.ref),
      files,
    }, options.signal);
    return Object.freeze({ import: imported, git, repositoryId });
  } catch (error) {
    await rollbackImportedWorkspace(options.workspace, entries);
    throw error;
  }
}

export function snapshotRepositoryId(owner: string, name: string, commit: string, destination: string): string {
  const slug = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").slice(0, 96).replace(/^[^a-z0-9]+/u, "") || "github";
  const destinationSlug = destination
    .replace(/^\/workspace\//u, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(-64) || "workspace";
  return `snapshot-${slug}-${destinationSlug}-${commit.slice(0, 12)}`.slice(0, 256);
}

function safeImportedBranch(ref: string): string {
  try { return validateBranchName(ref); } catch { return "snapshot"; }
}

async function rollbackImportedWorkspace(
  workspace: WorkspacePort,
  entries: readonly Readonly<{ path: string; revision: string }>[],
): Promise<void> {
  const failures: string[] = [];
  for (const entry of [...entries].reverse()) {
    try { await workspace.remove(entry.path, { expectedRevision: entry.revision }); } catch { failures.push(entry.path); }
  }
  if (failures.length) throw new Error(`Git admission failed and ${failures.length} imported workspace file(s) require explicit cleanup.`);
}
