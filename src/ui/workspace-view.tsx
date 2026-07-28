import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import { describeGitOperation } from "../git/operations";
import { preferredSourceRepositoryId } from "../git/source-selection";
import { gitWorktreeWorkspaceRoot, resolveGitWorkspaceBinding } from "../git/workspace-binding";
import type { GitAuthor, GitOperation, GitOperationDescriptor, GitRepositorySnapshot, GitStatusEntry, GitWorktreeSnapshot } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { normalizeWorkspacePath } from "../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../workspace/content-codec";
import { moveWorkspaceFile } from "../workspace/mutations";
import { buildWorkspaceTree, visibleWorkspaceTree, workspaceBaseName, workspaceDirectories, workspaceParentPath } from "../workspace/tree";
import { trapFocus } from "./focus-trap";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { Seal } from "./seal";
import { middleTruncate, Tabs, type TabItem } from "./tabs";
import {
  settledWorkbenchNotice,
  WORKBENCH_DESCRIPTION,
  WORKBENCH_DONE_NOTICE_MS,
  WORKBENCH_RAIL_DEFAULT_PERCENT,
  WORKBENCH_RAIL_MAX_PERCENT,
  WORKBENCH_RAIL_MIN_PERCENT,
  WORKBENCH_RAIL_STEP_PERCENT,
  workbenchBufferState,
  workbenchFilterMatches,
  workbenchNotice,
  workbenchNoticeState,
  workbenchRailPercent,
  workbenchSuggestedFiles,
  workbenchTabQualifiers,
  type WorkbenchNotice,
  type WorkbenchPane,
} from "./workbench-model";
import "./workspace-view.css";

export const WORKSPACE_FILE_ROW_HEIGHT = 34;
export const WORKSPACE_FILE_OVERSCAN = 7;
export const WORKSPACE_EDITOR_BYTE_LIMIT = 128 * 1024;
/**
 * The virtualization window's height before the live rail has been measured.
 *
 * It is a fallback, not a layout: the tree now fills its rail and reports its
 * real height through a `ResizeObserver`. The shipped defect was this number
 * being the *actual* height — 432px inside a 718px tablet rail, so 53% of a
 * bordered panel was dead and the code column was starved to pay for it.
 */
export const WORKSPACE_FILE_VIEWPORT_HEIGHT = 432;
const TAB_STORAGE = "airship.workspace.tabs.v1";
const PAGE_DRAFTS = new WeakMap<WorkspacePort, Readonly<Record<string, Buffer>>>();

type Review = (operation: GitOperation, descriptor: GitOperationDescriptor) => Promise<"allow" | "deny">;
type Buffer = WorkspaceFile & { draft: string; truncated: boolean; binary: boolean };
type Dialog = Readonly<{ kind: "create" | "rename" | "move" | "delete" | "discard"; path: string }>;
type TabState = Readonly<{ tabs: readonly string[]; activePath: string; rail: number }>;

