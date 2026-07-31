import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import type { GitOperation, GitOperationDescriptor } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { durabilityLabel, durabilitySeal, type DurabilityState } from "./durability-indicator";
import { trapFocus } from "./focus-trap";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import type { SourcesImportRequest } from "./sources-view";
import { WORKBENCH_SHARED_SURFACE_NOTE, workbenchIdentity } from "./workbench-model";
import { WorkspaceView, workspaceWorkbenchScope } from "./workspace-view";
import type { TerminalOpenRequest } from "./terminal-dock-state";
import { WorkspaceTerminalDock } from "./workspace-terminal-dock";
import "./editor-view.css";

type SourcesComponent = typeof import("./sources-view").SourcesView;

export type EditorViewProps = Readonly<{
  /** Active cockpit owner for all page-local workbench view state. */
  profileId: string;
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen(path: string): void | Promise<void>;
  workspace: WorkspacePort;
  git: BrowserGitClient;
  review(operation: GitOperation, descriptor: GitOperationDescriptor): Promise<"allow" | "deny">;
  reviewImport(request: SourcesImportRequest): Promise<"allow" | "deny">;
  onWorkspaceChanged(): void | Promise<void>;
  onOpenTerminalAt?(cwd: string): void;
  terminalOpenRequest?: TerminalOpenRequest;
  onTerminalOpenRequestHandled?(requestId: string): void;
  onOpenFullTerminal?(): void;
  threadId?: string;
  profileName?: string;
  durability: Readonly<{ state: DurabilityState; detail: string }>;
  workspaceIdentity?: string;
  /**
   * Bumped by the shell on every request for a destination, including a repeat
   * of the one already on screen. The route→pane mapping is keyed on this
   * rather than on the hash value, because the hash is unchanged for exactly
   * the case that needs re-applying: the workbench opened a file into its
   * editor pane without leaving `#workspace`, and tapping Workspace again — or
   * a same-document navigation back to it — must return to the tree.
   */
  destinationArrival?: number;
}>;

/**
 * One Workspace destination with lightweight editing and full source control.
 *
 * `app.tsx` renders this component for both `#workspace` and `#editor` and
 * passes no discriminator, which is how the shipped screen ended up with three
 * names: a rail row saying Workspace, an H1 saying Editor and an eyebrow saying
 * PAGE WORKSPACE. The route is read from the hash here — the only source of the
 * answer this file can reach without an `app.tsx` edit — so each destination
 * states its own name and opens its own pane.
 */
