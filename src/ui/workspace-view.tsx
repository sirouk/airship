import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
// The Explorer's own B/KiB/MiB copy stopped at MiB, so a 2 GB imported file
// read "1907.3 MiB" here while #vault printed "1.9 GiB" for the same bytes.
// One vocabulary, one rounding rule, one module — nothing left here to drift.
import { formatBytes } from "../core/bytes";
import type { BrowserGitClient } from "../git/client";
import { describeGitOperation } from "../git/operations";
import { preferredSourceRepositoryId } from "../git/source-selection";
import { resolveGitWorkspaceBinding } from "../git/workspace-binding";
import type { GitAuthor, GitCommitDetail, GitCommitFilePatch, GitCommitSummary, GitDiff, GitOperation, GitOperationDescriptor, GitRemoteSummary, GitRepositorySnapshot, GitStatusEntry, GitWorktreeSnapshot } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, workspaceEntryByteLength } from "../workspace/contracts";
import { decodeWorkspaceBytes, isWorkspaceBinaryEnvelope } from "../workspace/content-codec";
import { searchWorkspaceContent, workspaceSearchSummary, type WorkspaceContentMatch, type WorkspaceContentSearch } from "../workspace/content-search";
import { moveWorkspaceFile } from "../workspace/mutations";
import {
  adoptWorkspaceWitness,
  clearWorkspaceWitness,
  dismissWorkspaceLoss,
  lostWorkspaceWorkNotice,
  readWorkspaceWitness,
  recordWorkspaceWork,
  WORKSPACE_PAGE_LOAD_ID,
  writeWorkspaceWitness,
} from "../workspace/page-witness";
import { buildWorkspaceTree, visibleWorkspaceTree, workspaceBaseName, workspaceDirectories, workspaceFilesUnder, workspaceFolderRenamePlan, workspaceParentPath, type VisibleWorkspaceNode, type WorkspaceMove } from "../workspace/tree";
import { CODE_THEMES, codeThemeCssVariables, resolveCodeTheme } from "../profiles/code-themes";
import { CodeHighlightLayer } from "./code-surface";
import { readMirroredCodeTheme, writeMirroredCodeTheme } from "./code-theme-mirror";
import { ConfirmDialog } from "./confirm-dialog";
import type { DurabilityState } from "./durability-indicator";
import { downloadBytes, downloadFileName } from "./file-download";
import { Icon } from "./icons";
import { MenuSelect, moveMenuSelection, type MenuSelectOption } from "./menu-select";
import { StatusMark } from "./status-mark";
// One conflict predicate for every staging surface: the Advanced controls
// exclude conflicted paths from bulk staging (`isConflicted`) and the
// workbench rail must never be able to send what that panel refused.
// `UnifiedPatch` arrives the same way and for the same reason: this pane used
// to dump the identical `git.diff` result into a `<pre>` while Source Control,
// one click away on the same route, numbered and classified every line.
import { deltaLetter, isConflicted, UnifiedPatch } from "./sources-view";
import { middleTruncate, Tabs, type TabItem } from "./tabs";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import {
  activateWorkbenchDocument,
  closeWorkbenchDocument,
  defaultEditorWrap,
  editorSurfaceNote,
  folderOperationReport,
  openWorkbenchDocument,
  parseWorkbenchDocumentId,
  pinWorkbenchDocument,
  remapWorkbenchDocuments,
  retainWorkbenchDocuments,
  settledWorkbenchNotice,
  WORKBENCH_DESCRIPTION,
  WORKBENCH_DONE_NOTICE_MS,
  WORKBENCH_RAIL_DEFAULT_PERCENT,
  WORKBENCH_RAIL_MAX_PERCENT,
  WORKBENCH_RAIL_MIN_PERCENT,
  WORKBENCH_RAIL_STEP_PERCENT,
  WORKSPACE_FOLDER_NOT_ATOMIC_NOTE,
  WORKSPACE_FOLDER_PLACEHOLDER,
  WORKSPACE_FOLDER_PLACEHOLDER_NOTE,
  workbenchArrivalPane,
  workbenchBufferState,
  workbenchDialogCopy,
  workbenchDiscardConfirmation,
  workbenchDocumentId,
  workbenchFilterMatches,
  workbenchNotice,
  workbenchNoticeState,
  workbenchRailPercent,
  workbenchSuggestedFiles,
  workbenchTabQualifiers,
  workspaceNameError,
  workspacePathError,
  WORKSPACE_GUTTER_LINE_LIMIT,
  type WorkbenchDocumentOpenMode,
  type WorkbenchDocumentTabs,
  type WorkbenchHistoryDiffDocument,
  type WorkbenchStatusDiffDocument,
  type WorkbenchDialogKind,
  type WorkbenchNotice,
  type WorkbenchPane,
} from "./workbench-model";
import "./workspace-view.css";
import "./workspace-file-icon.css";

/**
 * How long the field waits before spending a bounded read on what was typed.
 *
 * A scan is up to 8 MiB of workspace reads; running one per keystroke would
 * charge the whole workspace for a word the user has not finished typing.
 */
export const WORKSPACE_SEARCH_DEBOUNCE_MS = 180;
/**
 * The Explorer's default row pitch, and the virtualization window's unit.
 *
 * 28px, down from 34px — which measured a 42px pitch at the shipped default
 * density, against VS Code's 22px list row. `--tree-row` in workspace-view.css
 * carries the same number for the box that is drawn; `workspaceRowHeight()`
 * below carries the density and touch variants for both.
 */
export const WORKSPACE_FILE_ROW_HEIGHT = 28;
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
const TAB_STORAGE = "airship.workspace.tabs.v2";
/** How many doomed paths a delete confirmation names before it counts the rest. */
const DIALOG_PATH_PREVIEW = 8;
/**
 * How many paths each Source Control lane draws before it states its bound.
 *
 * The rail is a fixed-height list inside a 15rem column; a 4,000-path status is
 * a real state after a branch switch, and drawing it here would cost more than
 * the Advanced controls' virtualized worktree costs to open.
 */
export const SCM_LANE_LIMIT = 250;
/**
 * How deep the workbench reads commit history.
 *
 * One constant for the request and for the sentence that describes it: the
 * shipped rail asked for 20 and then printed `20` where every other group in
 * the column prints a total, so a bounded read read as a repository fact.
 */
export const WORKBENCH_HISTORY_DEPTH = 20;
/**
 * How far the branch row looks for the point where a branch and its upstream
 * last agreed.
 *
 * Ahead/behind is not a field any adapter publishes — `GitWorktreeSnapshot`
 * carries `branch` and `head` and nothing about a remote-tracking ref — so the
 * rail derives it from two bounded `log` reads, exactly like the History group
 * derives its list. Two bounded reads can only produce a bounded answer, which
 * is why `workbenchBranchDivergence` reports whether it found common ground at
 * all, and why the row prints `20+` rather than a confident number when it did
 * not. A count that is a floor must look like a floor.
 */
export const WORKBENCH_DIVERGENCE_DEPTH = WORKBENCH_HISTORY_DEPTH;
/** The dialogs whose subject is the path itself, so an empty field is fine. */
const DIALOG_KINDS_WITHOUT_VALUE: readonly string[] = Object.freeze(["delete", "delete-folder", "discard"]);
type Review = (operation: GitOperation, descriptor: GitOperationDescriptor) => Promise<"allow" | "deny">;
type Buffer = WorkspaceFile & { draft: string; truncated: boolean; binary: boolean };
type DiffBuffer = Readonly<{
  document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument;
  content: string;
  binary: boolean;
  truncated: boolean;
  byteLength?: number;
  loading: boolean;
  error?: string;
  /** Present for a history read, so its exact changed paths remain actionable. */
  files?: readonly GitCommitFilePatch[];
}>;
type Dialog = Readonly<{ kind: WorkbenchDialogKind; path: string }>;
export type WorkspaceTabState = WorkbenchDocumentTabs & Readonly<{
  rail: number;
  wrap: boolean;
  /** Profile-local Source Control selection; identifiers are revalidated on load. */
  repositoryId?: string;
  worktreeId?: string;
}>;

/** Page-memory state partitioned by both authoritative workspace and profile cockpit. */
export class ProfileScopedWorkspacePageStore<T> {
  private readonly workspaces = new WeakMap<WorkspacePort, Map<string, T>>();

  read(workspace: WorkspacePort, workspaceIdentity: string, profileId: string): T | undefined {
    return this.workspaces.get(workspace)?.get(workspaceWorkbenchScope(workspaceIdentity, profileId));
  }

  write(workspace: WorkspacePort, workspaceIdentity: string, profileId: string, value: T): void {
    const profiles = this.workspaces.get(workspace) ?? new Map<string, T>();
    profiles.set(workspaceWorkbenchScope(workspaceIdentity, profileId), value);
    this.workspaces.set(workspace, profiles);
  }
}

const PAGE_DRAFTS = new ProfileScopedWorkspacePageStore<Readonly<Record<string, Buffer>>>();

/**
 * The open requests this page has already answered.
 *
 * One entry per `openFile` result object, held weakly so it costs nothing and
 * disappears with the selection itself. A request is a fact about a moment, not
 * a state to be restored: replaying it after the user has closed the document
 * it opened would contradict the action they took most recently.
 */
const CONSUMED_SELECTIONS = new WeakSet<WorkspaceFile>();

/** Treat a selection object inherited across profiles as stale until that profile selects anew. */
export class WorkbenchProfileSelectionFence {
  private profileId?: string;
  private inherited?: Readonly<{ profileId: string; selected?: WorkspaceFile }>;

  resolve(profileId: string, selected?: WorkspaceFile): WorkspaceFile | undefined {
    if (this.profileId === undefined) {
      this.profileId = profileId;
      return selected;
    }
    if (this.profileId !== profileId) {
      this.profileId = profileId;
      this.inherited = Object.freeze({ profileId, ...(selected ? { selected } : {}) });
      return undefined;
    }
    if (this.inherited?.profileId !== profileId) return selected;
    if (this.inherited.selected === selected) return undefined;
    this.inherited = undefined;
    return selected;
  }
}

/* Static: the shipped palettes cannot change at runtime, so the option list
   is built once rather than on every keystroke in the buffer below it. */
const CODE_THEME_OPTIONS: readonly MenuSelectOption[] = Object.freeze(
  CODE_THEMES.map((theme) => Object.freeze({ value: theme.codeThemeId, label: theme.name, description: theme.description })),
);

export type WorkspaceViewProps = Readonly<{
  profileId: string;
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen: (path: string) => void | Promise<void>;
  workspace: WorkspacePort;
  git?: BrowserGitClient;
  review?: Review;
  onWorkspaceChanged: () => void | Promise<void>;
  /** Opens one profile-scoped terminal tab at this exact workspace directory. */
  onOpenTerminalAt?: (cwd: string) => void;
  workspaceIdentity?: string;
  /**
   * What this workspace's storage authority can actually keep.
   *
   * Only `ephemeral` licenses the page witness below to record, and only it
   * licenses the lost-work sentence: on any durable tier the commits and saves
   * are still there after a reload, and a notice claiming otherwise would be
   * the same kind of untruth in the opposite direction.
   */
  durability?: Readonly<{ state: DurabilityState }>;
  onOpenRepositoryManager?: () => void;
  /** Which pane the destination that opened this workbench asks for. */
  opensPane?: WorkbenchPane;
  /** Changes on every arrival at that destination, repeats of it included. */
  opensPaneArrival?: number;
  /** Compatibility/request seam for opening the Source Control activity. */
  opensActivity?: "explorer" | "source";
  /**
   * The syntax palette this profile edits under.
   *
   * Absent means "the shipped default" rather than "no theme": the editor
   * always paints a sheet, and a workbench rendered before the catalog has
   * been read must not flash an unstyled one.
   */
  codeThemeId?: string | undefined;
  /**
   * Auto-save. There is no Save button beside the theme menu because the menu
   * *is* the commit: the shell writes the catalog on change and the choice
   * travels with the agent, not with this browser tab.
   */
  onCodeThemeChange?: ((codeThemeId: string) => void | Promise<void>) | undefined;
}>;

/** A profile switch remounts the state owner while preserving the shared WorkspacePort. */
export function WorkspaceView(props: WorkspaceViewProps) {
  // App owns the durable file selection. If its prior-profile object survives
  // a cockpit switch, do not reinterpret it as a new-profile open request.
  const selectionFence = useRef<WorkbenchProfileSelectionFence>();
  selectionFence.current ??= new WorkbenchProfileSelectionFence();
  const selected = selectionFence.current.resolve(props.profileId, props.selected);
  const scope = workspaceWorkbenchScope(props.workspaceIdentity ?? "page-memory", props.profileId);
  return <ProfileScopedWorkspaceView key={scope} {...props} selected={selected} />;
}

