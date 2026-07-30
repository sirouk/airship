import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import type { BrowserGitClient } from "../git/client";
import type { TerminalGitReview } from "../git/terminal-commands";
import type { ClientEncryptedWorkspacePort, WorkspacePort } from "../workspace/contracts";
import { nextTabId, stripViewport, tabBox, tabScrollLeft } from "./tabs";
import { getBrowserTerminalManager, type BrowserTerminalManager } from "../terminal/manager";
import { WEB_CONTAINER_TERMINAL_RUNTIME, type TerminalSessionSnapshot } from "../terminal/contracts";
import { durabilityLabel, type DurabilityState } from "./durability-indicator";
import { Icon } from "./icons";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import { readTerminalDockState, terminalDockStorageKey, terminalOpenRequestForAuthority, updateTerminalDockState, type TerminalOpenRequest } from "./terminal-dock-state";
import "./terminal-view.css";

export { terminalOpenRequestForAuthority } from "./terminal-dock-state";
export type { TerminalOpenRequest } from "./terminal-dock-state";

/**
 * Where the runtime band's open state lives between visits.
 *
 * The band was 183px of permanently-open explanation on desktop — its own
 * `<summary>` was `display: none` above 760px, so the one control that could
 * close it was invisible. It is a disclosure now at every width, which means
 * its state has to survive a route change or closing it would be a gesture the
 * user repeats forever.
 */
export const TERMINAL_SETUP_STORAGE_KEY = "airship.terminal.setup.v1";

/**
 * Closed by default, and only a stored choice reopens it.
 *
 * Deliberately not "open on first visit": the four facts the band carried are
 * now on the summary row itself, so nothing is hidden by the default except
 * the paragraph, which the summary names.
 */
export function readTerminalSetupOpen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(TERMINAL_SETUP_STORAGE_KEY) === "open";
  } catch {
    // A blocked or partitioned storage is not an error worth surfacing here;
    // it just means the band starts closed, which is the default anyway.
    return false;
  }
}

function writeTerminalSetupOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(TERMINAL_SETUP_STORAGE_KEY, open ? "open" : "closed");
  } catch { /* Page-memory only. The band still works for this page's lifetime. */ }
}

/**
 * The boundary the Profile switch actually enforces, said plainly.
 *
 * Only the workspace mount is Profile-owned: handoff unmounts and rebuilds it.
 * The rest of the WebContainer filesystem is booted once per page and shared by
 * every Profile that uses the terminal in that page, so anything a shell writes
 * outside the mount survives the switch. Stated here rather than assumed,
 * because the alternative — a container teardown and reboot per handoff — is a
 * multi-second cost that has not been taken.
 */
export const TERMINAL_CONTAINER_SCOPE_NOTICE = "Only the workspace mount is Profile-owned. The rest of this WebContainer's filesystem is page-shared: it is booted once per page, so anything a shell writes outside the mount is visible to every Profile that uses the terminal in this page and survives a Profile switch.";

export type TerminalEmulatorWrite =
  | Readonly<{ kind: "append"; text: string }>
  | Readonly<{ kind: "redraw"; text: string }>
  | Readonly<{ kind: "none" }>;

/**
 * What the emulator has to be told, given what it last rendered.
 *
 * The manager publishes a *sliding* 256 KiB tail. Past that cap the buffer is
 * no longer append-only, so a view that reconstructed the delta by prefix
 * matching fell through to clear-and-rewrite on every single chunk — 256 KiB
 * of writes per keystroke of output. The sequence removes the inference: one
 * step forward is exactly `appendedOutput`, and only a discontinuity (first
 * mount, resubscribe, a reconstructed session) is worth a full redraw.
 * xterm's own 5,000-line scrollback owns history from there.
 */
export function terminalEmulatorWrite(
  rendered: number | undefined,
  next: Pick<TerminalSessionSnapshot, "outputSequence" | "appendedOutput" | "bufferedOutput">,
): TerminalEmulatorWrite {
  if (rendered === next.outputSequence) return Object.freeze({ kind: "none" });
  if (rendered !== undefined && next.outputSequence === rendered + 1 && next.appendedOutput) {
    return Object.freeze({ kind: "append", text: next.appendedOutput });
  }
  return Object.freeze({ kind: "redraw", text: next.bufferedOutput });
}

/** The one status vocabulary, fed by the terminal's own lifecycle. */
export function terminalSealState(status: TerminalSessionSnapshot["status"]): SealState {
  if (status === "running") return "verified";
  if (status === "starting") return "checking";
  if (status === "failed") return "failed";
  if (status === "restart-required") return "attention";
  return "none";
}

