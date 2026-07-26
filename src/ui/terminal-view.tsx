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
import "./terminal-view.css";

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
  const [setupOpen, setSetupOpen] = useState(() => (
    typeof matchMedia !== "function" || !matchMedia("(max-width: 760px)").matches
  ));
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

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(max-width: 760px)");
    const syncDisclosure = () => setSetupOpen(!media.matches);
    media.addEventListener("change", syncDisclosure);
    return () => media.removeEventListener("change", syncDisclosure);
  }, []);

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
      <header class="terminal-route__heading">
        <div><span class="eyebrow">Workspace · browser process room</span><h1 id="terminal-title">Terminal</h1></div>
        <div class="terminal-route__actions">
          <button type="button" onClick={() => void sync()} disabled={syncing || !sessions.some(({ status }) => status === "running" || status === "exited")}><Icon name="cloud" size={16} />{syncing ? "Reconciling…" : "Reconcile workspace"}</button>
          <button type="button" onClick={createTab} disabled={sessions.length >= 8}><span aria-hidden="true">＋</span> New terminal</button>
        </div>
      </header>

      <details class="terminal-route__setup" open={setupOpen} onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
        <summary>
          <span><Icon name="terminal" size={16} /><strong>Browser Node shell</strong></span>
          <small>Runtime facts &amp; Shared Git</small>
        </summary>
        <div class="terminal-route__setup-body">
          <p>Real interactive Node processes run inside this page's WebContainer. This is not your device shell, host Bash, SSH, or a remote Airship backend.</p>
          <div class="terminal-assurance" role="note">
            <span><Icon name="terminal" size={16} /><strong>Browser Node shell</strong></span>
            <span>Processes stay hot while this page lives</span>
            <span>Reload requires process restart</span>
            <span>{threadId ? `Thread ${compactId(threadId)}` : "No conversation thread attached"}</span>
          </div>
          <form class="terminal-git-bridge" onSubmit={(event) => { event.preventDefault(); void runGit(); }}>
            <label for="terminal-git-command"><strong>Shared Git</strong><span>Authoritative Editor/source-control state · approval policy applies</span></label>
            <div><input id="terminal-git-command" value={gitCommand} spellcheck={false} onInput={(event) => setGitCommand(event.currentTarget.value)} aria-describedby="terminal-git-detail" /><button type="submit" disabled={!active || gitRunning}>{gitRunning ? "Running…" : "Run"}</button></div>
            <small id="terminal-git-detail">This deterministic bridge uses browser Git directly; the WebContainer never receives a second copy of <code>.git</code>. Try <code>git help</code>.</small>
          </form>
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
            <span class={`terminal-status status-${session.status}`} aria-hidden="true" /><span class="terminal-tab__label"><strong>{session.name}</strong><small>{statusLabel(session)}</small></span>
          </button>}
          <button class="terminal-tab__rename" type="button" aria-label={`Rename ${session.name}`} title="Rename terminal" onClick={() => beginRename(session)}>✎</button>
        </div>)}
      </div>

      {active ? <TerminalPanel key={active.id} manager={manager} session={active} onNotice={setNotice} /> : (
        <div class="terminal-empty"><Icon name="terminal" /><h2>No terminal tab</h2><p>Create a tab to cold-start an isolated browser runtime.</p><button type="button" onClick={createTab}>New terminal</button></div>
      )}
      <footer class="terminal-route__footer" role="status"><Icon name="proof" size={15} /><span>{notice}</span></footer>
    </section>
  );
}

function TerminalPanel({ manager, session: initial, onNotice }: Readonly<{
  manager: BrowserTerminalManager;
  session: TerminalSessionSnapshot;
  onNotice(message: string): void;
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
      <div><span class={`terminal-status status-${session.status}`} aria-hidden="true" /><strong>{statusLabel(session)}</strong><code>{session.cwd}</code>{session.threadId ? <span title={session.threadId}>thread {compactId(session.threadId)}</span> : null}</div>
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