function ProfileScopedWorkspaceView({
  profileId,
  files,
  selected,
  onOpen,
  workspace,
  git,
  review,
  onWorkspaceChanged,
  onOpenTerminalAt,
  workspaceIdentity = "page-memory",
  durability,
  onOpenRepositoryManager,
  opensPane = "navigation",
  opensPaneArrival = 0,
  opensActivity = "explorer",
  codeThemeId,
  onCodeThemeChange,
}: WorkspaceViewProps) {
  /*
   * The catalog answers first. The device mirror answers only when it does not.
   *
   * Without an adopted Vault the catalog is page memory, so a reload returned
   * every reader to One Dark Pro no matter what they picked — while the shell's
   * own theme, mode, density and body font all came back from
   * `airship.display-preferences.v1`. `code-theme-mirror` closes that gap for
   * the one preference that was missing it, and the ordering here is what keeps
   * it a fallback: a Vault-backed catalog is durable, encrypted and portable
   * between devices, and must never be overruled by a value one browser
   * remembers.
   */
  const [mirroredCodeThemeId, setMirroredCodeThemeId] = useState<string>();
  useEffect(() => {
    if (codeThemeId) return;
    let current = true;
    // The answer is written even when it is "nothing". `WorkspaceView` keys
    // this component on the profile so a switch remounts it, but a state that
    // only ever moves forward would carry one profile's sheet into the next the
    // day that key changes — and a colour crossing a profile boundary is the
    // one failure this whole module exists to avoid.
    void readMirroredCodeTheme(profileId).then((value) => { if (current) setMirroredCodeThemeId(value); });
    return () => { current = false; };
  }, [profileId, codeThemeId]);
  const codeTheme = resolveCodeTheme(codeThemeId ?? mirroredCodeThemeId);
  const changeCodeTheme = onCodeThemeChange
    ? (value: string) => {
      // Optimistic and local: the mirror is written before the catalog is
      // asked, because the catalog write is what can fail, and a reader who
      // saw the sheet change should get the same sheet back on reload whether
      // or not the ephemeral catalog survived the trip.
      setMirroredCodeThemeId(value);
      void writeMirroredCodeTheme(profileId, value);
      void onCodeThemeChange(value);
    }
    : undefined;
  const contextHintId = useId();
  // One id per *window slot*, not per path: a workspace path may contain a
  // space, and an `aria-owns` value is a space-separated IDREF list.
  const rowActionBaseId = useId();
  // Same slot-indexed scheme for the label the row points its name at, kept
  // separate from the action id so neither can be derived from the other by
  // accident once one of them moves.
  const rowLabelBaseId = useId();
  // Both tab strips in the rail switch the same region, so they name the same
  // panel; the document strip names the editor's. Each panel is named by an
  // `sr-only` heading inside it, which is the same accessible-heading pattern used by other routes
  // and the one the portability audit checks: a tabpanel must be labelled by an
  // element that exists, not by a second string that can drift from the tab.
  const panelBaseId = useId();
  const activityPanelId = `${panelBaseId}-activity-panel`;
  const activityPanelTitleId = `${panelBaseId}-activity-title`;
  const editorPanelId = `${panelBaseId}-editor-panel`;
  const editorPanelTitleId = `${panelBaseId}-editor-title`;
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState<WorkspaceContentSearch>();
  const [searching, setSearching] = useState(false);
  /**
   * Whether the scan for the current query came back as a rejection.
   *
   * A failed scan settles the rail exactly as a successful one does. Without
   * this the only evidence a scan had finished was `search` being defined, so a
   * rejection — an object whose key rotated, a transient IndexedDB failure —
   * left the count line saying "reading contents…" and the tree hidden behind
   * "Searching file contents…" for as long as the query stayed in the field.
   * Nothing was reading.
   */
  const [scanFailed, setScanFailed] = useState(false);
  const query = filter.trim();
  const filtered = useMemo(() => workbenchFilterMatches(files, filter), [files, filter]);
  /**
   * The text hits this query found, grouped under the file that holds them.
   *
   * One question, one field. The route used to ask the reader to choose between
   * "Path" and "Contents" before typing — a segmented control the owner called
   * "a mess", filled `--accent-bright` as if picking a search mode were the
   * primary action on the page — and the two modes were genuinely disjoint: the
   * path matcher saw an empty query in Contents mode and the content results
   * replaced the tree wholesale. A person who does not already know which of
   * the two answers their question has to try both. So both run on every
   * keystroke: `workbenchFilterMatches` is free and synchronous, the bounded
   * scan is debounced and abortable, and the rail draws one tree out of the
   * union of what they found.
   */
  const hitsByPath = useMemo(() => {
    const grouped = new Map<string, WorkspaceContentMatch[]>();
    for (const match of search?.matches ?? []) {
      const existing = grouped.get(match.path);
      if (existing) existing.push(match);
      else grouped.set(match.path, [match]);
    }
    return grouped;
  }, [search]);
  /*
   * Inventory order, not match order: `buildWorkspaceTree` takes its child
   * ordering from insertion, and both workspace backends list with
   * `localeCompare`. Filtering `files` keeps that order for free, where
   * concatenating the two match sets would have put content-only hits after
   * every path match and shuffled the tree under the reader.
   */
  const searchMatches = useMemo(() => {
    if (!query) return filtered.matches;
    const byPath = new Set(filtered.matches.map((entry) => entry.path));
    return files.filter((entry) => byPath.has(entry.path) || hitsByPath.has(entry.path));
  }, [query, files, filtered.matches, hitsByPath]);
  const filtering = searchMatches.length !== filtered.total;
  const fullTree = useMemo(() => buildWorkspaceTree(files), [files]);
  const tree = useMemo(() => filtering ? buildWorkspaceTree(searchMatches) : fullTree, [filtering, searchMatches, fullTree]);
  const directories = useMemo(() => workspaceDirectories(fullTree), [fullTree]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["/workspace", "/workspace/docs", "/workspace/notes", "/workspace/sources"]));
  // A filter that left its matches inside collapsed folders would report a
  // count the user cannot see. Filtering expands every ancestor it produced,
  // and clearing it restores exactly the folders the user had open.
  const effectiveExpanded = useMemo(
    () => filtering ? new Set(workspaceDirectories(tree).map((node) => node.path)) : expanded,
    [filtering, tree, expanded],
  );
  /*
   * A search answers with files, not with the folders that happen to contain
   * them. Searching `src` in a 13-file workspace drew 7 rows, 2 of which were
   * `src` and `lib` — folder rows the reader cannot open, cannot act on, and
   * did not ask for; a 6-match search across six folders cost six of them. The
   * matched files are listed flat, each carrying its own folder as a dimmed
   * suffix the way VS Code's own results list does, so the row count is the
   * match count. Clearing the field restores the tree, and the reader's
   * expansion state with it, because `expanded` was never touched.
   */
  const visible = useMemo(
    () => query ? explorerSearchNodes(searchMatches) : visibleWorkspaceTree(tree, effectiveExpanded),
    [query, searchMatches, tree, effectiveExpanded],
  );
  /**
   * The drawn tree: its nodes, and the text hits that belong inside them.
   *
   * A hit is a place in a file, so it is a row of this tree one level deeper
   * than the file — not a separate list that replaced the tree, which is what
   * Contents mode did. Keeping them in one array is what keeps them in one
   * keyboard path: ↑/↓ walk hits and files alike, the roving tabindex is
   * unchanged, and `aria-posinset`/`aria-setsize` still describe the whole
   * list rather than the ~24 rows virtualization renders.
   */
  const rows = useMemo(() => explorerRows(visible, hitsByPath), [visible, hitsByPath]);
  /**
   * Clearing a filter cannot hand the keyboard back inside the same call.
   *
   * `focusTreeIndex` reads the *current* `visible`, which for the case that
   * needs it most — a filter matching nothing — is empty, so it returned
   * without focusing anything and the Escape shortcut silently did half its
   * job. The row to focus only exists after the unfiltered tree renders, so the
   * request is queued here and spent by the effect below.
   */
  const pendingTreeFocus = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [treeHeight, setTreeHeight] = useState(WORKSPACE_FILE_VIEWPORT_HEIGHT);
  const rowHeight = workspaceRowHeight();
  const rowWindow = workspaceFileWindow(rows.length, scrollTop, treeHeight, rowHeight);
  const [treeFocusPath, setTreeFocusPath] = useState("");
  const [revealedPath, setRevealedPath] = useState("");
  const [revealRequest, setRevealRequest] = useState<Readonly<{ path: string; sequence: number }>>();
  const [dropTarget, setDropTarget] = useState("");
  const [mode, setMode] = useState<"explorer" | "source">(opensActivity);
  const tabStorageKey = useMemo(() => workspaceTabStorageKey(workspaceIdentity, profileId), [workspaceIdentity, profileId]);
  const restoredTabs = useMemo(() => readTabState(tabStorageKey), [tabStorageKey]);
  const restoredBuffers = PAGE_DRAFTS.read(workspace, workspaceIdentity, profileId) ?? {};
  const [documents, setDocuments] = useState<WorkbenchDocumentTabs>(() => {
    const restoredPreview = restoredTabs.previewId;
    const previewDocument = restoredPreview ? parseWorkbenchDocumentId(restoredPreview) : undefined;
    const previewBuffer = previewDocument?.kind === "file" ? restoredBuffers[previewDocument.path] : undefined;
    // A page-remount can recover a draft from the WeakMap. If that draft was
    // edited before the remount, it is pinned even if sessionStorage observed
    // the preceding preview state.
    return restoredPreview && previewBuffer?.draft !== previewBuffer?.content
      ? pinWorkbenchDocument(restoredTabs, restoredPreview)
      : restoredTabs;
  });
  const { tabs, activeId, previewId } = documents;
  // The first pane obeys the same rule every later arrival does. Read as a bare
  // `useState(opensPane)` it did not: a mount at #editor with no restored tabs
  // opened the pane whose switch tab is disabled at zero documents, which is a
  // screen with no visible way out of it.
  const [mobilePane, setMobilePane] = useState<WorkbenchPane>(
    () => workbenchArrivalPane(opensPane, restoredTabs.tabs.length) ?? "navigation",
  );
  const [rail, setRail] = useState(restoredTabs.rail);
  const [wrap, setWrap] = useState(restoredTabs.wrap);
  const [buffers, setBuffers] = useState<Readonly<Record<string, Buffer>>>(restoredBuffers);
  const [diffs, setDiffs] = useState<Readonly<Record<string, DiffBuffer>>>({});
  const [context, setContext] = useState<Readonly<{ path: string; x: number; y: number }>>();
  const [dialog, setDialog] = useState<Dialog>();
  const [dialogValue, setDialogValue] = useState("");
  const [notice, setNotice] = useState<WorkbenchNotice>();
  const [busy, setBusy] = useState(false);
  const [repositories, setRepositories] = useState<readonly GitRepositorySnapshot[]>([]);
  const [repositoryId, setRepositoryId] = useState(restoredTabs.repositoryId ?? "");
  const [worktree, setWorktree] = useState<GitWorktreeSnapshot>();
  const [sourceSelectionResolved, setSourceSelectionResolved] = useState(false);
  const [history, setHistory] = useState<readonly GitCommitSummary[]>([]);
  const [historyMessage, setHistoryMessage] = useState("");
  const [upstream, setUpstream] = useState<Readonly<{ label: string; divergence: WorkbenchBranchDivergence }>>();
  const [scmLoading, setScmLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  /*
   * Adopted once per mount, before this load records anything of its own: the
   * comparison is between this page load and the one that wrote the witness.
   * `lost` is what the reload destroyed, held in state so dismissing it is a
   * decision and not a re-render away from coming back.
   */
  const witnessScope = workspaceWorkbenchScope(workspaceIdentity, profileId);
  const [lostWork, setLostWork] = useState(() => {
    const adopted = adoptWorkspaceWitness(readWorkspaceWitness(browserSessionStorage(), witnessScope), WORKSPACE_PAGE_LOAD_ID);
    // Written back at adoption, so the previous load's record is retired
    // exactly once and the loss survives leaving the route and coming back.
    writeWorkspaceWitness(browserSessionStorage(), witnessScope, adopted);
    return adopted.lost;
  });
  const ephemeral = durability?.state === "ephemeral";
  const lostWorkMessage = lostWorkspaceWorkNotice(lostWork);
  // Adopting a Vault copies this page's workspace and Git state into it, so the
  // record of work at risk is not merely stale, it is wrong: drop it the moment
  // the durability claim stops being page memory.
  useEffect(() => {
    if (!ephemeral) clearWorkspaceWitness(browserSessionStorage(), witnessScope);
  }, [ephemeral, witnessScope]);
  /** Only page-memory work is at risk, so only page-memory work is witnessed. */
  function witness(work: Readonly<{ commit?: string; savedPath?: string }>): void {
    if (ephemeral) recordWorkspaceWork(browserSessionStorage(), witnessScope, work);
  }
  const hoverTimer = useRef<number>();
  const hoverDirectory = useRef("");
  const treeViewport = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  // The painted twin behind the textarea, and the textarea itself. Both are
  // scroll-synced from the one real control; see `syncCodeScroll`.
  const highlightLayer = useRef<HTMLPreElement>(null);
  const wrapMeasure = useRef<HTMLPreElement>(null);
  const editorArea = useRef<HTMLTextAreaElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const dialogBox = useRef<HTMLDivElement>(null);
  const dialogOpener = useRef<HTMLElement>();
  const contextBox = useRef<HTMLDivElement>(null);
  const contextOpener = useRef<HTMLElement>();
  const filterField = useRef<HTMLInputElement>(null);
  const documentsRef = useRef(documents);
  const buffersRef = useRef(buffers);
  const diffsRef = useRef(diffs);
  const railRef = useRef(rail);
  const wrapRef = useRef(wrap);
  const [wrappedGutter, setWrappedGutter] = useState<readonly [number[], number]>();
  const repositoryIdRef = useRef(repositoryId);
  const persistedWorktreeId = workspacePersistedWorktreeId(
    restoredTabs.worktreeId,
    worktree?.id,
    sourceSelectionResolved,
  );
  const worktreeIdRef = useRef(persistedWorktreeId);
  documentsRef.current = documents;
  buffersRef.current = buffers;
  diffsRef.current = diffs;
  railRef.current = rail;
  wrapRef.current = wrap;
  repositoryIdRef.current = repositoryId;
  worktreeIdRef.current = persistedWorktreeId;

  useEffect(() => () => {
    // Profile changes remount this owner. Flush refs in cleanup so a switch in
    // the same frame as an edit/layout change cannot strand the latest state.
    PAGE_DRAFTS.write(workspace, workspaceIdentity, profileId, buffersRef.current);
    try {
      const current = documentsRef.current;
      writeWorkspaceTabState(sessionStorage, workspaceIdentity, profileId, {
        ...current,
        rail: railRef.current,
        wrap: wrapRef.current,
        ...(repositoryIdRef.current ? { repositoryId: repositoryIdRef.current } : {}),
        ...(worktreeIdRef.current ? { worktreeId: worktreeIdRef.current } : {}),
      });
    } catch { /* Page-memory isolation remains valid when session storage is unavailable. */ }
  }, [workspace, workspaceIdentity, profileId]);

  // Keyed on the selection's *identity*, not on its (path, revision) value.
  // Closing a tab discards its buffer without changing either of those fields,
  // so reopening the same file at the same revision was indistinguishable from
  // a no-op and the pane stayed empty. `app.tsx` publishes one fresh frozen
  // file object per `openFile`, so this runs exactly once per open request and
  // never on an unrelated re-render; the dirty-draft guard below keeps a
  // re-published selection from displacing unsaved work.
  //
  // "Exactly once" has to survive a remount, which is why the record of what
  // has been consumed is module-scoped rather than a ref. `app.tsx` unmounts
  // this workbench when the destination changes between #workspace and
  // #editor, while the selection it holds outlives that: an effect that reran
  // on mount replayed an open request the user had already answered by closing
  // the document, so the last tab a user closed came back by itself the next
  // time they crossed between the two doors of the same surface.
  useEffect(() => {
    if (!selected || CONSUMED_SELECTIONS.has(selected)) return;
    CONSUMED_SELECTIONS.add(selected);
    openDocumentState(workbenchDocumentId({ kind: "file", path: selected.path }), "preview");
    setBuffers((current) => {
      const prior = current[selected.path];
      if (prior && prior.draft !== prior.content) return current;
      const projection = workspaceEditorProjection(selected);
      const next = { ...current, [selected.path]: { ...selected, content: projection.content, draft: projection.content, truncated: projection.truncated, binary: projection.binary } };
      buffersRef.current = next;
      return next;
    });
  }, [selected]);

  useEffect(() => {
    try {
      writeWorkspaceTabState(sessionStorage, workspaceIdentity, profileId, {
        tabs,
        activeId,
        previewId,
        rail,
        wrap,
        ...(repositoryId ? { repositoryId } : {}),
        ...(persistedWorktreeId ? { worktreeId: persistedWorktreeId } : {}),
      });
    } catch {
      // Open tabs and drafts remain valid page-memory state when browser
      // privacy policy denies optional session preference storage.
    }
  }, [tabs, activeId, previewId, rail, wrap, repositoryId, persistedWorktreeId, tabStorageKey]);

  useEffect(() => {
    PAGE_DRAFTS.write(workspace, workspaceIdentity, profileId, buffers);
    const hasDirtyDraft = Object.values(buffers).some((candidate) => candidate.draft !== candidate.content);
    if (!hasDirtyDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [buffers, workspace, workspaceIdentity, profileId]);

  /*
   * Evict what the tree no longer lists.
   *
   * The listing is the only authority on what still exists, so this decision
   * is made on a *change of listing* and on nothing else. It used to also
   * depend on `activeId`, which re-asked "does this path exist?" against
   * whichever listing happened to be in state at that moment: a local move
   * publishes its remapped tab strip and its carried-over draft synchronously,
   * before the refresh it then awaits has landed, so the `activeId` rerun
   * judged the just-created target path against the pre-move listing, called
   * it externally deleted, and discarded the unsaved draft the move had just
   * carried across. `WorkspaceRefreshCoordinator` will not publish a
   * superseded listing, so a listing change is always the newest truth.
   *
   * Loading content for whatever document is active is a separate concern and
   * lives in the effect below, which still watches `activeId`.
   */
  useEffect(() => {
    if (files.length === 0) return;
    const filePaths = new Set(files.map((entry) => entry.path));
    const retained = new Set(documentsRef.current.tabs.filter((id) => {
      const document = parseWorkbenchDocumentId(id);
      return document?.kind === "diff" || (document?.kind === "file" && filePaths.has(document.path));
    }));
    const next = retainWorkbenchDocuments(documentsRef.current, retained);
    // Read the pre-retain tabs: `publishDocuments` swaps the ref synchronously,
    // so the evicted set is gone one statement later.
    const vanished = workbenchVanishedFilePaths(documentsRef.current.tabs, filePaths);
    if (next !== documentsRef.current) publishDocuments(next);
    // An externally deleted file's tab is gone with it, and its draft can
    // never be saved back to a path that no longer exists — an invisible dirty
    // buffer would keep the beforeunload guard armed forever and resurrect as
    // a stale draft if the path were created again. Discard follows the same
    // rule everywhere else in this view, so the buffer goes with the tab.
    if (vanished.length > 0) {
      const gone = new Set(vanished);
      setBuffers((current) => {
        const nextBuffers = Object.fromEntries(Object.entries(current).filter(([path]) => !gone.has(path)));
        buffersRef.current = nextBuffers;
        return nextBuffers;
      });
    }
    // The mirror case: the file is still listed, but an agent turn, a terminal
    // or a checkout moved its revision. A clean buffer holds no work to
    // protect, so it follows the external write; a dirty one keeps its draft —
    // the compare-and-swapped save is already the fence for that race.
    for (const path of workbenchExternalRevisionPaths(buffersRef.current, files)) {
      void reconcileExternalRevision(path, buffersRef.current[path]?.revision ?? "");
    }
  }, [files]);

  /*
   * Content for whatever document is active: after the eviction above changed
   * it, on the first listing after a restore, and when `git` arrives late for
   * a restored diff tab. Read through `documentsRef` rather than the `activeId`
   * render value, because the effect above has already published this commit's
   * retained strip into the ref.
   */
  useEffect(() => {
    if (files.length === 0) return;
    const active = documentsRef.current.activeId;
    const desired = active ? parseWorkbenchDocumentId(active) : undefined;
    if (desired?.kind === "file" && !buffersRef.current[desired.path]) void onOpen(desired.path);
    if (desired?.kind === "diff" && active && !diffsRef.current[active]) void loadDiffDocument(desired, active);
    if (!desired) setMobilePane("navigation");
  }, [files, activeId, git]);

  useEffect(() => {
    if (!git) return;
    void refreshSourceControl(restoredTabs.repositoryId, restoredTabs.worktreeId);
  }, [git]);

  useEffect(() => {
    // Advanced controls are entered from Source Control. Keep that activity
    // selected while its modal is open; closing the sheet never forces a user
    // back to Explorer.
    if (opensActivity !== "source") return;
    setMode("source");
    setMobilePane("navigation");
  }, [opensActivity]);

  // `opensPane` was read once, as a `useState` initializer, for a component
  // that `app.tsx` never remounts between #workspace and #editor — so on a
  // phone the two destinations mapped to whichever pane happened to mount
  // first and never switched again.
  //
  // Re-applying it whenever the *value* changes is still not enough, because
  // the pane leaves the destination behind without the destination moving:
  // opening a file from the tree shows the editor pane while the hash stays
  // `#workspace`. Asking for Workspace again then produces no change in
  // `opensPane` — and no `hashchange` either — so the request was dropped and
  // the door the user had just knocked on stayed shut. `opensPaneArrival`
  // counts the requests themselves, which is the event this needs.
  useEffect(() => {
    const pane = workbenchArrivalPane(opensPane, documentsRef.current.tabs.length);
    if (pane) setMobilePane(pane);
  }, [opensPane, opensPaneArrival]);

  /**
   * The menu half of the menu: focus, and where focus goes back to.
   *
   * The row actions were built as a positioned popup with menu *roles* and
   * none of the pattern's focus management, so Shift+F10 opened a `role="menu"`
   * the keyboard could not enter and Escape dropped the caret on `<body>`. The
   * menu now takes focus on open, roves it with the arrow keys, and hands it
   * back to the exact control that opened it.
   */
  useEffect(() => {
    if (!context) return;
    const dismiss = (restoreFocus: boolean) => {
      setContext(undefined);
      if (restoreFocus) restoreContextFocus();
    };
    const onPointerDown = () => dismiss(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dismiss(true); } };
    window.addEventListener("pointerdown", onPointerDown, { once: true });
    window.addEventListener("keydown", onKeyDown);
    focusContextItem(0);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("keydown", onKeyDown); };
  }, [context]);

  // The tree's virtualization window is driven by the rail it actually
  // occupies. Before this the window was a constant and the panel was sized to
  // match it, which is why a 718px rail rendered 432px of rows and 382px of
  // nothing.
  useEffect(() => {
    const element = treeViewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let resizeFrame: number | undefined;
    const measure = () => {
      resizeFrame = undefined;
      const height = element.clientHeight;
      if (height > 0) setTreeHeight(height);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrame === undefined) resizeFrame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    };
  }, [mode]);

  // The content half of the one search reads real bytes, so it is the half that
  // costs something: the request is debounced, abortable, and dropped entirely
  // the moment the field empties. The path half runs on every keystroke and is
  // already on screen while this one is still reading, which is what lets a
  // single field answer both questions without a mode.
  useEffect(() => {
    if (!query) {
      setSearch(undefined);
      setSearching(false);
      setScanFailed(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setScanFailed(false);
    const timer = setTimeout(() => {
      void searchWorkspaceContent(workspace, files, query, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setSearch(result); })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          // The previous query's result describes the previous query, and the
          // count line prints it verbatim: dropped here, a failed scan cannot
          // report an older term's file counts as though they were this one's.
          setSearch(undefined);
          setScanFailed(true);
          setNotice(workbenchNotice("error", cause instanceof Error ? cause.message : "Workspace content could not be searched."));
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, WORKSPACE_SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, files, workspace]);

  /*
   * Spends the queued focus request the moment the rows it names exist.
   *
   * `filter` is a dependency because `rows` is derived from `tree`,
   * `effectiveExpanded` and the hit map alone — clearing a filter that matched
   * nothing changes none of them, so keyed on `[rows]` this effect could not
   * run at all on the path that queues it most. The request then stayed armed
   * until some unrelated change (expanding a folder, a refresh adding a file)
   * rebuilt the list, and yanked focus and scroll to row 0 while the reader was
   * somewhere else entirely.
   */
  useEffect(() => {
    if (!pendingTreeFocus.current || !rows.length) return;
    pendingTreeFocus.current = false;
    focusTreeIndex(0);
  }, [rows, filter]);

  useEffect(() => {
    if (!revealRequest || mode !== "explorer" || filter) return;
    const index = rows.findIndex((row) => row.id === revealRequest.path);
    if (index < 0) return;
    const viewport = treeViewport.current;
    if (!viewport) return;
    if (index < rowWindow.start || index >= rowWindow.end) {
      const centered = Math.max(0, index * rowHeight - Math.max(0, treeHeight - rowHeight) / 2);
      viewport.scrollTop = centered;
      setScrollTop(centered);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const row = treeRowElement(index);
      row?.focus({ preventScroll: true });
      setRevealRequest((current) => current?.sequence === revealRequest.sequence ? undefined : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealRequest?.sequence, rows, mode, filter, scrollTop, rowWindow.start, rowWindow.end, rowHeight, treeHeight]);

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

  useEffect(() => () => clearHoverExpansion(), []);

  const activeDocument = activeId ? parseWorkbenchDocumentId(activeId) : undefined;
  const treeSelectedPath = activeDocument?.kind === "file" ? activeDocument.path : revealedPath;
  const buffer = activeDocument?.kind === "file" ? buffers[activeDocument.path] : undefined;
  const diffBuffer = activeDocument?.kind === "diff" ? diffs[activeId] : undefined;
  const dirty = Boolean(buffer && buffer.draft !== buffer.content);
  const gutterLines = buffer && !buffer.binary ? workspaceGutterLines(buffer.draft) : undefined;
  /**
   * One scroll position, three boxes.
   *
   * The textarea is the only one a person scrolls; the gutter and the painted
   * layer are followers. `scrollLeft` matters as much as `scrollTop` — without
   * it an unwrapped long line paints its colours at the left margin while the
   * caret is a hundred columns to the right.
   */
  function syncCodeScroll(source: HTMLTextAreaElement): void {
    if (gutter.current) gutter.current.scrollTop = source.scrollTop;
    if (highlightLayer.current) {
      highlightLayer.current.scrollTop = source.scrollTop;
      highlightLayer.current.scrollLeft = source.scrollLeft;
    }
  }
  useLayoutEffect(() => {
    const measure = wrapMeasure.current;
    if (!wrap || !measure || !gutterLines) return;
    const update = () => {
      setWrappedGutter(measureWrappedGutter(measure, buffer!.draft));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [wrap, gutterLines, buffer?.draft]);
  // Activating another document, or toggling wrap, moves the textarea's own
  // scroll offset without emitting a scroll event. Re-register after the paint
  // that changed it rather than leaving the layer at the previous file's offset.
  useEffect(() => {
    if (editorArea.current) syncCodeScroll(editorArea.current);
  });
  const contextIsFile = Boolean(context && files.some((file) => file.path === context.path));
  // A folder operation is a set of file operations, so the dialog computes the
  // set before it offers the button and prints its size in the confirmation.
  const dialogFolderFiles = useMemo(
    () => dialog?.kind === "rename-folder" || dialog?.kind === "delete-folder" ? workspaceFilesUnder(files, dialog.path) : [],
    [dialog?.kind, dialog?.path, files],
  );
  // Folder delete discards open buffers under the path without asking — the
  // confirmation owes those drafts the same sentence the single-file delete
  // prints, or the honest dialog is only honest for one of the two deletes.
  const dialogDirtyDrafts = dialog?.kind === "delete-folder" ? workbenchDirtyDraftsUnderFolder(buffers, dialog.path) : 0;
  const dialogCopy = dialog ? workbenchDialogCopy(dialog.kind, dialog.path, dialogFolderFiles.length) : undefined;
  // Only once something has been typed: "Enter a name." beside an empty field
  // the dialog just opened is a scold, not an explanation. Whitespace-only
  // still counts as typed, because that is the case a disabled button cannot
  // explain on its own.
  // All four name-taking kinds, not two: `create` and `rename` had neither
  // pre-validation nor any post-failure report, because their normalization ran
  // outside `transact`, so `..` in New file threw into a void and closed the
  // dialog with nothing said. `create` uses the path-shaped rules — its field is
  // documented as "Path relative to this folder", so a slash is legal there.
  const dialogNameError = dialogValue.length > 0
    ? dialog?.kind === "create-folder" || dialog?.kind === "rename-folder" || dialog?.kind === "rename"
      ? workspaceNameError(dialogValue)
      : dialog?.kind === "create" ? workspacePathError(dialogValue) : undefined
    : undefined;
  // The Move dialog's one Tab stop. Its listbox is full of native buttons, so
  // without a roving tabindex Tab visited every folder it offered.
  const moveTargetFocus = dialog?.kind === "move"
    ? workbenchMoveTargetFocusIndex(
        directories.map((directory) => ({ disabled: workspaceParentPath(dialog.path) === directory.path })),
        directories.findIndex((directory) => directory.path === dialogValue),
      )
    : -1;
  const changeCount = worktree?.status.length ?? 0;
  const tabQualifiers = useMemo(() => workbenchTabQualifiers(tabs.filter((id) => parseWorkbenchDocumentId(id)?.kind === "file")), [tabs]);
  const suggestions = useMemo(() => workbenchSuggestedFiles(files), [files]);
  const verdict = buffer
    ? workbenchBufferState({ binary: buffer.binary, truncated: buffer.truncated, dirty })
    : undefined;

  const documentTabs: readonly TabItem[] = tabs.map((id) => {
    const document = parseWorkbenchDocumentId(id)!;
    if (document.kind === "file") {
      const name = workspaceBaseName(document.path);
      const candidate = buffers[document.path];
      const unsaved = Boolean(candidate && candidate.draft !== candidate.content);
      return {
        id,
        leading: <WorkspaceFileIcon path={document.path} />,
        label: middleTruncate(name),
        detail: document.path.replace("/workspace/", ""),
        hint: tabQualifiers[document.path] || undefined,
        preview: previewId === id,
        state: unsaved ? "attention" : undefined,
        stateLabel: unsaved ? "Unsaved" : undefined,
        onClose: () => closeTab(id),
        // The disambiguator the tab's own name already carries: two files both
        // called index.ts otherwise produced two identical "Close index.ts"
        // buttons, so the label was unique for the tab and ambiguous for the
        // control beside it. Unchanged for every unique basename.
        closeLabel: `Close ${tabQualifiers[document.path] ? `${tabQualifiers[document.path]}/${name}` : name}`,
      };
    }
    const candidate = diffs[id];
    const status = document.source === "status";
    const name = status ? workspaceBaseName(document.path) : document.revision.slice(0, 12);
    const detail = status
      ? `${document.path} · ${document.scope} diff`
      : `Commit ${document.revision}`;
    // A status diff is a patch of one exact worktree version. When the worktree
    // moves on, that tab is a snapshot of a state the repository is no longer
    // in — and reopening the same path produced a second tab the strip drew
    // identically. The version is part of document identity; now it is part of
    // the tab's presentation too.
    const superseded = status ? workbenchSupersededStatusDiff(document.worktreeVersion, worktree?.version) : undefined;
    const stateLabel = candidate?.error ? "Unavailable" : candidate?.truncated ? "Truncated" : superseded ? "Superseded" : undefined;
    return {
      id,
      leading: status ? <WorkspaceFileIcon path={document.path} /> : <Icon name="source" size={16} />,
      label: middleTruncate(name),
      detail,
      hint: status ? workbenchStatusDiffHint(document.scope, document.worktreeVersion, worktree?.version) : "Commit diff",
      preview: previewId === id,
      state: stateLabel ? "attention" : undefined,
      stateLabel,
      onClose: () => closeTab(id),
      closeLabel: `Close ${detail}`,
    };
  });

  async function refreshSourceControl(preferredRepository = repositoryId, preferredWorktree = worktree?.id): Promise<void> {
    if (!git) return;
    setScmLoading(true);
    try {
      const next = await git.listRepositories();
      const selection = resolveWorkspaceSourceSelection(
        next,
        preferredRepository,
        preferredWorktree,
        preferredSourceRepositoryId(),
      );
      const { repository, worktree: nextWorktree } = selection;
      setRepositories(next);
      setRepositoryId(repository?.id ?? "");
      setWorktree(nextWorktree);
      setSourceSelectionResolved(true);
      const historyCapability = repository?.capabilities.features.history;
      if (!repository || !nextWorktree) {
        setHistory([]);
        setHistoryMessage("");
        setUpstream(undefined);
      } else if (!historyCapability?.available) {
        setHistory([]);
        setHistoryMessage(historyCapability?.reason ?? "History is unavailable for this repository adapter.");
        setUpstream(undefined);
      } else {
        try {
          const local = await git.log({ repositoryId: repository.id, worktreeId: nextWorktree.id, depth: WORKBENCH_HISTORY_DEPTH });
          setHistory(local);
          setHistoryMessage("");
          setUpstream(await readUpstreamDivergence(repository, nextWorktree, local));
        } catch (cause) {
          setHistory([]);
          setHistoryMessage(cause instanceof Error ? cause.message : "Commit history could not be read.");
          setUpstream(undefined);
        }
      }
    } catch (cause) {
      setNotice(workbenchNotice("error", cause instanceof Error ? cause.message : "Source control could not be refreshed."));
    } finally {
      setScmLoading(false);
    }
  }

  /**
   * A second bounded log, and only when there is a ref to read.
   *
   * Guarded three ways because the cheap version of this is a lie: no remote
   * means no upstream and no arrows; a `refs/remotes/…` ref that has never been
   * fetched throws, and that throw means "unknown", not "up to date". Anything
   * other than a resolved ref leaves the branch row printing branch and head
   * with no sync claim at all, which is the honest state for a repository this
   * page has never fetched.
   */
  async function readUpstreamDivergence(
    repository: GitRepositorySnapshot,
    target: GitWorktreeSnapshot,
    local: readonly GitCommitSummary[],
  ): Promise<Readonly<{ label: string; divergence: WorkbenchBranchDivergence }> | undefined> {
    if (!git) return undefined;
    const candidate = workbenchUpstreamRef(repository.remotes, target.branch);
    if (!candidate) return undefined;
    try {
      const remote = await git.log({ repositoryId: repository.id, worktreeId: target.id, ref: candidate.ref, depth: WORKBENCH_DIVERGENCE_DEPTH });
      return Object.freeze({
        label: candidate.label,
        divergence: workbenchBranchDivergence(local.map((entry) => entry.oid), remote.map((entry) => entry.oid)),
      });
    } catch {
      return undefined;
    }
  }

  function publishDocuments(next: WorkbenchDocumentTabs): void {
    if (next === documentsRef.current) return;
    documentsRef.current = next;
    setDocuments(next);
  }

  /**
   * Apply one preview/pin transition before asking the host for file content.
   *
   * The dirty check is intentionally repeated here in addition to the input
   * handler: a recovered page draft must not be displaced even if an older
   * sessionStorage snapshot still called it the preview.
   */
  function openDocumentState(id: string, mode: WorkbenchDocumentOpenMode): string {
    if (!parseWorkbenchDocumentId(id)) throw new Error("The requested editor document has no valid workspace identity.");
    let current = documentsRef.current;
    const currentPreview = current.previewId;
    const previewDocument = currentPreview ? parseWorkbenchDocumentId(currentPreview) : undefined;
    const candidate = previewDocument?.kind === "file" ? buffersRef.current[previewDocument.path] : undefined;
    if (currentPreview && candidate && candidate.draft !== candidate.content) {
      current = pinWorkbenchDocument(current, currentPreview);
      publishDocuments(current);
    }
    const transition = openWorkbenchDocument(current, id, mode);
    publishDocuments(transition.state);
    if (transition.displacedId) {
      const displacedDocument = parseWorkbenchDocumentId(transition.displacedId);
      if (displacedDocument?.kind === "file") setBuffers((currentBuffers) => {
        const displaced = currentBuffers[displacedDocument.path];
        // This should be unreachable because the guard above pins dirty
        // previews. Fail safe by retaining the buffer rather than deleting an
        // unsaved draft if an external state mutation violates the invariant.
        if (displaced && displaced.draft !== displaced.content) return currentBuffers;
        const next = Object.fromEntries(Object.entries(currentBuffers).filter(([key]) => key !== displacedDocument.path));
        buffersRef.current = next;
        return next;
      });
      if (displacedDocument?.kind === "diff") setDiffs((currentDiffs) => {
        const next = Object.fromEntries(Object.entries(currentDiffs).filter(([key]) => key !== transition.displacedId));
        diffsRef.current = next;
        return next;
      });
    }
    return id;
  }

  async function openPreviewTab(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    openDocumentState(workbenchDocumentId({ kind: "file", path: normalized }), "preview");
    closeContextMenu();
    setMobilePane("editor");
    await onOpen(normalized);
  }

  async function openPinnedTab(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    openDocumentState(workbenchDocumentId({ kind: "file", path: normalized }), "pinned");
    closeContextMenu();
    setMobilePane("editor");
    await onOpen(normalized);
  }

  async function openDiffDocument(document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument, mode: WorkbenchDocumentOpenMode): Promise<void> {
    const id = workbenchDocumentId(document);
    openDocumentState(id, mode);
    setMobilePane("editor");
    await loadDiffDocument(document, id);
  }

  function revealWorkspacePath(path: string, contextLabel = "File"): void {
    let normalized: string;
    try {
      normalized = normalizeWorkspacePath(path);
    } catch (cause) {
      setNotice(workbenchNotice("error", `${contextLabel} cannot be revealed: ${cause instanceof Error ? cause.message : "the path is outside this workspace."}`));
      return;
    }
    if (!files.some((entry) => entry.path === normalized)) {
      setNotice(workbenchNotice("error", `${contextLabel} ${normalized.replace("/workspace/", "")} is not present in the current workspace tree. It may be deleted or absent from this loaded snapshot; the open document remains available.`));
      return;
    }
    // Revealing is navigation, never another open. In particular a diff keeps
    // its active tab and bounded buffer while the tree becomes visible.
    setFilter("");
    setMode("explorer");
    setMobilePane("navigation");
    setExpanded((current) => new Set([...current, ...workspaceRevealAncestors(normalized)]));
    setTreeFocusPath(normalized);
    setRevealedPath(normalized);
    setRevealRequest((current) => Object.freeze({ path: normalized, sequence: (current?.sequence ?? 0) + 1 }));
    setNotice(workbenchNotice("done", `Revealed ${normalized.replace("/workspace/", "")} in Explorer. The open document remains active.`));
  }

  function revealGitPath(document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument, relativePath: string): void {
    const resolution = resolveWorkspacePathFromGit(repositories, document.repositoryId, document.worktreeId, relativePath);
    if (resolution.state === "unavailable") {
      setNotice(workbenchNotice("error", `Git path ${relativePath} cannot be revealed: ${resolution.reason} The open diff remains available.`));
      return;
    }
    revealWorkspacePath(resolution.path, document.source === "history" ? "Commit path" : "Diff path");
  }

  async function loadDiffDocument(document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument, id: string): Promise<void> {
    if (diffsRef.current[id]?.loading || (diffsRef.current[id] && !diffsRef.current[id]?.error)) return;
    const loading: DiffBuffer = { document, content: "", binary: false, truncated: false, loading: true };
    setDiffBuffer(id, loading);
    if (!git) {
      setDiffBuffer(id, { ...loading, loading: false, error: "Browser Git is not connected, so this diff cannot be read." });
      return;
    }
    try {
      if (document.source === "status") {
        const request = { repositoryId: document.repositoryId, worktreeId: document.worktreeId };
        const before = await git.status(request);
        if (before.version !== document.worktreeVersion) throw new Error("This status diff belongs to an earlier worktree version. Open the path again from Source Control for the current patch.");
        const result = await git.diff({ ...request, path: document.path, scope: document.scope });
        const after = await git.status(request);
        if (after.version !== document.worktreeVersion) throw new Error("The worktree changed while this patch was being read. Open it again from Source Control.");
        setDiffBuffer(id, statusDiffBuffer(document, result));
      } else {
        const result = await git.show({ repositoryId: document.repositoryId, worktreeId: document.worktreeId, revision: document.revision });
        setDiffBuffer(id, historyDiffBuffer(document, result));
      }
    } catch (cause) {
      setDiffBuffer(id, { ...loading, loading: false, error: cause instanceof Error ? cause.message : "This diff could not be read." });
    }
  }

  function setDiffBuffer(id: string, value: DiffBuffer): void {
    // A replaced preview may finish its bounded read after it has closed. Do
    // not resurrect an orphan cache entry that no document can display.
    if (!documentsRef.current.tabs.includes(id)) return;
    setDiffs((current) => {
      const next = { ...current, [id]: value };
      diffsRef.current = next;
      return next;
    });
  }

  async function activateTab(id: string): Promise<void> {
    const document = parseWorkbenchDocumentId(id);
    if (!document) return;
    publishDocuments(activateWorkbenchDocument(documentsRef.current, id));
    setMobilePane("editor");
    if (document.kind === "file") await onOpen(document.path);
    else await loadDiffDocument(document, id);
  }

  function pinTab(id: string): void {
    publishDocuments(pinWorkbenchDocument(documentsRef.current, id));
  }

  function closeTab(id: string, discard = false): void {
    const document = parseWorkbenchDocumentId(id);
    if (!document) return;
    const filePath = document.kind === "file" ? document.path : undefined;
    const candidate = filePath ? buffersRef.current[filePath] : undefined;
    if (!discard && candidate && candidate.draft !== candidate.content) {
      openDialog("discard", filePath!);
      return;
    }
    const previousActive = documentsRef.current.activeId;
    const nextDocuments = closeWorkbenchDocument(documentsRef.current, id);
    publishDocuments(nextDocuments);
    if (filePath) setBuffers((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== filePath));
      buffersRef.current = next;
      return next;
    });
    else setDiffs((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
      diffsRef.current = next;
      return next;
    });
    if (previousActive === id) {
      if (nextDocuments.activeId) void activateTab(nextDocuments.activeId);
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
    assertMutableWorkspacePath(path);
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
    // The one chokepoint every workbench write passes through, so the witness
    // cannot miss a save that a new caller forgets to report.
    witness({ savedPath: written.path });
    return written;
  }

  async function removeWorkspaceAndGit(path: string): Promise<void> {
    assertMutableWorkspacePath(path);
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

  /**
   * One version-fenced move, workspace and Git together, with no UI side effects.
   *
   * Bindings are re-resolved per call because `expectedWorktreeVersion` moves
   * with every accepted Git write: a folder rename is N of these back to back,
   * and reusing the snapshot taken before the first one would make step two
   * fail a version fence it should have passed.
   */
  async function moveOne(source: string, target: string): Promise<WorkspaceFile> {
    // Both ends: a move out of the control plane would expose private state as
    // a user file just as surely as a move into it would corrupt Airship's own.
    assertMutableWorkspacePath(source);
    assertMutableWorkspacePath(target);
    const currentRepositories = git ? await git.listRepositories() : repositories;
    setRepositories(currentRepositories);
    const sourceBinding = resolveGitBinding(source, currentRepositories);
    const targetBinding = resolveGitBinding(target, currentRepositories);
    if ((sourceBinding || targetBinding) && (!sourceBinding || !targetBinding || targetBinding.repository.id !== sourceBinding.repository.id || targetBinding.worktree.id !== sourceBinding.worktree.id)) {
      throw new Error("Moving a repository file across repository roots is not atomic. Move it within its worktree or use Advanced source controls.");
    }
    const moved = await moveWorkspaceFile(workspace, source, target);
    try {
      if (sourceBinding && targetBinding && git) await git.moveWorkingFile({ repositoryId: sourceBinding.repository.id, worktreeId: sourceBinding.worktree.id, sourcePath: sourceBinding.relativePath, targetPath: targetBinding.relativePath, expectedWorktreeVersion: sourceBinding.worktree.version });
    } catch (cause) {
      await moveWorkspaceFile(workspace, target, source);
      throw cause;
    }
    return moved;
  }

  /** Re-points open tabs, the active tab and page drafts at moved paths. */
  function remapPaths(moves: readonly WorkspaceMove[]): void {
    if (moves.length === 0) return;
    const map = new Map(moves.map((move) => [move.source, move.target] as const));
    publishDocuments(remapWorkbenchDocuments(documentsRef.current, map));
    setBuffers((current) => {
      const next = Object.fromEntries(Object.entries(current).map(([path, value]) => {
      const target = map.get(path);
      // The draft travels with the tab; the durable revision is the new one, so
      // the next save is still compare-and-swapped against a revision that exists.
      return target ? [target, { ...value, path: target }] : [path, value];
      }));
      buffersRef.current = next;
      return next;
    });
  }

  /** Drops paths that no longer exist from the tab strip and the draft store. */
  function forgetPaths(removed: readonly string[]): void {
    if (removed.length === 0) return;
    const gone = new Set(removed);
    const previousActive = documentsRef.current.activeId;
    const nextDocuments = retainWorkbenchDocuments(
      documentsRef.current,
      new Set(documentsRef.current.tabs.filter((id) => {
        const document = parseWorkbenchDocumentId(id);
        return document?.kind === "diff" || (document?.kind === "file" && !gone.has(document.path));
      })),
    );
    publishDocuments(nextDocuments);
    setBuffers((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([path]) => !gone.has(path)));
      buffersRef.current = next;
      return next;
    });
    const previousDocument = parseWorkbenchDocumentId(previousActive);
    if (previousDocument?.kind !== "file" || !gone.has(previousDocument.path)) return;
    if (nextDocuments.activeId) void activateTab(nextDocuments.activeId);
    else setMobilePane("navigation");
  }

  /**
   * Adopt an external write into one open clean buffer.
   *
   * Triggered by the files-refresh effect when the tree lists a newer revision
   * than the editor holds. The read races the user: the guarded merge in
   * `workbenchExternalRevisionBuffer` declines the moment the buffer went dirty
   * or moved revisions on its own, because a compare-and-swapped save is the
   * fence for those — this path is only for following writes nobody here made.
   */
  async function reconcileExternalRevision(path: string, expectedRevision: string): Promise<void> {
    let file: WorkspaceFile | undefined;
    try {
      file = await workspace.read(path);
    } catch {
      // A read failure leaves the buffer exactly as it was; the next refresh
      // either retries or evicts the tab because the path vanished.
      return;
    }
    if (!file) return;
    setBuffers((current) => {
      const adopted = workbenchExternalRevisionBuffer(current[path], expectedRevision, file);
      if (!adopted) return current;
      const next = { ...current, [path]: adopted };
      buffersRef.current = next;
      return next;
    });
  }

  async function moveFile(source: string, destinationDirectory: string, nextName = workspaceBaseName(source)): Promise<void> {
    const pending = buffers[source];
    const parent = workspaceParentPath(source);
    if (destinationDirectory === parent && nextName === workspaceBaseName(source)) {
      setNotice(workbenchNotice("done", "That file is already in this folder."));
      return;
    }
    await transact("Moving file", async () => {
      // Inside the boundary: `normalizeWorkspacePath` throws on a name this
      // workspace cannot address, and outside `transact` that throw had no
      // reporter at all — the dialog simply closed and nothing moved.
      const target = normalizeWorkspacePath(`${destinationDirectory}/${nextName}`);
      const moved = await moveOne(source, target);
      publishDocuments(remapWorkbenchDocuments(documentsRef.current, new Map([[source, target]])));
      setBuffers((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([path]) => path !== source));
        next[target] = { ...moved, draft: pending?.draft ?? moved.content, truncated: pending?.truncated ?? false, binary: pending?.binary ?? isWorkspaceBinaryEnvelope(moved.content) };
        buffersRef.current = next;
        return next;
      });
      await refreshAll(target);
      setNotice(workbenchNotice("done", `Moved to ${target.replace("/workspace/", "")}.${pending && pending.draft !== pending.content ? " Unsaved edits moved with the tab." : ""}`));
    });
  }

  /**
   * Creates a folder by creating the one file that makes it exist.
   *
   * There is no `mkdir` on `WorkspacePort` and there is no directory object in
   * the tree — `buildWorkspaceTree` derives folders from file paths. The dialog
   * states this before the write, and the completion notice names the file that
   * was written, so nothing here implies a capability the storage lacks.
   */
  async function createFolder(parent: string, name: string): Promise<void> {
    const folder = normalizeWorkspacePath(`${parent}/${name}`);
    const placeholder = `${folder}/${WORKSPACE_FOLDER_PLACEHOLDER}`;
    await transact("Creating folder", async () => {
      await writeWorkspaceAndGit(placeholder, "", null);
      setExpanded((current) => new Set([...current, folder]));
      await refreshAll();
      setNotice(workbenchNotice("done", `Created ${folder.replace("/workspace/", "")}/ holding an empty ${WORKSPACE_FOLDER_PLACEHOLDER}.`));
    });
  }

  /**
   * Runs a folder operation as the sequence of file operations it really is.
   *
   * Each step is individually compare-and-swapped, so stopping half way is a
   * genuine partial outcome, not a clean failure. The loop stops at the first
   * rejection, settles the UI against the steps that *did* run, and reports the
   * split — "Renamed 9 of 14 files … then stopped" — because "failed safely"
   * becomes a false statement the moment step one succeeds.
   */
  async function runFolderPlan<Step>(input: Readonly<{
    label: string;
    verb: "Renamed" | "Deleted";
    target: string;
    steps: readonly Step[];
    run(step: Step): Promise<void>;
    settle(done: readonly Step[]): void;
  }>): Promise<void> {
    await transact(input.label, async () => {
      const done: Step[] = [];
      let failure: string | undefined;
      for (const step of input.steps) {
        try {
          await input.run(step);
          done.push(step);
        } catch (cause) {
          failure = cause instanceof Error ? cause.message : "The operation was rejected.";
          break;
        }
      }
      input.settle(done);
      await refreshAll();
      const report = folderOperationReport({ verb: input.verb, done: done.length, total: input.steps.length, target: input.target, failure });
      if (failure) throw new Error(report);
      setNotice(workbenchNotice("done", report));
    });
  }

  async function renameFolder(folder: string, nextName: string): Promise<void> {
    const target = normalizeWorkspacePath(`${workspaceParentPath(folder)}/${nextName}`);
    if (target === folder) {
      setNotice(workbenchNotice("done", "That folder already has this name."));
      return;
    }
    await runFolderPlan<WorkspaceMove>({
      label: "Renaming folder",
      verb: "Renamed",
      target: target.replace("/workspace/", ""),
      steps: workspaceFolderRenamePlan(files, folder, nextName),
      run: async (step) => { await moveOne(step.source, step.target); },
      settle: (done) => {
        remapPaths(done);
        // Without this the folder the user just renamed would collapse, and
        // the tree would look as though the files had gone somewhere else.
        setExpanded((current) => new Set([...current].map((path) => path === folder || path.startsWith(`${folder}/`) ? `${target}${path.slice(folder.length)}` : path).concat(target)));
      },
    });
  }

  /** Deletes a folder as the revision-checked removal of every file under it. */
  async function deleteFolder(folder: string): Promise<void> {
    await runFolderPlan<WorkspaceEntry>({
      label: "Deleting folder",
      verb: "Deleted",
      target: folder.replace("/workspace/", ""),
      steps: workspaceFilesUnder(files, folder),
      run: (entry) => removeWorkspaceAndGit(entry.path),
      settle: (done) => forgetPaths(done.map((entry) => entry.path)),
    });
  }

  async function runDialog(): Promise<void> {
    if (!dialog) return;
    if (dialog.kind === "create") {
      if (workspacePathError(dialogValue)) return;
      await transact("Creating file", async () => {
        const target = normalizeWorkspacePath(`${dialog.path}/${dialogValue.trim()}`);
        await writeWorkspaceAndGit(target, "", null);
        await refreshAll(target);
        setNotice(workbenchNotice("done", `Created ${target.replace("/workspace/", "")}.`));
      });
    } else if (dialog.kind === "create-folder") {
      if (workspaceNameError(dialogValue)) return;
      await createFolder(dialog.path, dialogValue.trim());
    } else if (dialog.kind === "rename-folder") {
      if (workspaceNameError(dialogValue)) return;
      await renameFolder(dialog.path, dialogValue.trim());
    } else if (dialog.kind === "delete-folder") {
      await deleteFolder(dialog.path);
    } else if (dialog.kind === "rename") {
      if (workspaceNameError(dialogValue)) return;
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

  /** Takes one file out of the browser, whole. */
  async function downloadFile(path: string): Promise<void> {
    closeContextMenu();
    const name = workspaceBaseName(path);
    try {
      const payload = await workspaceDownloadPayload(workspace, path);
      downloadBytes(payload.bytes, payload.filename);
      setNotice(workbenchNotice("done", `Downloaded ${name} — the complete stored bytes at revision ${payload.revision.slice(0, 7)}.`));
    } catch (cause) {
      setNotice(workbenchNotice("error", `${name} could not be downloaded: ${cause instanceof Error ? cause.message : "the workspace refused the read."}`));
    }
  }

  async function refreshAll(open?: string): Promise<void> {
    await onWorkspaceChanged();
    const binding = open ? await gitBinding(open) : undefined;
    await refreshSourceControl(binding?.repository.id ?? repositoryId, binding?.worktree.id ?? worktree?.id);
    if (open) await openPreviewTab(open);
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
    // The backstop, not the gate a person sees: the rail's own verbs are
    // disabled while `busy`, because a dropped request that says nothing is
    // indistinguishable from a control that did not work.
    if (!git || !review || busy) return;
    const decision = await review(operation, describeGitOperation(operation));
    if (decision !== "allow") { setNotice(workbenchNotice("done", "Source-control operation denied; nothing changed.")); return; }
    await transact("Updating source control", async () => {
      // The clear is a consequence of the adapter *accepting* the commit, never
      // of the click: a throw propagates out of `runSourceMutation` and the
      // typed message survives, which is the user's only copy of it.
      if (await runSourceMutation(git, operation)) {
        // Recorded on acceptance for the same reason, and by subject rather
        // than by oid: after the reload the oid names nothing, and the subject
        // is what the person typed and will look for.
        if (operation.kind === "commit") witness({ commit: commitSubject(operation.request.message) });
        setCommitMessage("");
      }
      // A restore rewrites workspace bytes, which staging and committing never
      // do — so the tree, the open buffer and the byte counts beside them are
      // stale the instant it lands. Refreshing only Source Control would leave
      // the Editor showing the text the user just threw away.
      if (operation.kind === "restore") await onWorkspaceChanged();
      await refreshSourceControl();
      if (operation.kind === "restore") {
        setNotice(workbenchNotice("done", `Discarded worktree changes in ${operation.request.paths.map((path) => path.replace("/workspace/", "")).join(", ")}. ${operation.request.source === "head" ? "The file is back at HEAD." : "The file is back at the staged copy."}`));
      }
    });
  }

  function openDialog(kind: Dialog["kind"], path: string): void {
    setContext(undefined);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // A context-menu item unmounts with its menu, so "return focus to whatever
    // opened this" would return it to a detached node and the keyboard would
    // land on `<body>`. Measured doing exactly that: after Escape, the active
    // element was the document. Fall back to the tree row the menu came from.
    dialogOpener.current = active?.closest(".workbench-context")
      ? treeRowElement(visible.findIndex((node) => node.path === path)) ?? undefined
      : active;
    setDialog({ kind, path });
    setDialogValue(kind === "rename" || kind === "rename-folder" ? workspaceBaseName(path) : kind === "move" ? workspaceParentPath(path) : "");
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

  /** Opens the row menu and records the exact control focus must return to. */
  function openContextMenu(path: string, x: number, y: number, opener?: HTMLElement | null): void {
    contextOpener.current = opener ?? undefined;
    setContext(clampedContext(path, x, y));
  }

  /** The menu's items, in the order the keyboard walks them. */
  function contextItems(): readonly HTMLElement[] {
    return contextBox.current ? [...contextBox.current.querySelectorAll<HTMLElement>("[role=\"menuitem\"]")] : [];
  }

  /** Moves the roving tabindex with focus, so Tab never lands mid-menu. */
  function focusContextItem(index: number): void {
    const items = contextItems();
    const target = items[index];
    if (!target) return;
    for (const [position, item] of items.entries()) item.tabIndex = position === index ? 0 : -1;
    target.focus();
  }

  function handleContextKey(event: KeyboardEvent): void {
    const items = contextItems();
    const current = items.findIndex((item) => item === event.target);
    const next = workbenchMenuFocusIndex(items.length, current, event.key);
    if (next === undefined) return;
    event.preventDefault();
    focusContextItem(next);
  }

  /** The Move dialog's destination folders, in the order the keyboard walks them. */
  function moveTargetItems(): readonly HTMLElement[] {
    return dialogBox.current ? [...dialogBox.current.querySelectorAll<HTMLElement>(".move-targets [role=\"option\"]")] : [];
  }

  function handleMoveTargetKey(event: KeyboardEvent): void {
    if (dialog?.kind !== "move") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = moveTargetItems();
    const current = items.findIndex((item) => item === event.target);
    if (current < 0) return;
    const parent = workspaceParentPath(dialog.path);
    const next = moveMenuSelection(current, event.key, directories.map((directory) => ({ disabled: parent === directory.path })));
    const directory = directories[next];
    if (!directory) return;
    /*
     * Selection follows focus in this listbox. Every option is one toggle of
     * the single fact the dialog asks for, so an arrow is already the choice
     * and there is no focused-but-unselected state a screen reader could land
     * on without hearing; Enter and Space keep their native button behaviour
     * on whichever option holds the roving stop, and every other key — Escape
     * and Tab included — still belongs to the dialog.
     */
    event.preventDefault();
    setDialogValue(directory.path);
    items[next]?.focus();
  }

  /**
   * Returns the keyboard to the row the menu was opened from.
   *
   * A menu item unmounts with its menu, so "focus whatever opened this" is only
   * safe while that element is still connected — a virtualized row can be gone.
   * The tree row for the same path is the honest fallback, and it is where a
   * keyboard user was standing before Shift+F10.
   */
  function restoreContextFocus(): void {
    const opener = contextOpener.current;
    const path = context?.path;
    contextOpener.current = undefined;
    // No menu was open, so there is no focus to give back and nothing this may
    // steal from — every other caller of `setContext(undefined)` is a no-op.
    if (path === undefined) return;
    if (opener?.isConnected) { opener.focus(); return; }
    treeRowElement(visible.findIndex((node) => node.path === path))?.focus();
  }

  /** Dismisses the row menu and hands the keyboard back to its opener. */
  function closeContextMenu(): void {
    restoreContextFocus();
    setContext(undefined);
  }

  /**
   * The one way out of a filter, wherever it is offered.
   *
   * An already-empty filter focuses immediately rather than queueing: setting
   * state to the value it already holds need not re-render, and a queued
   * request that nothing re-renders to spend is a request that never runs.
   * Escape on an empty Path filter used to move the keyboard to row 0 and had
   * silently stopped doing anything at all.
   */
  function clearFilter(): void {
    if (!filter) {
      focusTreeIndex(0);
      return;
    }
    setFilter("");
    pendingTreeFocus.current = true;
  }

  function focusTreeIndex(index: number): void {
    if (!rows.length) return;
    const bounded = Math.max(0, Math.min(index, rows.length - 1));
    const row = rows[bounded]!;
    setTreeFocusPath(row.id);
    const viewport = treeViewport.current;
    if (viewport) {
      const top = bounded * rowHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowHeight - viewport.clientHeight;
    }
    requestAnimationFrame(() => treeRowElement(bounded)?.focus());
  }

  /*
   * One keyboard path over both row kinds.
   *
   * `id` rather than `path`, because a text hit and the file that holds it
   * share a path and only the id distinguishes them. A hit answers the same
   * verbs its file does — Enter opens the file, Ctrl+Enter opens the file's
   * menu, ArrowLeft climbs to the file — so nothing in the tree's contract
   * needs a second spelling for the deeper row.
   */
  function handleTreeKey(event: KeyboardEvent, id: string): void {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const row = rows[index]!;
    const node = row.node;
    if (event.key === "ArrowDown") { event.preventDefault(); focusTreeIndex(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusTreeIndex(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusTreeIndex(0); }
    else if (event.key === "End") { event.preventDefault(); focusTreeIndex(rows.length - 1); }
    else if (event.key === "ArrowRight" && node?.kind === "directory") {
      event.preventDefault();
      if (!node.expanded) toggleDirectory(node.path); else focusTreeIndex(index + 1);
    } else if (event.key === "ArrowRight" && !node && index + 1 < rows.length) {
      // A hit already shows everything it has; the only place right can go is
      // the next hit in the same file, and it stops at that file's last one.
      event.preventDefault();
      if (rows[index + 1]?.node === undefined) focusTreeIndex(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node?.kind === "directory" && node.expanded) toggleDirectory(node.path);
      else {
        // A hit's parent is its own file; a node's parent is its folder.
        const parent = node ? workspaceParentPath(node.path) : row.path;
        const parentIndex = rows.findIndex((candidate) => candidate.node !== undefined && candidate.path === parent);
        if (parentIndex >= 0) focusTreeIndex(parentIndex);
      }
    } else if (workspaceRowMenuKey(event)) {
      // Ahead of the Enter branches on purpose: Control+Enter is a menu key
      // here, not a second way to open the file.
      event.preventDefault();
      const element = treeRowElement(index);
      const bounds = element?.getBoundingClientRect();
      openContextMenu(row.path, bounds?.left ?? 24, bounds?.bottom ?? 48, element);
    } else if (event.key === "Enter" && event.shiftKey && node?.kind !== "directory") {
      event.preventDefault();
      void openPinnedTab(row.path);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node?.kind === "directory") toggleDirectory(node.path); else void openPreviewTab(row.path);
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

  /*
   * What the rail says while and after the bounded half of the search runs.
   *
   * The path half has already answered by the time a keystroke settles, so the
   * tree is only yielded when *neither* half found anything — and "nothing yet"
   * is never allowed to read as "nothing": while the scan is still out, the
   * rail says it is reading rather than that the query matched no file.
   *
   * A rejection settles the rail too. Keyed on a result alone, a scan that
   * threw left `scanning` true forever — the tree hidden behind "Searching file
   * contents…" with nothing reading — so `scanFailed` is the second way this
   * query can be finished with.
   */
  const scanSettled = Boolean(query) && !searching && (search !== undefined || scanFailed);
  const scanning = Boolean(query) && !scanSettled;
  const emptyFilterCopy = query && rows.length === 0 && scanSettled
    ? workspaceFilterEmptyCopy(filter, filtered.total, search)
    : undefined;
  const treeHidden = rows.length === 0 && (scanning || emptyFilterCopy !== undefined);

  return (
    <section class="work-view workspace-workbench">
      {/*
        The sentence the route owed the person who committed here.

        Measured: commit, reload, and History is back to a freshly-seeded
        "Initial browser workspace" under a new hash with nothing said. It is a
        row in the grid, above the panes and before the tab strip, because a
        loss is the first thing to read on arrival — not a toast that expires
        while the reader is still looking for the commit. `role="alert"`: this
        is not the status of an action the reader just took.
      */}
      {lostWorkMessage ? <div class="notice workbench-lost-work" data-state="attention" role="alert">
        <StatusMark state="attention" density="dot" size={16} label="Work did not survive the reload" />
        <p>{lostWorkMessage}</p>
        <button type="button" onClick={() => {
          dismissWorkspaceLoss(browserSessionStorage(), witnessScope);
          setLostWork(undefined);
        }}>Dismiss</button>
      </div> : null}
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
          // "Explorer", not "Files": this is the same control as the desktop
          // strip's first tab, and one control that answers to two names is a
          // control the reader has to learn twice.
          { id: "explorer", label: "Explorer" },
          { id: "editor", label: "Editor", count: tabs.length || undefined, countLabel: `${String(tabs.length)} open documents`, disabled: tabs.length === 0 },
          { id: "source", label: "Source Control", count: changeCount, countLabel: `${String(changeCount)} changes` },
        ]}
        activeId={mobilePane === "editor" ? "editor" : mode}
        onSelect={selectPane}
        panelId={(id) => id === "editor" ? editorPanelId : activityPanelId}
      />
      <div class="workbench-shell" ref={shell} style={{ "--workbench-rail": `${String(rail)}%` }}>
        <aside class={`workbench-activity ${mobilePane === "navigation" ? "mobile-active" : ""}`} aria-label="Workspace activity">
          {/*
            Two tabs that read as tabs. The leading glyphs are the ones each
            destination already owns in `icons.tsx` — the same folder the
            Workspace rail item carries and the same branch mark Source Control
            carries — so the strip states what it switches between before its
            labels are read. The count stays `.tabs__count` text: "a count
            travels with its label as text; a filled badge outranks the word".
          */}
          <Tabs
            class="workbench-mode-tabs"
            label="Workspace activity view"
            items={[
              { id: "explorer", label: "Explorer", leading: <Icon name="workspace" size={15} /> },
              { id: "source", label: "Source Control", leading: <Icon name="source" size={15} />, count: changeCount, countLabel: `${String(changeCount)} changes` },
            ]}
            activeId={mode}
            onSelect={(id) => setMode(id === "source" ? "source" : "explorer")}
            panelId={() => activityPanelId}
          />
          {/*
            The switched region is a wrapper inside the landmark, never the
            landmark itself: `role="tabpanel"` on `<aside>`/`<main>` would
            delete the complementary and main landmarks this route depends on.
          */}
          <div class="workbench-panel" id={activityPanelId} role="tabpanel" aria-labelledby={activityPanelTitleId}>
          <h2 class="sr-only" id={activityPanelTitleId}>{mode === "source" ? "Source Control" : "Explorer"}</h2>
          {mode === "explorer" ? <>
            {/*
              One field, above the tree, where it already was — the one thing
              about this rail the owner asked us to keep. What it lost is the
              44px segmented control under it that made the reader choose
              between searching paths and searching text before typing a
              character. It now does both.
            */}
            {/*
              One control row, the way Source Control's own row was rebuilt.
              Creation used to be two full-word bordered buttons on a line of
              their own, below a file count on a line of its own: 56px of chrome
              between the search field and the first file, measured at 1440x900,
              where VS Code has none. Both verbs are icon controls on the search
              field's row now — named for assistive technology and on hover, and
              still reachable as `New file…` / `New folder…` from every row's
              context menu, which is where a folder-scoped create has always
              lived.
            */}
            <div class="workbench-section-heading">
              <input
                class="workspace-filter"
                ref={filterField}
                type="search"
                value={filter}
                aria-label="Search workspace files by path and contents"
                placeholder="Search files"
                onInput={(event) => setFilter(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  clearFilter();
                }}
              />
              <button class="workspace-new" type="button" aria-label="New file" title="New file in this workspace" onClick={() => openDialog("create", "/workspace")}>
                <CreationGlyph name="file" />
              </button>
              <button class="workspace-new" type="button" aria-label="New folder" title="New folder in this workspace" onClick={() => openDialog("create-folder", "/workspace")}>
                <CreationGlyph name="workspace" />
              </button>
            </div>
            {/* A filtered tree must never be mistakable for an empty workspace,
                and a bounded scan must never read as an exhaustive one. One
                field now asks two questions, so one sentence answers both: how
                much of the tree is left, and — verbatim from
                `workspaceSearchSummary`, the sentence the model's own
                `search_text` gets — what the scan did and did not reach.
                `truncated`, `unsearchedFiles` and `capReachedIn` ride in that
                sentence, and a path match must never make a bounded scan look
                exhaustive by standing in front of it.

                At rest it says nothing: an unfiltered tree states its own
                contents, and the count was the second of the two lines standing
                between the search field and the first file. It is emptied
                rather than unmounted, and hidden by `:empty` — a `role="status"`
                that appears already carrying its text is a live region most
                screen readers never announce, so the region has to outlive the
                query that fills it. */}
            <p class="workspace-filter-count" role="status">
              {query
                ? `${String(searchMatches.length)} of ${String(filtered.total)} files · ${scanning ? "reading contents…" : search ? workspaceSearchSummary(search) : "file contents could not be read"}`
                : ""}
            </p>
            {/* `hidden`, not unmounted: the tree owns the scroll box the
                virtualization window is measured from, and remounting it on
                every empty filter would strand the ResizeObserver on a detached
                node and reset the reader's place in a 40,000-row tree. */}
            <div ref={treeViewport} class="workspace-tree" hidden={treeHidden} role="tree" aria-label="Workspace files" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHoverExpansion(); }}>
              {/* Presentational, all three of them: a `role="tree"` owns
                  `role="treeitem"` children, and the virtualization scaffolding
                  put two generic boxes and a row wrapper in between. */}
              <div role="presentation" style={{ height: rows.length * rowHeight, position: "relative" }}><div role="presentation" style={{ position: "absolute", top: rowWindow.start * rowHeight, left: 0, right: 0 }}>
                {rows.slice(rowWindow.start, rowWindow.end).map((row, offset) => {
                  // The absolute row index, not the window offset: every id and
                  // every position below has to be stated in the coordinates of
                  // the whole tree, because the window is a rendering detail no
                  // assistive technology can see.
                  const index = rowWindow.start + offset;
                  const actionId = `${rowActionBaseId}-${String(index)}`;
                  const nameId = `${rowLabelBaseId}-${String(index)}`;
                  const sizeId = `${nameId}-size`;
                  const node = row.node;
                  /*
                    A text hit, drawn as the tree row it is. It has no `•••`:
                    every verb the menu offers acts on the *file*, and the file
                    is the row directly above this one, where the menu already
                    is. Enter, click and Shift+Enter still open the file, so the
                    hit is never a dead end.
                  */
                  if (!node) return <div class="tree-row-wrap" role="presentation" style={{ height: rowHeight }} key={row.id}>
                    <button
                      class="tree-row tree-row--hit"
                      type="button" role="treeitem"
                      aria-level={row.depth}
                      aria-selected={false}
                      aria-posinset={index + 1}
                      aria-setsize={rows.length}
                      /* The name is capped where the snippet is not: a scan
                         keeps 240 characters around a hit, and a screen reader
                         reading all of them for each of fifty rows is a worse
                         answer than the first line of one. The `title` keeps
                         the whole snippet, and the column is in it because two
                         hits on one line are otherwise indistinguishable. */
                      aria-label={`Line ${String(row.match?.line ?? 0)} in ${workspaceBaseName(row.path)}: ${workspaceHitLabel(row.match?.snippet ?? "")}`}
                      title={`${row.path}:${String(row.match?.line ?? 0)}:${String(row.match?.column ?? 0)} — ${(row.match?.snippet ?? "").trim()}`}
                      data-workspace-tree-index={index}
                      tabIndex={treeFocusPath === row.id ? 0 : -1}
                      onFocus={() => setTreeFocusPath(row.id)}
                      onKeyDown={(event) => handleTreeKey(event, row.id)}
                      style={{ height: rowHeight, paddingLeft: `${String(7 + Math.max(0, row.depth - 1) * 15)}px` }}
                      onClick={() => void openPreviewTab(row.path)}
                    >
                      {/* Three columns, not four: a hit has no icon of its own
                          — the file above it carries the one that matters —
                          and `.tree-row--hit` restates the template so the
                          snippet lands in the same `span:nth-of-type(2)` the
                          filename does, which is where the tree's truncation
                          rule lives. Written as four children with an empty
                          spacer, the snippet was the third span, missed that
                          rule, and wrapped nine lines deep inside a 28px row. */}
                      <span class="tree-chevron" aria-hidden="true" />
                      <span>{(row.match?.snippet ?? "").trim()}</span>
                      <small>line {String(row.match?.line ?? 0)}</small>
                    </button>
                  </div>;
                  return <div class="tree-row-wrap" role="presentation" style={{ height: rowHeight }} key={row.id}>
                  {/* `aria-posinset`/`aria-setsize` are the window's restatement
                      of the truth virtualization deleted: without them every
                      row reports its position within the ~24 rendered rows, so
                      row 3,891 of 40,000 announces as "1 of 24".
                      `aria-owns` adopts the `•••` button that sits beside this
                      row in the DOM: with the wrappers presentational it would
                      otherwise be a `role="button"` owned directly by
                      `role="tree"`, which owns treeitems and groups and nothing
                      else. Adoption, not `aria-hidden`, because that button is
                      the only way a touch screen-reader user reaches Rename,
                      Move, Delete or Download — hiding it would trade a
                      structural violation for a lost capability.
                      `aria-labelledby` is the price of that adoption. `treeitem`
                      takes its name from content, and accname walks *owned*
                      children too, so the bare adoption made every row announce
                      its own name twice — "README.md 1.2 KB Actions for
                      README.md". Pointing the name at the row's own two spans
                      says what the row is exactly once, and drops the `›`/`⌄`
                      glyph that `aria-expanded` already carries. */}
                  <button
                    aria-owns={actionId}
                    aria-labelledby={node.entry ? `${nameId} ${sizeId}` : nameId}
                    class={`tree-row ${treeSelectedPath === node.path ? "active" : ""} ${dropTarget === (node.kind === "directory" ? node.path : workspaceParentPath(node.path)) ? "drop-target" : ""}`}
                    type="button" role="treeitem" aria-level={node.depth} aria-expanded={node.kind === "directory" ? Boolean(node.expanded) : undefined}
                    aria-selected={treeSelectedPath === node.path}
                    aria-posinset={index + 1}
                    aria-setsize={rows.length}
                    aria-keyshortcuts={node.kind === "file" ? "Enter Shift+Enter Control+Enter Shift+F10" : "Control+Enter Shift+F10"}
                    title={node.kind === "file" ? `${node.path} · Enter/click previews · Shift+Enter/double-click keeps open · Ctrl+Enter opens actions` : `${node.path} · Ctrl+Enter opens actions`}
                    data-workspace-tree-index={index}
                    tabIndex={treeFocusPath === node.path || (!treeFocusPath && index === 0) ? 0 : -1}
                    onFocus={() => setTreeFocusPath(node.path)}
                    onKeyDown={(event) => handleTreeKey(event, node.path)}
                    style={{ height: rowHeight, paddingLeft: `${String(7 + Math.max(0, node.depth - 1) * 15)}px` }}
                    draggable={node.kind === "file"}
                    onDragStart={(event) => { if (node.kind === "file") { event.dataTransfer?.setData("text/x-airship-workspace-path", node.path); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; } }}
                    onDragEnd={clearHoverExpansion}
                    onDragEnter={() => scheduleHoverExpansion(node.kind === "directory" ? node.path : workspaceParentPath(node.path))}
                    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer?.getData("text/x-airship-workspace-path"); const destination = node.kind === "directory" ? node.path : workspaceParentPath(node.path); clearHoverExpansion(); if (source) void moveFile(source, destination); }}
                    onContextMenu={(event) => { event.preventDefault(); openContextMenu(node.path, event.clientX, event.clientY, event.currentTarget); }}
                    onClick={() => node.kind === "directory" ? toggleDirectory(node.path) : void openPreviewTab(node.path)}
                    onDblClick={() => { if (node.kind === "file") void openPinnedTab(node.path); }}
                  ><span class="tree-chevron">{node.kind === "directory" ? node.expanded ? "⌄" : "›" : ""}</span>{node.kind === "directory" ? <Icon name="workspace" size={15} /> : <WorkspaceFileIcon path={node.path} />}<span id={nameId}>{node.name}{/* The folder the flattened result came from. It rides inside the
                        name cell, not beside it, because the cell's own
                        `nth-of-type(2)` rule is what truncates a long row —
                        stated as a sibling it would escape that rule and push
                        the byte size off the rail. */}
                    {query ? workspaceSearchFolder(node.path) && <small class="tree-row__dir">{workspaceSearchFolder(node.path)}</small> : null}</span>{node.entry ? <small id={sizeId}>{row.hits ? `${String(row.hits)} in text · ` : ""}{formatBytes(workspaceEntryByteLength(node.entry))}</small> : null}</button>
                  {/* Not in the tab order: the tree's contract is that Tab
                      leaves it in one press, and the same menu is on the row
                      itself via ContextMenu, Shift+F10 and — for the Macs where
                      neither of those keys exists — Ctrl+Enter. It keeps its
                      name and its pointer/touch reachability, and the row above
                      `aria-owns` it so the tree still owns treeitems only. */}
                  <button id={actionId} class="tree-overflow" type="button" tabIndex={-1} aria-label={`Actions for ${node.name}`} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); openContextMenu(node.path, box.right, box.bottom, event.currentTarget); }}>•••</button>
                </div>;
                })}
              </div></div>
            </div>
            {/* Only reached when the path half found nothing either: while the
                scan is out and the tree has rows, those rows are the answer and
                this never draws. */}
            {rows.length === 0 && scanning ? <div class="workbench-empty" role="status">
              <Icon name="workspace" size={28} />
              <strong>Searching file contents…</strong>
              <span>Reading bounded UTF-8 text from this workspace. Binary and oversized files are skipped.</span>
            </div> : null}
            {/*
              `.workbench-empty` and not the shared `.empty-state` recipe: this
              is the same layout the editor pane on this route already draws,
              and it flex-fills rather than reserving 330px — what a 15%-wide
              rail on a short viewport can afford. The distinct layout is a
              measured space decision rather than a second component API.
            */}
            {emptyFilterCopy ? <div class="workbench-empty">
              <Icon name="workspace" size={28} />
              <strong>{emptyFilterCopy.title}</strong>
              <span>{emptyFilterCopy.detail}</span>
              {/* One action, because there is no longer a second search to
                  offer: both have already run against this term. */}
              <div class="workbench-empty__actions">
                <button class="primary" type="button" onClick={clearFilter}>{emptyFilterCopy.action}</button>
              </div>
            </div> : null}
          </> : <SourceControlRail
            repositories={repositories}
            repositoryId={repositoryId}
            selectRepository={(id) => { const target = repositories.find((item) => item.id === id)?.worktrees[0]; void refreshSourceControl(id, target?.id); }}
            worktree={worktree}
            selectWorktree={(id) => void refreshSourceControl(repositoryId, id)}
            history={history}
            historyMessage={historyMessage}
            upstream={upstream}
            loading={scmLoading}
            busy={busy}
            refresh={() => void refreshSourceControl(repositoryId, worktree?.id)}
            openDiff={(document, openMode) => void openDiffDocument(document, openMode)}
            mutate={mutateSource}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            onOpenRepositoryManager={onOpenRepositoryManager}
          />}
          </div>
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
        <main class={`workbench-editor ${mobilePane === "editor" ? "mobile-active" : ""}`} aria-label="Document editor">
          <Tabs
            class="editor-tabs"
            variant="document"
            label="Open documents"
            overflowHeading="Open documents"
            items={documentTabs}
            activeId={activeId}
            onSelect={(id) => void activateTab(id)}
            panelId={() => editorPanelId}
          />
          <div class="workbench-panel" id={editorPanelId} role="tabpanel" aria-labelledby={editorPanelTitleId}>
          <h2 class="sr-only" id={editorPanelTitleId}>Open document</h2>
          {activeDocument?.kind === "diff" ? <DiffDocumentEditor
            document={activeDocument}
            buffer={diffBuffer}
            preview={previewId === activeId}
            wrap={wrap}
            pin={() => pinTab(activeId)}
            toggleWrap={() => setWrap((current) => !current)}
            reveal={(path) => revealGitPath(activeDocument, path)}
          /> : buffer && verdict ? <>
            {buffer.binary ? <div class="workspace-binary-preview" role="status"><WorkspaceFileIcon path={buffer.path} /><strong>Binary file · read-only</strong><span>Airship preserves the original bytes for Git and browser execution. The internal storage envelope is never exposed as editable text.</span></div> : <>
              {buffer.truncated ? <div class="workspace-boundary attention" role="status">{buffer.content ? "Bounded preview only." : "Encrypted file not downloaded."} Files above {formatBytes(WORKSPACE_EDITOR_BYTE_LIMIT)} are read-only; full-object AES-GCM verification is never mislabeled as a range stream.</div> : null}
              {/* The gutter is presentational and scroll-synced from the
                  textarea, so the editable surface remains one real control. */}
              <div class="code-editor-frame" data-code-theme={codeTheme.codeThemeId} style={codeThemeCssVariables(codeTheme)}>
                {gutterLines ? <div
                  class="code-gutter"
                  ref={gutter}
                  aria-hidden="true"
                  data-wrap={wrap ? "on" : "off"}
                >{wrap ? wrappedGutter ? <div class="code-gutter__lines" style={{ height: wrappedGutter[1] }}>
                  {wrappedGutter[0].map((top, index) => <span class="code-gutter__line" style={{ top }}>{index + 1}</span>)}
                </div> : null : gutterLines}</div> : null}
                <div class="code-surface">
                  {wrap ? <pre class="code-wrap-measure" data-wrap="on" aria-hidden="true" ref={wrapMeasure}>{buffer.draft.endsWith("\n") ? `${buffer.draft} ` : buffer.draft || " "}</pre> : null}
                  <CodeHighlightLayer text={buffer.draft} path={buffer.path} wrap={wrap} layer={highlightLayer} />
                  <textarea
                    class="code-editor"
                    ref={editorArea}
                    data-wrap={wrap ? "on" : "off"}
                    aria-label={`Edit ${workspaceBaseName(buffer.path)}`}
                    value={buffer.draft}
                    readOnly={buffer.truncated}
                    spellcheck={false}
                    onScroll={(event) => syncCodeScroll(event.currentTarget)}
                    onInput={(event) => {
                      // The first edit promotes a replaceable preview before its
                      // draft changes, so a subsequent file activation cannot
                      // evict unsaved work.
                      pinTab(buffer.path);
                      setBuffers((current) => {
                        const next = { ...current, [buffer.path]: { ...buffer, draft: event.currentTarget.value } };
                        buffersRef.current = next;
                        return next;
                      });
                    }}
                    onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveActive(); } }}
                  />
                </div>
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
              <StatusMark class="editor-strip__verdict" state={verdict.state} density="chip" label={verdict.word} detail={verdict.detail} />
              <span class="editor-strip__path" title={buffer.path}>{buffer.path.replace("/workspace/", "")}</span>
              <span class="editor-strip__meta">
                <span title={`Revision ${buffer.revision} — every save is compare-and-swapped against this exact revision.`}>rev {buffer.revision.slice(0, 7)}</span>
                {/* The file's own bytes, not the storage envelope: a binary
                    buffer's `size` is its base64 encoding and read one third
                    larger here than `read_file` reported for the same path. */}
                <span>{formatBytes(workspaceEntryByteLength(buffer))}</span>
                {/*
                  `.code-editor` was `white-space: pre` at every width, so on a
                  390px pane a markdown paragraph was reachable only by
                  horizontal scrolling one line at a time. Wrap is a real
                  control now, enabled by default and persisted with the tabs;
                  line numbers stay attached to logical lines when text wraps.
                */}
                <span>{editorSurfaceNote({ wrap, binary: buffer.binary, gutter: Boolean(gutterLines) })}</span>
              </span>
              {/* One group so the strip's two controls stay together when it
                  wraps: a Save button on a line of its own reads as belonging
                  to whatever ends up beside it. */}
              <span class="editor-strip__controls">
              {/*
                The editor theme lives here, beside Wrap, because both are
                answers to "how do I want to read this file" and neither is a
                property of the file. There is no Save beside it: `onChange`
                writes the profile catalog, which is what "saved with the
                agent, auto-saved on change" has to mean if switching profiles
                is to switch the sheet back.
              */}
              {changeCodeTheme ? <MenuSelect
                className="editor-strip__theme"
                ariaLabel="Editor theme"
                value={codeTheme.codeThemeId}
                options={CODE_THEME_OPTIONS}
                onChange={changeCodeTheme}
                leading={(option) => <span
                  class="editor-strip__theme-swatch"
                  aria-hidden="true"
                  style={codeThemeCssVariables(resolveCodeTheme(option.value))}
                />}
              /> : null}
              {/*
                Three words became a glyph. This strip is the file's status bar
                — VS Code's carries short states and icons, never a sentence —
                and "Reveal in Explorer" was its widest control by some way. The
                accessible name is unchanged, so every keyboard and
                screen-reader path to it, and the e2e that drives it by name,
                still find the same button.
              */}
              <button
                class="editor-strip__reveal"
                type="button"
                aria-label="Reveal in Explorer"
                title="Show this exact path in Explorer without closing the editor"
                onClick={() => revealWorkspacePath(buffer.path)}
              ><Icon name="workspace" size={15} /></button>
              {previewId === workbenchDocumentId({ kind: "file", path: buffer.path }) ? (
                <button
                  class="editor-strip__pin"
                  type="button"
                  title="Keep this preview open when another file is selected"
                  onClick={() => pinTab(buffer.path)}
                >Keep open</button>
              ) : null}
              <button
                class="editor-strip__wrap"
                type="button"
                aria-pressed={wrap}
                title="Soft-wrap long lines while keeping file line numbers aligned"
                onClick={() => setWrap((current) => !current)}
              >Wrap</button>
              <span class="editor-strip__save">
                <button class="primary" type="button" title="Save this file — ⌘S or Ctrl+S" disabled={!dirty || busy || buffer.truncated || buffer.binary} onClick={() => void saveActive()}>Save</button>
                <kbd aria-hidden="true">⌘S</kbd>
              </span>
              </span>
            </div>
          </> : <div class="workbench-empty">
            <Icon name="workspace" size={36} />
            <strong>{files.length === 0 ? "This workspace is empty" : "Open a file from Explorer"}</strong>
            <span>{files.length === 0 ? "Create a file, or import a repository snapshot from Source Control." : "Nothing is downloaded until you select it."}</span>
            {suggestions.length > 0 ? <div class="workbench-empty__files">
              {suggestions.map((entry) => <button type="button" key={entry.path} onClick={() => void openPreviewTab(entry.path)}>
                <WorkspaceFileIcon path={entry.path} />
                <span>{entry.path.replace("/workspace/", "")}</span>
                <small>{formatBytes(workspaceEntryByteLength(entry))}</small>
              </button>)}
            </div> : null}
            <div class="workbench-empty__actions">
              <button class="primary" type="button" onClick={() => openDialog("create", "/workspace")}>New file</button>
              <button type="button" onClick={() => openDialog("create-folder", "/workspace")}>New folder</button>
              {onOpenRepositoryManager ? <button type="button" onClick={onOpenRepositoryManager}>Import a repository snapshot</button> : null}
            </div>
            {/*
              The route header's paragraph lands here rather than being burned
              into every populated session's chrome. It also stays verbatim in
              the route bar's ⓘ.
            */}
            <p class="workbench-empty__note">{WORKBENCH_DESCRIPTION} Every write is compare-and-swapped against the revision you opened.</p>
          </div>}
          </div>
        </main>
      </div>
      {notice ? <div class={`notice workbench-notice ${notice.kind}`} data-state={workbenchNoticeState(notice.kind)} role={notice.kind === "error" ? "alert" : "status"}>
        <StatusMark state={workbenchNoticeState(notice.kind)} density="dot" size={16} acting={notice.kind === "progress"} />
        <p>{notice.message}</p>
        {notice.kind === "progress" ? null : <button type="button" aria-label="Dismiss this message" onClick={() => setNotice(undefined)}>Dismiss</button>}
      </div> : null}
      {context ? <div
        class="workbench-context"
        ref={contextBox}
        role="menu"
        aria-label={`Actions for ${workspaceBaseName(context.path)}`}
        aria-describedby={contextHintId}
        style={{ left: `${String(context.x)}px`, top: `${String(context.y)}px` }}
        onKeyDown={handleContextKey}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button role="menuitem" tabIndex={-1} onClick={() => { if (contextIsFile) void openPreviewTab(context.path); else { toggleDirectory(context.path); closeContextMenu(); } }}>{contextIsFile ? "Open preview" : expanded.has(context.path) ? "Collapse" : "Expand"}</button>
        {contextIsFile ? <button role="menuitem" tabIndex={-1} onClick={() => void openPinnedTab(context.path)}>Open and keep</button> : null}
        {contextIsFile ? <button role="menuitem" tabIndex={-1} onClick={() => void downloadFile(context.path)}>Download</button> : null}
        {onOpenTerminalAt ? <button role="menuitem" tabIndex={-1} onClick={() => {
          onOpenTerminalAt(contextIsFile ? workspaceParentPath(context.path) : context.path);
          setContext(undefined);
        }}><Icon name="terminal" size={15} /> Open terminal here</button> : null}
        <button role="menuitem" tabIndex={-1} onClick={() => openDialog("create", contextIsFile ? workspaceParentPath(context.path) : context.path)}>New file…</button>
        {contextIsFile ? <>
          <button role="menuitem" tabIndex={-1} onClick={() => openDialog("rename", context.path)}>Rename…</button>
          <button role="menuitem" tabIndex={-1} onClick={() => openDialog("move", context.path)}>Move…</button>
          <button class="danger" role="menuitem" tabIndex={-1} onClick={() => openDialog("delete", context.path)}>Delete…</button>
        </> : <>
          {/*
            A folder used to offer Expand and New file and nothing else, so the
            only way to rename or remove one was to move its files out by hand,
            one drag at a time. These three run exactly that, in one confirmed
            step, and each dialog says how many files it is really touching.
          */}
          <button role="menuitem" tabIndex={-1} onClick={() => openDialog("create-folder", context.path)}>New folder…</button>
          <button role="menuitem" tabIndex={-1} onClick={() => openDialog("rename-folder", context.path)}>Rename folder…</button>
          <button class="danger" role="menuitem" tabIndex={-1} onClick={() => openDialog("delete-folder", context.path)}>Delete folder…</button>
        </>}
        {/*
          Replaces a "Close" row that duplicated behaviour already bound. It is
          presentational and referenced by `aria-describedby` rather than left
          as a generic child of `role="menu"`, whose only permitted element
          children are its items.
        */}
        <p class="workbench-context__hint" id={contextHintId} role="presentation">Esc or a tap outside dismisses this menu. Arrow keys move between actions.</p>
      </div> : null}
      {/* The Escape/Tab trap, the scrim and the button row live in
          `ConfirmDialog` now — the same component the terminal tab and the
          remote controls confirm through, so one gesture means one thing on
          this route. */}
      {dialog && dialogCopy ? <ConfirmDialog
        boxRef={dialogBox}
        title={dialogCopy.title}
        titleDetail={dialog.path}
        confirmLabel={dialogCopy.confirm}
        destructive={dialogCopy.destructive}
        confirmDisabled={busy || Boolean(dialogNameError) || (!DIALOG_KINDS_WITHOUT_VALUE.includes(dialog.kind) && !dialogValue.trim())}
        extraActions={dialog.kind === "discard" && !buffers[dialog.path]?.truncated ? <button class="primary" type="button" disabled={busy} onClick={() => void saveAndClose(dialog.path)}>Save and close</button> : undefined}
        onCancel={closeDialog}
        onConfirm={() => void runDialog()}
      >
          {dialog.kind === "move" ? <>
            <p class="workbench-dialog__where">Currently in {workspaceParentPath(dialog.path).replace("/workspace", "workspace")}.</p>
            <div class="move-targets" role="listbox" aria-label="Destination folder" onKeyDown={handleMoveTargetKey}>{directories.map((directory, index) => {
              const label = directory.path.replace("/workspace", "workspace");
              return <button
                key={directory.path}
                role="option"
                aria-selected={dialogValue === directory.path}
                aria-label={label}
                title={label}
                disabled={workspaceParentPath(dialog.path) === directory.path}
                tabIndex={index === moveTargetFocus ? 0 : -1}
                style={{ paddingLeft: `${String(12 + directory.depth * 15)}px` }}
                onClick={() => setDialogValue(directory.path)}
              >{directory.depth === 0 ? "workspace" : directory.name}</button>;
            })}</div>
          </> : dialog.kind === "discard" ? <p>Save <strong>{workspaceBaseName(dialog.path)}</strong> before closing, keep editing, or permanently discard its unsaved in-browser draft.</p>
            : dialog.kind === "delete" ? <p>Delete <strong>{dialog.path.replace("/workspace/", "")}</strong>? The exact revision is checked before removal.{buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? " Its unsaved draft will also be discarded." : ""}</p>
            : dialog.kind === "delete-folder" ? <>
              {/* The count is the headline: a folder row hides how much a
                  single "Delete" is about to remove. Names follow, bounded. */}
              <p>Delete <strong>{dialog.path.replace("/workspace/", "")}</strong> and the {dialogFolderFiles.length} {dialogFolderFiles.length === 1 ? "file" : "files"} in it? Each file&rsquo;s exact revision is checked before removal.{dialogDirtyDrafts > 0 ? ` The unsaved ${dialogDirtyDrafts === 1 ? "draft" : "drafts"} of the ${String(dialogDirtyDrafts)} open ${dialogDirtyDrafts === 1 ? "document" : "documents"} under it will also be discarded.` : ""}</p>
              <ul class="workbench-dialog__paths">
                {dialogFolderFiles.slice(0, DIALOG_PATH_PREVIEW).map((entry) => <li key={entry.path}>{entry.path.replace("/workspace/", "")}</li>)}
                {dialogFolderFiles.length > DIALOG_PATH_PREVIEW ? <li class="workbench-dialog__paths-more">and {dialogFolderFiles.length - DIALOG_PATH_PREVIEW} more under this folder</li> : null}
              </ul>
              <p class="workbench-dialog__caveat">{WORKSPACE_FOLDER_NOT_ATOMIC_NOTE}</p>
            </>
            : <label>{dialog.kind === "create" ? "Path relative to this folder" : dialog.kind === "create-folder" ? "Folder name" : dialog.kind === "rename-folder" ? "New folder name" : "New name"}
              <input autofocus value={dialogValue} aria-invalid={dialogNameError ? "true" : undefined} onInput={(event) => setDialogValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void runDialog(); }} />
              {dialog.kind === "create" ? <small>In {dialog.path.replace("/workspace", "workspace")}. A path with slashes creates the folders it names — <code>notes/2026/plan.md</code>.</small> : null}
              {dialog.kind === "create-folder" ? <small>In {dialog.path.replace("/workspace", "workspace")}. {WORKSPACE_FOLDER_PLACEHOLDER_NOTE}</small> : null}
              {dialog.kind === "rename-folder" ? <small>Moves the {dialogFolderFiles.length} {dialogFolderFiles.length === 1 ? "file" : "files"} under {dialog.path.replace("/workspace/", "")}. {WORKSPACE_FOLDER_NOT_ATOMIC_NOTE}</small> : null}
              {/* Stated beside the field rather than expressed only as a
                  disabled button, which is a dead end that never says why. */}
              {dialogNameError ? <small class="workbench-dialog__error" role="alert">{dialogNameError}</small> : null}
            </label>}
          {(dialog.kind === "move" || dialog.kind === "rename") && buffers[dialog.path]?.draft !== buffers[dialog.path]?.content ? <p class="workspace-boundary attention">The unsaved draft will move with this tab; the durable file is not changed until you save.</p> : null}
      </ConfirmDialog> : null}
    </section>
  );
}