export function WorkspaceView({
  files,
  selected,
  onOpen,
  workspace,
  git,
  review,
  onWorkspaceChanged,
  workspaceIdentity = "page-memory",
  onOpenRepositoryManager,
  opensPane = "navigation",
}: {
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen: (path: string) => void | Promise<void>;
  workspace: WorkspacePort;
  git?: BrowserGitClient;
  review?: Review;
  onWorkspaceChanged: () => void | Promise<void>;
  workspaceIdentity?: string;
  onOpenRepositoryManager?: () => void;
  /** Which pane the destination that opened this workbench asks for. */
  opensPane?: WorkbenchPane;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => workbenchFilterMatches(files, filter), [files, filter]);
  const filtering = filtered.shown !== filtered.total;
  const fullTree = useMemo(() => buildWorkspaceTree(files), [files]);
  const tree = useMemo(() => filtering ? buildWorkspaceTree(filtered.matches) : fullTree, [filtering, filtered.matches, fullTree]);
  const directories = useMemo(() => workspaceDirectories(fullTree), [fullTree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["/workspace", "/workspace/docs", "/workspace/notes", "/workspace/sources"]));
  // A filter that left its matches inside collapsed folders would report a
  // count the user cannot see. Filtering expands every ancestor it produced,
  // and clearing it restores exactly the folders the user had open.
  const effectiveExpanded = useMemo(
    () => filtering ? new Set(workspaceDirectories(tree).map((node) => node.path)) : expanded,
    [filtering, tree, expanded],
  );
  const visible = useMemo(() => visibleWorkspaceTree(tree, effectiveExpanded), [tree, effectiveExpanded]);
  const [scrollTop, setScrollTop] = useState(0);
  const [treeHeight, setTreeHeight] = useState(WORKSPACE_FILE_VIEWPORT_HEIGHT);
  const rowHeight = workspaceRowHeight();
  const rowWindow = workspaceFileWindow(visible.length, scrollTop, treeHeight, rowHeight);
  const [treeFocusPath, setTreeFocusPath] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [mode, setMode] = useState<"explorer" | "source">("explorer");
  const [mobilePane, setMobilePane] = useState<WorkbenchPane>(opensPane);
  const tabStorageKey = useMemo(() => workspaceTabStorageKey(workspaceIdentity), [workspaceIdentity]);
  const restoredTabs = useMemo(() => readTabState(tabStorageKey), [tabStorageKey]);
  const [tabs, setTabs] = useState<readonly string[]>(restoredTabs.tabs);
  const [activePath, setActivePath] = useState<string>(restoredTabs.activePath);
  const [rail, setRail] = useState(restoredTabs.rail);
  const [buffers, setBuffers] = useState<Readonly<Record<string, Buffer>>>(() => PAGE_DRAFTS.get(workspace) ?? {});
  const [context, setContext] = useState<Readonly<{ path: string; x: number; y: number }>>();
  const [dialog, setDialog] = useState<Dialog>();
  const [dialogValue, setDialogValue] = useState("");
  const [notice, setNotice] = useState<WorkbenchNotice>();
  const [busy, setBusy] = useState(false);
  const [repositories, setRepositories] = useState<readonly GitRepositorySnapshot[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [worktree, setWorktree] = useState<GitWorktreeSnapshot>();
  const [scmLoading, setScmLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const hoverTimer = useRef<number>();
  const hoverDirectory = useRef("");
  const treeViewport = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const dialogBox = useRef<HTMLDivElement>(null);
  const dialogOpener = useRef<HTMLElement>();
  const filterField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selected) return;
    setActivePath(selected.path);
    setTabs((current) => current.includes(selected.path) ? current : [...current, selected.path]);
    setBuffers((current) => {
      const prior = current[selected.path];
      if (prior && prior.draft !== prior.content) return current;
      const projection = workspaceEditorProjection(selected);
      return { ...current, [selected.path]: { ...selected, content: projection.content, draft: projection.content, truncated: projection.truncated, binary: projection.binary } };
    });
  }, [selected?.path, selected?.revision]);

  useEffect(() => {
    try {
      sessionStorage.setItem(tabStorageKey, JSON.stringify({ tabs, activePath, rail }));
    } catch {
      // Open tabs and drafts remain valid page-memory state when browser
      // privacy policy denies optional session preference storage.
    }
  }, [tabs, activePath, rail, tabStorageKey]);

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

  // The tree's virtualization window is driven by the rail it actually
  // occupies. Before this the window was a constant and the panel was sized to
  // match it, which is why a 718px rail rendered 432px of rows and 382px of
  // nothing.
  useEffect(() => {
    const element = treeViewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const height = element.clientHeight;
      if (height > 0) setTreeHeight(height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  // A completion sentence is worth reading once; it is not worth 40px of
  // permanent layout. Errors are excluded — see `dismissNotice`.
  useEffect(() => {
    if (notice?.kind !== "done") return;
    const timer = window.setTimeout(
      () => setNotice((current) => current === notice ? undefined : current),
      WORKBENCH_DONE_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!dialog) return;
    const box = dialogBox.current;
    const focusable = box?.querySelector<HTMLElement>("input, [role=\"option\"]:not([disabled]), button");
    (focusable ?? box)?.focus();
  }, [dialog?.kind, dialog?.path]);

  useEffect(() => () => clearHoverExpansion(), []);

  const buffer = buffers[activePath];
  const dirty = Boolean(buffer && buffer.draft !== buffer.content);
  const gutterLines = buffer && !buffer.binary ? workspaceGutterLines(buffer.draft) : undefined;
  const contextIsFile = Boolean(context && files.some((file) => file.path === context.path));
  const changeCount = worktree?.status.length ?? 0;
  const tabQualifiers = useMemo(() => workbenchTabQualifiers(tabs), [tabs]);
  const suggestions = useMemo(() => workbenchSuggestedFiles(files), [files]);
  const verdict = buffer
    ? workbenchBufferState({ binary: buffer.binary, truncated: buffer.truncated, dirty })
    : undefined;

  const fileTabs: readonly TabItem[] = tabs.map((path) => {
    const name = workspaceBaseName(path);
    const candidate = buffers[path];
    const unsaved = Boolean(candidate && candidate.draft !== candidate.content);
    return {
      id: path,
      label: middleTruncate(name),
      detail: path.replace("/workspace/", ""),
      hint: tabQualifiers[path] || undefined,
      state: unsaved ? "attention" : undefined,
      stateLabel: unsaved ? "Unsaved" : undefined,
      onClose: () => closeTab(path),
      closeLabel: `Close ${name}`,
    };
  });

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
      setNotice(workbenchNotice("error", cause instanceof Error ? cause.message : "Source control could not be refreshed."));
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
      openDialog("discard", path);
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
    if (!buffer || buffer.truncated || buffer.binary || !dirty || busy) return;
    await transact("Saving file", async () => {
      const saved = await writeWorkspaceAndGit(buffer.path, buffer.draft, buffer.revision);
      setBuffers((current) => ({
        ...current,
        [saved.path]: { ...saved, draft: saved.content, truncated: false, binary: false },
      }));
      await refreshAll(buffer.path);
      setNotice(workbenchNotice("done", `Saved ${workspaceBaseName(buffer.path)} with revision compare-and-swap.`));
    });
  }

  async function saveAndClose(path: string): Promise<void> {
    const candidate = buffers[path];
    if (!candidate || candidate.truncated || candidate.binary || candidate.draft === candidate.content || busy) return;
    await transact("Saving file", async () => {
      const saved = await writeWorkspaceAndGit(candidate.path, candidate.draft, candidate.revision);
      setBuffers((current) => ({ ...current, [saved.path]: { ...saved, draft: saved.content, truncated: false, binary: false } }));
      await onWorkspaceChanged();
      const binding = await gitBinding(saved.path);
      await refreshSourceControl(binding?.repository.id ?? repositoryId, binding?.worktree.id ?? worktree?.id);
      closeTab(saved.path, true);
      closeDialog();
      setNotice(workbenchNotice("done", `Saved and closed ${workspaceBaseName(saved.path)}.`));
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
      setNotice(workbenchNotice("done", "That file is already in this folder."));
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
      next[target] = { ...moved, draft: pending?.draft ?? moved.content, truncated: pending?.truncated ?? false, binary: pending?.binary ?? isWorkspaceBinaryEnvelope(moved.content) };
        return next;
      });
      await refreshAll(target);
      setNotice(workbenchNotice("done", `Moved to ${target.replace("/workspace/", "")}.${pending && pending.draft !== pending.content ? " Unsaved edits moved with the tab." : ""}`));
    });
  }

  async function runDialog(): Promise<void> {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const target = normalizeWorkspacePath(`${dialog.path}/${dialogValue.trim()}`);
      await transact("Creating file", async () => {
        await writeWorkspaceAndGit(target, "", null);
        await refreshAll(target);
        setNotice(workbenchNotice("done", `Created ${target.replace("/workspace/", "")}.`));
      });
    } else if (dialog.kind === "rename") {
      await moveFile(dialog.path, workspaceParentPath(dialog.path), dialogValue.trim());
    } else if (dialog.kind === "move") {
      await moveFile(dialog.path, dialogValue, workspaceBaseName(dialog.path));
    } else if (dialog.kind === "discard") {
      closeTab(dialog.path, true);
    } else {
      await transact("Deleting file", async () => {
        await removeWorkspaceAndGit(dialog.path);
        closeTab(dialog.path, true);
        await refreshAll();
        setNotice(workbenchNotice("done", `Deleted ${dialog.path.replace("/workspace/", "")}.`));
      });
    }
    closeDialog();
  }

  async function refreshAll(open?: string): Promise<void> {
    await onWorkspaceChanged();
    const binding = open ? await gitBinding(open) : undefined;
    await refreshSourceControl(binding?.repository.id ?? repositoryId, binding?.worktree.id ?? worktree?.id);
    if (open) await openTab(open);
  }

  async function transact(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setNotice(workbenchNotice("progress", `${label}…`));
    try { await action(); } catch (cause) { setNotice(workbenchNotice("error", cause instanceof Error ? cause.message : `${label} failed safely.`)); }
    finally {
      setBusy(false);
      // The shipped bug: nothing ever cleared "Creating file…", so a present
      // tense verb stayed on screen for minutes describing finished work.
      setNotice(settledWorkbenchNotice);
    }
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
    if (decision !== "allow") { setNotice(workbenchNotice("done", "Source-control operation denied; nothing changed.")); return; }
    await transact("Updating source control", async () => {
      if (operation.kind === "stage") await git.stage(operation.request);
      else if (operation.kind === "unstage") await git.unstage(operation.request);
      else if (operation.kind === "commit") await git.commit(operation.request);
      await refreshSourceControl();
    });
  }

  function openDialog(kind: Dialog["kind"], path: string): void {
    setContext(undefined);
    dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setDialog({ kind, path });
    setDialogValue(kind === "rename" ? workspaceBaseName(path) : kind === "move" ? workspaceParentPath(path) : "");
  }

  /** Closes the modal and returns the keyboard to the control that opened it. */
  function closeDialog(): void {
    setDialog(undefined);
    const opener = dialogOpener.current;
    dialogOpener.current = undefined;
    if (opener?.isConnected) opener.focus();
  }

  function selectPane(id: string): void {
    if (id === "editor") { setMobilePane("editor"); return; }
    setMode(id === "source" ? "source" : "explorer");
    setMobilePane("navigation");
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

  /** Writes a rail width the code column can survive; the CSS clamps it again in rem. */
  function resizeRail(percent: number): void {
    setRail(workbenchRailPercent(percent));
  }

  function handleSplitterKey(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") { event.preventDefault(); resizeRail(rail - WORKBENCH_RAIL_STEP_PERCENT); }
    else if (event.key === "ArrowRight") { event.preventDefault(); resizeRail(rail + WORKBENCH_RAIL_STEP_PERCENT); }
    else if (event.key === "Home") { event.preventDefault(); resizeRail(WORKBENCH_RAIL_MIN_PERCENT); }
    else if (event.key === "End") { event.preventDefault(); resizeRail(WORKBENCH_RAIL_MAX_PERCENT); }
  }

  return (
    <section class="work-view workspace-workbench">
      {/*
        One phone control instead of two. Three identically-weighted strips
        stacked to y=424 on a 932px phone; the route strip is now inside the
        44px route bar and these two are one segmented control that keeps every
        label and the Source Control count.
      */}
      <Tabs
        class="workbench-mobile-switch"
        label="Workspace pane"
        items={[
          { id: "explorer", label: "Files" },
          { id: "editor", label: "Editor", count: tabs.length || undefined, countLabel: `${String(tabs.length)} open files`, disabled: tabs.length === 0 },
          { id: "source", label: "Source Control", count: changeCount, countLabel: `${String(changeCount)} changes` },
        ]}
        activeId={mobilePane === "editor" ? "editor" : mode}
        onSelect={selectPane}
      />
      <div class="workbench-shell" ref={shell} style={{ "--workbench-rail": `${String(rail)}%` }}>
        <aside class={`workbench-activity ${mobilePane === "navigation" ? "mobile-active" : ""}`} aria-label="Workspace activity">
          <Tabs
            class="workbench-mode-tabs"
            label="Workspace activity view"
            items={[
              { id: "explorer", label: "Explorer" },
              { id: "source", label: "Source Control", count: changeCount, countLabel: `${String(changeCount)} changes` },
            ]}
            activeId={mode}
            onSelect={(id) => setMode(id === "source" ? "source" : "explorer")}
          />
          {mode === "explorer" ? <>
            <div class="workbench-section-heading">
              <input
                class="workspace-filter"
                ref={filterField}
                type="search"
                value={filter}
                aria-label="Filter workspace files by path"
                placeholder="Filter files"
                onInput={(event) => setFilter(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setFilter("");
                  focusTreeIndex(0);
                }}
              />
              {/* The only creation affordance used to be a 26x26 bare "+". */}
              <button class="workspace-new" type="button" onClick={() => openDialog("create", "/workspace")}>
                <span aria-hidden="true">+</span> New file
              </button>
            </div>
            {/* A filtered tree must never be mistakable for an empty workspace. */}
            <p class="workspace-filter-count" role="status">
              {filtering ? `${String(filtered.shown)} of ${String(filtered.total)} files` : `${String(filtered.total)} files`}
            </p>
            <div ref={treeViewport} class="workspace-tree" role="tree" aria-label="Workspace files" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHoverExpansion(); }}>
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
        <div
          class="workbench-splitter"
          role="separator"
          aria-label="Explorer width"
          aria-orientation="vertical"
          aria-valuenow={Math.round(rail)}
          aria-valuemin={WORKBENCH_RAIL_MIN_PERCENT}
          aria-valuemax={WORKBENCH_RAIL_MAX_PERCENT}
          tabIndex={0}
          onKeyDown={handleSplitterKey}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const box = shell.current?.getBoundingClientRect();
            if (!box || box.width === 0) return;
            resizeRail(((event.clientX - box.left) / box.width) * 100);
          }}
          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); }}
        />
        <main class={`workbench-editor ${mobilePane === "editor" ? "mobile-active" : ""}`} aria-label="File editor">
          <Tabs
            class="editor-tabs"
            variant="document"
            label="Open files"
            overflowHeading="Open files"
            items={fileTabs}
            activeId={activePath}
            onSelect={(path) => void openTab(path)}
          />
          {buffer && verdict ? <>
            {buffer.binary ? <div class="workspace-binary-preview" role="status"><Icon name="file" size={30} /><strong>Binary file · read-only</strong><span>Airship preserves the original bytes for Git and browser execution. The internal storage envelope is never exposed as editable text.</span></div> : <>
              {buffer.truncated ? <div class="workspace-boundary attention" role="status">{buffer.content ? "Bounded preview only." : "Encrypted file not downloaded."} Files above {formatBytes(WORKSPACE_EDITOR_BYTE_LIMIT)} are read-only; full-object AES-GCM verification is never mislabeled as a range stream.</div> : null}
              {/* The gutter is presentational and scroll-synced from the
                  textarea, so the editable surface remains one real control. */}
              <div class="code-editor-frame">
                {gutterLines ? <pre class="code-gutter" ref={gutter} aria-hidden="true">{gutterLines}</pre> : null}
                <textarea class="code-editor" aria-label={`Edit ${workspaceBaseName(buffer.path)}`} value={buffer.draft} readOnly={buffer.truncated} spellcheck={false} onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }} onInput={(event) => setBuffers((current) => ({ ...current, [buffer.path]: { ...buffer, draft: event.currentTarget.value } }))} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveActive(); } }} />
              </div>
            </>}
            {/*
              The toolbar and the status footer were the same eight words in two
              bands, and the footer measured at y=959 on a 900px viewport — never
              visible on any device. One pinned strip, and the revision hash and
              byte size that `.editor-toolbar small { display:none }` deleted
              below 760px are on a phone for the first time.
            */}
            <div class="editor-strip">
              <Seal class="editor-strip__verdict" state={verdict.state} density="chip" label={verdict.word} detail={verdict.detail} />
              <span class="editor-strip__path" title={buffer.path}>{buffer.path.replace("/workspace/", "")}</span>
              <span class="editor-strip__meta">
                <span title={`Revision ${buffer.revision} — every save is compare-and-swapped against this exact revision.`}>rev {buffer.revision.slice(0, 7)}</span>
                <span>{formatBytes(buffer.size)}</span>
                <span>{buffer.binary ? "Binary · read-only" : "UTF-8 · LF"} · client-side</span>
              </span>
              <span class="editor-strip__save">
                <button class="primary" type="button" title="Save this file — ⌘S or Ctrl+S" disabled={!dirty || busy || buffer.truncated || buffer.binary} onClick={() => void saveActive()}>Save</button>
                <kbd aria-hidden="true">⌘S</kbd>
              </span>
            </div>
          </> : <div class="workbench-empty">
            <Icon name="workspace" size={36} />
            <strong>{files.length === 0 ? "This workspace is empty" : "Open a file from Explorer"}</strong>
            <span>{files.length === 0 ? "Create a file, or import a repository snapshot from Sources." : "Nothing is downloaded until you select it."}</span>
            {suggestions.length > 0 ? <div class="workbench-empty__files">
              {suggestions.map((entry) => <button type="button" key={entry.path} onClick={() => void openTab(entry.path)}>
                <span aria-hidden="true">↳</span>
                <span>{entry.path.replace("/workspace/", "")}</span>
                <small>{formatBytes(entry.size)}</small>
              </button>)}
            </div> : null}
            <div class="workbench-empty__actions">
              <button class="primary" type="button" onClick={() => openDialog("create", "/workspace")}>New file</button>
              {onOpenRepositoryManager ? <button type="button" onClick={onOpenRepositoryManager}>Import a repository snapshot</button> : null}
            </div>
            {/*
              The route header's paragraph lands here rather than being burned
              into every populated session's chrome. It also stays verbatim in
              the route bar's ⓘ.
            */}
            <p class="workbench-empty__note">{WORKBENCH_DESCRIPTION} Every write is compare-and-swapped against the revision you opened.</p>
          </div>}
        </main>
      </div>
      {notice ? <div class={`notice workbench-notice ${notice.kind}`} data-state={workbenchNoticeState(notice.kind)} role={notice.kind === "error" ? "alert" : "status"}>
        <Seal state={workbenchNoticeState(notice.kind)} density="dot" size={16} acting={notice.kind === "progress"} />
        <p>{notice.message}</p>
        {notice.kind === "progress" ? null : <button type="button" aria-label="Dismiss this message" onClick={() => setNotice(undefined)}>Dismiss</button>}
      </div> : null}
      {context ? <div class="workbench-context" role="menu" style={{ left: `${String(context.x)}px`, top: `${String(context.y)}px` }} onPointerDown={(event) => event.stopPropagation()}>
        <button role="menuitem" onClick={() => { if (contextIsFile) void openTab(context.path); else { toggleDirectory(context.path); setContext(undefined); } }}>{contextIsFile ? "Open" : expanded.has(context.path) ? "Collapse" : "Expand"}</button>
        <button role="menuitem" onClick={() => openDialog("create", contextIsFile ? workspaceParentPath(context.path) : context.path)}>New file…</button>
        {contextIsFile ? <>
          <button role="menuitem" onClick={() => openDialog("rename", context.path)}>Rename</button>
          <button role="menuitem" onClick={() => openDialog("move", context.path)}>Move…</button>
          <button class="danger" role="menuitem" onClick={() => openDialog("delete", context.path)}>Delete</button>
        </> : null}
        {/* Replaces a "Close" row that duplicated behaviour already bound. */}
        <p class="workbench-context__hint">Esc or a tap outside dismisses this menu.</p>
      </div> : null}
      {dialog ? <div class="workbench-dialog-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
        <div
          class="workbench-dialog"
          ref={dialogBox}
          role="dialog"
          aria-modal="true"
          aria-label={`${dialog.kind} workspace file`}
          tabIndex={-1}
          onKeyDown={(event) => {
            // The one modal in Airship that shipped without either. Verified
            // live: Playwright could not dismiss the Move dialog with Escape.
            if (event.key === "Escape") { event.preventDefault(); closeDialog(); }
            else if (event.key === "Tab") trapFocus(event, dialogBox.current);
          }}
        >
          <h2 title={dialog.path}>
            {dialog.kind === "create" ? "New file" : dialog.kind === "rename" ? "Rename file" : dialog.kind === "move" ? `Move ${workspaceBaseName(dialog.path)}` : dialog.kind === "discard" ? "Unsaved changes" : "Delete file"}
          </h2>
          {dialog.kind === "move" ? <>
            <p class="workbench-dialog__where">Currently in {workspaceParentPath(dialog.path).replace("/workspace", "workspace")}.</p>
            <div class="move-targets" role="listbox" aria-label="Destination folder">{directories.map((directory) => {
              const label = directory.path.replace("/workspace", "workspace");
              return <button
                key={directory.path}
                role="option"
                aria-selected={dialogValue === directory.path}
                aria-label={label}
                title={label}
                disabled={workspaceParentPath(dialog.path) === directory.path}
                style={{ paddingLeft: `${String(12 + directory.depth * 15)}px` }}
                onClick={() => setDialogValue(directory.path)}
              >{directory.depth === 0 ? "workspace" : directory.name}</button>;
            })}</div>
          </> : dialog.kind === "discard" ? <p>Save <strong>{workspaceBaseName(dialog.path)}</strong> before closing, keep editing, or permanently discard its unsaved in-browser draft.</p>
            : dialog.kind === "delete" ? <p>Delete <strong>{dialog.path.replace("/workspace/", "")}</strong>? The exact revision is checked before removal.{buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? " Its unsaved draft will also be discarded." : ""}</p>
            : <label>{dialog.kind === "create" ? "Path relative to this folder" : "New name"}
              <input autofocus value={dialogValue} onInput={(event) => setDialogValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void runDialog(); }} />
              {dialog.kind === "create" ? <small>In {dialog.path.replace("/workspace", "workspace")}. A path with slashes creates the folders it names — <code>notes/2026/plan.md</code>.</small> : null}
            </label>}
          {(dialog.kind === "move" || dialog.kind === "rename") && buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? <p class="workspace-boundary attention">The unsaved draft will move with this tab; the durable file is not changed until you save.</p> : null}
          <div>
            <button type="button" onClick={closeDialog}>Cancel</button>
            {dialog.kind === "discard" && !buffers[dialog.path]?.truncated ? <button class="primary" type="button" disabled={busy} onClick={() => void saveAndClose(dialog.path)}>Save and close</button> : null}
            <button class={dialog.kind === "delete" || dialog.kind === "discard" ? "danger" : "primary"} type="button" disabled={busy || (!(["delete", "discard"] as string[]).includes(dialog.kind) && !dialogValue.trim())} onClick={() => void runDialog()}>{dialog.kind === "delete" ? "Delete" : dialog.kind === "discard" ? "Discard and close" : dialog.kind === "move" ? "Move here" : "Apply"}</button>
          </div>
        </div>
      </div> : null}
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

