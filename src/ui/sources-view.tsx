import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { GitDomainError } from "../git/errors";
import { describeGitOperation } from "../git/operations";
import type {
  GitAuthor,
  GitCommitDetail,
  GitCommitSummary,
  GitDiff,
  GitDiffScope,
  GitDeltaKind,
  GitMutationResult,
  GitOperation,
  GitOperationDescriptor,
  GitRepositorySnapshot,
  GitStatusEntry,
  GitTagSummary,
} from "../git/types";
import type { BrowserGitClient } from "../git/client";
import { preferredSourceRepositoryId, rememberSourceRepository } from "../git/source-selection";
import { isRemoteOriginPermitted, remoteOrigin } from "../git/validation";
import type { RepositoryImportProgress, RepositoryImportResult } from "../tools/repository-import";
import { importAndAdmitGithubRepository } from "../tools/repository-admission";
import type { WorkspacePort } from "../workspace/contracts";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import { Tabs } from "./tabs";
import { durabilityLabel, type DurabilityState } from "./durability-indicator";
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
  /** Rendered as Workspace → Source Control's advanced modal, never a route. */
  embedded?: boolean;
}>;

/** Depth of one history read. Bounded here so the pane cannot outgrow its box. */
const HISTORY_DEPTH = 50;

export function SourcesView({ client, author, review, workspace, reviewImport, onWorkspaceChanged, workspaceDurability = { state: "ephemeral", detail: "Workspace files exist only in this page runtime." }, embedded = false }: SourcesViewProps) {
  const [repositories, setRepositories] = useState<readonly GitRepositorySnapshot[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [worktreeId, setWorktreeId] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [statusPresentation, setStatusPresentation] = useState<"tree" | "flat">("tree");
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [pane, setPane] = useState<"changes" | "history">("changes");
  const [diff, setDiff] = useState<GitDiff>();
  const [commit, setCommit] = useState<GitCommitDetail>();
  const [commitPath, setCommitPath] = useState<string>();
  // Wrap defaults on: the longest patch line measured on this surface was 261
  // characters against a 669px panel, so `pre` clipped the end of the line the
  // reader came to read. Wrapping shows every character; the two-gutter layout
  // is what keeps a wrapped line legible.
  const [wrapDiff, setWrapDiff] = useState(true);
  const [postureOpen, setPostureOpen] = useState(false);
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
  const postureRef = useRef<HTMLDetailsElement>(null);

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
  // `features.fetch/push.available` is one flag for the whole build, and it is
  // true whenever any origin is permitted — the page's own always is. The
  // decision that actually governs a fetch or push is per-remote
  // (`assertRemoteOriginPermitted`), so the controls follow the remote in hand.
  const remoteReachable = remote ? isRemoteOriginPermitted(remote.url, client.capabilities.remote.permittedOrigins) : false;
  const hasConflict = selectedStatus.some(isConflicted);
  const posture = useMemo(
    () => sourcePostureFacts(client.capabilities, workspaceDurability),
    [client.capabilities, workspaceDurability.state, workspaceDurability.detail],
  );
  const history = client.capabilities.features.history;

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
    clearInspection();
    setError(undefined);
    setNotice(undefined);
  }

  function clearInspection() {
    setDiff(undefined);
    setCommit(undefined);
    setCommitPath(undefined);
  }

  function togglePath(path: string) {
    setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }

  /** Opens the one posture disclosure from anywhere that used to restate it. */
  function revealPosture() {
    setPostureOpen(true);
    postureRef.current?.scrollIntoView({ block: "nearest" });
    postureRef.current?.querySelector("summary")?.focus();
  }

  async function inspectDiff(entry: GitStatusEntry, scope: GitDiffScope) {
    if (!repository || !worktree) return;
    diffAbort.current?.abort();
    const controller = new AbortController();
    diffAbort.current = controller;
    setBusy(`diff:${entry.path}:${scope}`);
    setError(undefined);
    try {
      const next = await client.diff({ repositoryId: repository.id, worktreeId: worktree.id, path: entry.path, scope }, controller.signal);
      setCommit(undefined);
      setCommitPath(undefined);
      setDiff(next);
    } catch (caught) {
      if (!controller.signal.aborted) setError(publicError(caught));
    } finally {
      if (diffAbort.current === controller) diffAbort.current = undefined;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  async function inspectCommit(oid: string) {
    if (!repository || !worktree) return;
    diffAbort.current?.abort();
    const controller = new AbortController();
    diffAbort.current = controller;
    setBusy(`show:${oid}`);
    setError(undefined);
    try {
      const detail = await client.show({ repositoryId: repository.id, worktreeId: worktree.id, revision: oid }, controller.signal);
      setDiff(undefined);
      setCommit(detail);
      setCommitPath(detail.files[0]?.path);
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
      clearInspection();
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

  async function commitStaged() {
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
    <section class={`git-sources${embedded ? " git-sources--embedded" : ""}`} aria-labelledby="git-sources-title">
      {/* The 158px eyebrow/serif-H1/paragraph slab becomes the shared 44px bar.
          Nothing is dropped: the eyebrow is the ⓘ panel's heading and the
          paragraph is its body, both verbatim, and the ⓘ opens itself on the
          first visit to this pane so a first-run reader still meets the
          remote-traffic caveat before touching anything. */}
      <RouteHeader
        class="git-sources-header"
        routeId="sources"
        density="tool"
        title="Repositories & worktrees"
        // The advanced sheet is the only visible home for this title now; the
        // removed route-level Sources tab no longer duplicates it above.
        titleVisible={embedded}
        eyebrow="Browser-native source control"
        description="Inspect, stage, branch, and commit against an adapter-owned browser filesystem. Remote traffic is direct and only available when its CORS and credential contract is actually installed."
        headingId="git-sources-title"
        actions={<>
          <button
            class="git-import-toggle"
            type="button"
            aria-expanded={importOpen}
            title="Direct CORS-safe API + raw reads, pinned to one immutable commit"
            onClick={() => setImportOpen((value) => !value)}
          ><Icon name="plus" /> {importOpen ? "Close import" : "Import"}</button>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={Boolean(busy)} aria-label="Refresh repositories"><Icon name="source" /> Refresh</button>
        </>}
      />

      {/* One posture row at every width. The three trust cards and the two
          durability pills used to render as a 212px desktop grid *and* a phone
          disclosure — the same facts twice, in two layouts, with the middle
          card's 660-character Content-Security-Policy paragraph also printed a
          second time under Remote boundary. The summary names every fact it
          holds, so the collapse cannot bury one. */}
      <details
        class="git-sources-trust-disclosure"
        ref={postureRef}
        open={postureOpen}
        onToggle={(event) => setPostureOpen(event.currentTarget.open)}
      >
        <summary>
          <span class="eyebrow">Source posture</span>
          <span class="git-posture-chips">
            {posture.map((fact) => <Seal key={fact.id} state={fact.state} label={fact.label} density="chip" />)}
          </span>
          <small>{posture.length} facts · full detail</small>
        </summary>
        <div class="git-sources-trust" role="status">
          <SourceTrustFacts facts={posture} />
        </div>
      </details>

      {importOpen ? (
        <section class="git-import" aria-labelledby="git-import-title">
          <div class="git-import-body">
            <div class="git-import-title">
              <strong id="git-import-title">Import public GitHub snapshot</strong>
              <small>Direct CORS-safe API + raw reads, pinned to one immutable commit</small>
            </div>
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
        </section>
      ) : null}

      {error ? <div class="git-sources-alert error" role="alert"><Icon name="warning" /><span>{error}</span></div> : null}
      {error?.toLowerCase().includes("version") ? <div class="git-reconcile" role="alert"><strong>Worktree changed since review</strong><span>Refresh this worktree and re-review. Your current path selection stays visible until fresh state arrives.</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Refresh this worktree</button></div> : null}
      {notice ? <div class="git-sources-alert" role="status"><Icon name="proof" /><span>{notice}</span></div> : null}

      {!repository || !worktree ? (
        <div class="git-sources-empty">
          <Icon name="branch" size={28} />
          <h2>{busy === "refresh" ? "Inspecting local repositories…" : "No repository adapter state"}</h2>
          <p>Use the public GitHub snapshot importer above, or install an adapter with a real browser-safe clone path. This surface never invents a proxy.</p>
          <div class="git-sources-empty__actions">
            <button class="primary" type="button" onClick={() => setImportOpen(true)}><Icon name="plus" /> Import a public GitHub snapshot</button>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Check available browser sources</button>
          </div>
          <small>{cloneBoundaryNote(client.capabilities)}</small>
        </div>
      ) : (
        <div class="git-sources-layout">
          <main class="git-change-stage">
            <div class="git-stage-heading">
              <Tabs
                label="Source control views"
                class="git-stage-tabs"
                items={[
                  { id: "changes", label: "Changes", count: worktree.status.length, countLabel: `${worktree.status.length} changed paths` },
                  // `detail` becomes the tab's accessible name, so it carries
                  // the honest reason only when the tab cannot be opened.
                  history.available
                    ? { id: "history", label: "History" }
                    : {
                      id: "history",
                      label: "History",
                      disabled: true,
                      hint: "unavailable",
                      detail: `History unavailable: ${history.reason ?? "this adapter does not read commit history"}`,
                    },
                ]}
                activeId={pane}
                onSelect={(next) => setPane(next === "history" ? "history" : "changes")}
                panelId={(id) => `git-pane-${id}`}
              />
              <div class="git-stage-actions">
                {pane === "changes" ? <>
                  <div class="git-view-toggle" role="group" aria-label="Changed path layout">
                    <button type="button" aria-pressed={statusPresentation === "tree"} onClick={() => setStatusPresentation("tree")}>Tree</button>
                    <button type="button" aria-pressed={statusPresentation === "flat"} onClick={() => setStatusPresentation("flat")}>Flat</button>
                  </div>
                  <button type="button" disabled={Boolean(busy) || !selectedStatus.some((entry) => entry.index)} onClick={unstageSelected}>Unstage selected</button>
                  <button class="primary" type="button" disabled={Boolean(busy) || !selectedStatus.some((entry) => entry.worktree)} onClick={stageSelected}>Stage selected</button>
                </> : null}
              </div>
            </div>

            {pane === "changes" ? (
              <div class="git-pane" id="git-pane-changes" role="tabpanel" aria-label="Changed paths">
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
                ) : (
                  <div class="git-clean">
                    <Icon name="check" />
                    <strong>Nothing to stage</strong>
                    <span>HEAD, index, and working tree agree.</span>
                    {history.available ? <button type="button" onClick={() => setPane("history")}>Read the history of {worktree.branch}</button> : null}
                  </div>
                )}
              </div>
            ) : (
              <HistoryPane
                client={client}
                repository={repository}
                worktree={worktree}
                selectedOid={commit?.commit.oid}
                onSelect={inspectCommit}
                onError={setError}
              />
            )}

          </main>

          <div class="git-rails">
              <details class="git-repository-controls" open={repository.worktrees.length > 1}>
                <summary>
                  <span class="eyebrow">Repository</span>
                  <strong>{repository.name} · {worktree.branch} · {shortOid(worktree.head)}</strong>
                  <small>{repository.worktrees.length} worktree{repository.worktrees.length === 1 ? "" : "s"} · branch, worktree and checkout controls</small>
                </summary>
                <div class="git-repository-controls__body">
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
                </div>
              </details>

              <section class="git-commit-box">
                <span class="git-section-label">Local commit</span>
                <strong>{stagedCount} staged path{stagedCount === 1 ? "" : "s"}</strong>
                <label>Message<textarea rows={3} value={commitMessage} onInput={(event) => setCommitMessage(event.currentTarget.value)} placeholder="Describe the evidence-backed change" /></label>
                <small>Author: {author.name} &lt;{author.email}&gt;</small>
                <button class="primary" type="button" disabled={Boolean(busy) || stagedCount === 0 || !commitMessage.trim()} onClick={commitStaged}><Icon name="check" /> Commit locally</button>
                <p>Commit never implies push. Both operations receive separate approval.</p>
              </section>

              {/* Open exactly when a remote operation can actually run. The
                  1,030-character remote essay was permanently on screen while
                  both of its buttons were disabled; the live claim
                  (`upstreamStatus`) stays visible either way. */}
              <details class="git-remote-boundary" open={remoteReachable && (client.capabilities.features.fetch.available || client.capabilities.features.push.available)}>
                <summary>
                  <span class="eyebrow">Remote boundary</span>
                  <strong>{remote ? `${remote.name} · ${remote.transport}` : "No remote configured"}</strong>
                  <small class="git-upstream-status" role="status">{upstreamStatus(repository, worktree)}</small>
                </summary>
                <div class="git-remote-boundary__body">
                  {remote ? <small class="git-remote-url">{remote.url}</small> : null}
                  <button type="button" disabled={Boolean(busy) || !remoteReachable || !client.capabilities.features.fetch.available} onClick={fetchRemote}><Icon name="cloud" /> Fetch direct</button>
                  <button type="button" disabled={Boolean(busy) || !remoteReachable || !client.capabilities.features.push.available} onClick={pushRemote}><Icon name="source" /> Push {worktree.branch}</button>
                  <p class="git-push-warning">Push is always reviewed. A non-fast-forward update is blocked unless the remote is fetched and reconciled first.</p>
                  {remoteBoundaryParagraphs(client.capabilities, remote).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {/* The transport's own contract paragraph is stated once, in
                      Source posture. This is a pointer to it, not a reprint —
                      and an adapter with no transport has no CSP permission to
                      point at, so it gets the pointer without the claim. */}
                  {client.capabilities.remote.transport === "none"
                    ? <p>This adapter's remote contract is stated once, under <button class="git-inline-link" type="button" onClick={revealPosture}>Source posture ↑</button>.</p>
                    : <p>What this build's Content-Security-Policy permits is stated once, under <button class="git-inline-link" type="button" onClick={revealPosture}>Source posture ↑</button>.</p>}
                </div>
              </details>
          </div>

          <DiffPanel
            diff={diff}
            commit={commit}
            commitPath={commitPath}
            onSelectCommitPath={setCommitPath}
            wrap={wrapDiff}
            onWrapChange={setWrapDiff}
            busy={busy}
          />
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
    {/* The two slots read as single letters — "M", "A", "?" — so the label is
        the only text that says what they mean. On a bare span ARIA drops it:
        naming an element whose computed role is generic is forbidden. `role="img"`
        is the smallest role that permits a name and keeps the letters as the
        decoration they are. */}
    <span class="git-delta-slots" role="img" aria-label={gitStatusLabel(entry)}>{entry.index ? <b class="git-delta filled" title={`Staged ${entry.index.kind}`}>{deltaLetter(entry.index.kind)}</b> : <i />}{entry.worktree ? <b class="git-delta outlined" title={`Working ${entry.worktree.kind}`}>{deltaLetter(entry.worktree.kind)}</b> : <i />}</span>
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

/**
 * Commit history, read through the verbs the adapter already implements.
 *
 * `BrowserGitClient.log` and `.show` shipped with the object database and were
 * reachable only by typing into the Terminal's Shared Git box on another
 * route: after a commit, this surface showed nothing, and a branch created
 * here appeared nowhere but inside a closed select. Both calls are reads, so
 * neither passes through the approval path — which is also why this pane adds
 * no mutating verb: a half-built menu of tag/stash/merge/reset would be worse
 * than the honest absence.
 */
function HistoryPane({ client, repository, worktree, selectedOid, onSelect, onError }: Readonly<{
  client: BrowserGitClient;
  repository: GitRepositorySnapshot;
  worktree: GitRepositorySnapshot["worktrees"][number];
  selectedOid?: string;
  onSelect(oid: string): void;
  onError(message: string): void;
}>) {
  const [commits, setCommits] = useState<readonly GitCommitSummary[]>();
  const [tags, setTags] = useState<readonly GitTagSummary[]>([]);
  const capability = client.capabilities.features.history;

  useEffect(() => {
    if (!capability.available) return;
    const controller = new AbortController();
    setCommits(undefined);
    void client.log({ repositoryId: repository.id, worktreeId: worktree.id, depth: HISTORY_DEPTH }, controller.signal)
      .then((next) => setCommits(next), (caught: unknown) => {
        if (!controller.signal.aborted) { setCommits([]); onError(publicError(caught)); }
      });
    // Tags are decoration on a row; a tag read that fails must not blank the
    // history that succeeded, so its failure is swallowed rather than raised.
    void client.listTags(repository.id, controller.signal).then(setTags, () => setTags([]));
    return () => controller.abort();
  }, [client, repository.id, repository.version, worktree.id, worktree.version, capability.available]);

  if (!capability.available) {
    return <div class="git-pane git-clean" id="git-pane-history" role="tabpanel">
      <Icon name="branch" />
      <strong>History unavailable</strong>
      <span>{capability.reason ?? "This adapter does not read commit history."}</span>
    </div>;
  }

  return <div class="git-pane" id="git-pane-history" role="tabpanel" aria-label="Commit history">
    <p class="git-status-legend"><span>{commits === undefined ? "Reading history…" : `${commits.length} commit${commits.length === 1 ? "" : "s"} on ${worktree.branch}, newest first`}</span><span>Bounded to the {HISTORY_DEPTH} most recent.</span></p>
    <div class="git-history-list" role="list" aria-label="Commits">
      {commits?.length === 0 ? <p class="git-history-empty">No commit is recorded in this repository yet.</p> : null}
      {commits?.map((entry) => {
        const refs = commitRefs(entry.oid, repository, tags);
        return <button
          class={`git-history-row ${entry.oid === selectedOid ? "selected" : ""}`}
          key={entry.oid}
          type="button"
          role="listitem"
          aria-current={entry.oid === selectedOid ? "true" : undefined}
          title={entry.message}
          onClick={() => onSelect(entry.oid)}
        >
          <code>{shortOid(entry.oid)}</code>
          <strong>{commitSubject(entry.message)}</strong>
          {refs.length ? <span class="git-history-refs">{refs.map((ref) => <em key={ref}>{ref}</em>)}</span> : null}
          <small>{entry.author.name} · {relativeTime(entry.committedAt)}{entry.parents.length > 1 ? " · merge" : ""}</small>
        </button>;
      })}
    </div>
  </div>;
}

/** Branch and tag names pointing at one commit, so a new branch is visible. */
export function commitRefs(
  oid: string,
  repository: Readonly<{ branches: readonly Readonly<{ name: string; oid: string }>[] }>,
  tags: readonly GitTagSummary[],
): readonly string[] {
  return Object.freeze([
    ...repository.branches.filter((branch) => branch.oid === oid).map((branch) => branch.name),
    ...tags.filter((tag) => tag.target === oid || tag.oid === oid).map((tag) => `tag: ${tag.name}`),
  ]);
}

/** First line of a commit message; the whole message stays in `title`. */
export function commitSubject(message: string): string {
  return message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(no message)";
}

function DiffPanel({ diff, commit, commitPath, onSelectCommitPath, wrap, onWrapChange, busy }: Readonly<{
  diff?: GitDiff;
  commit?: GitCommitDetail;
  commitPath?: string;
  onSelectCommitPath(path: string): void;
  wrap: boolean;
  onWrapChange(next: boolean): void;
  busy?: string;
}>) {
  const file = commit?.files.find((item) => item.path === commitPath) ?? commit?.files[0];
  const patch = commit ? file?.patch : diff?.patch;
  const parsed = useMemo(() => parseUnifiedPatch(patch ?? ""), [patch]);
  const title = commit
    ? `${file?.path ?? commitSubject(commit.commit.message)}`
    : diff?.path ?? "Diff inspector";
  const subtitle = commit
    ? `commit ${shortOid(commit.commit.oid)} · ${commitSubject(commit.commit.message)}`
    : diff ? diffComparisonLabel(diff.scope) : undefined;
  const truncated = commit ? file?.truncated : diff?.truncated;

  return <section class="git-diff-panel" aria-label="Selected diff">
    <header>
      <div class="git-diff-title">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      {truncated ? <em>bounded preview</em> : null}
      <label><input type="checkbox" checked={wrap} onChange={(event) => onWrapChange(event.currentTarget.checked)} /> Wrap</label>
    </header>
    {commit && commit.files.length > 1 ? (
      <div class="git-diff-files" role="group" aria-label="Files in this commit">
        {commit.files.map((item) => <button
          class={item.path === (file?.path ?? "") ? "active" : ""}
          key={item.path}
          type="button"
          title={item.path}
          onClick={() => onSelectCommitPath(item.path)}
        ><b class="git-delta outlined">{deltaLetter(item.kind)}</b>{item.path}</button>)}
      </div>
    ) : null}
    {/* `---`/`+++`/`diff --git` are headers about the file, not lines of it.
        They kept the gutter's first three numbers and pushed real code out of
        a 91px box; here they render verbatim, once, above the code. */}
    {parsed.header.length ? <p class="git-diff-header">{parsed.header.map((line) => <code key={line}>{line}</code>)}</p> : null}
    {commit?.truncated ? <p class="git-diff-notice" role="status">This commit touched more paths than the per-commit patch bound; the paths above are the bounded set.</p> : null}
    {file?.binary || diff?.binary ? <p class="git-diff-notice" role="status">Binary file. Airship does not render a byte diff.</p> : null}
    <div class={`git-diff-lines ${wrap ? "wrap" : ""}`}>
      {parsed.lines.length ? parsed.lines.map((line, index) => (
        line.kind === "hunk"
          ? <div class="hunk" key={`${index}:${line.raw}`}><code>{line.raw}</code></div>
          : <div class={line.kind} key={`${index}:${line.raw.slice(0, 16)}`}>
            <span class="git-diff-old">{line.oldLine ?? ""}</span>
            <span class="git-diff-new">{line.newLine ?? ""}</span>
            <b>{line.sign}</b>
            <code>{line.text}</code>
          </div>
      )) : <p>{diffPlaceholder({ diff, commit, file, busy })}</p>}
    </div>
  </section>;
}

/** What the diff box says when it has no patch to draw. */
export function diffPlaceholder(input: Readonly<{
  diff?: GitDiff;
  commit?: GitCommitDetail;
  file?: Readonly<{ path: string; binary: boolean }>;
  busy?: string;
}>): string {
  if (input.busy?.startsWith("diff:") || input.busy?.startsWith("show:")) return "Computing this patch locally…";
  // "Nothing is selected" and "this file has no textual change" used to read
  // identically, which conflated an idle panel with an empty-file answer.
  if (input.commit && input.file) return `No textual change in ${input.file.path} for this commit.`;
  if (input.commit) return "This commit records no bounded file patch.";
  if (input.diff) return `No textual change in ${input.diff.path}. The comparison returned an empty patch.`;
  return "Choose a staged or working diff. Patches are computed locally and bounded before display.";
}

/** Plain English for the two comparisons the raw scope enum names. */
export function diffComparisonLabel(scope: GitDiffScope): string {
  return scope === "staged" ? "index vs HEAD" : "working tree vs index";
}

export type DiffLine = Readonly<{
  kind: "context" | "added" | "removed" | "hunk";
  sign: string;
  text: string;
  raw: string;
  oldLine?: number;
  newLine?: number;
}>;

export type ParsedPatch = Readonly<{
  /** `diff --git`, `index`, `---`, `+++`, mode lines — verbatim, in order. */
  header: readonly string[];
  lines: readonly DiffLine[];
}>;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * A unified patch, projected onto real file line numbers.
 *
 * The previous renderer numbered the *array*, so `--- a/README.md` was line 1
 * and no reader could map a hunk to a file. It also printed the sign twice —
 * once as its own cell and once because the raw line was never stripped — so
 * the screen read `+ +# Airship workspace`. Both are parsing bugs, not styling
 * ones: the `@@` headers carry the counters, and this reads them.
 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  const header: string[] = [];
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows = patch.split("\n");
  // A unified patch ends with a newline, so the split leaves a trailing empty
  // string. Rendering it produced a numbered row of nothing at the end of
  // every file.
  if (rows.at(-1) === "") rows.pop();
  for (const raw of rows) {
    if (raw === "" && lines.length === 0 && header.length === 0) continue;
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push(Object.freeze({ kind: "hunk", sign: "", text: raw, raw }));
      continue;
    }
    if (!inHunk) {
      // Everything before the first hunk is file-level header text.
      if (raw.length) header.push(raw);
      continue;
    }
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the previous line and numbers
      // nothing; it is kept verbatim as an unnumbered context row.
      lines.push(Object.freeze({ kind: "context", sign: " ", text: raw, raw }));
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push(Object.freeze({ kind: "added", sign: "+", text: raw.slice(1), raw, newLine }));
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push(Object.freeze({ kind: "removed", sign: "−", text: raw.slice(1), raw, oldLine }));
      oldLine += 1;
      continue;
    }
    lines.push(Object.freeze({ kind: "context", sign: " ", text: raw.startsWith(" ") ? raw.slice(1) : raw, raw, oldLine, newLine }));
    oldLine += 1;
    newLine += 1;
  }
  return Object.freeze({ header: Object.freeze(header), lines: Object.freeze(lines) });
}

export type SourcePostureFact = Readonly<{
  id: string;
  state: SealState;
  label: string;
  detail: string;
}>;

/**
 * Every posture claim this surface makes, computed once and rendered once.
 *
 * Three trust cards, two durability pills and a repeat of the transport
 * paragraph under Remote boundary were five renderings of four facts. The
 * durability pair merges only while the two scopes agree — a workspace held in
 * a vault behind a page-memory Git index is a real, different state and still
 * renders as two rows.
 */
export function sourcePostureFacts(
  capabilities: BrowserGitClient["capabilities"],
  workspaceDurability: Readonly<{ state: DurabilityState; detail: string }>,
): readonly SourcePostureFact[] {
  const gitDurability: DurabilityState = capabilities.storage.durable ? "synced" : "ephemeral";
  const durability: readonly SourcePostureFact[] = workspaceDurability.state === gitDurability
    ? [{
      id: "durability",
      state: durabilitySeal(gitDurability),
      // Scoped even when merged: the Workspace route header states the
      // workspace-files durability on its own, and two chips reading exactly
      // `Ephemeral · this page only` 200px apart is the restatement this
      // package exists to remove. This one covers strictly more — the Git
      // index and refs as well — so it says so.
      label: `Workspace & Git index · ${durabilityLabel(gitDurability)}`,
      detail: `Workspace files — ${workspaceDurability.detail} Git index & refs — ${capabilities.storage.detail}`,
    }]
    : [
      {
        id: "durability-workspace",
        state: durabilitySeal(workspaceDurability.state),
        label: `Workspace files · ${durabilityLabel(workspaceDurability.state)}`,
        detail: workspaceDurability.detail,
      },
      {
        id: "durability-git",
        state: durabilitySeal(gitDurability),
        label: `Git index & refs · ${durabilityLabel(gitDurability)}`,
        detail: capabilities.storage.detail,
      },
    ];
  const facts: readonly SourcePostureFact[] = [
    {
      id: "storage",
      // Page memory is `none` — nothing failed, nothing durable was claimed.
      state: capabilities.storage.durable ? "verified" : "none",
      label: storageLabel(capabilities.storage.backend),
      detail: capabilities.storage.detail,
    },
    {
      id: "remote",
      // A transport with no origin it may reach is not "ready", which is what
      // the teal dot said while the paragraph beside it named the two hosts
      // this build's Content-Security-Policy blocks.
      state: capabilities.remote.transport === "none"
        ? "none"
        : capabilities.remote.permittedOrigins.length === 0 ? "attention" : "asserted",
      label: remoteTransportLabel(capabilities.remote.transport, capabilities.remote.permittedOrigins.length),
      detail: capabilities.remote.detail,
    },
    {
      id: "version-bound",
      // Airship enforces this, and nothing external verifies it: `asserted`.
      state: "asserted",
      label: "Version-bound writes",
      detail: "Every mutation is tied to the reviewed worktree generation.",
    },
    ...durability,
  ];
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
}

function durabilitySeal(state: DurabilityState): SealState {
  return state === "ephemeral" ? "none" : state === "syncing" ? "checking" : "verified";
}

/** The transport, and how many origins this page may actually reach with it. */
export function remoteTransportLabel(transport: string, permittedOrigins: number): string {
  const name = remoteLabel(transport);
  if (transport === "none") return name;
  return `${name} · ${permittedOrigins} permitted origin${permittedOrigins === 1 ? "" : "s"}`;
}

function SourceTrustFacts({ facts }: Readonly<{ facts: readonly SourcePostureFact[] }>) {
  return <>
    {facts.map((fact) => <div key={fact.id}>
      <Seal state={fact.state} label={fact.label} density="chip" />
      <small>{fact.detail}</small>
    </div>)}
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
    // Source Control drives one reviewed mutation per button. Read-only kinds
    // and the verbs this panel does not surface fail closed here rather than
    // being routed to an approximate neighbour. The History pane reads through
    // `log`/`show` directly and never enters this path: tag, stash, merge,
    // restore and reset are implemented in the client and still have no UI.
    default:
      throw new GitDomainError("not-a-source-control-mutation", `${operation.kind} is not a mutation this Source Control panel performs.`);
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

function gitCredentialBoundary(capabilities: BrowserGitClient["capabilities"]): string {
  if (capabilities.remote.credentialPersistence === "memory-only") {
    return "Authenticated challenges use an integration-supplied credential held only in this page's memory. It is never written to Git config or Vault.";
  }
  if (capabilities.remote.credentialPersistence === "host-managed") {
    return "The selected Git host owns credential custody; Airship does not persist or display the credential.";
  }
  return "Anonymous direct push only. This build has no Git credential broker, so an authenticated remote will refuse the request.";
}

/**
 * The paragraphs under the remote boundary, in order. A remote this build's
 * CSP cannot reach never gets the credential-custody sentence: no request is
 * ever sent, so custody is not the thing standing in the way, and saying
 * "anonymous direct push only" would describe a push that cannot happen.
 */
export function remoteBoundaryParagraphs(
  capabilities: BrowserGitClient["capabilities"],
  remote: Readonly<{ url: string }> | undefined,
): readonly string[] {
  // A transport-less adapter (memory, encrypted workspace) permits no origin
  // because it installs no Git HTTP client at all, not because the page's
  // policy refused one — and it can still carry a real GitHub `origin` that
  // snapshot import registered. Answering with the CSP sentence there would
  // blame the wrong layer and bury the adapter's own reason, so the adapter
  // speaks first and the policy sentence is kept for builds that do have a
  // transport and a remote that transport may not reach.
  if (capabilities.remote.transport === "none") {
    return [capabilities.features.push.reason ?? "This adapter installs no Git remote transport, so fetch and push never leave this page."];
  }
  if (remote && !isRemoteOriginPermitted(remote.url, capabilities.remote.permittedOrigins)) {
    const origin = remoteOrigin(remote.url) ?? remote.url;
    return [
      `This build's Content-Security-Policy does not permit ${origin}, so fetch and push against this remote are refused before any request is sent — the adapter's capability flags describe the build, not this remote.`,
      `Git Smart HTTP may reach ${permittedOriginList(capabilities)} from this page.`,
    ];
  }
  if (!capabilities.features.push.available) {
    return [capabilities.features.push.reason ?? "Push is unavailable on this adapter."];
  }
  return [
    gitCredentialBoundary(capabilities),
    "If the final response is lost, Airship reports the outcome as unknown and never retries automatically. Fetch before retrying.",
  ];
}

/**
 * The empty state offers the snapshot importer and no clone control, so it may
 * not advertise a clone adapter as if one could be driven from here. State the
 * origin boundary a clone would actually be judged against instead.
 */
export function cloneBoundaryNote(capabilities: BrowserGitClient["capabilities"]): string {
  if (!capabilities.features.clone.available) {
    return `Full-history clone unavailable: ${capabilities.features.clone.reason ?? "no direct adapter is installed"}.`;
  }
  return `Full-history clone can reach only ${permittedOriginList(capabilities)} — the origins this build's Content-Security-Policy permits Git Smart HTTP to. Every other remote is refused before a request is sent.`;
}

function permittedOriginList(capabilities: BrowserGitClient["capabilities"]): string {
  const permitted = capabilities.remote.permittedOrigins;
  return permitted.length ? permitted.join(", ") : "no origin at all";
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