/**
 * A search result list: the matched files, flat, in inventory order.
 *
 * Every row is a file at depth 1, which is what deletes the folder rows and
 * the indent that went with them. It takes the already-filtered entries rather
 * than a tree, so the ordering `searchMatches` established — inventory order,
 * so a content-only hit does not jump ahead of a path match — is carried
 * through untouched.
 */
export function explorerSearchNodes(matches: readonly WorkspaceEntry[]): readonly VisibleWorkspaceNode[] {
  return Object.freeze(matches.map((entry) => Object.freeze({
    kind: "file" as const,
    name: workspaceBaseName(entry.path),
    path: entry.path,
    depth: 1,
    entry,
    children: [],
  })));
}

/**
 * The folder a flattened search result came from, workspace-relative.
 *
 * Empty for a file at the workspace root — VS Code prints nothing there, and a
 * bare `/` beside every top-level filename is noise standing in for "no
 * folder".
 */
export function workspaceSearchFolder(path: string): string {
  const parent = workspaceParentPath(path);
  return parent === "/workspace" ? "" : parent.slice("/workspace/".length);
}

/**
 * A creation mark: the thing being made, with the `+` that makes it.
 *
 * `icons.tsx` carries no new-file or new-folder glyph and this lane does not
 * own that file, so both are composed from marks the set already ships — the
 * same `file` and `workspace` glyphs the tree and the empty state draw. The
 * `+` sits in the corner rather than beside the mark, which is what keeps two
 * `<svg>` elements from reading as two separate controls in a 30px button.
 */
