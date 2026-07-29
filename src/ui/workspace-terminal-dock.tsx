import { useEffect, useRef, useState } from "preact/hooks";
import type { BrowserGitClient } from "../git/client";
import type { TerminalGitReview } from "../git/terminal-commands";
import type { WorkspacePort } from "../workspace/contracts";
import { Icon } from "./icons";
import {
  TERMINAL_DOCK_EDITOR_FLOOR,
  TERMINAL_DOCK_MIN_HEIGHT,
  TERMINAL_DOCK_RESIZE_STEP,
  readTerminalDockState,
  terminalDockHeight,
  terminalDockStorageKey,
  terminalOpenRequestForAuthority,
  updateTerminalDockState,
  type TerminalDockState,
  type TerminalOpenRequest,
} from "./terminal-dock-state";
import type { TerminalDurability } from "./terminal-view";
import "./workspace-terminal-dock.css";

type TerminalComponent = typeof import("./terminal-view").TerminalView;

export type WorkspaceTerminalDockProps = Readonly<{
  workspace: WorkspacePort;
  workspaceIdentity: string;
  profileId: string;
  profileName?: string;
  threadId?: string;
  git: BrowserGitClient;
  reviewGit: TerminalGitReview;
  durability: TerminalDurability;
  openRequest?: TerminalOpenRequest;
  onOpenRequestHandled?(requestId: string): void;
  onWorkspaceChanged?(): void | Promise<void>;
  onOpenFullView(): void;
  workspaceRoot?: string;
}>;

/** Keyed wrapper prevents one profile's transient dock layout flashing in another cockpit. */
export function WorkspaceTerminalDock(props: WorkspaceTerminalDockProps) {
  const scope = terminalDockStorageKey(props.workspaceIdentity, props.profileId);
  return <ProfileScopedWorkspaceTerminalDock key={scope} {...props} />;
}

