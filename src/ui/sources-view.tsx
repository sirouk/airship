import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { GitDomainError } from "../git/errors";
import { describeGitOperation } from "../git/operations";
import type {
  GitAuthor,
  GitDiff,
  GitDiffScope,
  GitDeltaKind,
  GitMutationResult,
  GitOperation,
  GitOperationDescriptor,
  GitRepositorySnapshot,
  GitStatusEntry,
} from "../git/types";
import type { BrowserGitClient } from "../git/client";
import { preferredSourceRepositoryId, rememberSourceRepository } from "../git/source-selection";
import type { RepositoryImportProgress, RepositoryImportResult } from "../tools/repository-import";
import { importAndAdmitGithubRepository } from "../tools/repository-admission";
import type { WorkspacePort } from "../workspace/contracts";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { DurabilityIndicator, type DurabilityState } from "./durability-indicator";
import "./sources-view.css";
import { mapUnknownRequestFailure } from "./request-state";

export type SourcesReview = (
  operation: GitOperation,
  descriptor: GitOperationDescriptor,
) => Promise<"allow" | "deny">;

export type SourcesImportRequest = Readonly<{ repository: string; ref?: string; destination: string }>;
export type SourcesImportReview = (request: SourcesImportRequest) => Promise<"allow" | "deny">;

export type SourcesViewProps = Readonly<{
  client: BrowserGitClient;
  author: GitAuthor;
  /** Required fail-closed integration point for Airship's durable approval path. */
  review: SourcesReview;
  workspace: WorkspacePort;
  reviewImport: SourcesImportReview;
  onWorkspaceChanged?: () => void | Promise<void>;
  workspaceDurability?: Readonly<{ state: DurabilityState; detail: string }>;
}>;