function CreationGlyph({ name }: Readonly<{ name: "file" | "workspace" }>) {
  return <span class="workspace-new__glyph" aria-hidden="true">
    <Icon name={name} size={16} />
    <Icon name="plus" size={9} />
  </span>;
}

/**
 * Restore only identifiers that still exist in the freshly-read Git inventory.
 * A deleted/imported repository or worktree falls back inside the same live
 * inventory; an opaque saved id is never rendered as if it remained valid.
 */
export function resolveWorkspaceSourceSelection<
  R extends Readonly<{ id: string; worktrees: readonly Readonly<{ id: string }>[] }>,
>(
  repositories: readonly R[],
  preferredRepositoryId?: string,
  preferredWorktreeId?: string,
  fallbackRepositoryId?: string,
): Readonly<{ repository?: R; worktree?: R["worktrees"][number] }> {
  const repository = repositories.find((item) => item.id === preferredRepositoryId)
    ?? repositories.find((item) => item.id === fallbackRepositoryId)
    ?? repositories[0];
  const worktree = repository?.worktrees.find((item) => item.id === preferredWorktreeId)
    ?? repository?.worktrees[0];
  return Object.freeze({
    ...(repository ? { repository } : {}),
    ...(worktree ? { worktree } : {}),
  });
}

/** Keep the unverified saved candidate until the first live inventory resolves. */
export function workspacePersistedWorktreeId(
  restoredWorktreeId: string | undefined,
  resolvedWorktreeId: string | undefined,
  inventoryResolved: boolean,
): string | undefined {
  return inventoryResolved ? resolvedWorktreeId : restoredWorktreeId;
}

