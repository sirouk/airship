import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import { describeGitOperation } from "../git/operations";
import { preferredSourceRepositoryId } from "../git/source-selection";
import { gitWorktreeWorkspaceRoot, resolveGitWorkspaceBinding } from "../git/workspace-binding";
import type { GitAuthor, GitOperation, GitOperationDescriptor, GitRepositorySnapshot, GitStatusEntry, GitWorktreeSnapshot } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { normalizeWorkspacePath } from "../workspace/contracts";
import { moveWorkspaceFile } from "../workspace/mutations";
import { buildWorkspaceTree, visibleWorkspaceTree, workspaceBaseName, workspaceDirectories, workspaceParentPath } from "../workspace/tree";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { DurabilityIndicator, type DurabilityState } from "./durability-indicator";
import "./workspace-view.css";

export const WORKSPACE_FILE_ROW_HEIGHT = 34;
export const WORKSPACE_FILE_OVERSCAN = 7;
export const WORKSPACE_EDITOR_BYTE_LIMIT = 128 * 1024;
export const WORKSPACE_FILE_VIEWPORT_HEIGHT = 432;
const TAB_STORAGE = "airship.workspace.tabs.v1";
const PAGE_DRAFTS = new WeakMap<WorkspacePort, Readonly<Record<string, Buffer>>>();

type Review = (operation: GitOperation, descriptor: GitOperationDescriptor) => Promise<"allow" | "deny">;
type Buffer = WorkspaceFile & { draft: string; truncated: boolean };
type Dialog = Readonly<{ kind: "create" | "rename" | "move" | "delete" | "discard"; path: string }>;
type TabState = Readonly<{ tabs: readonly string[]; activePath: string }>;