/**
 * Whether selecting a tab may cold-start its session.
 *
 * `exited` and `failed` are endings with evidence on screen — final output,
 * the exit code — and each owns an explicit Restart button. Merely selecting
 * such a tab must not silently spend that evidence on a respawn: the manager
 * would happily start it again (`start()` only short-circuits a live process),
 * and the scrollback the user came to read would be the price. An idle or
 * restart-required session has no process output to lose, so being shown may
 * pick it back up.
 */
export function terminalPanelAutoStart(status: TerminalSessionSnapshot["status"]): boolean {
  return status !== "exited" && status !== "failed";
}

export type TerminalDurability = Readonly<{ state: DurabilityState; detail?: string; label?: string }>;
export type TerminalViewProps = Readonly<{
  workspace: WorkspacePort;
  /** Retained for app compatibility; the terminal never injects browser-Git commands into PTY scrollback. */
  git: BrowserGitClient;
  reviewGit: TerminalGitReview;
  onWorkspaceChanged?(): void | Promise<void>;
  threadId?: string;
  /** App integration seam: pass the active profile so tabs never cross profile cockpits. */
  profileId?: string;
  profileName?: string;
  /** Stable authority name used only to partition browser-session surface state. */
  workspaceIdentity?: string;
  /** App integration seam: the active workspace/journal durability claim. */
  durability?: TerminalDurability;
  /** App/Workspace seam: one idempotent request to open a new tab at a selected directory. */
  openRequest?: TerminalOpenRequest;
  onOpenRequestHandled?(requestId: string): void;
  workspaceRoot?: string;
  variant?: "route" | "dock";
  onCollapse?(): void;
  onOpenFullView?(): void;
}>;

export function terminalPersistenceNotice(durability: TerminalDurability, profileId?: string): string {
  const scope = profileId ? `Profile ${profileId}` : "Unscoped legacy terminal";
  if (durability.state === "ephemeral") return `${scope} tab metadata, bounded transcript, input history, and lineage live only in this page's workspace memory. Reload loses them; processes also end.`;
  if (durability.state === "syncing") return `${scope} terminal metadata is queued through the active encrypted workspace while synchronization is in progress. Processes remain page-local.`;
  // A stopped sync is not a running one: the writes reach the adopted vault's
  // encrypted objects, and nothing carries them off this browser until it is
  // reachable again.
  if (durability.state === "sync-paused") return `${scope} terminal metadata is written to the adopted encrypted workspace, but nothing is synchronizing while this browser cannot reach it. Processes remain page-local.`;
  return `${scope} tab metadata, bounded transcript, input history, and lineage are retained through the active encrypted workspace. Processes still restart after reload.`;
}

/**
 * What the footer may claim, given what durable writes have actually done.
 *
 * A persistence failure was previously swallowed while this line kept promising
 * the lineage was retained, so the two could never disagree. An observed
 * failure now replaces the claim outright, and its return is the claim's only
 * licence to come back.
 */
export function terminalFooterNotice(notice: string, persistenceFailure?: string): string {
  return persistenceFailure
    ? `Terminal metadata, transcript and lineage are not reaching storage: ${persistenceFailure} Nothing shown here is retained until this clears.`
    : notice;
}

/** Infer only what the workspace port proves. App should pass its richer durability state. */
export function inferredTerminalDurability(workspace: WorkspacePort): TerminalDurability {
  const encryptionBoundary = (workspace as Partial<ClientEncryptedWorkspacePort>).encryptionBoundary;
  if (encryptionBoundary === "airship-client-envelope-v1") {
    return Object.freeze({
      state: "local",
      label: "Client-encrypted workspace · tier unknown",
      detail: "The active workspace proves Airship's client-encryption boundary. Its backing tier was not supplied to Terminal, so this view does not claim device or cloud synchronization.",
    });
  }
  return Object.freeze({
    state: "ephemeral",
    detail: "No durable or client-encrypted workspace capability was supplied to Terminal. Metadata is treated as page/workspace-memory only.",
  });
}

export function TerminalView(props: TerminalViewProps) {
  const workspaceIdentity = props.workspaceIdentity ?? "page-memory";
  const profileId = props.profileId ?? "legacy-unscoped";
  const scope = terminalDockStorageKey(workspaceIdentity, profileId);
  const scopedOpenRequest = terminalOpenRequestForAuthority(props.openRequest, workspaceIdentity, profileId);
  useEffect(() => {
    if (props.openRequest && !scopedOpenRequest) props.onOpenRequestHandled?.(props.openRequest.id);
  }, [props.openRequest?.id, scopedOpenRequest, props.onOpenRequestHandled]);
  return <ProfileScopedTerminalView key={scope} {...props} workspaceIdentity={workspaceIdentity} openRequest={scopedOpenRequest} />;
}