function DiffDocumentEditor({ document, buffer, preview, wrap, pin, toggleWrap, reveal }: {
  document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument;
  buffer?: DiffBuffer;
  preview: boolean;
  wrap: boolean;
  pin(): void;
  toggleWrap(): void;
  reveal(path: string): void;
}) {
  const label = document.source === "status"
    ? `${document.scope === "staged" ? "Staged" : "Working"} diff ${document.path}`
    : `Commit ${document.revision} diff`;
  const path = document.source === "status" ? document.path : `commit ${document.revision.slice(0, 12)}`;
  const state = buffer?.loading || !buffer ? "checking" : buffer.error ? "failed" : "verified";
  const stateLabel = buffer?.loading || !buffer ? "Reading patch" : buffer.error ? "Unavailable" : "Read-only diff";
  const stateDetail = buffer?.error ?? (document.source === "status"
    ? `Matches worktree version ${document.worktreeVersion}.`
    : `Read from commit object ${document.revision}.`);
  const revealPaths = workbenchDiffRevealPaths(document, buffer?.files);
  const diffIcon = document.source === "status"
    ? <WorkspaceFileIcon path={document.path} />
    : <Icon name="source" size={30} />;
  return <>
    {buffer?.error ? <div class="workspace-diff-state" role="alert">{diffIcon}<strong>Diff unavailable</strong><span>{buffer.error}</span></div>
      : buffer?.loading || !buffer ? <div class="workspace-diff-state" role="status">{diffIcon}<strong>Reading local patch…</strong><span>The editor is reading the browser-owned Git repository.</span></div>
      : <div class="code-editor-frame"><UnifiedPatch
          class="workspace-diff"
          patch={buffer.content}
          wrap={wrap}
          label={label}
          empty={document.source === "status"
            ? `No textual change in ${document.path}. The ${document.scope} comparison returned an empty patch.`
            : "This commit records no bounded file patch."}
        /></div>}
    <div class="editor-strip">
      <StatusMark class="editor-strip__verdict" state={state} density="chip" label={stateLabel} detail={stateDetail} acting={state === "checking"} />
      <span class="editor-strip__path" title={path}>{path}</span>
      <span class="editor-strip__meta">
        <span>{document.source === "status" ? `${document.scope} · snapshot ${document.worktreeVersion.slice(0, 12)}` : `object ${document.revision.slice(0, 12)}`}</span>
        {buffer?.byteLength !== undefined ? <span>{formatBytes(buffer.byteLength)}</span> : null}
        {buffer?.binary ? <span>binary change included</span> : null}
        {buffer?.truncated ? <span>bounded patch · truncated</span> : null}
      </span>
      <span class="editor-strip__controls">
        {revealPaths.length === 1 ? <button
          class="editor-strip__reveal"
          type="button"
          aria-label="Reveal in Explorer"
          title={document.source === "history" ? "Reveal this commit path in the current Explorer tree; the commit diff stays open" : "Reveal this changed path in Explorer; the diff stays open"}
          onClick={() => reveal(revealPaths[0]!)}
        ><Icon name="workspace" size={15} /></button> : revealPaths.length > 1 ? <MenuSelect
          className="editor-strip__reveal-menu"
          placement="up"
          ariaLabel="Reveal a changed path from this commit in Explorer"
          value=""
          options={[
            { value: "", label: "Reveal changed path…", disabled: true },
            ...revealPaths.map((changedPath) => ({ value: changedPath, label: changedPath, description: "Show current workspace path; keep commit diff open" })),
          ]}
          leading={(option) => option.value ? <WorkspaceFileIcon path={option.value} /> : <Icon name="workspace" size={16} />}
          onChange={reveal}
        /> : <button
          class="editor-strip__reveal"
          type="button"
          disabled
          title={buffer?.loading || !buffer ? "Changed paths are still loading" : "This bounded commit read did not return an exact path to reveal"}
        >Reveal unavailable</button>}
        {preview ? <button class="editor-strip__pin" type="button" title="Keep this diff open when another document is selected" onClick={pin}>Keep open</button> : null}
        <button class="editor-strip__wrap" type="button" aria-pressed={wrap} title="Soft-wrap long patch lines" onClick={toggleWrap}>Wrap</button>
      </span>
    </div>
  </>;
}