export function WorkspaceView({
  files,
  selected,
  onOpen,
  workspace,
  git,
  review,
  onWorkspaceChanged,
  workspaceName = "Page workspace",
  heading = "Workspace",
  onOpenRepositoryManager,
  durability = { state: "ephemeral", detail: "Workspace files exist only in this page-memory adapter. Nothing is synced." },
}: {
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen: (path: string) => void | Promise<void>;
  workspace: WorkspacePort;
  git?: BrowserGitClient;
  review?: Review;
  onWorkspaceChanged: () => void | Promise<void>;
  workspaceName?: string;
  heading?: string;
  onOpenRepositoryManager?: () => void;
  durability?: Readonly<{ state: DurabilityState; detail: string }>;
}) {
  const tree = useMemo(() => buildWorkspaceTree(files), [files]);
  const directories = useMemo(() => workspaceDirectories(tree), [tree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["/workspace", "/workspace/docs", "/workspace/notes", "/workspace/sources"]));
  const visible = useMemo(() => visibleWorkspaceTree(tree, expanded), [tree, expanded]);
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = workspaceRowHeight();
  const rowWindow = workspaceFileWindow(visible.length, scrollTop, WORKSPACE_FILE_VIEWPORT_HEIGHT, rowHeight);
  const [treeFocusPath, setTreeFocusPath] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [mode, setMode] = useState<"explorer" | "source">("explorer");
  const [mobilePane, setMobilePane] = useState<"navigation" | "editor">("navigation");
  const restoredTabs = useMemo(readTabState, []);
  const [tabs, setTabs] = useState<readonly string[]>(restoredTabs.tabs);
  const [activePath, setActivePath] = useState<string>(restoredTabs.activePath);
  const [buffers, setBuffers] = useState<Readonly<Record<string, Buffer>>>(() => PAGE_DRAFTS.get(workspace) ?? {});
  const [context, setContext] = useState<Readonly<{ path: string; x: number; y: number }>>();
  const [dialog, setDialog] = useState<Dialog>();
  const [dialogValue, setDialogValue] = useState("");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [repositories, setRepositories] = useState<readonly GitRepositorySnapshot[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [worktree, setWorktree] = useState<GitWorktreeSnapshot>();
  const [scmLoading, setScmLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const hoverTimer = useRef<number>();
  const hoverDirectory = useRef("");
  const treeViewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    setActivePath(selected.path);
    setTabs((current) => current.includes(selected.path) ? current : [...current, selected.path]);
    setBuffers((current) => {
      const prior = current[selected.path];
      if (prior && prior.draft !== prior.content) return current;
      const shownBytes = new TextEncoder().encode(selected.content).byteLength;
      return { ...current, [selected.path]: { ...selected, draft: selected.content, truncated: selected.size > shownBytes } };
    });
  }, [selected?.path, selected?.revision]);

  useEffect(() => {
    sessionStorage.setItem(TAB_STORAGE, JSON.stringify({ tabs, activePath }));
  }, [tabs, activePath]);

  useEffect(() => {
    PAGE_DRAFTS.set(workspace, buffers);
    const hasDirtyDraft = Object.values(buffers).some((candidate) => candidate.draft !== candidate.content);
    if (!hasDirtyDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [buffers, workspace]);

  useEffect(() => {
    if (files.length === 0) return;
    const existing = tabs.filter((path) => files.some((entry) => entry.path === path));
    if (existing.length !== tabs.length) setTabs(existing);
    const desired = existing.includes(activePath) ? activePath : existing[0] ?? "";
    if (desired !== activePath) setActivePath(desired);
    if (desired && !buffers[desired]) void onOpen(desired);
    if (!desired) setMobilePane("navigation");
  }, [files, activePath]);

  useEffect(() => {
    if (!git) return;
    void refreshSourceControl();
  }, [git]);

  useEffect(() => {
    if (!context) return;
    const dismiss = () => setContext(undefined);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("pointerdown", dismiss, { once: true });
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", onKeyDown); };
  }, [context]);

  useEffect(() => () => clearHoverExpansion(), []);

  const buffer = buffers[activePath];
  const dirty = Boolean(buffer && buffer.draft !== buffer.content);
  const contextIsFile = Boolean(context && files.some((file) => file.path === context.path));

  async function refreshSourceControl(preferredRepository = repositoryId, preferredWorktree = worktree?.id): Promise<void> {
    if (!git) return;
    setScmLoading(true);
    try {
      const next = await git.listRepositories();
      const repository = next.find((item) => item.id === preferredRepository)
        ?? next.find((item) => item.id === preferredSourceRepositoryId())
        ?? next[0];
      const nextWorktree = repository?.worktrees.find((item) => item.id === preferredWorktree) ?? repository?.worktrees[0];
      setRepositories(next);
      setRepositoryId(repository?.id ?? "");
      setWorktree(nextWorktree);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Source control could not be refreshed.");
    } finally {
      setScmLoading(false);
    }
  }

  async function openTab(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    setContext(undefined);
    setTabs((current) => current.includes(normalized) ? current : [...current, normalized]);
    setActivePath(normalized);
    setMobilePane("editor");
    await onOpen(normalized);
  }

  function closeTab(path: string, discard = false): void {
    const candidate = buffers[path];
    if (!discard && candidate && candidate.draft !== candidate.content) {
      setDialog({ kind: "discard", path });
      return;
    }
    const remaining = tabs.filter((item) => item !== path);
    setTabs(remaining);
    setBuffers((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== path)));
    if (activePath === path) {
      const next = remaining.at(-1) ?? "";
      setActivePath(next);
      if (next) void onOpen(next);
      else setMobilePane("navigation");
    }
  }

  async function saveActive(): Promise<void> {
    if (!buffer || buffer.truncated || !dirty || busy) return;
    await transact("Saving file", async () => {
      const saved = await writeWorkspaceAndGit(buffer.path, buffer.draft, buffer.revision);
      setBuffers((current) => ({
        ...current,
        [saved.path]: { ...saved, draft: saved.content, truncated: false },
      }));
      await refreshAll(buffer.path);
      setNotice(`Saved ${workspaceBaseName(buffer.path)} with revision compare-and-swap.`);
    });
  }

  async function saveAndClose(path: string): Promise<void> {
    const candidate = buffers[path];
    if (!candidate || candidate.truncated || candidate.draft === candidate.content || busy) return;
    await transact("Saving file", async () => {
      const saved = await writeWorkspaceAndGit(candidate.path, candidate.draft, candidate.revision);
      setBuffers((current) => ({ ...current, [saved.path]: { ...saved, draft: saved.content, truncated: false } }));
      await onWorkspaceChanged();
      const binding = await gitBinding(saved.path);
      await refreshSourceControl(binding?.repository.id ?? repositoryId, binding?.worktree.id ?? worktree?.id);
      closeTab(saved.path, true);
      setDialog(undefined);
      setNotice(`Saved and closed ${workspaceBaseName(saved.path)}.`);
    });
  }

  async function writeWorkspaceAndGit(path: string, content: string, expectedRevision: string | null): Promise<WorkspaceFile> {
    const previous = await workspace.read(path);
    const written = await workspace.write(path, content, { expectedRevision });
    try {
      const binding = await gitBinding(path);
      if (binding && git) {
        await git.writeWorkingFile({
          repositoryId: binding.repository.id,
          worktreeId: binding.worktree.id,
          path: binding.relativePath,
          content,
          expectedWorktreeVersion: binding.worktree.version,
        });
      }
    } catch (cause) {
      if (previous) await workspace.write(path, previous.content, { expectedRevision: written.revision });
      else await workspace.remove(path, { expectedRevision: written.revision });
      throw cause;
    }
    return written;
  }

  async function removeWorkspaceAndGit(path: string): Promise<void> {
    const previous = await workspace.read(path);
    if (!previous) throw new Error("The selected file no longer exists.");
    await workspace.remove(path, { expectedRevision: previous.revision });
    try {
      const binding = await gitBinding(path);
      if (binding && git) await git.removeWorkingFile({
        repositoryId: binding.repository.id,
        worktreeId: binding.worktree.id,
        path: binding.relativePath,
        expectedWorktreeVersion: binding.worktree.version,
      });
    } catch (cause) {
      await workspace.write(path, previous.content, { expectedRevision: null });
      throw cause;
    }
  }

  async function moveFile(source: string, destinationDirectory: string, nextName = workspaceBaseName(source)): Promise<void> {
    const pending = buffers[source];
    const parent = workspaceParentPath(source);
    if (destinationDirectory === parent && nextName === workspaceBaseName(source)) {
      setNotice("That file is already in this folder.");
      return;
    }
    const target = normalizeWorkspacePath(`${destinationDirectory}/${nextName}`);
    await transact("Moving file", async () => {
      const currentRepositories = git ? await git.listRepositories() : repositories;
      setRepositories(currentRepositories);
      const sourceBinding = resolveGitBinding(source, currentRepositories);
      const targetBinding = resolveGitBinding(target, currentRepositories);
      if ((sourceBinding || targetBinding) && (!sourceBinding || !targetBinding || targetBinding.repository.id !== sourceBinding.repository.id || targetBinding.worktree.id !== sourceBinding.worktree.id)) {
        throw new Error("Moving a repository file across repository roots is not atomic. Move it within its worktree or use the full Sources view.");
      }
      const moved = await moveWorkspaceFile(workspace, source, target);
      try {
        if (sourceBinding && targetBinding && git) await git.moveWorkingFile({ repositoryId: sourceBinding.repository.id, worktreeId: sourceBinding.worktree.id, sourcePath: sourceBinding.relativePath, targetPath: targetBinding.relativePath, expectedWorktreeVersion: sourceBinding.worktree.version });
      } catch (cause) {
        await moveWorkspaceFile(workspace, target, source);
        throw cause;
      }
      setTabs((current) => current.map((path) => path === source ? target : path));
      setActivePath((current) => current === source ? target : current);
      setBuffers((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([path]) => path !== source));
        next[target] = { ...moved, draft: pending?.draft ?? moved.content, truncated: false };
        return next;
      });
      await refreshAll(target);
      setNotice(`Moved to ${target.replace("/workspace/", "")}.${pending && pending.draft !== pending.content ? " Unsaved edits moved with the tab." : ""}`);
    });
  }

  async function runDialog(): Promise<void> {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const target = normalizeWorkspacePath(`${dialog.path}/${dialogValue.trim()}`);
      await transact("Creating file", async () => { await writeWorkspaceAndGit(target, "", null); await refreshAll(target); });
    } else if (dialog.kind === "rename") {
      await moveFile(dialog.path, workspaceParentPath(dialog.path), dialogValue.trim());
    } else if (dialog.kind === "move") {
      await moveFile(dialog.path, dialogValue, workspaceBaseName(dialog.path));
    } else if (dialog.kind === "discard") {
      closeTab(dialog.path, true);
    } else {
      await transact("Deleting file", async () => { await removeWorkspaceAndGit(dialog.path); closeTab(dialog.path, true); await refreshAll(); });
    }
    setDialog(undefined);
  }

  async function refreshAll(open?: string): Promise<void> {
    await onWorkspaceChanged();
    const binding = open ? await gitBinding(open) : undefined;
    await refreshSourceControl(binding?.repository.id ?? repositoryId, binding?.worktree.id ?? worktree?.id);
    if (open) await openTab(open);
  }

  async function transact(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(undefined); setNotice(`${label}…`);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : `${label} failed safely.`); }
    finally { setBusy(false); }
  }

  async function gitBinding(path: string) {
    if (!git) return undefined;
    const next = await git.listRepositories();
    setRepositories(next);
    return resolveGitBinding(path, next);
  }

  async function mutateSource(operation: GitOperation): Promise<void> {
    if (!git || !review || busy) return;
    const decision = await review(operation, describeGitOperation(operation));
    if (decision !== "allow") { setNotice("Source-control operation denied; nothing changed."); return; }
    await transact("Updating source control", async () => {
      if (operation.kind === "stage") await git.stage(operation.request);
      else if (operation.kind === "unstage") await git.unstage(operation.request);
      else if (operation.kind === "commit") await git.commit(operation.request);
      await refreshSourceControl();
    });
  }

  function openDialog(kind: Dialog["kind"], path: string): void {
    setContext(undefined);
    setDialog({ kind, path });
    setDialogValue(kind === "rename" ? workspaceBaseName(path) : kind === "move" ? workspaceParentPath(path) : "");
  }

  function toggleDirectory(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function scheduleHoverExpansion(directory: string): void {
    setDropTarget(directory);
    if (hoverDirectory.current === directory) return;
    clearTimeout(hoverTimer.current);
    hoverDirectory.current = directory;
    hoverTimer.current = window.setTimeout(() => {
      setExpanded((current) => new Set([...current, directory]));
      hoverDirectory.current = "";
    }, 420);
  }

  function clearHoverExpansion(): void {
    clearTimeout(hoverTimer.current);
    hoverDirectory.current = "";
    setDropTarget("");
  }

  function focusTreeIndex(index: number): void {
    if (!visible.length) return;
    const bounded = Math.max(0, Math.min(index, visible.length - 1));
    const node = visible[bounded]!;
    setTreeFocusPath(node.path);
    const viewport = treeViewport.current;
    if (viewport) {
      const top = bounded * rowHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowHeight - viewport.clientHeight;
    }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-workspace-tree-index="${String(bounded)}"]`)?.focus());
  }

  function handleTreeKey(event: KeyboardEvent, path: string): void {
    const index = visible.findIndex((node) => node.path === path);
    if (index < 0) return;
    const node = visible[index]!;
    if (event.key === "ArrowDown") { event.preventDefault(); focusTreeIndex(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusTreeIndex(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusTreeIndex(0); }
    else if (event.key === "End") { event.preventDefault(); focusTreeIndex(visible.length - 1); }
    else if (event.key === "ArrowRight" && node.kind === "directory") {
      event.preventDefault();
      if (!node.expanded) toggleDirectory(node.path); else focusTreeIndex(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.kind === "directory" && node.expanded) toggleDirectory(node.path);
      else {
        const parent = workspaceParentPath(node.path);
        const parentIndex = visible.findIndex((candidate) => candidate.path === parent);
        if (parentIndex >= 0) focusTreeIndex(parentIndex);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node.kind === "directory") toggleDirectory(node.path); else void openTab(node.path);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const target = document.querySelector<HTMLElement>(`[data-workspace-tree-index="${String(index)}"]`);
      const bounds = target?.getBoundingClientRect();
      setContext(clampedContext(node.path, bounds?.left ?? 24, bounds?.bottom ?? 48));
    }
  }

  return (
    <section class="work-view workspace-workbench">
      <header class="page-heading workspace-heading"><div><span class="eyebrow">Device-executed · {workspaceName}</span><h1>{heading}</h1><p>Files, version-fenced editing, and browser-native source control share one workspace.</p></div><DurabilityIndicator state={durability.state} detail={durability.detail} /></header>
      <div class="workbench-mobile-switch" role="tablist" aria-label="Workspace pane"><button role="tab" aria-selected={mobilePane === "navigation"} onClick={() => setMobilePane("navigation")}>Files</button><button role="tab" aria-selected={mobilePane === "editor"} onClick={() => setMobilePane("editor")} disabled={!tabs.length}>Editor {tabs.length ? `· ${tabs.length}` : ""}</button></div>
      {(error || notice) ? <div class={`workbench-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error ?? notice}</div> : null}
      <div class="workbench-shell">
        <aside class={`workbench-activity ${mobilePane === "navigation" ? "mobile-active" : ""}`} aria-label="Workspace activity">
          <div class="workbench-mode-tabs" role="tablist" aria-label="Workspace activity view">
            <button role="tab" aria-selected={mode === "explorer"} onClick={() => setMode("explorer")}><Icon name="workspace" /> Explorer</button>
            <button role="tab" aria-selected={mode === "source"} onClick={() => setMode("source")}><Icon name="source" /> Source Control <b>{worktree?.status.length ?? 0}</b></button>
          </div>
          {mode === "explorer" ? <>
            <div class="workbench-section-heading"><strong>WORKSPACE</strong><button type="button" aria-label="New file in workspace" onClick={() => openDialog("create", "/workspace")}>+</button></div>
            <div ref={treeViewport} class="workspace-tree" role="tree" aria-label="Workspace files" style={{ maxHeight: WORKSPACE_FILE_VIEWPORT_HEIGHT }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHoverExpansion(); }}>
              <div style={{ height: visible.length * rowHeight, position: "relative" }}><div style={{ position: "absolute", top: rowWindow.start * rowHeight, left: 0, right: 0 }}>
                {visible.slice(rowWindow.start, rowWindow.end).map((node, offset) => <div class="tree-row-wrap" style={{ height: rowHeight }} key={node.path}>
                  <button
                    class={`tree-row ${activePath === node.path ? "active" : ""} ${dropTarget === (node.kind === "directory" ? node.path : workspaceParentPath(node.path)) ? "drop-target" : ""}`}
                    type="button" role="treeitem" aria-level={node.depth} aria-expanded={node.kind === "directory" ? Boolean(node.expanded) : undefined}
                    aria-selected={activePath === node.path}
                    data-workspace-tree-index={rowWindow.start + offset}
                    tabIndex={treeFocusPath === node.path || (!treeFocusPath && rowWindow.start + offset === 0) ? 0 : -1}
                    onFocus={() => setTreeFocusPath(node.path)}
                    onKeyDown={(event) => handleTreeKey(event, node.path)}
                    style={{ height: rowHeight, paddingLeft: `${String(7 + Math.max(0, node.depth - 1) * 15)}px` }}
                    draggable={node.kind === "file"}
                    onDragStart={(event) => { if (node.kind === "file") { event.dataTransfer?.setData("text/x-airship-workspace-path", node.path); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; } }}
                    onDragEnd={clearHoverExpansion}
                    onDragEnter={() => scheduleHoverExpansion(node.kind === "directory" ? node.path : workspaceParentPath(node.path))}
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer?.getData("text/x-airship-workspace-path"); const destination = node.kind === "directory" ? node.path : workspaceParentPath(node.path); clearHoverExpansion(); if (source) void moveFile(source, destination); }}
                    onContextMenu={(event) => { event.preventDefault(); setContext(clampedContext(node.path, event.clientX, event.clientY)); }}
                    onClick={() => node.kind === "directory" ? toggleDirectory(node.path) : void openTab(node.path)}
                  ><span class="tree-chevron">{node.kind === "directory" ? node.expanded ? "⌄" : "›" : ""}</span><Icon name={node.kind === "directory" ? "workspace" : "file"} size={15} /><span>{node.name}</span>{node.entry ? <small>{formatBytes(node.entry.size)}</small> : null}</button>
                  <button class="tree-overflow" type="button" aria-label={`Actions for ${node.name}`} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setContext(clampedContext(node.path, box.right, box.bottom)); }}>•••</button>
                </div>)}
              </div></div>
            </div>
          </> : <SourceControlRail repositories={repositories} repositoryId={repositoryId} setRepositoryId={(id) => { setRepositoryId(id); setWorktree(repositories.find((item) => item.id === id)?.worktrees[0]); }} worktree={worktree} setWorktreeId={(id) => setWorktree(repositories.find((item) => item.id === repositoryId)?.worktrees.find((item) => item.id === id))} loading={scmLoading} refresh={() => void refreshSourceControl(repositoryId, worktree?.id)} openPath={(path) => { const repository = repositories.find((item) => item.id === repositoryId); const root = repository && worktree ? gitWorktreeWorkspaceRoot(repository, worktree) : "/workspace"; void openTab(normalizeWorkspacePath(`${root}/${path}`)); }} mutate={mutateSource} commitMessage={commitMessage} setCommitMessage={setCommitMessage} onOpenRepositoryManager={onOpenRepositoryManager} />}
        </aside>
        <main class={`workbench-editor ${mobilePane === "editor" ? "mobile-active" : ""}`} aria-label="File editor">
          <div class="editor-tabs" role="tablist" aria-label="Open files">{tabs.map((path) => <div class={path === activePath ? "active" : ""} key={path}><button role="tab" aria-selected={path === activePath} onClick={() => void openTab(path)}><Icon name="file" size={13} />{workspaceBaseName(path)}{buffers[path]?.draft !== buffers[path]?.content ? <b aria-label="Unsaved">●</b> : null}</button><button type="button" aria-label={`Close ${workspaceBaseName(path)}`} onClick={() => closeTab(path)}>×</button></div>)}</div>
          {buffer ? <>
            <div class="editor-toolbar"><span title={buffer.path}>{buffer.path.replace("/workspace/", "")}</span><div><small>{buffer.revision.slice(0, 7)} · {formatBytes(buffer.size)}</small><button class="primary" type="button" disabled={!dirty || busy || buffer.truncated} onClick={() => void saveActive()}>Save</button></div></div>
            {buffer.truncated ? <div class="workspace-boundary attention" role="status">{buffer.content ? "Bounded preview only." : "Encrypted file not downloaded."} Files above {formatBytes(WORKSPACE_EDITOR_BYTE_LIMIT)} are read-only; full-object AES-GCM verification is never mislabeled as a range stream.</div> : null}
            <textarea class="code-editor" aria-label={`Edit ${workspaceBaseName(buffer.path)}`} value={buffer.draft} readOnly={buffer.truncated} spellcheck={false} onInput={(event) => setBuffers((current) => ({ ...current, [buffer.path]: { ...buffer, draft: event.currentTarget.value } }))} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveActive(); } }} />
            <footer class="editor-status"><span>{dirty ? "Modified" : "Saved"}</span><span>UTF-8 · LF · client-side</span></footer>
          </> : <div class="workbench-empty"><Icon name="workspace" size={36} /><strong>Open a file from Explorer</strong><span>Nothing is downloaded until you select it.</span></div>}
        </main>
      </div>
      {context ? <div class="workbench-context" role="menu" style={{ left: `${String(context.x)}px`, top: `${String(context.y)}px` }} onPointerDown={(event) => event.stopPropagation()}><button role="menuitem" onClick={() => { if (contextIsFile) void openTab(context.path); else { toggleDirectory(context.path); setContext(undefined); } }}>{contextIsFile ? "Open" : expanded.has(context.path) ? "Collapse" : "Expand"}</button>{contextIsFile ? <><button role="menuitem" onClick={() => openDialog("rename", context.path)}>Rename</button><button role="menuitem" onClick={() => openDialog("move", context.path)}>Move…</button><button class="danger" role="menuitem" onClick={() => openDialog("delete", context.path)}>Delete</button></> : <button role="menuitem" onClick={() => openDialog("create", context.path)}>New file…</button>}<button role="menuitem" onClick={() => setContext(undefined)}>Close</button></div> : null}
      {dialog ? <div class="workbench-dialog-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setDialog(undefined); }}><div class="workbench-dialog" role="dialog" aria-modal="true" aria-label={`${dialog.kind} workspace file`}><h2>{dialog.kind === "create" ? "New file" : dialog.kind === "rename" ? "Rename file" : dialog.kind === "move" ? "Move file" : dialog.kind === "discard" ? "Unsaved changes" : "Delete file"}</h2>{dialog.kind === "move" ? <div class="move-targets" role="listbox" aria-label="Destination folder">{directories.map((directory) => <button role="option" aria-selected={dialogValue === directory.path} disabled={workspaceParentPath(dialog.path) === directory.path} onClick={() => setDialogValue(directory.path)}>{directory.path.replace("/workspace", "workspace")}</button>)}</div> : dialog.kind === "discard" ? <p>Save <strong>{workspaceBaseName(dialog.path)}</strong> before closing, keep editing, or permanently discard its unsaved in-browser draft.</p> : dialog.kind === "delete" ? <p>Delete <strong>{dialog.path.replace("/workspace/", "")}</strong>? The exact revision is checked before removal.{buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? " Its unsaved draft will also be discarded." : ""}</p> : <label>{dialog.kind === "create" ? "Path relative to this folder" : "New name"}<input autofocus value={dialogValue} onInput={(event) => setDialogValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void runDialog(); }} /></label>}{(dialog.kind === "move" || dialog.kind === "rename") && buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? <p class="workspace-boundary attention">The unsaved draft will move with this tab; the durable file is not changed until you save.</p> : null}<div><button type="button" onClick={() => setDialog(undefined)}>Cancel</button>{dialog.kind === "discard" && !buffers[dialog.path]?.truncated ? <button class="primary" type="button" disabled={busy} onClick={() => void saveAndClose(dialog.path)}>Save and close</button> : null}<button class={dialog.kind === "delete" || dialog.kind === "discard" ? "danger" : "primary"} type="button" disabled={busy || (!(["delete", "discard"] as string[]).includes(dialog.kind) && !dialogValue.trim())} onClick={() => void runDialog()}>{dialog.kind === "delete" ? "Delete" : dialog.kind === "discard" ? "Discard and close" : dialog.kind === "move" ? "Move here" : "Apply"}</button></div></div></div> : null}
    </section>
  );
}

