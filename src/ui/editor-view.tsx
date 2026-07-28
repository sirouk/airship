import { useEffect, useMemo, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import type { GitOperation, GitOperationDescriptor } from "../git/types";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { durabilityLabel, type DurabilityState } from "./durability-indicator";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import type { SourcesImportRequest } from "./sources-view";
import { Tabs } from "./tabs";
import { WORKBENCH_SHARED_SURFACE_NOTE, workbenchIdentity } from "./workbench-model";
import { WorkspaceView } from "./workspace-view";
import "./editor-view.css";

type SourcesComponent = typeof import("./sources-view").SourcesView;

export type EditorViewProps = Readonly<{
  files: readonly WorkspaceEntry[];
  selected?: WorkspaceFile;
  onOpen(path: string): void | Promise<void>;
  workspace: WorkspacePort;
  git: BrowserGitClient;
  review(operation: GitOperation, descriptor: GitOperationDescriptor): Promise<"allow" | "deny">;
  reviewImport(request: SourcesImportRequest): Promise<"allow" | "deny">;
  onWorkspaceChanged(): void | Promise<void>;
  durability: Readonly<{ state: DurabilityState; detail: string }>;
  workspaceIdentity?: string;
}>;

const VIEW_TABS = Object.freeze([
  Object.freeze({ id: "files", label: "Files & editor" }),
  Object.freeze({ id: "sources", label: "Sources" }),
]);

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
  const [mode, setMode] = useState<"files" | "sources">("files");
  const [Sources, setSources] = useState<SourcesComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [hash, setHash] = useState(() => typeof location === "undefined" ? "" : location.hash);
  const identity = useMemo(() => workbenchIdentity(hash), [hash]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setHash(location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (mode !== "sources" || Sources) return;
    let current = true;
    setLoadError(undefined);
    void import("./sources-view").then((module) => {
      if (current) setSources(() => module.SourcesView);
    }).catch(() => {
      if (current) setLoadError("The full source-control tools could not be loaded. Workspace files and drafts were not changed.");
    });
    return () => { current = false; };
  }, [mode, Sources]);

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
      actions={<Tabs
        class="editor-route__tabs"
        label="Workspace views"
        items={VIEW_TABS}
        activeId={mode}
        onSelect={(id) => setMode(id === "sources" ? "sources" : "files")}
        panelId={(id) => `workbench-panel-${id}`}
      />}
    />
    <div class="editor-route__panel" data-mode={mode} id={`workbench-panel-${mode}`} role="tabpanel" aria-labelledby="workbench-route-title">
      {mode === "files" ? <WorkspaceView
        files={props.files}
        selected={props.selected}
        onOpen={props.onOpen}
        workspace={props.workspace}
        workspaceIdentity={props.workspaceIdentity}
        git={props.git}
        review={props.review}
        onWorkspaceChanged={props.onWorkspaceChanged}
        onOpenRepositoryManager={() => setMode("sources")}
        opensPane={identity.opensPane}
      /> : Sources ? <Sources
        client={props.git}
        author={{ name: "Local Airship User", email: "airship@local.invalid" }}
        review={props.review}
        workspace={props.workspace}
        reviewImport={props.reviewImport}
        onWorkspaceChanged={props.onWorkspaceChanged}
        workspaceDurability={props.durability}
      /> : <div class="editor-route__loading" role={loadError ? "alert" : "status"}>{loadError ?? "Loading full browser source control…"}</div>}
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
  const seal: SealState = state === "ephemeral" ? "none" : state === "syncing" ? "checking" : "verified";
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
          Open tabs are remembered for this browser tab. Unsaved drafts are not — closing or reloading this page discards them.
        </p>
      </Popover>
    </span>
  );
}