function statusDiffBuffer(document: WorkbenchStatusDiffDocument, result: GitDiff): DiffBuffer {
  return Object.freeze({
    document,
    // The patch, verbatim, including empty. The sentence for "there is nothing
    // to draw" belongs to the renderer: folded in here it became a line of the
    // document, so the patch reader printed it as a file header *and* the
    // empty-state placeholder printed it again underneath.
    content: result.patch,
    binary: result.binary,
    truncated: result.truncated,
    byteLength: result.byteLength,
    loading: false,
  });
}

function historyDiffBuffer(document: WorkbenchHistoryDiffDocument, result: GitCommitDetail): DiffBuffer {
  const content = workspaceHistoryPatch(result);
  return Object.freeze({
    document,
    content,
    binary: result.files.some((file) => file.binary),
    truncated: result.truncated || result.files.some((file) => file.truncated),
    byteLength: new TextEncoder().encode(content).byteLength,
    loading: false,
    files: Object.freeze([...result.files]),
  });
}

/** A bounded, read-only commit document assembled only from `git.show`. */
export function workspaceHistoryPatch(detail: GitCommitDetail): string {
  const header = [
    `commit ${detail.commit.oid}`,
    `Author: ${detail.commit.author.name} <${detail.commit.author.email}>`,
    `Date:   ${detail.commit.committedAt}`,
    "",
    detail.commit.message.trim() || "(no commit message)",
  ];
  const patches = detail.files.map((file) => file.patch || `${file.kind} ${file.path}${file.binary ? " (binary)" : " (no textual patch)"}`);
  if (detail.truncated) patches.push("Additional changed paths were omitted by the bounded history read.");
  return [...header, "", ...patches].join("\n").trimEnd();
}

/** Exact, de-duplicated paths an open diff can offer to Explorer. */
export function workbenchDiffRevealPaths(
  document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument,
  historyFiles?: readonly Pick<GitCommitFilePatch, "path">[],
): readonly string[] {
  return Object.freeze(document.source === "status"
    ? [document.path]
    : [...new Set(historyFiles?.map((file) => file.path) ?? [])]);
}

/**
 * File-document tabs the freshly listed tree no longer contains.
 *
 * The refresh effect evicts these from the document strip; the returned set is
 * also the buffer purge list, because tab and draft are discarded as one unit
 * everywhere else a document leaves this view.
 */
export function workbenchVanishedFilePaths(
  tabs: readonly string[],
  filePaths: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(tabs.filter((id) => {
    const document = parseWorkbenchDocumentId(id);
    return document?.kind === "file" && !filePaths.has(document.path);
  }));
}

/**
 * Open *clean* buffers whose stored revision the tree no longer lists.
 *
 * Listed-at-a-different-revision means the file was written outside this page
 * — an agent turn, a terminal, a checkout. Only clean buffers are returned:
 * a dirty draft is the user's unsaved work and its compare-and-swapped save
 * already fences the external write.
 */
export function workbenchExternalRevisionPaths(
  buffers: Readonly<Record<string, Readonly<{ revision: string; draft: string; content: string }>>>,
  files: readonly Readonly<{ path: string; revision: string }>[],
): readonly string[] {
  const revisions = new Map(files.map((entry) => [entry.path, entry.revision] as const));
  return Object.freeze(Object.keys(buffers).filter((path) => {
    const candidate = buffers[path];
    const listed = revisions.get(path);
    return candidate.draft === candidate.content && listed !== undefined && listed !== candidate.revision;
  }));
}

/**
 * The buffer a clean open document becomes after an external write, or
 * `undefined` when the merge must be declined.
 *
 * The re-read and this adoption guard are one race: the buffer must still be
 * at the revision the refresh *triggered* on and still clean. A save or a
 * first keystroke that landed during the read owns the buffer now, and this
 * path yields to it.
 */
export function workbenchExternalRevisionBuffer(
  candidate: Readonly<{ revision: string; draft: string; content: string }> | undefined,
  expectedRevision: string,
  file: WorkspaceFile,
): (WorkspaceFile & { draft: string; truncated: boolean; binary: boolean }) | undefined {
  if (!candidate || candidate.revision !== expectedRevision || candidate.draft !== candidate.content) return undefined;
  const projection = workspaceEditorProjection(file);
  return { ...file, content: projection.content, draft: projection.content, truncated: projection.truncated, binary: projection.binary };
}

/**
 * How many open documents under a folder carry unsaved in-browser drafts.
 *
 * Folder delete discards every buffer under the path (`forgetPaths`), so the
 * confirmation has to say the same sentence the single-file delete says.
 */
export function workbenchDirtyDraftsUnderFolder(
  buffers: Readonly<Record<string, Readonly<{ draft: string; content: string }>>>,
  folder: string,
): number {
  const prefix = `${folder}/`;
  return Object.entries(buffers)
    .filter(([path, candidate]) => path.startsWith(prefix) && candidate.draft !== candidate.content)
    .length;
}

/**
 * The paths a "Stage all visible" click may send.
 *
 * The Advanced source controls exclude merge-conflicted entries from their
 * bulk stage (`isConflicted` in `sources-view`); the workbench rail sends the
 * same operation, so it holds the same fence or the two panels stage
 * different sets for identical clicks.
 */