function readTabState(storageKey: string): TabState {
  const empty: TabState = { tabs: [], activePath: "", rail: WORKBENCH_RAIL_DEFAULT_PERCENT };
  if (typeof sessionStorage === "undefined") return empty;
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    const tabs = Array.isArray(value.tabs) ? value.tabs.filter((path: unknown): path is string => typeof path === "string" && path.startsWith("/workspace/")) : [];
    const activePath = typeof value.activePath === "string" && tabs.includes(value.activePath) ? value.activePath : tabs[0] ?? "";
    const rail = typeof value.rail === "number" ? workbenchRailPercent(value.rail) : WORKBENCH_RAIL_DEFAULT_PERCENT;
    return { tabs, activePath, rail };
  } catch { return empty; }
}

export function workspaceTabStorageKey(identity: string): string {
  let digest = 5381;
  for (const codePoint of identity) digest = ((digest << 5) + digest) ^ codePoint.codePointAt(0)!;
  return `${TAB_STORAGE}.${(digest >>> 0).toString(36)}`;
}

function clampedContext(path: string, x: number, y: number) {
  const width = typeof innerWidth === "number" ? innerWidth : 1_024;
  const height = typeof innerHeight === "number" ? innerHeight : 768;
  return { path, x: Math.max(8, Math.min(x, width - 208)), y: Math.max(8, Math.min(y, height - 230)) };
}

