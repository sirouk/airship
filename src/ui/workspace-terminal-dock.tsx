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
  terminalDockFitsPanel,
  terminalDockHeight,
  terminalDockMaximum,
  terminalDockMinimum,
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
  /*
   * The measured panel, held in state rather than only read off the DOM during
   * render, because whether the dock may open at all now depends on it. The
   * resize observer below used to commit only when the clamped HEIGHT changed,
   * and a panel can cross the fitness threshold without moving the height by a
   * pixel — a landscape phone whose panel goes 380px to 327px leaves a dock
   * already at 220px exactly where it was. Nothing re-rendered, and the dock
   * stayed open in a box that could not hold it.
   */
  const [panelHeight, setPanelHeight] = useState<number>();
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

  const available = panelHeight ?? availableDockHeight(root.current);
  const maximum = terminalDockMaximum(available);
  /*
   * Home goes to the shortest the dock may be made, which is the shortest it
   * may be at all. A separator that reports `aria-valuemin` above its own
   * `aria-valuemax` describes a range that does not exist to the one reader who
   * cannot see the split; on every panel that renders a separator the maximum
   * is now at least this number, so that cannot be stated.
   */
  const minimum = terminalDockMinimum();
  /*
   * The reader asked for a terminal and this panel has no terminal to give:
   * see `terminalDockFitsPanel` for the two viewports and the 246px of dock
   * chrome that measurement is. `state.open` is deliberately left alone — the
   * request outlives the rotation that cannot honour it, so turning a landscape
   * phone upright restores the dock exactly as it was left.
   *
   * Gated on the OBSERVED panel and not on `available`, whose unseen-viewport
   * fallback is a guess from `innerHeight`. A guess is the right shape of
   * answer for a clamp, which only has to pick a height, and the wrong shape
   * for this, which decides whether a surface exists: a window whose fallback
   * came out short would close a dock for one frame and open it again the
   * moment the observer spoke. Until the panel has actually been measured this
   * is `undefined`, which `terminalDockFitsPanel` reads as "believe the
   * reader" — and in a runtime with no `ResizeObserver` it stays undefined, so
   * the dock behaves exactly as it did before this gate existed.
   */
  const open = state.open && terminalDockFitsPanel(panelHeight);

  useEffect(() => {
    if (scopedOpenRequest) commit({ open: true });
    else if (props.openRequest) props.onOpenRequestHandled?.(props.openRequest.id);
  }, [props.openRequest?.id, scopedOpenRequest, props.onOpenRequestHandled]);

  useEffect(() => {
    // Gated on `open`, not on `state.open`: a dock that will render its closed
    // bar has nothing to do with the terminal chunk, and fetching it there
    // spends a phone's bandwidth on a surface it is not going to show.
    if (!open || TerminalSurface || loadError) return;
    let current = true;
    setLoadError(undefined);
    void import("./terminal-view").then((module) => {
      if (current) setTerminalSurface(() => module.TerminalView);
    }).catch(() => {
      if (current) setLoadError("The browser terminal could not be loaded. Existing manager-owned sessions were not closed.");
    });
    return () => { current = false; };
  }, [open, TerminalSurface, loadError]);

  useEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    let resizeFrame: number | undefined;
    const measure = () => {
      resizeFrame = undefined;
      setPanelHeight(parent.clientHeight);
      const nextHeight = terminalDockHeight(state.height, parent.clientHeight);
      if (nextHeight !== state.height) commit({ height: nextHeight }, parent.clientHeight);
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrame === undefined) resizeFrame = requestAnimationFrame(measure);
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    };
  }, [state.height, props.workspaceIdentity, props.profileId]);

  const resize = (height: number) => commit({ height }, availableDockHeight(root.current));
  const handleResizeKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowUp") { event.preventDefault(); resize(state.height + TERMINAL_DOCK_RESIZE_STEP); }
    else if (event.key === "ArrowDown") { event.preventDefault(); resize(state.height - TERMINAL_DOCK_RESIZE_STEP); }
    else if (event.key === "Home") { event.preventDefault(); resize(minimum); }
    else if (event.key === "End") { event.preventDefault(); resize(maximum); }
  };

  return <section
    ref={root}
    class="workspace-terminal-dock"
    data-open={open ? "true" : "false"}
    style={{ "--terminal-dock-height": `${String(state.height)}px` }}
    aria-label="Workspace terminal dock"
  >
    {open ? <div
      class="workspace-terminal-dock__resize"
      role="separator"
      aria-label="Terminal dock height"
      aria-orientation="horizontal"
      aria-valuenow={state.height}
      aria-valuemin={minimum}
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

    {open ? TerminalSurface ? <TerminalSurface
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
    </div> : state.open ? <div class="workspace-terminal-dock__collapsed" data-reason="no-room">
      {/*
        * The dock the reader asked for, in a panel that cannot hold one, saying
        * so. What it replaced was not a smaller terminal: at 932x430 it was a
        * 17px transcript under a process card whose bottom border ran off the
        * screen, and at 320x568 an 8px one with the card's thread line drawn
        * across its own divider. The wide control leads with the surface that
        * does have the room, because "expand" here would be a button that
        * cannot do what it says; Collapse stays so the reader can put the dock
        * away for good rather than have it reappear on the next rotation.
        *
        * The action rides the `span` and not the `small`, because `small` is
        * the field this bar drops below 760px — which is where two of the three
        * panels that reach this state live, and the last place a reader should
        * be told there is nowhere else to read their output.
        */}
      <button type="button" onClick={props.onOpenFullView}>
        <Icon name="terminal" size={16} />
        <strong>Terminal</strong>
        <span>No room for output — open full view</span>
        <small>Page-local processes keep running</small>
      </button>
      <button type="button" onClick={() => commit({ open: false })} aria-label="Collapse terminal dock">⌄ <span>Collapse</span></button>
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