export function SourcesView({ client, author, review, workspace, reviewImport, onWorkspaceChanged, workspaceDurability = { state: "ephemeral", detail: "Workspace files exist only in this page runtime." } }: SourcesViewProps) {
  const [repositories, setRepositories] = useState<readonly GitRepositorySnapshot[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [worktreeId, setWorktreeId] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [statusPresentation, setStatusPresentation] = useState<"tree" | "flat">("tree");
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [diff, setDiff] = useState<GitDiff>();
  const [wrapDiff, setWrapDiff] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchTarget, setBranchTarget] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [newWorktreePath, setNewWorktreePath] = useState("");
  const [newWorktreeBranch, setNewWorktreeBranch] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importRepository, setImportRepository] = useState("");
  const [importRef, setImportRef] = useState("");
  const [importDestination, setImportDestination] = useState("");
  const [importProgress, setImportProgress] = useState<RepositoryImportProgress>();
  const [importReceipt, setImportReceipt] = useState<RepositoryImportResult>();
  const operationAbort = useRef<AbortController>();
  const diffAbort = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    setBusy("refresh");
    setError(undefined);
    void client.listRepositories(controller.signal).then((next) => {
      setRepositories(next);
      const preferredId = preferredSourceRepositoryId();
      // Vault adoption replaces the client after this route may already have
      // rendered its page-memory fallback. A remembered imported repository
      // must win once it becomes available in the durable adapter.
      const selectedRepository = next.find((item) => item.id === preferredId)
        ?? next.find((item) => item.id === repositoryId)
        ?? next[0];
      setRepositoryId(selectedRepository?.id ?? "");
      const selectedWorktree = selectedRepository?.worktrees.find((item) => item.id === worktreeId) ?? selectedRepository?.worktrees[0];
      setWorktreeId(selectedWorktree?.id ?? "");
    }, (caught: unknown) => {
      if (!controller.signal.aborted) setError(publicError(caught));
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(undefined);
    });
    return () => controller.abort();
  }, [client, refreshKey]);

  useEffect(() => () => {
    operationAbort.current?.abort();
    diffAbort.current?.abort();
  }, []);

  const repository = repositories.find((item) => item.id === repositoryId) ?? repositories[0];
  const worktree = repository?.worktrees.find((item) => item.id === worktreeId) ?? repository?.worktrees[0];
  const selected = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedStatus = worktree?.status.filter((entry) => selected.has(entry.path)) ?? [];
  const statusTree = useMemo(() => buildStatusTree(worktree?.status ?? []), [worktree?.status]);
  const stagedCount = worktree?.status.filter((entry) => entry.index).length ?? 0;
  const remote = repository?.remotes.find((item) => item.name === "origin") ?? repository?.remotes[0];
  const hasConflict = selectedStatus.some(isConflicted);

  function selectRepository(nextId: string) {
    const next = repositories.find((item) => item.id === nextId);
    rememberSourceRepository(nextId);
    setRepositoryId(nextId);
    setWorktreeId(next?.worktrees[0]?.id ?? "");
    clearSelection();
  }

  function selectWorktree(nextId: string) {
    setWorktreeId(nextId);
    clearSelection();
  }

  function clearSelection() {
    setSelectedPaths([]);
    setDiff(undefined);
    setError(undefined);
    setNotice(undefined);
  }

  function togglePath(path: string) {
    setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }

  async function inspectDiff(entry: GitStatusEntry, scope: GitDiffScope) {
    if (!repository || !worktree) return;
    diffAbort.current?.abort();
    const controller = new AbortController();
    diffAbort.current = controller;
    setBusy(`diff:${entry.path}:${scope}`);
    setError(undefined);
    try {
      setDiff(await client.diff({ repositoryId: repository.id, worktreeId: worktree.id, path: entry.path, scope }, controller.signal));
    } catch (caught) {
      if (!controller.signal.aborted) setError(publicError(caught));
    } finally {
      if (diffAbort.current === controller) diffAbort.current = undefined;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  async function runMutation(operation: GitOperation, success: string): Promise<boolean> {
    if (busy) return false;
    const descriptor = describeGitOperation(operation);
    setError(undefined);
    setNotice(`Review required · ${descriptor.summary}`);
    setBusy(`review:${operation.kind}`);
    const decision = await review(operation, descriptor).catch(() => "deny" as const);
    if (decision !== "allow") {
      setNotice("Operation denied. No repository state changed.");
      setBusy(undefined);
      return false;
    }
    const controller = new AbortController();
    operationAbort.current = controller;
    setBusy(operation.kind);
    setNotice(`Running · ${descriptor.summary}`);
    try {
      const result = await execute(client, operation, controller.signal);
      applyMutation(result);
      setSelectedPaths([]);
      setDiff(undefined);
      setNotice(success);
      return true;
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(publicError(caught));
        if (caught instanceof GitDomainError && caught.code === "push-outcome-unknown") {
          setNotice("Push outcome unknown · fetch the remote before reviewing any retry.");
        }
      }
      return false;
    } finally {
      if (operationAbort.current === controller) operationAbort.current = undefined;
      setBusy(undefined);
    }
  }

  function applyMutation(result: GitMutationResult) {
    setRepositories((current) => {
      const found = current.some((item) => item.id === result.repository.id);
      return found
        ? current.map((item) => item.id === result.repository.id ? result.repository : item)
        : [...current, result.repository];
    });
    setRepositoryId(result.repository.id);
    rememberSourceRepository(result.repository.id);
    if (result.worktree) setWorktreeId(result.worktree.id);
  }

  async function stageSelected() {
    if (!repository || !worktree) return;
    const paths = selectedStatus.filter((entry) => entry.worktree && !isConflicted(entry)).map((entry) => entry.path);
    if (!paths.length) return;
    await runMutation({ kind: "stage", request: { repositoryId: repository.id, worktreeId: worktree.id, paths, expectedWorktreeVersion: worktree.version } }, `Staged ${paths.length} path${paths.length === 1 ? "" : "s"}.`);
  }

  async function unstageSelected() {
    if (!repository || !worktree) return;
    const paths = selectedStatus.filter((entry) => entry.index).map((entry) => entry.path);
    if (!paths.length) return;
    await runMutation({ kind: "unstage", request: { repositoryId: repository.id, worktreeId: worktree.id, paths, expectedWorktreeVersion: worktree.version } }, `Unstaged ${paths.length} path${paths.length === 1 ? "" : "s"}.`);
  }

  async function commit() {
    if (!repository || !worktree || !commitMessage.trim()) return;
    const message = commitMessage;
    if (await runMutation({ kind: "commit", request: { repositoryId: repository.id, worktreeId: worktree.id, message, author, expectedWorktreeVersion: worktree.version } }, "Commit created locally. Nothing was pushed.")) setCommitMessage("");
  }

  async function createBranch() {
    if (!repository || !worktree || !branchName.trim()) return;
    const name = branchName;
    if (await runMutation({ kind: "branch-create", request: { repositoryId: repository.id, worktreeId: worktree.id, name, checkout: false, expectedWorktreeVersion: worktree.version } }, `Created local branch ${name}.`)) setBranchName("");
  }

  async function switchBranch() {
    if (!repository || !worktree || !branchTarget || branchTarget === worktree.branch) return;
    await runMutation({ kind: "branch-switch", request: { repositoryId: repository.id, worktreeId: worktree.id, name: branchTarget, expectedWorktreeVersion: worktree.version } }, `Switched worktree to ${branchTarget}.`);
  }

  async function fetchRemote() {
    if (!repository || !remote) return;
    await runMutation({ kind: "fetch", request: { repositoryId: repository.id, remote: remote.name, expectedRepositoryVersion: repository.version } }, `Fetched ${remote.name}.`);
  }

  async function pushRemote() {
    if (!repository || !worktree || !remote) return;
    await runMutation({ kind: "push", request: { repositoryId: repository.id, worktreeId: worktree.id, remote: remote.name, branch: worktree.branch, expectedWorktreeVersion: worktree.version, force: false } }, `Pushed ${worktree.branch} to ${remote.name}.`);
  }

  async function createWorktree() {
    if (!repository || !newWorktreePath.trim() || !newWorktreeBranch.trim()) return;
    const id = `worktree-${Date.now().toString(36)}`;
    if (await runMutation({ kind: "worktree-create", request: { repositoryId: repository.id, worktreeId: id, path: newWorktreePath.trim(), branch: newWorktreeBranch.trim(), expectedRepositoryVersion: repository.version } }, `Created worktree for ${newWorktreeBranch.trim()}.`)) { setNewWorktreePath(""); setNewWorktreeBranch(""); }
  }

  async function removeWorktree() {
    if (!repository || !worktree || repository.worktrees.length < 2) return;
    await runMutation({ kind: "worktree-remove", request: { repositoryId: repository.id, worktreeId: worktree.id, expectedRepositoryVersion: repository.version } }, `Removed worktree ${worktree.path}.`);
  }

  async function importPublicSnapshot() {
    if (busy || !importRepository.trim()) return;
    const destination = importDestination.trim() || defaultImportDestination(importRepository);
    const request: SourcesImportRequest = {
      repository: importRepository.trim(),
      ...(importRef.trim() ? { ref: importRef.trim() } : {}),
      destination,
    };
    setError(undefined);
    setNotice("Review required · read a public GitHub snapshot and write it into this workspace.");
    setBusy("review:snapshot-import");
    const decision = await reviewImport(request).catch(() => "deny" as const);
    if (decision !== "allow") {
      setNotice("Snapshot import denied. No network request or workspace write occurred.");
      setBusy(undefined);
      return;
    }
    const controller = new AbortController();
    operationAbort.current = controller;
    setBusy("snapshot-import");
    setNotice("Resolving public repository directly from GitHub…");
    try {
      const admission = await importAndAdmitGithubRepository({
        ...request,
        workspace,
        git: client,
        fetch: globalThis.fetch,
        signal: controller.signal,
        onProgress: setImportProgress,
      });
      const result = admission.import;
      if (!admission.git) throw new Error("The browser Git adapter did not admit the imported snapshot.");
      applyMutation(admission.git);
      setImportReceipt(result);
      setImportDestination(result.destination);
      setSelectedPaths([]);
      setNotice(`Imported ${result.filesWritten} pinned text file${result.filesWritten === 1 ? "" : "s"}. Review and stage them locally when ready.`);
      await onWorkspaceChanged?.();
    } catch (caught) {
      if (!controller.signal.aborted) setError(publicError(caught));
    } finally {
      if (operationAbort.current === controller) operationAbort.current = undefined;
      setBusy(undefined);
    }
  }

  return (
    <section class="git-sources" aria-labelledby="git-sources-title">
      <header class="git-sources-heading">
        <div>
          <span>Browser-native source control</span>
          <h1 id="git-sources-title">Repositories &amp; worktrees</h1>
          <p>Inspect, stage, branch, and commit against an adapter-owned browser filesystem. Remote traffic is direct and only available when its CORS and credential contract is actually installed.</p>
          <div class="git-durability-split">
            <span>Workspace files <DurabilityIndicator state={workspaceDurability.state} detail={workspaceDurability.detail} /></span>
            <span>Git index &amp; refs <DurabilityIndicator state={client.capabilities.storage.durable ? "synced" : "ephemeral"} detail={client.capabilities.storage.detail} /></span>
          </div>
        </div>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={Boolean(busy)} aria-label="Refresh repositories"><Icon name="source" /> Refresh</button>
      </header>

      <section class="git-import" aria-labelledby="git-import-title">
        <button class="git-import-toggle" type="button" aria-expanded={importOpen} onClick={() => setImportOpen((value) => !value)}>
          <Icon name="plus" />
          <span><strong id="git-import-title">Import public GitHub snapshot</strong><small>Direct CORS-safe API + raw reads, pinned to one immutable commit</small></span>
          <b>{importOpen ? "Close" : "Import"}</b>
        </button>
        {importOpen ? (
          <div class="git-import-body">
            <div class="git-import-form">
              <label>Repository URL or owner/name<input aria-label="GitHub repository" value={importRepository} onInput={(event) => setImportRepository(event.currentTarget.value)} placeholder="octocat/Hello-World" autoCapitalize="none" spellcheck={false} /></label>
              <label>Ref <small>optional</small><input aria-label="GitHub ref" value={importRef} onInput={(event) => setImportRef(event.currentTarget.value)} placeholder="default branch, tag, or commit" autoCapitalize="none" spellcheck={false} /></label>
              <label>Workspace destination <small>optional</small><input aria-label="Import destination" value={importDestination} onInput={(event) => setImportDestination(event.currentTarget.value)} placeholder={defaultImportDestination(importRepository)} autoCapitalize="none" spellcheck={false} /></label>
              <button class="primary" type="button" disabled={Boolean(busy) || !importRepository.trim()} onClick={importPublicSnapshot}>{busy === "snapshot-import" ? "Importing…" : "Review & import"}</button>
            </div>
            <div class="git-import-contract">
              <strong>Snapshot contract</strong>
              <p>Public repositories only. Airship contacts <code>api.github.com</code> and <code>raw.githubusercontent.com</code> directly; browser CORS, connectivity, and GitHub’s unauthenticated rate limit apply.</p>
              <p>This is not a clone: commit history, tags, Git objects, submodules, LFS objects, and binary files are not imported. Text files are bounded, staged before mutation, and written beneath the chosen workspace path.</p>
            </div>
            {importProgress && busy === "snapshot-import" ? <ImportProgress progress={importProgress} /> : null}
            {importReceipt ? <ImportReceipt receipt={importReceipt} /> : null}
          </div>
        ) : null}
      </section>

      <div class="git-sources-trust git-sources-trust-desktop" role="status">
        <SourceTrustFacts client={client} />
      </div>
      <details class="git-sources-trust-disclosure">
        <summary><span>Source posture</span><strong>{client.capabilities.storage.durable ? "Vault synced" : "Page memory"} · {client.capabilities.remote.transport === "none" ? "Remote unavailable" : "Remote available"} · Version-bound</strong></summary>
        <div class="git-sources-trust" role="status">
          <SourceTrustFacts client={client} />
        </div>
      </details>

      {error ? <div class="git-sources-alert error" role="alert"><Icon name="warning" /><span>{error}</span></div> : null}
      {error?.toLowerCase().includes("version") ? <div class="git-reconcile" role="alert"><strong>Worktree changed since review</strong><span>Refresh this worktree and re-review. Your current path selection stays visible until fresh state arrives.</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Refresh this worktree</button></div> : null}
      {notice ? <div class="git-sources-alert" role="status"><Icon name="proof" /><span>{notice}</span></div> : null}

      {!repository || !worktree ? (
        <div class="git-sources-empty">
          <Icon name="branch" size={28} />
          <h2>{busy === "refresh" ? "Inspecting local repositories…" : "No repository adapter state"}</h2>
          <p>Use the public GitHub snapshot importer above, or install an adapter with a real browser-safe clone path. This surface never invents a proxy.</p>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Check available browser sources</button>
          <small>{client.capabilities.features.clone.available ? "A clone-capable adapter is available." : `Full-history clone unavailable: ${client.capabilities.features.clone.reason ?? "no direct adapter is installed"}.`}</small>
        </div>
      ) : (
        <div class="git-sources-layout">
          <aside class="git-source-rail" aria-label="Repository and worktree selection">
            <div class="git-select-field">
              <span>Repository</span>
              <MenuSelect
                placement="down"
                ariaLabel="Repository"
                value={repository.id}
                options={repositories.map((item) => ({ value: item.id, label: item.name }))}
                onChange={selectRepository}
              />
            </div>
            <div class="git-repository-meta">
              <strong>{repository.name}</strong>
              <span>{shortOid(worktree.head)}</span>
              <small>{repository.storage.durable ? "Durable adapter" : "Page-memory adapter"}</small>
              <small>{repository.lastRemoteSyncAt ? `Last fetch ${relativeTime(repository.lastRemoteSyncAt)}` : "Never fetched in this browser"}</small>
            </div>
            <span class="git-section-label">Worktrees</span>
            <div class="git-worktree-list">
              {repository.worktrees.map((item) => (
                <button class={item.id === worktree.id ? "active" : ""} type="button" onClick={() => selectWorktree(item.id)} key={item.id}>
                  <Icon name="branch" />
                  <span><strong>{item.branch}</strong><small>{item.path}</small></span>
                  <em>{item.status.length}</em>
                </button>
              ))}
            </div>
            <div class="git-branch-controls">
              <div class="git-select-field">
                <span>Switch branch</span>
                <MenuSelect
                  placement="down"
                  ariaLabel="Switch branch"
                  value={branchTarget || worktree.branch}
                  options={repository.branches.map((branch) => ({ value: branch.name, label: branch.name }))}
                  onChange={setBranchTarget}
                />
              </div>
              <button type="button" disabled={Boolean(busy) || !branchTarget || branchTarget === worktree.branch} onClick={switchBranch}>Switch checkout</button>
              <label>New branch<input value={branchName} onInput={(event) => setBranchName(event.currentTarget.value)} placeholder="feature/evidence" /></label>
              <button type="button" disabled={Boolean(busy) || !branchName.trim()} onClick={createBranch}><Icon name="plus" /> Create branch</button>
              <label>Worktree branch<input value={newWorktreeBranch} onInput={(event) => setNewWorktreeBranch(event.currentTarget.value)} placeholder="feature/evidence" /></label>
                  <label>Workspace path<input value={newWorktreePath} onInput={(event) => setNewWorktreePath(event.currentTarget.value)} placeholder="/workspace/worktrees/evidence" /></label>
              <button type="button" disabled={Boolean(busy) || !client.capabilities.features.worktree.available || !newWorktreeBranch.trim() || !newWorktreePath.trim()} title={client.capabilities.features.worktree.reason} onClick={createWorktree}><Icon name="plus" /> Create worktree</button>
              <button type="button" disabled={Boolean(busy) || !client.capabilities.features.worktree.available || repository.worktrees.length < 2} title={repository.worktrees.length < 2 ? "The repository must retain at least one worktree." : client.capabilities.features.worktree.reason} onClick={removeWorktree}>Remove selected worktree</button>
            </div>
          </aside>

          <main class="git-change-stage">
            <div class="git-stage-heading">
              <div><span class="git-section-label">{worktree.branch}</span><h2>{worktree.status.length ? `${worktree.status.length} changed path${worktree.status.length === 1 ? "" : "s"}` : "Worktree clean"}</h2></div>
              <div>
                <div class="git-view-toggle" role="group" aria-label="Changed path layout">
                  <button type="button" aria-pressed={statusPresentation === "tree"} onClick={() => setStatusPresentation("tree")}>Tree</button>
                  <button type="button" aria-pressed={statusPresentation === "flat"} onClick={() => setStatusPresentation("flat")}>Flat</button>
                </div>
                <button type="button" disabled={Boolean(busy) || !selectedStatus.some((entry) => entry.index)} onClick={unstageSelected}>Unstage selected</button>
                <button class="primary" type="button" disabled={Boolean(busy) || !selectedStatus.some((entry) => entry.worktree)} onClick={stageSelected}>Stage selected</button>
              </div>
            </div>
            <p class="git-status-legend"><span><b class="git-delta filled">M</b> Staged = ready to commit</span><span><b class="git-delta outlined">M</b> Working = not yet staged</span></p>
            {hasConflict ? <p class="git-conflict-note" role="status">Conflicted paths are excluded from bulk Stage. Resolve them explicitly, then refresh and mark resolved through the adapter.</p> : null}
            {worktree.status.length ? (
              <div class="git-change-list" role="list" aria-label="Changed paths">
                {statusPresentation === "flat" ? worktree.status.map((entry) => <ChangedPathRow key={entry.path} entry={entry} selected={selected.has(entry.path)} onToggle={togglePath} onInspect={inspectDiff} />) : statusTree.map((node) => <ChangedPathTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  selected={selected}
                  collapsed={collapsedFolders}
                  onToggleFolder={(path) => setCollapsedFolders((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                  onTogglePath={togglePath}
                  onInspect={inspectDiff}
                />)}
              </div>
            ) : <div class="git-clean"><Icon name="check" /><strong>Nothing to stage</strong><span>HEAD, index, and working tree agree.</span></div>}
            <section class="git-diff-panel" aria-label="Selected diff">
              <header><span>{diff ? `${diff.scope} · ${diff.path}` : "Diff inspector"}</span>{diff?.truncated ? <em>bounded preview</em> : null}<label><input type="checkbox" checked={wrapDiff} onChange={(event) => setWrapDiff(event.currentTarget.checked)} /> Wrap</label></header>
              <div class={`git-diff-lines ${wrapDiff ? "wrap" : ""}`}>{diff?.patch ? diff.patch.split("\n").map((line, index) => <div class={diffLineKind(line)} key={`${index}:${line.slice(0, 12)}`}><span>{index + 1}</span><b>{line.startsWith("+") ? "+" : line.startsWith("-") ? "−" : " "}</b><code>{line}</code></div>) : <p>Choose a staged or working diff. Patches are computed locally and bounded before display.</p>}</div>
            </section>
          </main>

          <aside class="git-action-rail" aria-label="Commit and remote actions">
            <section>
              <span class="git-section-label">Local commit</span>
              <strong>{stagedCount} staged path{stagedCount === 1 ? "" : "s"}</strong>
              <label>Message<textarea rows={4} value={commitMessage} onInput={(event) => setCommitMessage(event.currentTarget.value)} placeholder="Describe the evidence-backed change" /></label>
              <small>Author: {author.name} &lt;{author.email}&gt;</small>
              <button class="primary" type="button" disabled={Boolean(busy) || stagedCount === 0 || !commitMessage.trim()} onClick={commit}><Icon name="check" /> Commit locally</button>
              <p>Commit never implies push. Both operations receive separate approval.</p>
            </section>
            <section>
              <span class="git-section-label">Remote boundary</span>
              <strong>{remote ? `${remote.name} · ${remote.transport}` : "No remote configured"}</strong>
              <small>{remote?.url ?? client.capabilities.remote.detail}</small>
              <p class="git-upstream-status" role="status">{upstreamStatus(repository, worktree)}</p>
              <button type="button" disabled={Boolean(busy) || !remote || !client.capabilities.features.fetch.available} onClick={fetchRemote}><Icon name="cloud" /> Fetch direct</button>
              <button type="button" disabled={Boolean(busy) || !remote || !client.capabilities.features.push.available} onClick={pushRemote}><Icon name="source" /> Push {worktree.branch}</button>
              <p class="git-push-warning">Push is always reviewed. A non-fast-forward update is blocked unless the remote is fetched and reconciled first.</p>
              {!client.capabilities.features.push.available ? <p>{client.capabilities.features.push.reason}</p> : <>
                <p>{gitCredentialBoundary(client)}</p>
                <p>If the final response is lost, Airship reports the outcome as unknown and never retries automatically. Fetch before retrying.</p>
              </>}
            </section>
          </aside>
        </div>
      )}
    </section>
  );
}

export type StatusTreeNode = Readonly<{
  name: string;
  path: string;
  kind: "folder" | "file";
  children: readonly StatusTreeNode[];
  entry?: GitStatusEntry;
}>;

/** Deterministic path projection used by the changed-files navigator. */
export function buildStatusTree(entries: readonly GitStatusEntry[]): readonly StatusTreeNode[] {
  type MutableNode = { name: string; path: string; kind: "folder" | "file"; children: MutableNode[]; entry?: GitStatusEntry };
  const root: MutableNode[] = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = entry.path.split("/").filter(Boolean);
    let children = root;
    let parent = "";
    parts.forEach((name, index) => {
      const path = parent ? `${parent}/${name}` : name;
      const isFile = index === parts.length - 1;
      let node = children.find((candidate) => candidate.name === name && candidate.kind === (isFile ? "file" : "folder"));
      if (!node) {
        node = { name, path, kind: isFile ? "file" : "folder", children: [], ...(isFile ? { entry } : {}) };
        children.push(node);
      }
      children = node.children;
      parent = path;
    });
  }
  const sort = (nodes: MutableNode[]): readonly StatusTreeNode[] => nodes
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1)
    .map((node) => Object.freeze({ ...node, children: sort(node.children) }));
  return Object.freeze(sort(root));
}

function ChangedPathTreeNode({ node, depth, selected, collapsed, onToggleFolder, onTogglePath, onInspect }: Readonly<{
  node: StatusTreeNode;
  depth: number;
  selected: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggleFolder(path: string): void;
  onTogglePath(path: string): void;
  onInspect(entry: GitStatusEntry, scope: GitDiffScope): void;
}>) {
  if (node.kind === "file" && node.entry) return <ChangedPathRow entry={node.entry} selected={selected.has(node.entry.path)} onToggle={onTogglePath} onInspect={onInspect} depth={depth} displayName={node.name} />;
  const isCollapsed = collapsed.has(node.path);
  return <div class="git-change-tree-branch" role="listitem">
    <button class="git-change-folder" type="button" aria-expanded={!isCollapsed} style={{ "--tree-depth": depth }} onClick={() => onToggleFolder(node.path)}>
      <span aria-hidden="true">{isCollapsed ? "›" : "⌄"}</span><Icon name="workspace" size={15} /><strong>{node.name}</strong><small>{countTreeFiles(node)} changed</small>
    </button>
    {!isCollapsed ? <div class="git-change-tree-children" role="list">{node.children.map((child) => <ChangedPathTreeNode key={child.path} node={child} depth={depth + 1} selected={selected} collapsed={collapsed} onToggleFolder={onToggleFolder} onTogglePath={onTogglePath} onInspect={onInspect} />)}</div> : null}
  </div>;
}

function ChangedPathRow({ entry, selected, onToggle, onInspect, depth = 0, displayName }: Readonly<{
  entry: GitStatusEntry;
  selected: boolean;
  onToggle(path: string): void;
  onInspect(entry: GitStatusEntry, scope: GitDiffScope): void;
  depth?: number;
  displayName?: string;
}>) {
  return <div class={`git-change-row ${selected ? "selected" : ""} ${isConflicted(entry) ? "conflicted" : ""}`} role="listitem" style={{ "--tree-depth": depth }}>
    <label><input type="checkbox" checked={selected} disabled={isConflicted(entry)} title={isConflicted(entry) ? "Resolve this conflict before staging." : undefined} onChange={() => onToggle(entry.path)} /><Icon name="file" /><span><strong title={entry.path}>{displayName ?? entry.path}</strong><small>{entry.index ? `staged · ${entry.index.kind}` : ""}{entry.index && entry.worktree ? " · " : ""}{entry.worktree ? `working · ${entry.worktree.kind}` : ""}</small></span></label>
    <span class="git-delta-slots" aria-label={gitStatusLabel(entry)}>{entry.index ? <b class="git-delta filled" title={`Staged ${entry.index.kind}`}>{deltaLetter(entry.index.kind)}</b> : <i />}{entry.worktree ? <b class="git-delta outlined" title={`Working ${entry.worktree.kind}`}>{deltaLetter(entry.worktree.kind)}</b> : <i />}</span>
    {entry.index?.fromPath || entry.worktree?.fromPath ? <small class="git-rename">{entry.index?.fromPath ?? entry.worktree?.fromPath} → {entry.path}</small> : null}
    <span class="git-change-count"><i>+{entry.additions ?? 0}</i><b>−{entry.deletions ?? 0}</b></span>
    <div class="git-diff-actions">
      {entry.index ? <button type="button" onClick={() => onInspect(entry, "staged")}>Staged diff</button> : null}
      {entry.worktree ? <button type="button" onClick={() => onInspect(entry, "worktree")}>Working diff</button> : null}
      {isConflicted(entry) ? <button type="button" disabled title="Conflict resolution is not available in this adapter.">Mark resolved</button> : null}
    </div>
  </div>;
}

function countTreeFiles(node: StatusTreeNode): number {
  return node.kind === "file" ? 1 : node.children.reduce((sum, child) => sum + countTreeFiles(child), 0);
}

function SourceTrustFacts({ client }: Readonly<{ client: BrowserGitClient }>) {
  return <>
    <div><span class={client.capabilities.storage.durable ? "ready" : "warning"} /><strong>{storageLabel(client.capabilities.storage.backend)}</strong><small>{client.capabilities.storage.detail}</small></div>
    <div><span class={client.capabilities.remote.transport === "none" ? "warning" : "ready"} /><strong>{remoteLabel(client.capabilities.remote.transport)}</strong><small>{client.capabilities.remote.detail}</small></div>
    <div><Icon name="proof" /><strong>Version-bound writes</strong><small>Every mutation is tied to the reviewed worktree generation.</small></div>
  </>;
}

function ImportProgress({ progress }: Readonly<{ progress: RepositoryImportProgress }>) {
  const percent = progress.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : undefined;
  return (
    <div class="git-import-progress" role="status" aria-live="polite">
      <div><strong>{progressLabel(progress.phase)}</strong><span>{progress.completed}{progress.total ? ` / ${progress.total}` : ""}{progress.bytes !== undefined ? ` · ${formatBytes(progress.bytes)}` : ""}</span></div>
      <div class="git-import-meter" aria-hidden="true"><i style={{ width: `${percent ?? 8}%` }} /></div>
      <small>{progress.detail}</small>
    </div>
  );
}

function ImportReceipt({ receipt }: Readonly<{ receipt: RepositoryImportResult }>) {
  return (
    <article class="git-import-receipt" aria-label="GitHub snapshot import receipt">
      <header><Icon name="proof" /><strong>Snapshot admitted</strong><span>workspace + browser Git</span></header>
      <dl>
        <div><dt>Source</dt><dd>{receipt.repository}@{receipt.ref}</dd></div>
        <div><dt>Pinned commit</dt><dd title={receipt.commit}>{receipt.commit}</dd></div>
        <div><dt>Destination</dt><dd>{receipt.destination}</dd></div>
        <div><dt>Payload</dt><dd>{receipt.filesWritten} text files · {formatBytes(receipt.bytesWritten)}</dd></div>
        <div><dt>Skipped</dt><dd>{receipt.skippedBinary} binary · {receipt.skippedUnsafe} unsafe/oversize</dd></div>
        <div><dt>History</dt><dd>Not imported</dd></div>
      </dl>
      <p>Receipt provenance is also stored in <code>.airship-import.json</code>. Imported files are unstaged local additions so their exact diff can be reviewed before the first local commit.</p>
    </article>
  );
}

function progressLabel(phase: RepositoryImportProgress["phase"]): string {
  return ({ resolving: "Resolving source", tree: "Reading tree", fetching: "Fetching pinned files", writing: "Writing workspace", complete: "Import complete" })[phase];
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function defaultImportDestination(repository: string): string {
  const normalized = repository.trim().replace(/\.git$/u, "").replace(/\/+$/u, "");
  const name = normalized.split("/").filter(Boolean).at(-1)?.replace(/[^A-Za-z0-9._-]/gu, "-") || "repository";
  return `/workspace/sources/${name}`;
}

async function execute(client: BrowserGitClient, operation: GitOperation, signal: AbortSignal): Promise<GitMutationResult> {
  switch (operation.kind) {
    case "stage": return client.stage(operation.request, signal);
    case "unstage": return client.unstage(operation.request, signal);
    case "commit": return client.commit(operation.request, signal);
    case "branch-create": return client.createBranch(operation.request, signal);
    case "branch-switch": return client.switchBranch(operation.request, signal);
    case "worktree-create": return client.createWorktree(operation.request, signal);
    case "worktree-remove": return client.removeWorktree(operation.request, signal);
    case "clone": return client.clone(operation.request, signal);
    case "fetch": return client.fetch(operation.request, signal);
    case "push": return client.push(operation.request, signal);
    case "status":
    case "diff":
      throw new GitDomainError("not-a-mutation", `${operation.kind} is not a mutating operation.`);
  }
}

function shortOid(oid: string): string {
  const digest = oid.includes(":") ? oid.slice(oid.indexOf(":") + 1) : oid;
  return digest.slice(0, 10);
}

function storageLabel(backend: string): string {
  if (backend === "opfs") return "OPFS repository";
  if (backend === "file-system-access") return "Authorized device folder";
  if (backend === "indexeddb") return "IndexedDB repository";
  if (backend === "encrypted-workspace") return "Encrypted vault repository";
  if (backend === "host-managed") return "Host-managed repository";
  return "Page-memory repository";
}

function gitCredentialBoundary(client: BrowserGitClient): string {
  if (client.capabilities.remote.credentialPersistence === "memory-only") {
    return "Authenticated challenges use an integration-supplied credential held only in this page's memory. It is never written to Git config or Vault.";
  }
  if (client.capabilities.remote.credentialPersistence === "host-managed") {
    return "The selected Git host owns credential custody; Airship does not persist or display the credential.";
  }
  return "Anonymous direct push only. This build has no Git credential broker, so an authenticated remote will refuse the request.";
}

function remoteLabel(transport: string): string {
  if (transport === "direct-git-http") return "Direct Git HTTPS";
  if (transport === "host-provider-api") return "Direct provider API";
  return "Remote operations unavailable";
}

function publicError(caught: unknown): string {
  if (caught instanceof GitDomainError) return caught.message;
  return mapUnknownRequestFailure(caught, navigator.onLine).message;
}

function isConflicted(entry: GitStatusEntry): boolean {
  return entry.index?.kind === "conflicted" || entry.worktree?.kind === "conflicted";
}

export function deltaLetter(kind: GitDeltaKind): string {
  return ({ added: "A", modified: "M", deleted: "D", renamed: "R", conflicted: "C" })[kind];
}

function gitStatusLabel(entry: GitStatusEntry): string {
  return [entry.index && `Staged ${entry.index.kind}`, entry.worktree && `Working ${entry.worktree.kind}`].filter(Boolean).join("; ");
}

export function diffLineKind(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  return "context";
}

function relativeTime(value: string): string {
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "at an unknown time";
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function upstreamStatus(repository: GitRepositorySnapshot, worktree: GitRepositorySnapshot["worktrees"][number]): string {
  const remote = repository.remotes.find((item) => item.name === "origin") ?? repository.remotes[0];
  if (!remote) return "No upstream configured. Ahead/behind unavailable.";
  const fetched = repository.lastRemoteSyncAt ? ` Fetched ${relativeTime(repository.lastRemoteSyncAt)}.` : " Not fetched here.";
  return `${worktree.branch} → ${remote.name}/${worktree.branch}. Adapter does not report ahead/behind.${fetched}`;
}