function SourceControlRail({ repositories, repositoryId, setRepositoryId, worktree, setWorktreeId, loading, refresh, openPath, mutate, commitMessage, setCommitMessage, onOpenRepositoryManager }: { repositories: readonly GitRepositorySnapshot[]; repositoryId: string; setRepositoryId(id: string): void; worktree?: GitWorktreeSnapshot; setWorktreeId(id: string): void; loading: boolean; refresh(): void; openPath(path: string): void; mutate(operation: GitOperation): void | Promise<void>; commitMessage: string; setCommitMessage(value: string): void; onOpenRepositoryManager?: () => void }) {
  const repository = repositories.find((item) => item.id === repositoryId) ?? repositories[0];
  const staged = (worktree?.status.filter((entry) => entry.index) ?? []).slice(0, 250);
  const unstaged = (worktree?.status.filter((entry) => entry.worktree) ?? []).slice(0, 250);
  const truncated = (worktree?.status.length ?? 0) > 250;
  const operation = (kind: "stage" | "unstage", paths: readonly string[]): GitOperation | undefined => repository && worktree ? { kind, request: { repositoryId: repository.id, worktreeId: worktree.id, paths, expectedWorktreeVersion: worktree.version } } : undefined;
  return <div class="workspace-scm">
    <label>Repository<MenuSelect placement="down" ariaLabel="Workspace repository" value={repository?.id ?? ""} options={repositories.map((item) => ({ value: item.id, label: item.name }))} onChange={setRepositoryId} /></label>
    {repository && repository.worktrees.length > 1 ? <label>Worktree<MenuSelect placement="down" ariaLabel="Workspace worktree" value={worktree?.id ?? ""} options={repository.worktrees.map((item) => ({ value: item.id, label: `${item.branch} · ${item.path}` }))} onChange={setWorktreeId} /></label> : null}
    <div class="scm-toolbar"><button type="button" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>{onOpenRepositoryManager ? <button type="button" onClick={onOpenRepositoryManager}>Repository manager</button> : null}</div>
    <div class="scm-summary"><strong>{worktree?.branch ?? "No worktree"}</strong><span>{worktree?.status.length ?? 0} changes</span></div>
    {!loading && !repository ? <div class="workspace-boundary">No Git repositories are connected to this workspace.</div> : null}
    {staged.length ? <ScmGroup title="Staged" entries={staged} lane="staged" repository={repository} worktree={worktree} openPath={openPath} mutate={mutate} /> : null}
    {staged.length > 1 ? <button type="button" onClick={() => { const next = operation("unstage", staged.map((entry) => entry.path)); if (next) void mutate(next); }}>Unstage all visible</button> : null}
    {unstaged.length ? <ScmGroup title="Changes" entries={unstaged} lane="unstaged" repository={repository} worktree={worktree} openPath={openPath} mutate={mutate} /> : null}
    {unstaged.length > 1 ? <button type="button" onClick={() => { const next = operation("stage", unstaged.map((entry) => entry.path)); if (next) void mutate(next); }}>Stage all visible</button> : null}
    {truncated ? <div class="workspace-boundary attention">Showing the first 250 staged and unstaged paths. Open the repository manager for the complete, virtualized worktree.</div> : null}
    {worktree?.status.some((entry) => entry.index) ? <div class="scm-commit"><textarea aria-label="Commit message" value={commitMessage} onInput={(event) => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" /><button class="primary" type="button" disabled={!commitMessage.trim()} onClick={() => repository && mutate({ kind: "commit", request: { repositoryId: repository.id, worktreeId: worktree.id, message: commitMessage, author: DEFAULT_AUTHOR, expectedWorktreeVersion: worktree.version } })}>Commit staged</button></div> : null}
  </div>;
}

function ScmGroup({ title, entries, lane, repository, worktree, openPath, mutate }: { title: string; entries: readonly GitStatusEntry[]; lane: "staged" | "unstaged"; repository?: GitRepositorySnapshot; worktree?: GitWorktreeSnapshot; openPath(path: string): void; mutate(operation: GitOperation): void | Promise<void> }) {
  return <section class="scm-group"><header><strong>{title}</strong><span>{entries.length}</span></header>{entries.map((entry) => {
    const delta = lane === "staged" ? entry.index : entry.worktree;
    const deleted = delta?.kind === "deleted";
    const conflicted = delta?.kind === "conflicted";
    return <div class="scm-row" key={`${lane}:${entry.path}`}><button type="button" disabled={deleted} title={deleted ? "Deleted paths have no working file to open." : undefined} onClick={() => openPath(entry.path)}><span>{entry.path}</span><b>{conflicted ? "C" : delta?.kind === "added" ? "A" : delta?.kind === "deleted" ? "D" : delta?.kind === "renamed" ? "R" : "M"}</b></button><div><button type="button" aria-label={`${lane === "staged" ? "Unstage" : "Stage"} ${entry.path}`} onClick={() => repository && worktree && mutate({ kind: lane === "staged" ? "unstage" : "stage", request: { repositoryId: repository.id, worktreeId: worktree.id, paths: [entry.path], expectedWorktreeVersion: worktree.version } })}>{lane === "staged" ? "−" : "+"}</button></div></div>;
  })}</section>;
}

const DEFAULT_AUTHOR: GitAuthor = { name: "Local Airship User", email: "airship@local.invalid" };

export function resolveGitBinding(path: string, repositories: readonly GitRepositorySnapshot[]) {
  return resolveGitWorkspaceBinding(path, repositories);
}

function readTabState(): TabState {
  if (typeof sessionStorage === "undefined") return { tabs: [], activePath: "" };
  try {
    const value = JSON.parse(sessionStorage.getItem(TAB_STORAGE) ?? "{}") as Record<string, unknown>;
    const tabs = Array.isArray(value.tabs) ? value.tabs.filter((path: unknown): path is string => typeof path === "string" && path.startsWith("/workspace/")) : [];
    const activePath = typeof value.activePath === "string" && tabs.includes(value.activePath) ? value.activePath : tabs[0] ?? "";
    return { tabs, activePath };
  } catch { return { tabs: [], activePath: "" }; }
}

function clampedContext(path: string, x: number, y: number) {
  const width = typeof innerWidth === "number" ? innerWidth : 1_024;
  const height = typeof innerHeight === "number" ? innerHeight : 768;
  return { path, x: Math.max(8, Math.min(x, width - 208)), y: Math.max(8, Math.min(y, height - 190)) };
}

export function workspaceFileWindow(count: number, scrollTop: number, viewportHeight: number, rowHeight = WORKSPACE_FILE_ROW_HEIGHT) { const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight)); const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight); const start = Math.max(0, first - WORKSPACE_FILE_OVERSCAN); return Object.freeze({ start, end: Math.min(count, first + visible + WORKSPACE_FILE_OVERSCAN) }); }

function workspaceRowHeight(): number { if (typeof innerWidth === "number" && innerWidth <= 760) return 44; if (typeof document === "undefined") return WORKSPACE_FILE_ROW_HEIGHT; return document.documentElement.dataset.density === "comfortable" ? 42 : document.documentElement.dataset.density === "compact" ? 30 : WORKSPACE_FILE_ROW_HEIGHT; }

export function boundedWorkspaceContent(content: string, byteLimit: number, knownTotalBytes?: number) { if (!Number.isInteger(byteLimit) || byteLimit < 1) throw new Error("Workspace byte limit must be a positive integer."); const bytes = new TextEncoder().encode(content); const totalBytes = Math.max(bytes.byteLength, knownTotalBytes ?? 0); if (bytes.byteLength <= byteLimit) return Object.freeze({ content, shownBytes: bytes.byteLength, totalBytes, truncated: totalBytes > bytes.byteLength }); const bounded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, byteLimit)); return Object.freeze({ content: bounded, shownBytes: new TextEncoder().encode(bounded).byteLength, totalBytes, truncated: true }); }

function formatBytes(size: number): string { if (size < 1_024) return `${String(size)} B`; if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`; return `${(size / 1_048_576).toFixed(1)} MiB`; }