export function workspaceFileWindow(count: number, scrollTop: number, viewportHeight: number, rowHeight = WORKSPACE_FILE_ROW_HEIGHT) { const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight)); const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight); const start = Math.max(0, first - WORKSPACE_FILE_OVERSCAN); return Object.freeze({ start, end: Math.min(count, first + visible + WORKSPACE_FILE_OVERSCAN) }); }

/**
 * Row height, keyed on the pointer rather than the viewport width.
 *
 * A tablet is 834px wide and has no hover, so the old `innerWidth <= 760` test
 * shipped 34px rows — and hover-only row actions — to every finger over 760px.
 * The touch floor follows the finger.
 */
function workspaceRowHeight(): number {
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return 44;
  if (typeof innerWidth === "number" && innerWidth <= 760) return 44;
  if (typeof document === "undefined") return WORKSPACE_FILE_ROW_HEIGHT;
  return document.documentElement.dataset.density === "comfortable" ? 42 : document.documentElement.dataset.density === "compact" ? 30 : WORKSPACE_FILE_ROW_HEIGHT;
}

export function workspaceEditorProjection(file: WorkspaceFile) {
  const shownBytes = new TextEncoder().encode(file.content).byteLength;
  const binary = isWorkspaceBinaryEnvelope(file.content);
  return Object.freeze({
    content: binary ? "" : file.content,
    binary,
    shownBytes: binary ? 0 : shownBytes,
    truncated: binary || file.size > shownBytes,
  });
}