function ProfileScopedWorkspaceTerminalDock(props: WorkspaceTerminalDockProps) {
  const root = useRef<HTMLElement>(null);
  const scopedOpenRequest = terminalOpenRequestForAuthority(props.openRequest, props.workspaceIdentity, props.profileId);
  const [TerminalSurface, setTerminalSurface] = useState<TerminalComponent>();
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<TerminalDockState>(() => readTerminalDockState(
    browserSessionStorage(),
    props.workspaceIdentity,
    props.profileId,
    availableDockHeight(),
  ));

  const commit = (patch: Partial<TerminalDockState>, availableHeight = availableDockHeight(root.current)) => {
    const next = updateTerminalDockState(browserSessionStorage(), props.workspaceIdentity, props.profileId, patch, availableHeight);
    setState(next);
  };

  useEffect(() => {
    if (scopedOpenRequest) commit({ open: true });
    else if (props.openRequest) props.onOpenRequestHandled?.(props.openRequest.id);
  }, [props.openRequest?.id, scopedOpenRequest, props.onOpenRequestHandled]);

  useEffect(() => {
    if (!state.open || TerminalSurface || loadError) return;
    let current = true;
    setLoadError(undefined);
    void import("./terminal-view").then((module) => {
      if (current) setTerminalSurface(() => module.TerminalView);
    }).catch(() => {
      if (current) setLoadError("The browser terminal could not be loaded. Existing manager-owned sessions were not closed.");
    });
    return () => { current = false; };
  }, [state.open, TerminalSurface, loadError]);

  useEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const nextHeight = terminalDockHeight(state.height, parent.clientHeight);
      if (nextHeight !== state.height) commit({ height: nextHeight }, parent.clientHeight);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [state.height, props.workspaceIdentity, props.profileId]);

  const maximum = dockMaximum(root.current);
  const resize = (height: number) => commit({ height }, availableDockHeight(root.current));
  const handleResizeKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp") { event.preventDefault(); resize(state.height + TERMINAL_DOCK_RESIZE_STEP); }
    else if (event.key === "ArrowDown") { event.preventDefault(); resize(state.height - TERMINAL_DOCK_RESIZE_STEP); }
    else if (event.key === "Home") { event.preventDefault(); resize(TERMINAL_DOCK_MIN_HEIGHT); }
    else if (event.key === "End") { event.preventDefault(); resize(maximum); }
  };

  return <section
    ref={root}
    class="workspace-terminal-dock"
    data-open={state.open ? "true" : "false"}
    style={{ "--terminal-dock-height": `${String(state.height)}px` }}
    aria-label="Workspace terminal dock"
  >
    {state.open ? <div
      class="workspace-terminal-dock__resize"
      role="separator"
      aria-label="Terminal dock height"
      aria-orientation="horizontal"
      aria-valuenow={state.height}
      aria-valuemin={TERMINAL_DOCK_MIN_HEIGHT}
      aria-valuemax={maximum}
      tabIndex={0}
      title="Drag, or use Up and Down arrows, to resize the terminal dock"
      onKeyDown={handleResizeKey}
      onDblClick={() => resize(320)}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const parent = root.current?.parentElement?.getBoundingClientRect();
        if (parent) resize(parent.bottom - event.clientY);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
    /> : null}

    {state.open ? TerminalSurface ? <TerminalSurface
      workspace={props.workspace}
      workspaceIdentity={props.workspaceIdentity}
      profileId={props.profileId}
      {...(props.profileName ? { profileName: props.profileName } : {})}
      {...(props.threadId ? { threadId: props.threadId } : {})}
      git={props.git}
      reviewGit={props.reviewGit}
      durability={props.durability}
      {...(scopedOpenRequest ? { openRequest: scopedOpenRequest } : {})}
      {...(props.onOpenRequestHandled ? { onOpenRequestHandled: props.onOpenRequestHandled } : {})}
      {...(props.onWorkspaceChanged ? { onWorkspaceChanged: props.onWorkspaceChanged } : {})}
      workspaceRoot={props.workspaceRoot ?? "/workspace"}
      variant="dock"
      onCollapse={() => commit({ open: false })}
      onOpenFullView={props.onOpenFullView}
    /> : <div class="workspace-terminal-dock__loading" role={loadError ? "alert" : "status"}>
      <Icon name="terminal" size={17} />
      <span>{loadError ?? "Loading the profile terminal…"}</span>
      {loadError ? <button type="button" onClick={() => { setLoadError(undefined); setTerminalSurface(undefined); }}>Retry</button> : null}
      <button type="button" onClick={props.onOpenFullView}>Open full Terminal view</button>
      <button type="button" onClick={() => commit({ open: false })}>Collapse terminal dock</button>
    </div> : <div class="workspace-terminal-dock__collapsed">
      <button type="button" aria-expanded="false" onClick={() => commit({ open: true })}>
        <Icon name="terminal" size={16} />
        <strong>Terminal</strong>
        <span>WebContainer jsh</span>
        <small>Expand dock — existing page-local processes keep running</small>
      </button>
      <button type="button" onClick={props.onOpenFullView} aria-label="Open full Terminal view">↗ <span>Full view</span></button>
    </div>}
  </section>;
}

function browserSessionStorage(): Storage | undefined {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
}

function availableDockHeight(root?: HTMLElement | null): number | undefined {
  const parentHeight = root?.parentElement?.clientHeight;
  if (parentHeight && parentHeight > 0) return parentHeight;
  return typeof innerHeight === "number" ? Math.max(TERMINAL_DOCK_MIN_HEIGHT + TERMINAL_DOCK_EDITOR_FLOOR, innerHeight - 96) : undefined;
}

function dockMaximum(root?: HTMLElement | null): number {
  const available = availableDockHeight(root);
  return typeof available === "number"
    ? Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.floor(available) - TERMINAL_DOCK_EDITOR_FLOOR)
    : 720;
}