export function workbenchVisibleStagePaths(entries: readonly GitStatusEntry[]): readonly string[] {
  return Object.freeze(entries.filter((entry) => !isConflicted(entry)).map((entry) => entry.path));
}

function commitSubject(message: string): string {
  return message.trim().split(/\r?\n/u)[0] || "(no commit message)";
}

/**
 * What this branch has that its upstream does not, and the reverse.
 *
 * Set difference over two bounded reads rather than an index walk: a branch
 * that merged its upstream shares commits at several depths, and "the first
 * oid the two lists have in common" would call an already-merged history
 * divergent. Both counts are exact whenever the two windows reach shared
 * ground; when they share nothing at all the windows were too shallow to see
 * the fork, and `bounded` says so instead of the caller inventing certainty.
 */
export type WorkbenchBranchDivergence = Readonly<{ ahead: number; behind: number; bounded: boolean }>;

export function workbenchBranchDivergence(
  local: readonly string[],
  upstream: readonly string[],
): WorkbenchBranchDivergence {
  const upstreamSet = new Set(upstream);
  const localSet = new Set(local);
  const shared = local.some((oid) => upstreamSet.has(oid));
  return Object.freeze({
    ahead: local.filter((oid) => !upstreamSet.has(oid)).length,
    behind: upstream.filter((oid) => !localSet.has(oid)).length,
    bounded: !shared && (local.length > 0 || upstream.length > 0),
  });
}

/**
 * The upstream a rail can actually read.
 *
 * Airship never writes a branch's configured upstream, so there is no
 * `branch.<name>.merge` to consult. What a fetch does leave behind is
 * `refs/remotes/<remote>/<branch>`, so that — and only that — is what the row
 * claims. `origin` wins when it exists because that is the name every import
 * and clone in this product creates; otherwise the single remote is
 * unambiguous, and two unnamed candidates are not a guess worth printing.
 */
export function workbenchUpstreamRef(
  remotes: readonly GitRemoteSummary[],
  branch: string,
): Readonly<{ ref: string; label: string }> | undefined {
  if (!branch) return undefined;
  const remote = remotes.find((candidate) => candidate.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
  if (!remote) return undefined;
  return Object.freeze({ ref: `refs/remotes/${remote.name}/${branch}`, label: `${remote.name}/${branch}` });
}

/**
 * The sentence a screen reader hears where sighted readers see `↑2 ↓1`.
 *
 * Arrows are not text. The glyph pair is `aria-hidden` and this is its only
 * carrier, so it has to survive being read alone — including the bounded case,
 * where a floor announced as a total would be worse than saying nothing.
 */
export function workbenchDivergenceSentence(divergence: WorkbenchBranchDivergence, upstream: string): string {
  const bound = divergence.bounded ? "at least " : "";
  const ahead = `${bound}${String(divergence.ahead)} ${divergence.ahead === 1 ? "commit" : "commits"} to push`;
  const behind = `${bound}${String(divergence.behind)} to pull`;
  if (divergence.ahead === 0 && divergence.behind === 0) return `Up to date with ${upstream}`;
  if (divergence.behind === 0) return `${ahead} to ${upstream}`;
  if (divergence.ahead === 0) return `${bound}${String(divergence.behind)} ${divergence.behind === 1 ? "commit" : "commits"} to pull from ${upstream}`;
  return `${ahead}, ${behind}, against ${upstream}`;
}

/** `20+` where the read saturated, a plain number where it did not. See `workbenchHistoryCount`. */
function divergenceCount(value: number, bounded: boolean): string {
  return bounded && value >= WORKBENCH_DIVERGENCE_DEPTH ? `${String(value)}+` : String(value);
}

function SourceControlRail({ repositories, repositoryId, selectRepository, worktree, selectWorktree, history, historyMessage, upstream, loading, busy, refresh, openDiff, mutate, commitMessage, setCommitMessage, onOpenRepositoryManager }: {
  repositories: readonly GitRepositorySnapshot[];
  repositoryId: string;
  selectRepository(id: string): void;
  worktree?: GitWorktreeSnapshot;
  selectWorktree(id: string): void;
  history: readonly GitCommitSummary[];
  historyMessage: string;
  upstream?: Readonly<{ label: string; divergence: WorkbenchBranchDivergence }>;
  loading: boolean;
  /**
   * Whether a workbench transaction holds the workspace right now.
   *
   * `mutateSource` drops every request while it is true, and it says nothing
   * when it does: without this prop the verbs stayed pressable through a save
   * or a forty-file folder rename and staging simply did not happen. The same
   * gate `Save` already uses, on the rail that shares its transaction.
   */
  busy: boolean;
  refresh(): void;
  openDiff(document: WorkbenchStatusDiffDocument | WorkbenchHistoryDiffDocument, mode: WorkbenchDocumentOpenMode): void;
  mutate(operation: GitOperation): void | Promise<void>;
  commitMessage: string;
  setCommitMessage(value: string): void;
  onOpenRepositoryManager?: () => void;
}) {
  const repository = repositories.find((item) => item.id === repositoryId) ?? repositories[0];
  const lanes = workbenchSourceLanes(worktree?.status ?? []);
  const { staged, unstaged } = lanes;
  const truncation = workbenchSourceTruncationNote(lanes);
  const operation = (kind: "stage" | "unstage", paths: readonly string[]): GitOperation | undefined => repository && worktree ? { kind, request: { repositoryId: repository.id, worktreeId: worktree.id, paths, expectedWorktreeVersion: worktree.version } } : undefined;
  /**
   * The path whose worktree changes are one confirmation from being destroyed.
   *
   * Gated the same way deleting a workspace file is, and for the same reason:
   * the approval dialog behind this decides *permission*, and a profile in
   * `full-access` mode never shows one. The row's own consequence sentence is
   * the only thing between a mis-tap and unrecoverable bytes.
   */
  const [discarding, setDiscarding] = useState<string>();
  const discardCopy = discarding ? workbenchDiscardConfirmation(discarding) : undefined;
  const changed = worktree?.status.length ?? 0;
  return <div class="workspace-scm">
    {/*
      One row: the repository, the reload, and the way to everything else.
      Two full words in a `1fr 1fr` grid put "Advanced source controls" — 24
      characters — into a 143px cell, so it wrapped to two lines inside a 44px
      button and the block cost 93px before a single changed path. The words
      survive verbatim as the accessible names; `aria-name-contract.test.ts`
      and `workspace-source-controls.spec.ts` both read them, and so does
      anyone who cannot see the glyph.
    */}
    <div class="scm-bar">
      <MenuSelect placement="down" ariaLabel="Workspace repository" value={repository?.id ?? ""} options={repositories.map((item) => ({ value: item.id, label: item.name }))} onChange={selectRepository} />
      <button class="scm-bar__action" type="button" aria-label="Refresh" aria-busy={loading ? "true" : undefined} title={loading ? "Refreshing…" : "Refresh repositories, status and history"} onClick={refresh} disabled={loading}><Icon name="refresh" size={16} /></button>
      {onOpenRepositoryManager ? <button class="scm-bar__action" type="button" aria-label="Advanced source controls" title="Import, repository setup, branch checkout, worktrees, remote operations, full status selection, tags, and detailed history" onClick={onOpenRepositoryManager}><Icon name="settings" size={16} /></button> : null}
    </div>
    {repository && repository.worktrees.length > 1 ? <label>Worktree<MenuSelect placement="down" ariaLabel="Workspace worktree" value={worktree?.id ?? ""} options={repository.worktrees.map((item) => ({ value: item.id, label: `${item.branch} · ${item.path}` }))} onChange={selectWorktree} /></label> : null}
    {/*
      The repository row: branch, how far it has drifted from its upstream, the
      head it is actually at, and the size of the working set. `head` was in
      the workbench inventory and had no home on screen — the old summary
      printed branch and a count and nothing that identified the commit those
      changes are measured against.
    */}
    <div class="scm-branch">
      <Icon name="branch" size={14} />
      <strong>{worktree?.branch ?? "No worktree"}</strong>
      {upstream ? <span class="scm-branch__sync" data-bounded={upstream.divergence.bounded ? "true" : undefined}>
        <span aria-hidden="true">↑{divergenceCount(upstream.divergence.ahead, upstream.divergence.bounded)} ↓{divergenceCount(upstream.divergence.behind, upstream.divergence.bounded)}</span>
        <span class="sr-only">{workbenchDivergenceSentence(upstream.divergence, upstream.label)}</span>
      </span> : null}
      {/* Twelve, because every other object id in this workbench — the diff
          tab's label, its strip, the History row — is abbreviated to twelve.
          Two shorthands for one commit on adjacent rows is two commits to
          anyone scanning the column. */}
      {worktree ? <code class="scm-branch__head">{worktree.head.slice(0, 12)}</code> : null}
      <span class="scm-branch__count">{changed} {changed === 1 ? "change" : "changes"}</span>
    </div>
    {!loading && !repository ? <div class="workspace-boundary">No Git repositories are connected to this workspace.</div> : null}
    {/*
      The group's own verb, on the group's own header.
      Two full-width word buttons stacked under the two lists, each a 24px
      slab, and the reader had to work out which list "Stage all visible"
      belonged to from its position. The names are unchanged — the inventory
      requires "stage/unstage one or all visible paths" to keep a tested home,
      and `+`/`−` on a header is only legible because the accessible name still
      says the whole sentence. The `> 1` gate is unchanged too: with a single
      path in a lane, its own row toggle already is the bulk action.
    */}
    {staged.length ? <ScmGroup
      title="Staged"
      entries={staged}
      lane="staged"
      repository={repository}
      worktree={worktree}
      openDiff={openDiff}
      mutate={mutate}
      busy={busy}
      bulk={staged.length > 1 ? { label: "Unstage all visible", glyph: "−", run: () => { const next = operation("unstage", staged.map((entry) => entry.path)); if (next) void mutate(next); } } : undefined}
    /> : null}
    {unstaged.length ? <ScmGroup
      title="Changes"
      entries={unstaged}
      lane="unstaged"
      repository={repository}
      worktree={worktree}
      openDiff={openDiff}
      mutate={mutate}
      busy={busy}
      discard={setDiscarding}
      bulk={unstaged.length > 1 ? { label: "Stage all visible", glyph: "+", run: () => { const next = operation("stage", workbenchVisibleStagePaths(unstaged)); if (next) void mutate(next); } } : undefined}
    /> : null}
    {discarding && discardCopy && repository && worktree ? <ConfirmDialog
      title={discardCopy.title}
      titleDetail={discarding}
      confirmLabel={discardCopy.confirm}
      destructive
      confirmDisabled={busy}
      onCancel={() => setDiscarding(undefined)}
      onConfirm={() => {
        setDiscarding(undefined);
        void mutate({ kind: "restore", request: { repositoryId: repository.id, worktreeId: worktree.id, paths: [discarding], source: "head", expectedWorktreeVersion: worktree.version } });
      }}
    ><p>{discardCopy.consequence}</p></ConfirmDialog> : null}
    {truncation ? <div class="workspace-boundary attention">{truncation}</div> : null}
    {worktree?.status.some((entry) => entry.index) ? <div class="scm-commit"><textarea aria-label="Commit message" value={commitMessage} onInput={(event) => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" /><button class="primary" type="button" disabled={busy || !commitMessage.trim()} onClick={() => repository && mutate({ kind: "commit", request: { repositoryId: repository.id, worktreeId: worktree.id, message: commitMessage, author: DEFAULT_AUTHOR, expectedWorktreeVersion: worktree.version } })}>Commit staged</button></div> : null}
    {/*
      The count is the read's bound, not the repository's total: `git.log` is
      asked for exactly WORKBENCH_HISTORY_DEPTH commits, and a bare `20` in the
      slot where Staged and Changes print totals read as "this repository has 20
      commits". The `20+` and the sentence below both name the same constant.
    */}
    {repository && worktree ? <section class="scm-group scm-history"><header><strong>History</strong><span>{workbenchHistoryCount(history.length)}</span></header>
      {history.length >= WORKBENCH_HISTORY_DEPTH ? <div class="workspace-boundary">Showing the most recent {WORKBENCH_HISTORY_DEPTH} commits on this worktree.</div> : null}
      {history.map((entry) => {
        const document: WorkbenchHistoryDiffDocument = { kind: "diff", source: "history", repositoryId: repository.id, worktreeId: worktree.id, revision: entry.oid };
        const short = entry.oid.slice(0, 12);
        return <div class="scm-row scm-history-row" key={entry.oid}>
          <button
            type="button"
            title="Click previews this commit patch · Shift+Enter or double-click keeps it open"
            aria-keyshortcuts="Enter Shift+Enter"
            onClick={() => openDiff(document, "preview")}
            onDblClick={() => openDiff(document, "pinned")}
            onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); openDiff(document, "pinned"); } }}
          ><span><strong>{commitSubject(entry.message)}</strong><small>
            {/*
              Two values on one line, and only one of them may be cut.

              This was a single text node — `fe5341494b6c · 2026-08-08` — with
              no ellipsis on it, so a rail too narrow for the pair clipped the
              line mid-glyph at the `↱`: measured at tablet-768, the date read
              "2026-08-0" with the last digit sliced down the middle. A date
              that has lost its last digit is not a shorter date, it is a wrong
              one. The revision gives way instead, because it is abbreviated
              already, it is repeated in full in the accessible name of the
              button beside it, and it is the value the reader is least likely
              to be scanning history by. `<time>` carries the whole committed
              timestamp regardless of what the row has room to print.
            */}
            <span class="scm-history-row__oid">{short}</span>
            <span class="scm-history-row__sep" aria-hidden="true">·</span>
            <time class="scm-history-row__date" dateTime={entry.committedAt}>{entry.committedAt.slice(0, 10)}</time>
          </small></span><b>↱</b></button>
          <div><button type="button" aria-label={`Open and keep commit ${short} diff`} title="Open and keep" onClick={() => openDiff(document, "pinned")}>↗</button></div>
        </div>;
      })}
      {historyMessage ? <div class="workspace-boundary">{historyMessage}</div> : null}
      {!loading && history.length === 0 && !historyMessage ? <div class="workspace-boundary">No commits are available in this worktree history.</div> : null}
    </section> : null}
  </div>;
}

function ScmGroup({ title, entries, lane, repository, worktree, openDiff, mutate, busy, discard, bulk }: { title: string; entries: readonly GitStatusEntry[]; lane: "staged" | "unstaged"; repository?: GitRepositorySnapshot; worktree?: GitWorktreeSnapshot; openDiff(document: WorkbenchStatusDiffDocument, mode: WorkbenchDocumentOpenMode): void; mutate(operation: GitOperation): void | Promise<void>; busy: boolean; discard?(path: string): void; bulk?: Readonly<{ label: string; glyph: string; run: () => void }> }) {
  return <section class="scm-group"><header><strong>{title}</strong>{bulk ? <button class="scm-group__bulk" type="button" aria-label={bulk.label} title={bulk.label} disabled={busy} onClick={bulk.run}>{bulk.glyph}</button> : null}<span>{entries.length}</span></header>{entries.map((entry) => {
    const delta = lane === "staged" ? entry.index : entry.worktree;
    const conflicted = delta?.kind === "conflicted";
    // Split on the raw Git path: status entries are repository-relative
    // (`docs/architecture.md`), so the `/workspace`-rooted helpers would
    // normalize a prefix onto them that this row must never print.
    const cut = entry.path.lastIndexOf("/");
    const folder = cut > 0 ? entry.path.slice(0, cut) : "";
    const kind = conflicted ? "conflicted" : delta?.kind ?? "modified";
    const status = `${lane === "staged" ? "Staged" : "Working"} ${kind}`;
    const document: WorkbenchStatusDiffDocument | undefined = repository && worktree ? {
      kind: "diff",
      source: "status",
      repositoryId: repository.id,
      worktreeId: worktree.id,
      worktreeVersion: worktree.version,
      path: entry.path,
      scope: lane === "staged" ? "staged" : "worktree",
    } : undefined;
    return <div class="scm-row" key={`${lane}:${entry.path}`}>
      {/*
        The name is authored rather than assembled.
        Splitting the path into a dimmed directory and a file name puts two
        text nodes in the button, and the accessible-name algorithm joins them
        with a space — `docs/ architecture.md` is not a path. So the exact path
        is written once, here, and the status letter is decoration under it.
        The tooltip leads with the path for the same reason: in a 15rem rail
        the directory is the first thing elided.
      */}
      <button
        type="button"
        disabled={!document}
        aria-label={`${entry.path} · ${status}`}
        title={`${entry.path} · Click previews this patch · Shift+Enter or double-click keeps it open`}
        aria-keyshortcuts="Enter Shift+Enter"
        onClick={() => { if (document) openDiff(document, "preview"); }}
        onDblClick={() => { if (document) openDiff(document, "pinned"); }}
        onKeyDown={(event) => { if (document && event.key === "Enter" && event.shiftKey) { event.preventDefault(); openDiff(document, "pinned"); } }}
      >
        {/*
          The same mark Explorer draws for this path, on the row that says the
          path changed. Source Control was the one list in the workbench
          identifying a file by its characters alone — 250 of them at
          `--fs-micro`, a wall of grey text where the neighbouring pane has
          per-kind colour. `data-file-kind` is the hook `workspace-file-icon`'s
          own tests read, so the two panes cannot drift.
        */}
        <WorkspaceFileIcon path={entry.path} />
        {/* Path order, not VS Code's file-then-folder: the directory is dimmed
            rather than moved, so what a sighted reader scans and what the
            tooltip and label say are the same string in the same order. */}
        <span class="scm-row__path">{folder ? <span class="scm-row__dir">{folder}/</span> : null}<span class="scm-row__file">{entry.path.slice(cut + 1)}</span></span>
        <b data-delta={kind} aria-hidden="true">{deltaLetter(kind)}</b>
      </button>
      <div>
        <button type="button" aria-label={`Open and keep ${lane} diff ${entry.path}`} title="Open and keep" disabled={!document} onClick={() => { if (document) openDiff(document, "pinned"); }}>↗</button>
        {/*
          The way back from a bad save, on the row that is showing you the
          damage. `git restore` was implemented and approved and reachable only
          by typing it into a text field on another route, so the Workspace
          surface had every verb that makes a change and none that takes one
          back. A conflicted path is fenced out for the same reason staging is:
          restoring one half of an unresolved merge is not a recovery.
        */}
        {lane === "unstaged" && discard ? <button
          class="danger"
          type="button"
          aria-label={`Discard changes in ${entry.path}`}
          title={conflicted ? "Merge conflict — resolve it in Advanced source controls before discarding." : `Discard changes in ${entry.path} and return it to HEAD`}
          disabled={busy || !repository || !worktree || conflicted}
          onClick={() => discard(entry.path)}
        >↺</button> : null}
        {/*
          Staging a conflicted path cannot resolve the conflict — only mark it
          resolved verbatim — so the Advanced controls fence it out of every
          selection. The row gate mirrors that fence and says where the real
          resolution flow lives.
        */}
        {lane === "unstaged" && isConflicted(entry)
          ? <button type="button" aria-label={`Stage ${entry.path}`} disabled title="Merge conflict — resolve it in Advanced source controls before staging.">+</button>
          : <button type="button" aria-label={`${lane === "staged" ? "Unstage" : "Stage"} ${entry.path}`} disabled={busy} onClick={() => repository && worktree && mutate({ kind: lane === "staged" ? "unstage" : "stage", request: { repositoryId: repository.id, worktreeId: worktree.id, paths: [entry.path], expectedWorktreeVersion: worktree.version } })}>{lane === "staged" ? "−" : "+"}</button>}
      </div>
    </div>;
  })}</section>;
}

const DEFAULT_AUTHOR: GitAuthor = { name: "Local Airship User", email: "airship@local.invalid" };

/**
 * Airship's own control plane is not a user file, and hiding it is not fencing it.
 *
 * Explorer filters these paths out of the tree, which is a read concern. Every
 * write in this view takes a path the tree never had to show: the create dialog
 * accepts a slash-delimited name, rename and move both take a destination, and
 * a folder plan expands into N of those. A write that lands in
 * `/workspace/.airship/**` does not merely create an invisible file — it
 * corrupts the evidence-acquisition queue, the endpoint-evidence store or the
 * browser-Git repository catalog that Airship later reads back as its own
 * state, and the failure surfaces much later as an unrecoverable record gap.
 *
 * The reserved namespace is the *root* `.airship` tree plus a `.git` segment at
 * any depth. A repository that legitimately carries its own nested `.airship`
 * directory is user content and stays writable.
 */