export function EditorView(props: EditorViewProps) {
  const sourceToolsAuthority = workspaceWorkbenchScope(props.workspaceIdentity ?? "page-memory", props.profileId);
  // Record the authority that opened the sheet rather than a bare boolean.
  // A profile/workspace switch therefore removes the prior inventory in the
  // same render that receives the new authority; an effect never gets one
  // paint in which to expose the former profile's repository state.
  const [sourceToolsAuthorityOpen, setSourceToolsAuthorityOpen] = useState<string>();
  const sourceToolsOpen = sourceToolsAuthorityOpen === sourceToolsAuthority;
  const [Sources, setSources] = useState<SourcesComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [hash, setHash] = useState(() => typeof location === "undefined" ? "" : location.hash);
  const identity = useMemo(() => workbenchIdentity(hash), [hash]);
  const sourceToolsDialog = useRef<HTMLDivElement>(null);
  const sourceToolsClose = useRef<HTMLButtonElement>(null);
  const sourceToolsOpener = useRef<HTMLElement>();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setHash(location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    // Back/forward between the two workbench doors is a same-document
    // navigation: Chrome answers it with `popstate`, and only fires
    // `hashchange` when the fragment differs from the one already displayed.
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  useEffect(() => {
    if (sourceToolsAuthorityOpen === undefined || sourceToolsOpen) return;
    setSourceToolsAuthorityOpen(undefined);
    sourceToolsOpener.current = undefined;
  }, [sourceToolsAuthorityOpen, sourceToolsOpen]);

  useEffect(() => {
    if (!sourceToolsOpen || Sources) return;
    let current = true;
    setLoadError(undefined);
    void import("./sources-view").then((module) => {
      if (current) setSources(() => module.SourcesView);
    }).catch(() => {
      if (current) setLoadError("The full source-control tools could not be loaded. Workspace files and drafts were not changed.");
    });
    return () => { current = false; };
  }, [sourceToolsOpen, Sources]);

  useEffect(() => {
    if (!sourceToolsOpen) return;
    const frame = requestAnimationFrame(() => sourceToolsClose.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [sourceToolsOpen]);

  function openSourceTools(): void {
    sourceToolsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setLoadError(undefined);
    setSourceToolsAuthorityOpen(sourceToolsAuthority);
  }

  function closeSourceTools(): void {
    setSourceToolsAuthorityOpen(undefined);
    const opener = sourceToolsOpener.current;
    sourceToolsOpener.current = undefined;
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  }

  return <section class="editor-route" aria-label="Workspace editor">
    {/*
      One 44px bar replaces 315px of desktop chrome (375px on a phone): the
      route tabs, the mono eyebrow, a 47px serif H1, a two-line paragraph and a
      floating durability pill. Nothing is deleted — the eyebrow and the
      sentence are the ⓘ panel, verbatim, and the pill is the chip beside it.
    */}
    <RouteHeader
      class="editor-route__header"
      routeId={identity.routeId}
      density="tool"
      title={identity.title}
      eyebrow={identity.eyebrow}
      description={identity.description}
      headingId="workbench-route-title"
      notes={<p class="route-header__about-description">{WORKBENCH_SHARED_SURFACE_NOTE}</p>}
      status={<WorkbenchDurabilityChip state={props.durability.state} detail={props.durability.detail} />}
    />
    <div class="editor-route__panel" data-mode="files" role="group" aria-labelledby="workbench-route-title">
      <div class="editor-workbench-host" aria-hidden={sourceToolsOpen ? "true" : undefined}>
      <WorkspaceView
        profileId={props.profileId}
        files={props.files}
        selected={props.selected}
        onOpen={props.onOpen}
        workspace={props.workspace}
        workspaceIdentity={props.workspaceIdentity}
        durability={props.durability}
        git={props.git}
        review={props.review}
        onWorkspaceChanged={props.onWorkspaceChanged}
        onOpenTerminalAt={props.onOpenTerminalAt}
        onOpenRepositoryManager={openSourceTools}
        opensPane={identity.opensPane}
        opensPaneArrival={props.destinationArrival ?? 0}
        opensActivity={sourceToolsOpen ? "source" : "explorer"}
      />
      </div>
      <WorkspaceTerminalDock
        workspace={props.workspace}
        workspaceIdentity={props.workspaceIdentity ?? "page-memory"}
        profileId={props.profileId}
        {...(props.profileName ? { profileName: props.profileName } : {})}
        {...(props.threadId ? { threadId: props.threadId } : {})}
        git={props.git}
        reviewGit={props.review}
        durability={props.durability}
        {...(props.terminalOpenRequest ? { openRequest: props.terminalOpenRequest } : {})}
        {...(props.onTerminalOpenRequestHandled ? { onOpenRequestHandled: props.onTerminalOpenRequestHandled } : {})}
        onWorkspaceChanged={props.onWorkspaceChanged}
        onOpenFullView={props.onOpenFullTerminal ?? (() => { if (typeof location !== "undefined") location.hash = "terminal"; })}
      />
      {sourceToolsOpen ? <div class="source-tools-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) closeSourceTools(); }}>
        <div
          class="source-tools-dialog"
          ref={sourceToolsDialog}
          role="dialog"
          aria-modal="true"
          aria-label="Advanced source controls"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeSourceTools(); }
            else if (event.key === "Tab") trapFocus(event, sourceToolsDialog.current);
          }}
        >
          <button ref={sourceToolsClose} class="source-tools-close" type="button" onClick={closeSourceTools}>Close advanced source controls</button>
          {Sources ? <Sources
            key={sourceToolsAuthority}
            embedded
            client={props.git}
            author={{ name: "Local Airship User", email: "airship@local.invalid" }}
            review={props.review}
            workspace={props.workspace}
            reviewImport={props.reviewImport}
            onWorkspaceChanged={props.onWorkspaceChanged}
            workspaceDurability={props.durability}
            witnessScope={sourceToolsAuthority}
          /> : <div class="editor-route__loading" role={loadError ? "alert" : "status"}>{loadError ?? "Loading advanced browser source controls…"}</div>}
        </div>
      </div> : null}
    </div>
  </section>;
}

/**
 * Where this workspace lives, as a chip that opens its own sentence.
 *
 * The shipped `DurabilityIndicator` put its detail in `title=` and nowhere
 * else, so on every touch device — and for every keyboard user — the sentence
 * explaining what "Ephemeral" costs you was unreachable. Same words, one rung
 * down the ladder instead of zero rungs and a hover.
 */
function WorkbenchDurabilityChip({ state, detail }: Readonly<{ state: DurabilityState; detail: string }>) {
  const label = durabilityLabel(state);
  const seal: SealState = durabilitySeal(state);
  return (
    // `role="status"` is kept from the retired pill: adopting a vault while
    // this route is open is a state change that has to be announced.
    <span class="workbench-durability" role="status">
      <Popover
        class="workbench-durability__popover"
        label={`Workspace durability. ${label}. ${detail}`}
        heading="Workspace durability"
        trigger={<Seal state={seal} density="chip" label={label} />}
      >
        <p class="workbench-durability__detail">{detail}</p>
        <p class="workbench-durability__detail">
          Open tabs and layout are remembered for this profile in this browser tab. Unsaved drafts stay in this page and profile only — closing or reloading discards them.
        </p>
      </Popover>
    </span>
  );
}