/**
 * A line gutter is a rendering cost proportional to the file, so it is only
 * offered while that cost stays trivial. Past the cap the editor keeps working
 * without numbers rather than doubling the DOM on a very large buffer.
 */
export const WORKSPACE_GUTTER_LINE_LIMIT = 5_000;

/** The gutter's rendered text, or undefined when no gutter may be shown. */
export function workspaceGutterLines(draft: string, limit = WORKSPACE_GUTTER_LINE_LIMIT): string | undefined {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("The gutter line limit must be a positive integer.");
  let lines = 1;
  for (let index = 0; index < draft.length; index += 1) {
    if (draft[index] !== "\n") continue;
    lines += 1;
    // Stop counting the moment the cap is passed: a 10 MiB paste must not be
    // walked to the end just to decide the gutter is off.
    if (lines > limit) return undefined;
  }
  let text = "1";
  for (let line = 2; line <= lines; line += 1) text += `\n${String(line)}`;
  return text;
}

export function boundedWorkspaceContent(content: string, byteLimit: number, knownTotalBytes?: number) { if (!Number.isInteger(byteLimit) || byteLimit < 1) throw new Error("Workspace byte limit must be a positive integer."); const bytes = new TextEncoder().encode(content); const totalBytes = Math.max(bytes.byteLength, knownTotalBytes ?? 0); if (bytes.byteLength <= byteLimit) return Object.freeze({ content, shownBytes: bytes.byteLength, totalBytes, truncated: totalBytes > bytes.byteLength }); const bounded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, byteLimit)); return Object.freeze({ content: bounded, shownBytes: new TextEncoder().encode(bounded).byteLength, totalBytes, truncated: true }); }

function formatBytes(size: number): string { if (size < 1_024) return `${String(size)} B`; if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`; return `${(size / 1_048_576).toFixed(1)} MiB`; }