function ProfileScopedTerminalView({ workspace, onWorkspaceChanged, threadId, profileId, profileName, workspaceIdentity = "page-memory", durability, openRequest, onOpenRequestHandled, workspaceRoot = "/workspace", variant = "route", onCollapse, onOpenFullView }: TerminalViewProps) {
  const effectiveDurability = durability ?? inferredTerminalDurability(workspace);
  const manager = useMemo(() => getBrowserTerminalManager(workspace, profileId), [workspace]);
  const [sessions, setSessions] = useState<readonly TerminalSessionSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(() => readTerminalDockState(browserSessionStorage(), workspaceIdentity, profileId ?? "legacy-unscoped").selectedSessionId);
  const [notice, setNotice] = useState("Loading terminal metadata through the active workspace…");
  const [syncing, setSyncing] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [setupOpen, setSetupOpen] = useState(() => readTerminalSetupOpen(globalThis.localStorage));
  const [persistenceFailure, setPersistenceFailure] = useState<string>();
  const [reconcilable, setReconcilable] = useState(false);
  const cancelRename = useRef(false);
  const strip = useRef<HTMLDivElement>(null);
  const workspaceChanged = useRef(onWorkspaceChanged);
  workspaceChanged.current = onWorkspaceChanged;
  const openRequestHandled = useRef(onOpenRequestHandled);
  openRequestHandled.current = onOpenRequestHandled;

  useEffect(() => {
    updateTerminalDockState(browserSessionStorage(), workspaceIdentity, profileId ?? "legacy-unscoped", { selectedSessionId: activeId ?? "" });
  }, [activeId, workspaceIdentity, profileId]);

  useEffect(() => {
    let current = true;
    const unsubscribe = manager.subscribeList((next) => {
      if (!current) return;
      setSessions(next);
      setActiveId((selected) => next.some(({ id }) => id === selected)
        ? selected
        : next.find((session) => threadId && session.threadId === threadId)?.id ?? next[0]?.id);
    }, profileId);
    void manager.ready.then(() => {
      if (!current) return;
      const ensured = openRequest
        ? manager.openWorkspaceSession({
            requestId: openRequest.id,
            ...(profileId ? { profileId } : {}),
            ...(threadId ? { threadId } : {}),
            ...(openRequest.name ? { name: openRequest.name } : {}),
            cwd: openRequest.cwd,
          })
        : manager.ensureProfileSession({ ...(profileId ? { profileId } : {}), ...(threadId ? { threadId } : {}), cwd: workspaceRoot });
      if (openRequest) {
        setActiveId(ensured.id);
        setNotice(`Opened a terminal at ${ensured.cwd}.`);
        openRequestHandled.current?.(openRequest.id);
      } else {
        setActiveId((selected) => selected ?? ensured.id);
        setNotice(terminalPersistenceNotice(effectiveDurability, profileId));
      }
    }).catch((error) => {
      if (current) setNotice(error instanceof Error ? error.message : "Terminal metadata could not be loaded.");
    });
    return () => { current = false; unsubscribe(); };
  }, [manager, threadId, profileId, workspaceRoot, openRequest?.id, openRequest?.cwd, openRequest?.name, effectiveDurability.state, effectiveDurability.detail]);

  useEffect(() => manager.subscribeWorkspace(() => {
    void workspaceChanged.current?.();
  }), [manager]);

  // The retention claim is only allowed to come from writes that landed. While
  // metadata is failing to persist, the footer says so instead of repeating the
  // declared durability tier back at the user.
  useEffect(() => manager.subscribePersistence(setPersistenceFailure), [manager]);

  // Host authority and the mount are not session state, so reading
  // `canReconcile()` during render only ever happened to be right when a
  // session emission chanced to accompany the flip. It is a subscription of its
  // own now: acquiring the mount publishes before the PTY spawns, and losing it
  // publishes even when every tab is idle and nothing else changes.
  useEffect(() => manager.subscribeReconcile(setReconcilable), [manager]);

  // Eight tabs at a 9rem floor is ~1.2kpx of strip in a 390px phone, so a tab
  // created by "New here" or by the dock's ＋ is selected off-screen while the
  // panel below already shows it. Keyboard movement scrolls itself because it
  // moves focus; selection by click or by creation does not, which is exactly
  // the case `Tabs` fixes and this strip was rebuilding without. The rule is
  // `tabs.tsx`'s measured one — deliberately not `scrollIntoView`, which also
  // scrolls every scrollable ancestor and takes the page with it.
  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    for (const child of box.children) {
      if (!(child instanceof HTMLElement) || child.dataset.tabId !== activeId) continue;
      const next = tabScrollLeft(tabBox(box, child), stripViewport(box));
      if (next !== box.scrollLeft) box.scrollLeft = next;
    }
    // Keyed on the id list, as `Tabs` is: a name edit changes tab widths but
    // not which tab has to be reachable, and re-measuring on every keystroke of
    // a rename would fight the input for the strip's scroll position.
  }, [activeId, sessions.map(({ id }) => id).join(" ")]);

  const active = sessions.find(({ id }) => id === activeId);
  const createTab = () => {
    const created = manager.create({ ...(profileId ? { profileId } : {}), ...(threadId ? { threadId } : {}), cwd: workspaceRoot, origin: threadId ? { kind: "conversation" } : { kind: "terminal-route" } });
    setActiveId(created.id);
  };
  const sync = async () => {
    setSyncing(true);
    try {
      const paths = await manager.syncWorkspace(active?.id);
      setNotice(paths.length ? `Synced ${paths.length} revision-fenced workspace change${paths.length === 1 ? "" : "s"}.` : "Workspace is already synchronized.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Workspace synchronization failed safely.");
    } finally { setSyncing(false); }
  };
  /**
   * Selection follows focus, per the tablist pattern. Returns whether the key
   * belonged to the strip, so a key it does not own — Tab above all — is left
   * alone rather than turned into a keyboard trap.
   */
  const moveTab = (key: string): boolean => {
    const next = nextTabId(sessions.map(({ id, name }) => ({ id, label: name })), activeId ?? "", key);
    if (next === undefined) return false;
    setActiveId(next);
    for (const child of strip.current?.children ?? []) {
      if (!(child instanceof HTMLElement) || child.dataset.tabId !== next) continue;
      child.querySelector<HTMLButtonElement>('button[role="tab"]')?.focus();
    }
    return true;
  };
  const beginRename = (session: TerminalSessionSnapshot) => {
    cancelRename.current = false;
    setActiveId(session.id);
    setRenameValue(session.name);
    setRenamingId(session.id);
  };
  const commitRename = (sessionId: string, value: string) => {
    if (cancelRename.current) {
      cancelRename.current = false;
      setRenamingId(undefined);
      return;
    }
    try {
      manager.rename(sessionId, value);
      setNotice(`Terminal renamed to ${value.trim()}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Terminal tab could not be renamed.");
    } finally {
      setRenamingId(undefined);
    }
  };

  return (
    <section
      class={`terminal-route ${variant === "dock" ? "terminal-route--dock" : ""}`}
      // A process room, not a document: the shell's 1160px prose measure left
      // ~640px of empty gutter per side at 1920px while the transcript inside
      // wrapped. `routes.css` reads this attribute; the dock variant is not a
      // route child, so the declaration is simply inert there.
      data-route-measure="wide"
      aria-labelledby={variant === "dock" ? "workspace-terminal-dock-title" : "terminal-title"}
    >
      {/* The 54px eyebrow-plus-serif-H1 block named a route the rail already
          shows as selected. The words survive: the eyebrow is the ⓘ panel's
          heading, and the notes below it are facts this route states nowhere
          else — including which shell a tab actually spawns. */}
      {variant === "route" ? <RouteHeader
        class="terminal-route__header"
        routeId="terminal"
        density="tool"
        title="Terminal"
        eyebrow="Workspace · browser process room"
        description="Interactive page-local processes with profile-scoped, workspace-backed tab metadata, bounded transcripts, input history, and lineage."
        headingId="terminal-title"
        notes={<>
          {/* Verified against `manager.ts`, which spawns `jsh`, and against
              `execution-tools.ts`, where airship-sh is the agent's shell
              runtime. Neither claim is inferred from the other. */}
          <p>Each tab spawns one persistent, interactive <code>jsh</code> PTY inside the page's WebContainer. It is not host Bash or Linux. The real WASIX Bash pack currently runs bounded disposable jobs, so Airship does not inject commands into it and mislabel that as a terminal.</p>
          <p>{profileId ? `Owned by profile ${profileName ?? profileId}.` : "This app integration has not supplied a profile ID, so these are legacy unscoped tabs."} {threadId ? `Attached to conversation thread ${threadId}.` : "No conversation thread is attached to this route."}</p>
        </>}
        actions={<div class="terminal-route__actions">
          {/* Enabled by the fact the manager actually holds — a mounted host
              with a baseline — not by a session-status proxy for it. A failed
              tab's mount is still reconcilable, and that was the work at risk.
              Read from the manager's own signal, never re-derived here. */}
          <button type="button" onClick={() => void sync()} disabled={syncing || !reconcilable}><Icon name="cloud" size={16} />{syncing ? "Reconciling…" : "Reconcile workspace"}</button>
          <button type="button" onClick={createTab} disabled={sessions.length >= 8}><span aria-hidden="true">＋</span> New terminal</button>
        </div>}
      /> : <header class="terminal-dock__toolbar">
        <div class="terminal-dock__identity">
          <Icon name="terminal" size={16} />
          <strong id="workspace-terminal-dock-title">Terminal</strong>
          <small>{WEB_CONTAINER_TERMINAL_RUNTIME.engineLabel} · {WEB_CONTAINER_TERMINAL_RUNTIME.shellLabel} · page-local, not Bash/Linux</small>
          <span>{profileId ? `Profile ${profileName ?? compactId(profileId)}` : "Legacy unscoped"}</span>
        </div>
        <div class="terminal-dock__actions">
          <button type="button" onClick={() => void sync()} disabled={syncing || !reconcilable} aria-label="Reconcile terminal workspace"><Icon name="cloud" size={15} /><span>{syncing ? "Reconciling…" : "Reconcile"}</span></button>
          <button type="button" onClick={createTab} disabled={sessions.length >= 8} aria-label="New terminal"><span aria-hidden="true">＋</span><span>New</span></button>
          {onOpenFullView ? <button type="button" onClick={onOpenFullView} aria-label="Open full Terminal view"><span aria-hidden="true">↗</span><span>Full view</span></button> : null}
          {onCollapse ? <button type="button" onClick={onCollapse} aria-label="Collapse terminal dock"><span aria-hidden="true">⌄</span><span>Collapse</span></button> : null}
        </div>
      </header>}

      {/* One 44px row that carries every fact the 183px band carried on its
          face, and holds only the boundary paragraph inside. Its own control
          is visible at every width now, and the choice is remembered. */}
      {variant === "route" ? <details class="terminal-route__setup" open={setupOpen} onToggle={(event) => {
        setSetupOpen(event.currentTarget.open);
        writeTerminalSetupOpen(event.currentTarget.open);
      }}>
        <summary>
          <span><Icon name="terminal" size={16} /><strong>{WEB_CONTAINER_TERMINAL_RUNTIME.engineLabel} · {WEB_CONTAINER_TERMINAL_RUNTIME.shellLabel}</strong></span>
          <small>Interactive PTY, not Bash/Linux or a device shell — read the boundary</small>
          <span class="terminal-assurance" role="note">
            <span>Interactive process · this page</span>
            <span>Metadata · {terminalDurabilityLabel(effectiveDurability)}</span>
            <span>{profileId ? `Profile ${compactId(profileId)}` : "Legacy unscoped"}</span>
          </span>
        </summary>
        <div class="terminal-route__setup-body">
          <p>Real interactive Node processes run inside this page's WebContainer. This is not your device shell, host Bash, SSH, or a remote Airship backend. {effectiveDurability.detail ?? terminalPersistenceNotice(effectiveDurability, profileId)}</p>
          {/* Stated where someone can act on it: the mount is the Profile
              boundary, and the shell can reach past it. A Profile switch
              unmounts the workspace projection, which is all this manager
              owns — the WebContainer is booted once per page and cannot be
              rebooted per Profile without a multi-second teardown. */}
          <p>{TERMINAL_CONTAINER_SCOPE_NOTICE}</p>
        </div>
      </details> : null}

      {/* `role="tab"` obliges the whole widget contract, not just the styling:
          one tab in the tab order, ←/→/Home/End moving selection and focus.
          The movement rule is `tabs.tsx`'s `nextTabId` rather than a second
          copy of it — this strip cannot adopt `Tabs` itself because a tab
          being renamed is replaced by a text input, which `TabItem` has no
          shape for. */}
      <div ref={strip} class="terminal-tabs" role="tablist" aria-label="Terminal tabs" onKeyDown={(event) => {
        // The rename input lives inside the strip and owns its own arrows.
        if (event.target instanceof HTMLInputElement) return;
        if (moveTab(event.key)) event.preventDefault();
      }}>
        {sessions.map((session) => <div key={session.id} class="terminal-tab" role="presentation" data-tab-id={session.id} data-active={session.id === activeId ? "true" : "false"}>
          {renamingId === session.id ? <input
            class="terminal-tab__name-input"
            aria-label={`Rename ${session.name}`}
            value={renameValue}
            maxLength={80}
            autoFocus
            onInput={(event) => setRenameValue(event.currentTarget.value)}
            onBlur={(event) => commitRename(session.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { cancelRename.current = true; event.currentTarget.blur(); }
            }}
          /> : <button
            type="button"
            role="tab"
            id={terminalTabId(session.id)}
            aria-selected={session.id === activeId}
            aria-controls={terminalPanelId(session.id)}
            tabIndex={session.id === activeId ? 0 : -1}
            onClick={() => setActiveId(session.id)}
            onDblClick={() => beginRename(session)}
          >
            {/* The status word was printed twice within 90px — here and again
                in the panel bar below. It is one seal now, and the word it
                dropped is the seal's accessible name. */}
            <Seal state={terminalSealState(session.status)} label={statusLabel(session)} density="dot" size={16} />
            <span class="terminal-tab__label"><strong>{session.name}</strong></span>
          </button>}
          <button class="terminal-tab__rename" type="button" aria-label={`Rename ${session.name}`} title="Rename terminal" onClick={() => beginRename(session)}>✎</button>
        </div>)}
      </div>

      {active ? <TerminalPanel
        key={active.id}
        manager={manager}
        session={active}
        onNotice={setNotice}
        durability={effectiveDurability}
        profileLabel={profileName ?? profileId}
        onNewHere={() => {
          try {
            const created = manager.create({
              ...(active.profileId ? { profileId: active.profileId } : {}),
              ...(active.threadId ? { threadId: active.threadId } : {}),
              cwd: active.cwd,
              name: `${active.name} copy`,
              origin: { kind: "workspace-path", path: active.cwd },
            });
            setActiveId(created.id);
            setNotice(`Started a new terminal at ${active.cwd}.`);
          } catch (error) {
            setNotice(error instanceof Error ? error.message : "A terminal could not be opened at this path.");
          }
        }}
      /> : (
        <div class="terminal-empty"><Icon name="terminal" /><h2>No terminal tab</h2><p>Create a tab to cold-start an isolated browser runtime.</p><button type="button" onClick={createTab}>New terminal</button></div>
      )}
      <footer class="terminal-route__footer" role="status">
        {persistenceFailure
          ? <Seal state="attention" label="Terminal metadata is not reaching storage" density="dot" size={15} />
          : <Icon name="proof" size={15} />}
        <span>{terminalFooterNotice(notice, persistenceFailure)}</span>
      </footer>
    </section>
  );
}

function TerminalPanel({ manager, session: initial, onNotice, durability, profileLabel, onNewHere }: Readonly<{
  manager: BrowserTerminalManager;
  session: TerminalSessionSnapshot;
  onNotice(message: string): void;
  durability: TerminalDurability;
  profileLabel?: string;
  onNewHere(): void;
}>) {
  const [session, setSession] = useState(initial);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const renderedSequence = useRef<number>();
  const chromeSignature = useRef(sessionChromeSignature(initial));

  useEffect(() => manager.subscribe(initial.id, (next) => {
    host.current?.setAttribute("data-output-chars", String(next.bufferedOutput.length));
    const emulator = terminal.current;
    if (emulator) {
      const action = terminalEmulatorWrite(renderedSequence.current, next);
      if (action.kind === "redraw") emulator.clear();
      if (action.kind !== "none") emulator.write(action.text);
      renderedSequence.current = next.outputSequence;
    }
    const signature = sessionChromeSignature(next);
    if (signature !== chromeSignature.current) {
      chromeSignature.current = signature;
      setSession(next);
    }
  }), [manager, initial.id]);

  useEffect(() => {
    if (!host.current) return;
    const typography = terminalTypography(document.documentElement.dataset.density);
    const emulator = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
      scrollback: 5_000,
      screenReaderMode: true,
      theme: { background: "#0b0e0f", foreground: "#e6e0d2", cursor: "#d5b66f", selectionBackground: "#506a7655", black: "#111517", brightBlack: "#647078", red: "#d97767", green: "#83b99a", yellow: "#d5b66f", blue: "#79a9c8", magenta: "#b495cc", cyan: "#72bbb4", white: "#ded8ca" },
    });
    const fitter = new FitAddon();
    emulator.loadAddon(fitter);
    emulator.open(host.current);
    terminal.current = emulator;
    // One full write on mount; every later chunk arrives as its own append.
    if (initial.bufferedOutput) emulator.write(initial.bufferedOutput);
    renderedSequence.current = initial.outputSequence;
    const sendInput = (data: string) => {
      if (!data) return;
      void manager.write(initial.id, data).catch((error) => onNotice(error instanceof Error ? error.message : "Terminal input failed safely."));
    };
    const input = emulator.onData(sendInput);
    const binary = emulator.onBinary(sendInput);
    let frame = 0;
    let autoStartPending = true;
    let lastDimensions = "";
    const layout = () => {
      frame = 0;
      try {
        fitter.fit();
        const dimensions = { cols: emulator.cols, rows: emulator.rows };
        const key = `${dimensions.cols}x${dimensions.rows}`;
        if (key !== lastDimensions) {
          lastDimensions = key;
          manager.resize(initial.id, dimensions);
        }
        if (autoStartPending) {
          autoStartPending = false;
          // Being selected is a view, not a start command — ended sessions
          // keep their final output until the explicit Restart control says so
          // (`terminalPanelAutoStart` names the startable statuses).
          if (terminalPanelAutoStart(initial.status)) {
            void manager.start(initial.id, dimensions).catch((error) => onNotice(error instanceof Error ? error.message : "Terminal could not start."));
          }
        }
      } catch { /* Hidden route or zero-size transition. */ }
    };
    const scheduleLayout = () => {
      if (!frame) frame = requestAnimationFrame(layout);
    };
    const resize = new ResizeObserver(scheduleLayout);
    resize.observe(host.current);
    const densityObserver = new MutationObserver(() => {
      const next = terminalTypography(document.documentElement.dataset.density);
      emulator.options.fontSize = next.fontSize;
      emulator.options.lineHeight = next.lineHeight;
      scheduleLayout();
    });
    densityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    scheduleLayout();
    return () => {
      resize.disconnect();
      densityObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      input.dispose();
      binary.dispose();
      emulator.dispose();
      terminal.current = undefined;
    };
  }, [initial.id, manager, onNotice]);

  const dimensions = () => ({ cols: terminal.current?.cols ?? 100, rows: terminal.current?.rows ?? 30 });
  const restart = () => void manager.restart(session.id, dimensions());
  const close = async () => {
    try {
      await manager.close(session.id);
      onNotice(durability.state === "ephemeral"
        ? "Terminal tab closed. Its process ended; bounded lineage remains only for this page/workspace lifetime."
        : "Terminal tab closed. Its process ended; bounded lineage remains retained by the active encrypted workspace.");
    } catch (error) {
      onNotice(error instanceof Error ? `Terminal remains open: ${error.message}` : "Terminal remains open because workspace reconciliation failed.");
    }
  };
  const pasteInput = (command: string) => {
    void manager.write(session.id, command).then(() => {
      onNotice("Pasted prior input into the interactive PTY without submitting it.");
    }, (error) => {
      onNotice(error instanceof Error ? error.message : "Prior input could not be pasted into this terminal.");
    });
  };

  return <div class="terminal-panel" id={terminalPanelId(session.id)} role="tabpanel" aria-labelledby={terminalTabId(session.id)}>
    <div class="terminal-panel__bar">
      {/* The seal is hidden from the accessible tree because the word it
          carries is the `<strong>` immediately beside it — shape and word are
          both present visually, and the name is said once. */}
      <div><span aria-hidden="true"><Seal state={terminalSealState(session.status)} label={statusLabel(session)} density="dot" size={16} /></span><strong>{statusLabel(session)}</strong><code title={session.cwd}>{session.cwd}</code>{session.threadId ? <span title={session.threadId}>thread {compactId(session.threadId)}</span> : null}</div>
      <div>
        {session.status === "running" ? <button type="button" onClick={() => void manager.interrupt(session.id)} aria-label="Interrupt process">⌃C <span>Interrupt</span></button> : <span class="terminal-panel__starting" aria-live="polite">{statusLabel(session)}</span>}
        <button type="button" onClick={onNewHere} aria-label="New terminal at current directory" title={`New terminal at ${session.cwd}`}><span aria-hidden="true">＋</span> <span>New here</span></button>
        <button type="button" onClick={restart} disabled={session.status === "starting"}><Icon name="branch" size={14} /> Restart</button>
        <button type="button" onClick={() => void close()} aria-label="Close terminal tab">× <span>Close</span></button>
      </div>
    </div>
    <div
      class="terminal-emulator"
      ref={host}
      role="group"
      aria-label={`${session.name} browser terminal`}
      data-output-chars={session.bufferedOutput.length}
    />
    <div class="terminal-panel__meta">
      <span>{session.detail}</span>
      <div class="terminal-panel__meta-actions">
        <details>
          <summary>Input history · {session.history.length}</summary>
          <div class="terminal-panel__popover terminal-panel__history">
            <p>Lines captured when submitted to the PTY. Shell-side editing and completion may differ; resulting bytes remain in the bounded transcript.</p>
            {session.history.length ? <ol>{session.history.slice().reverse().map((command, index) => <li key={`${index}-${command}`}><code>{command}</code><button type="button" disabled={session.status !== "running"} onClick={() => pasteInput(command)} aria-label={`Paste input: ${command}`}>Paste</button></li>)}</ol> : <p>No submitted input recorded for this session.</p>}
          </div>
        </details>
        <details>
          <summary>Audit lineage · {session.audit.length}</summary>
          <div class="terminal-panel__popover terminal-panel__lineage">
            <dl>
              <div><dt>Session</dt><dd><code>{compactId(session.id)}</code></dd></div>
              <div><dt>Profile</dt><dd>{profileLabel ?? session.profileId ?? "Legacy unscoped"}</dd></div>
              <div><dt>Runtime</dt><dd>{session.runtime.engineLabel} · {session.runtime.shellLabel}</dd></div>
              <div><dt>Process</dt><dd>epoch {session.processEpoch} · page-local</dd></div>
              <div><dt>Origin</dt><dd>{originLabel(session)}</dd></div>
              <div><dt>Metadata</dt><dd>{terminalDurabilityLabel(durability)}{session.reconstructed ? " · reconstructed" : ""}</dd></div>
            </dl>
            {session.audit.length ? <ol>{session.audit.slice().reverse().map((record) => <li key={record.id}>
              <span><strong>{auditKindLabel(record.kind)}</strong> · {record.outcome} · epoch {record.processEpoch}</span>
              <small>{record.summary}</small>
              {record.command ? <code>{record.command}</code> : null}
            </li>)}</ol> : <p>No lifecycle records yet. Starting the PTY creates the first record.</p>}
          </div>
        </details>
      </div>
    </div>
  </div>;
}

function statusLabel(session: TerminalSessionSnapshot): string {
  if (session.status === "restart-required") return "Restart required";
  if (session.status === "exited") return `Exited ${session.exitCode ?? "?"}`;
  return `${session.status[0]?.toUpperCase()}${session.status.slice(1)}`;
}

function compactId(value: string): string { return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value; }

/**
 * The tab/panel id pair. Only the selected session's panel is in the DOM — a
 * terminal panel owns a live PTY viewport, so the unselected ones are not
 * rendered hidden — which is why `aria-labelledby` on the panel points back at
 * the tab that is guaranteed to exist.
 */
function terminalPanelId(sessionId: string): string { return `terminal-panel-${sessionId}`; }
function terminalTabId(sessionId: string): string { return `terminal-tab-${sessionId}`; }

function terminalDurabilityLabel(durability: TerminalDurability): string {
  return durability.label ?? durabilityLabel(durability.state);
}

function originLabel(session: TerminalSessionSnapshot): string {
  if (session.origin.kind === "workspace-path") return `Workspace · ${session.origin.path ?? session.cwd}`;
  if (session.origin.kind === "conversation") return session.threadId ? `Conversation · ${compactId(session.threadId)}` : "Conversation";
  return "Terminal route";
}

function auditKindLabel(kind: TerminalSessionSnapshot["audit"][number]["kind"]): string {
  if (kind === "interactive-input") return "PTY input";
  if (kind === "process-start") return "Process start";
  if (kind === "process-exit") return "Process exit";
  return "Workspace reconcile";
}

export function terminalTypography(density?: string): Readonly<{ fontSize: number; lineHeight: number }> {
  if (density === "comfortable") return Object.freeze({ fontSize: 15, lineHeight: 1.35 });
  if (density === "compact") return Object.freeze({ fontSize: 12, lineHeight: 1.18 });
  return Object.freeze({ fontSize: 13, lineHeight: 1.25 });
}

function sessionChromeSignature(session: TerminalSessionSnapshot): string {
  return JSON.stringify([
    session.name,
    session.profileId,
    session.threadId,
    session.origin,
    session.runtime,
    session.cwd,
    session.status,
    session.exitCode,
    session.detail,
    session.processEpoch,
    session.lastProcessStartedAt,
    session.closedAt,
    session.reconstructed,
    session.history,
    session.audit,
  ]);
}

function browserSessionStorage(): Storage | undefined {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
}