export function assertMutableWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (isWorkspaceControlPlanePath(normalized)) {
    throw new Error(`Workspace edits cannot reach Airship's private control plane: ${normalized.replace("/workspace/", "")}`);
  }
  return normalized;
}

export function resolveGitBinding(path: string, repositories: readonly GitRepositorySnapshot[]) {
  return resolveGitWorkspaceBinding(path, repositories);
}

export type WorkspaceGitPathResolution =
  | Readonly<{ state: "resolved"; path: string }>
  | Readonly<{ state: "unavailable"; reason: string }>;

/**
 * Resolve a Git-relative changed path through the exact repository/worktree
 * carried by a diff document. No current selector is consulted, so switching
 * repositories cannot make an old tab reveal a similarly named file elsewhere.
 */
export function resolveWorkspacePathFromGit(
  repositories: readonly GitRepositorySnapshot[],
  repositoryId: string,
  worktreeId: string,
  relativePath: string,
): WorkspaceGitPathResolution {
  const repository = repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) return Object.freeze({ state: "unavailable", reason: "its repository is no longer connected to this workspace." });
  const worktree = repository.worktrees.find((candidate) => candidate.id === worktreeId);
  if (!worktree) return Object.freeze({ state: "unavailable", reason: "its original worktree is no longer connected." });
  const segments = relativePath.split("/");
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return Object.freeze({ state: "unavailable", reason: "the Git-relative path does not stay inside its worktree." });
  }
  try {
    const root = normalizeWorkspacePath(worktree.path);
    const path = normalizeWorkspacePath(`${root}/${relativePath}`);
    if (!path.startsWith(`${root}/`)) {
      return Object.freeze({ state: "unavailable", reason: "the resolved path is outside its original worktree." });
    }
    return Object.freeze({ state: "resolved", path });
  } catch {
    return Object.freeze({ state: "unavailable", reason: "the worktree path is outside this workspace." });
  }
}

/** Every directory that must be expanded to expose one exact file path. */
export function workspaceRevealAncestors(path: string): readonly string[] {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === "/workspace") return Object.freeze([normalized]);
  const ancestors: string[] = [];
  let current = workspaceParentPath(normalized);
  while (true) {
    ancestors.unshift(current);
    if (current === "/workspace") break;
    current = workspaceParentPath(current);
  }
  return Object.freeze(ancestors);
}

function readTabState(
  storageKey: string,
  storage: Pick<Storage, "getItem"> | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage,
  viewportWidth: number | undefined = typeof innerWidth === "number" ? innerWidth : undefined,
): WorkspaceTabState {
  const wrapDefault = defaultEditorWrap(viewportWidth);
  const empty: WorkspaceTabState = { tabs: [], activeId: "", rail: WORKBENCH_RAIL_DEFAULT_PERCENT, wrap: wrapDefault };
  if (!storage) return empty;
  try {
    const value = JSON.parse(storage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    const tabs = Array.isArray(value.tabs) ? value.tabs.filter((id: unknown): id is string => typeof id === "string" && Boolean(parseWorkbenchDocumentId(id))) : [];
    const storedActive = typeof value.activeId === "string" ? value.activeId : value.activePath;
    const storedPreview = typeof value.previewId === "string" ? value.previewId : value.previewPath;
    const activeId = typeof storedActive === "string" && tabs.includes(storedActive) ? storedActive : tabs[0] ?? "";
    const previewId = typeof storedPreview === "string" && tabs.includes(storedPreview) ? storedPreview : undefined;
    const rail = typeof value.rail === "number" ? workbenchRailPercent(value.rail) : WORKBENCH_RAIL_DEFAULT_PERCENT;
    const repositoryId = boundedSourceSelectionId(value.repositoryId);
    const worktreeId = boundedSourceSelectionId(value.worktreeId);
    return {
      tabs,
      activeId,
      ...(previewId ? { previewId } : {}),
      rail,
      wrap: typeof value.wrap === "boolean" ? value.wrap : wrapDefault,
      ...(repositoryId ? { repositoryId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
    };
  } catch { return empty; }
}

/** A partitioned or blocked session storage costs the durability notice, nothing else. */
function browserSessionStorage(): Storage | undefined {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
}

function boundedSourceSelectionId(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

export function readWorkspaceTabState(
  storage: Pick<Storage, "getItem"> | undefined,
  workspaceIdentity: string,
  profileId: string,
  viewportWidth?: number,
): WorkspaceTabState {
  return readTabState(workspaceTabStorageKey(workspaceIdentity, profileId), storage, viewportWidth);
}

export function writeWorkspaceTabState(
  storage: Pick<Storage, "setItem">,
  workspaceIdentity: string,
  profileId: string,
  state: WorkspaceTabState,
): void {
  storage.setItem(workspaceTabStorageKey(workspaceIdentity, profileId), JSON.stringify(state));
}

export function workspaceWorkbenchScope(workspaceIdentity: string, profileId: string): string {
  return `w${storageIdentitySegment(workspaceIdentity, "Workspace identity")}.p${storageIdentitySegment(profileId, "Profile ID")}`;
}

export function workspaceTabStorageKey(workspaceIdentity: string, profileId: string): string {
  return `${TAB_STORAGE}.${workspaceWorkbenchScope(workspaceIdentity, profileId)}`;
}

function storageIdentitySegment(value: string, label: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid for workbench view state.`);
  return [...value].map((codePoint) => codePoint.codePointAt(0)!.toString(16).padStart(6, "0")).join("");
}

/**
 * Whether an open status diff still describes the live worktree.
 *
 * `undefined` for the live version means "not known yet" — Source Control has
 * not resolved — and an unknown version may not be used to call a tab stale.
 */
export function workbenchSupersededStatusDiff(worktreeVersion: string, liveWorktreeVersion?: string): boolean {
  return liveWorktreeVersion !== undefined && liveWorktreeVersion !== worktreeVersion;
}

/** The tab qualifier for a status diff, which states its snapshot once stale. */
export function workbenchStatusDiffHint(
  scope: "staged" | "worktree",
  worktreeVersion: string,
  liveWorktreeVersion?: string,
): string {
  const lane = scope === "staged" ? "Staged" : "Working";
  return workbenchSupersededStatusDiff(worktreeVersion, liveWorktreeVersion)
    ? `${lane} diff · snapshot ${worktreeVersion.slice(0, 8)}`
    : `${lane} diff`;
}

/**
 * The two Source Control lanes, each bounded on its own.
 *
 * The shipped truncation banner tested `status.length > 250`, which is neither
 * lane: 200 staged plus 100 unstaged entries cut nothing and claimed it had,
 * while 260 staged entries with nothing unstaged cut ten paths and said
 * nothing. The slice bound and the predicate now share this one expression.
 */
export function workbenchSourceLanes<Entry extends Readonly<{ index?: unknown; worktree?: unknown }>>(
  status: readonly Entry[],
  limit = SCM_LANE_LIMIT,
): Readonly<{
  staged: readonly Entry[];
  unstaged: readonly Entry[];
  stagedTotal: number;
  unstagedTotal: number;
  clipped: readonly ("staged" | "unstaged")[];
}> {
  const stagedAll = status.filter((entry) => entry.index);
  const unstagedAll = status.filter((entry) => entry.worktree);
  return Object.freeze({
    staged: Object.freeze(stagedAll.slice(0, limit)),
    unstaged: Object.freeze(unstagedAll.slice(0, limit)),
    stagedTotal: stagedAll.length,
    unstagedTotal: unstagedAll.length,
    clipped: Object.freeze([
      ...(stagedAll.length > limit ? ["staged" as const] : []),
      ...(unstagedAll.length > limit ? ["unstaged" as const] : []),
    ]),
  });
}

/** The sentence a clipped lane owes the reader: which lane, and how many. */
export function workbenchSourceTruncationNote(
  lanes: Readonly<{ stagedTotal: number; unstagedTotal: number; clipped: readonly ("staged" | "unstaged")[] }>,
  limit = SCM_LANE_LIMIT,
): string | undefined {
  if (lanes.clipped.length === 0) return undefined;
  const named = lanes.clipped.map((lane) => lane === "staged"
    ? `Staged (${String(lanes.stagedTotal)} paths)`
    : `Changes (${String(lanes.unstagedTotal)} paths)`);
  return `${named.join(" and ")} ${lanes.clipped.length === 1 ? "is" : "are"} showing the first ${String(limit)}. Open Advanced source controls for the complete, virtualized worktree.`;
}

/**
 * What the History header may claim.
 *
 * `git.log` is asked for a fixed depth, so the list length is a bound and not a
 * total — and it was printed in the same position every other group in this
 * rail prints a total. A saturated read says so.
 */
export function workbenchHistoryCount(count: number, depth = WORKBENCH_HISTORY_DEPTH): string {
  return count >= depth ? `${String(depth)}+` : String(count);
}

/**
 * The exact bytes, name and revision one Explorer download will carry.
 *
 * Deliberately re-read from `WorkspacePort` rather than served from the open
 * buffer: that buffer is a bounded projection — above
 * `WORKSPACE_EDITOR_BYTE_LIMIT` it is a preview, and for opaque bytes it is
 * empty — so downloading it would hand the user a truncated file under the real
 * file's name. A file that has gone since the tree was read is refused with the
 * reason, never with silence, and the revision travels back so the notice can
 * say *which* version left the browser.
 */
export async function workspaceDownloadPayload(
  workspace: Readonly<Pick<WorkspacePort, "read">>,
  path: string,
): Promise<Readonly<{ bytes: Uint8Array; filename: string; revision: string }>> {
  const file = await workspace.read(path);
  if (!file) throw new Error("it is no longer present in this workspace.");
  return Object.freeze({
    bytes: decodeWorkspaceBytes(file.content),
    filename: downloadFileName(path),
    revision: file.revision,
  });
}

/**
 * The three source-control verbs the workbench rail can issue.
 *
 * Structural on purpose: the rail holds a whole `BrowserGitClient`, but the
 * post-condition below only needs to know which call was accepted, so a test
 * can state a commit that rejects without standing up an adapter.
 */
export type WorkbenchSourceMutations = Readonly<{
  stage(request: Extract<GitOperation, { kind: "stage" }>["request"]): Promise<unknown>;
  unstage(request: Extract<GitOperation, { kind: "unstage" }>["request"]): Promise<unknown>;
  commit(request: Extract<GitOperation, { kind: "commit" }>["request"]): Promise<unknown>;
  restore(request: Extract<GitOperation, { kind: "restore" }>["request"]): Promise<unknown>;
}>;

/**
 * Runs one source-control operation and reports whether it consumed the
 * composed commit message.
 *
 * `true` only after the adapter has returned: the box is the user's only copy
 * of that message, so a rejected commit must keep it, and an accepted one must
 * lose it — a message left behind is a loaded gun, because the next "Commit
 * staged" reuses it verbatim for an unrelated set of files. Returning the fact
 * instead of writing the state is what makes the rule testable without a DOM.
 */
export async function runSourceMutation(git: WorkbenchSourceMutations, operation: GitOperation): Promise<boolean> {
  if (operation.kind === "stage") { await git.stage(operation.request); return false; }
  if (operation.kind === "unstage") { await git.unstage(operation.request); return false; }
  if (operation.kind === "commit") { await git.commit(operation.request); return true; }
  // The way back from a bad save. `restore` was implemented, approved and
  // reachable only by submitting `git restore <path>` in Terminal for Airship
  // Browser Git: a scan of every button, summary and menu item in
  // Explorer, the Editor and Source Control for discard/revert/undo returned
  // nothing at all, so the one surface that shows you the damage had no verb
  // for it.
  if (operation.kind === "restore") { await git.restore(operation.request); return false; }
  // The rail issues exactly the four verbs above; anything else reaching here
  // is a caller bug, and refreshing the pane is the honest response to it.
  return false;
}

/**
 * Where ArrowDown/ArrowUp/Home/End move inside a menu, or `undefined`.
 *
 * Returns `undefined` for every key the menu does not own — a menu that
 * swallowed Tab or Enter would be the keyboard trap this pattern exists to
 * avoid — and wraps at both ends, which is what the menu pattern specifies and
 * what the tree beside it already does.
 */
export function workbenchMenuFocusIndex(count: number, current: number, key: string): number | undefined {
  if (count <= 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (step === 0) return undefined;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * Which destination in the Move dialog's listbox owns its one Tab stop.
 *
 * The folder the file already lives in arrives pre-selected *and* disabled —
 * it cannot be chosen again — so a stop tied to the selection alone would
 * leave a listbox of tabIndex -1 buttons completely unreachable. The
 * selection owns the stop when it can take focus; otherwise the stop falls to
 * the first folder that can actually be chosen.
 */
export function workbenchMoveTargetFocusIndex(
  candidates: readonly Readonly<{ disabled: boolean }>[],
  selected: number,
): number {
  if (selected >= 0 && !candidates[selected]?.disabled) return selected;
  return candidates.findIndex((candidate) => !candidate.disabled);
}

/**
 * Whether a keypress on a tree row asks for that row's action menu.
 *
 * `ContextMenu` and `Shift+F10` are the platform conventions, and on macOS
 * neither one exists: an Apple keyboard has no ContextMenu key, and F10 is a
 * system media key unless the user has changed a global setting. Rename, Move,
 * Delete and Download live only behind this menu, and the `•••` affordance is
 * deliberately out of the tab order so Tab leaves the tree in one press — so
 * with only the two conventions those actions were unreachable from a Mac
 * keyboard. `Control+Enter` is the third door and the only one every platform
 * can open; it is declared on the row as `aria-keyshortcuts` so it is findable
 * rather than folklore.
 */
export function workspaceRowMenuKey(event: Readonly<{ key: string; shiftKey: boolean; ctrlKey: boolean }>): boolean {
  if (event.key === "ContextMenu") return true;
  if (event.key === "F10") return event.shiftKey;
  return event.key === "Enter" && event.ctrlKey;
}

/** The rendered tree row at a flattened index, if the window is showing it. */
function treeRowElement(index: number): HTMLButtonElement | null {
  if (index < 0 || typeof document === "undefined") return null;
  return document.querySelector<HTMLButtonElement>(`[data-workspace-tree-index="${String(index)}"]`);
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
 *
 * These four numbers are the JS half of `--tree-row` in workspace-view.css and
 * must move with it: this one drives the virtualization window, that one draws
 * the box, and a disagreement between them desyncs the window from the rows.
 * They fell from 42/34/30 because the rail had opted out of the density block
 * entirely — five rows for three files were spending 210px of it.
 */
function workspaceRowHeight(): number {
  if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return 44;
  if (typeof innerWidth === "number" && innerWidth <= 760) return 44;
  if (typeof document === "undefined") return WORKSPACE_FILE_ROW_HEIGHT;
  return document.documentElement.dataset.density === "comfortable" ? 32 : document.documentElement.dataset.density === "compact" ? 24 : WORKSPACE_FILE_ROW_HEIGHT;
}

/**
 * One drawn line of the Explorer: a tree node, or a text hit inside a file.
 *
 * `id` is what the keyboard, the roving tabindex and the reveal request all
 * index on, and it is the one field the two kinds cannot share — a hit and the
 * file that holds it have the same `path`, so a path-keyed lookup would find
 * the wrong row for one of them. `path` stays the thing the row *acts* on, so
 * a hit opens, reveals and menus its own file without a second code path.
 */
export type ExplorerRow = Readonly<{
  id: string;
  path: string;
  depth: number;
  node?: VisibleWorkspaceNode;
  match?: WorkspaceContentMatch;
  /** On a file row: how many of this scan's hits are inside it. */
  hits?: number;
}>;

/** How much of a 240-character snippet a hit row spends on its accessible name. */
export const WORKSPACE_HIT_LABEL_MAX = 120;

/** The snippet as a hit row announces it: one readable line, never the cap. */
export function workspaceHitLabel(snippet: string, max = WORKSPACE_HIT_LABEL_MAX): string {
  const text = snippet.trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/**
 * Interleave the tree's visible nodes with the text hits found inside them.
 *
 * The shipped alternative was a mode: the tree for paths, a flat list for text,
 * and the reader choosing between them from a segmented control before typing.
 * One list means one virtualization window, one keyboard path, and — the part
 * that matters to a reader — one answer to "where is this thing", whether the
 * thing is a filename or a line of code.
 */
export function explorerRows(
  visible: readonly VisibleWorkspaceNode[],
  hitsByPath: ReadonlyMap<string, readonly WorkspaceContentMatch[]>,
): readonly ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  for (const node of visible) {
    const hits = node.kind === "file" ? hitsByPath.get(node.path) : undefined;
    rows.push(Object.freeze({ id: node.path, path: node.path, depth: node.depth, node, ...(hits?.length ? { hits: hits.length } : {}) }));
    for (const match of hits ?? []) {
      rows.push(Object.freeze({
        id: `${match.path}#${String(match.line)}:${String(match.column)}`,
        path: match.path,
        depth: node.depth + 1,
        match,
      }));
    }
  }
  return Object.freeze(rows);
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

// Defined with the strip sentence that names it, in `workbench-model`, and
// re-exported here so the cap and the words describing it cannot drift.
export { WORKSPACE_GUTTER_LINE_LIMIT };

/**
 * What the Explorer says when the filter matches nothing.
 *
 * Filtering to zero used to render literally nothing inside `role="tree"`: the
 * only signal was the 12px "0 of 412 files" counter above it, and on a phone —
 * where the Explorer is a full-screen pane of its own — a mistyped filter was a
 * blank screen. Sessions, the model picker and Index all name the term they
 * failed to match and offer the way out; the Explorer was the outlier.
 *
 * The term is quoted verbatim rather than summarized, because the reader's next
 * act is to correct a typo they cannot see any other way.
 *
 * One sentence for one search. There used to be two — "No path matches" and
 * "No file contains" — because there were two modes, and each of them told the
 * reader to go and try the other one. The field now runs both, so the empty
 * state has to account for both in the same breath: how many paths were
 * compared, how many files were actually read, and every bound that fired while
 * they were. A scan that stopped early may never be reported as an exhaustive
 * one, and "nothing matched" is the exact sentence where that would be easiest
 * to imply by omission.
 */
export function workspaceFilterEmptyCopy(
  filter: string,
  total: number,
  scan?: WorkspaceContentSearch,
): Readonly<{ title: string; detail: string; action: string }> {
  const term = filter.trim();
  const paths = `${String(total)} file${total === 1 ? "" : "s"} ${total === 1 ? "is" : "are"} in this workspace, and no path contains it.`;
  const read = scan
    ? ` ${String(scan.scannedFiles)} of them ${scan.scannedFiles === 1 ? "was" : "were"} read for text: ${workspaceSearchSummary(scan)}. Binary and oversized files are skipped.`
    : "";
  return Object.freeze({
    title: `Nothing matches “${term}”`,
    detail: `${paths}${read}`,
    action: "Clear filter",
  });
}

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

function measureWrappedGutter(element: HTMLPreElement, draft: string): readonly [number[], number] {
  const node = element.firstChild!;
  const box = element.getBoundingClientRect();
  const range = document.createRange();
  const tops: number[] = [];
  let start = 0;
  for (const line of draft.split("\n")) {
    range.setStart(node, start);
    range.collapse(true);
    tops.push(range.getBoundingClientRect().top - box.top);
    start += line.length + 1;
  }
  return [tops, element.scrollHeight];
}

export function boundedWorkspaceContent(content: string, byteLimit: number, knownTotalBytes?: number) { if (!Number.isInteger(byteLimit) || byteLimit < 1) throw new Error("Workspace byte limit must be a positive integer."); const bytes = new TextEncoder().encode(content); const totalBytes = Math.max(bytes.byteLength, knownTotalBytes ?? 0); if (bytes.byteLength <= byteLimit) return Object.freeze({ content, shownBytes: bytes.byteLength, totalBytes, truncated: totalBytes > bytes.byteLength }); const bounded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, byteLimit)); return Object.freeze({ content: bounded, shownBytes: new TextEncoder().encode(bounded).byteLength, totalBytes, truncated: true }); }
