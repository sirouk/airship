import type { ComponentChildren } from "preact";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import type { BrowserGitClient } from "../git/client";
import { runTerminalGitCommand, type TerminalGitReview } from "../git/terminal-commands";
import type { WorkspacePort } from "../workspace/contracts";
import { getBrowserTerminalManager, type BrowserTerminalManager } from "../terminal/manager";
import type { TerminalSessionSnapshot } from "../terminal/contracts";
import { Icon } from "./icons";
import { RouteHeader } from "./route-header";
import { Seal, type SealState } from "./seal";
import "./terminal-view.css";

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

/** The one status vocabulary, fed by the terminal's own lifecycle. */
export function terminalSealState(status: TerminalSessionSnapshot["status"]): SealState {
  if (status === "running") return "verified";
  if (status === "starting") return "checking";
  if (status === "failed") return "failed";
  if (status === "restart-required") return "attention";
  return "none";
}

export function TerminalView({ workspace, git, reviewGit, onWorkspaceChanged, threadId, workspaceRoot = "/workspace" }: Readonly<{
  workspace: WorkspacePort;
  git: BrowserGitClient;
  reviewGit: TerminalGitReview;
  onWorkspaceChanged?(): void | Promise<void>;
  threadId?: string;
  workspaceRoot?: string;
}>) {
  const manager = useMemo(() => getBrowserTerminalManager(workspace), [workspace]);
  const [sessions, setSessions] = useState<readonly TerminalSessionSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [notice, setNotice] = useState("Loading encrypted terminal metadata…");
  const [syncing, setSyncing] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [gitCommand, setGitCommand] = useState("git status");
  const [gitRunning, setGitRunning] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() => readTerminalSetupOpen(globalThis.localStorage));
  const cancelRename = useRef(false);
  const workspaceChanged = useRef(onWorkspaceChanged);
  workspaceChanged.current = onWorkspaceChanged;

  useEffect(() => {
    let current = true;
    const unsubscribe = manager.subscribeList((next) => {
      if (!current) return;
      setSessions(next);
      setActiveId((selected) => next.some(({ id }) => id === selected)
        ? selected
        : next.find((session) => threadId && session.threadId === threadId)?.id ?? next[0]?.id);
    });
    void manager.ready.then(() => current && setNotice("Tab metadata is stored through the active encrypted workspace. Process memory remains page-local."), (error) => {
      if (current) setNotice(error instanceof Error ? error.message : "Terminal metadata could not be loaded.");
    });
    return () => { current = false; unsubscribe(); };
  }, [manager, threadId]);

  useEffect(() => manager.subscribeWorkspace(() => {
    void workspaceChanged.current?.();
  }), [manager]);

  const active = sessions.find(({ id }) => id === activeId);
  const runGit = async () => {
    if (!active || gitRunning) return;
    setGitRunning(true);
    try {
      const result = await runTerminalGitCommand({ command: gitCommand, cwd: active.cwd, client: git, review: reviewGit });
      manager.recordBridgeCommand(active.id, gitCommand, result.output);
      if (result.changed) await onWorkspaceChanged?.();
      setNotice(result.changed ? "Shared Git state updated; Editor, agent tools, and source control now see the same revision." : "Shared Git command completed against the authoritative browser repository.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Shared Git command failed safely.";
      manager.recordBridgeCommand(active.id, gitCommand, `error: ${message}\n`);
      setNotice(message);
    } finally {
      setGitRunning(false);
    }
  };
  const createTab = () => {
    const created = manager.create({ ...(threadId ? { threadId } : {}), cwd: workspaceRoot });
    setActiveId(created.id);
  };
  const sync = async () => {
    setSyncing(true);
    try {
      const paths = await manager.syncWorkspace();
      setNotice(paths.length ? `Synced ${paths.length} revision-fenced workspace change${paths.length === 1 ? "" : "s"}.` : "Workspace is already synchronized.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Workspace synchronization failed safely.");
    } finally { setSyncing(false); }
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
    <section class="terminal-route" aria-labelledby="terminal-title">
      {/* The 54px eyebrow-plus-serif-H1 block named a route the rail already
          shows as selected. The words survive: the eyebrow is the ⓘ panel's
          heading, and the notes below it are facts this route states nowhere
          else — including which shell a tab actually spawns. */}
      <RouteHeader
        class="terminal-route__header"
        routeId="terminal"
        density="tool"
        title="Terminal"
        eyebrow="Workspace · browser process room"
        description="Interactive processes, a Shared Git bridge onto the browser repository, and per-tab command history, all held inside this page."
        headingId="terminal-title"
        notes={<>
          {/* Verified against `manager.ts`, which spawns `jsh`, and against
              `execution-tools.ts`, where airship-sh is the agent's shell
              runtime. Neither claim is inferred from the other. */}
          <p>Each tab spawns <code>jsh</code>, the WebContainer image's own shell. <code>airship-sh</code>, Airship's first-party POSIX interpreter, runs the agent's shell tool and is <strong>not</strong> selectable as a terminal tab in this build, so a script <code>jsh</code> rejects cannot be retried here.</p>
          <p>{threadId ? `Attached to conversation thread ${threadId}.` : "No conversation thread is attached to this route."}</p>
        </>}
        actions={<div class="terminal-route__actions">
          <button type="button" onClick={() => void sync()} disabled={syncing || !sessions.some(({ status }) => status === "running" || status === "exited")}><Icon name="cloud" size={16} />{syncing ? "Reconciling…" : "Reconcile workspace"}</button>
          <button type="button" onClick={createTab} disabled={sessions.length >= 8}><span aria-hidden="true">＋</span> New terminal</button>
        </div>}
      />

      {/* One 44px row that carries every fact the 183px band carried on its
          face, and holds only the boundary paragraph inside. Its own control
          is visible at every width now, and the choice is remembered. */}
      <details class="terminal-route__setup" open={setupOpen} onToggle={(event) => {
        setSetupOpen(event.currentTarget.open);
        writeTerminalSetupOpen(event.currentTarget.open);
      }}>
        <summary>
          <span><Icon name="terminal" size={16} /><strong>Browser Node shell</strong></span>
          <small>WebContainer, not a device shell — read the boundary</small>
          <span class="terminal-assurance" role="note">
            <span>Processes stay hot while this page lives</span>
            <span>Reload requires process restart</span>
            <span>{threadId ? `Thread ${compactId(threadId)}` : "No conversation thread attached"}</span>
          </span>
        </summary>
        <div class="terminal-route__setup-body">
          <p>Real interactive Node processes run inside this page's WebContainer. This is not your device shell, host Bash, SSH, or a remote Airship backend.</p>
        </div>
      </details>

      <div class="terminal-tabs" role="tablist" aria-label="Terminal tabs">
        {sessions.map((session) => <div key={session.id} class="terminal-tab" role="presentation" data-active={session.id === activeId ? "true" : "false"}>
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
          /> : <button type="button" role="tab" aria-selected={session.id === activeId} onClick={() => setActiveId(session.id)} onDblClick={() => beginRename(session)}>
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
        bridge={<form class="terminal-git-bridge" onSubmit={(event) => { event.preventDefault(); void runGit(); }}>
          {/* Output from this form is echoed into the same scrollback as the
              shell's, so the line has to say which authority produced it. */}
          <span class="terminal-git-bridge__mark" aria-hidden="true">git▸</span>
          <label for="terminal-git-command"><strong>Shared Git</strong><span>Authoritative Editor/source-control state · approval policy applies</span></label>
          <input id="terminal-git-command" value={gitCommand} spellcheck={false} onInput={(event) => setGitCommand(event.currentTarget.value)} aria-describedby="terminal-git-detail" />
          <button type="submit" disabled={!active || gitRunning}>{gitRunning ? "Running…" : "Run"}</button>
          <small id="terminal-git-detail">This deterministic bridge uses browser Git directly; the WebContainer never receives a second copy of <code>.git</code>. Try <code>git help</code>.</small>
        </form>}
      /> : (
        <div class="terminal-empty"><Icon name="terminal" /><h2>No terminal tab</h2><p>Create a tab to cold-start an isolated browser runtime.</p><button type="button" onClick={createTab}>New terminal</button></div>
      )}
      <footer class="terminal-route__footer" role="status"><Icon name="proof" size={15} /><span>{notice}</span></footer>
    </section>
  );
}

function TerminalPanel({ manager, session: initial, onNotice, bridge }: Readonly<{
  manager: BrowserTerminalManager;
  session: TerminalSessionSnapshot;
  onNotice(message: string): void;
  /** The Shared Git form, rendered as the panel's own footer strip. */
  bridge: ComponentChildren;
}>) {
  const [session, setSession] = useState(initial);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const renderedOutput = useRef("");
  const chromeSignature = useRef(sessionChromeSignature(initial));

  useEffect(() => manager.subscribe(initial.id, (next) => {
    host.current?.setAttribute("data-output-chars", String(next.bufferedOutput.length));
    const emulator = terminal.current;
    if (emulator && next.bufferedOutput !== renderedOutput.current) {
      if (next.bufferedOutput.startsWith(renderedOutput.current)) emulator.write(next.bufferedOutput.slice(renderedOutput.current.length));
      else { emulator.clear(); emulator.write(next.bufferedOutput); }
      renderedOutput.current = next.bufferedOutput;
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
    if (initial.bufferedOutput) {
      emulator.write(initial.bufferedOutput);
      renderedOutput.current = initial.bufferedOutput;
    }
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
          void manager.start(initial.id, dimensions).catch((error) => onNotice(error instanceof Error ? error.message : "Terminal could not start."));
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
  const close = async () => { await manager.close(session.id); onNotice("Terminal tab closed. Its page-local process was terminated."); };

  return <div class="terminal-panel">
    <div class="terminal-panel__bar">
      {/* The seal is hidden from the accessible tree because the word it
          carries is the `<strong>` immediately beside it — shape and word are
          both present visually, and the name is said once. */}
      <div><span aria-hidden="true"><Seal state={terminalSealState(session.status)} label={statusLabel(session)} density="dot" size={16} /></span><strong>{statusLabel(session)}</strong><code title={session.cwd}>{session.cwd}</code>{session.threadId ? <span title={session.threadId}>thread {compactId(session.threadId)}</span> : null}</div>
      <div>
        {session.status === "running" ? <button type="button" onClick={() => void manager.interrupt(session.id)} aria-label="Interrupt process">⌃C <span>Interrupt</span></button> : <span class="terminal-panel__starting" aria-live="polite">{statusLabel(session)}</span>}
        <button type="button" onClick={restart} disabled={session.status === "starting"}><Icon name="branch" size={14} /> Restart</button>
        <button type="button" onClick={() => void close()} aria-label="Close terminal tab">× <span>Close</span></button>
      </div>
    </div>
    <div
      class="terminal-emulator"
      ref={host}
      aria-label={`${session.name} browser terminal`}
      data-output-chars={session.bufferedOutput.length}
    />
    {bridge}
    <div class="terminal-panel__meta"><span>{session.detail}</span><details><summary>Command history · {session.history.length}</summary>{session.history.length ? <ol>{session.history.slice().reverse().map((command, index) => <li key={`${index}-${command}`}><code>{command}</code></li>)}</ol> : <p>No commands recorded in this page.</p>}</details></div>
  </div>;
}

function statusLabel(session: TerminalSessionSnapshot): string {
  if (session.status === "restart-required") return "Restart required";
  if (session.status === "exited") return `Exited ${session.exitCode ?? "?"}`;
  return `${session.status[0]?.toUpperCase()}${session.status.slice(1)}`;
}

function compactId(value: string): string { return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value; }

export function terminalTypography(density?: string): Readonly<{ fontSize: number; lineHeight: number }> {
  if (density === "comfortable") return Object.freeze({ fontSize: 15, lineHeight: 1.35 });
  if (density === "compact") return Object.freeze({ fontSize: 12, lineHeight: 1.18 });
  return Object.freeze({ fontSize: 13, lineHeight: 1.25 });
}

function sessionChromeSignature(session: TerminalSessionSnapshot): string {
  return JSON.stringify([session.name, session.threadId, session.cwd, session.status, session.exitCode, session.detail, session.history]);
}
