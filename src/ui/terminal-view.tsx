import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import type { WorkspacePort } from "../workspace/contracts";
import { getBrowserTerminalManager, type BrowserTerminalManager } from "../terminal/manager";
import type { TerminalSessionSnapshot } from "../terminal/contracts";
import { Icon } from "./icons";
import "./terminal-view.css";

export function TerminalView({ workspace, threadId, workspaceRoot = "/workspace" }: Readonly<{
  workspace: WorkspacePort;
  threadId?: string;
  workspaceRoot?: string;
}>) {
  const manager = useMemo(() => getBrowserTerminalManager(workspace), [workspace]);
  const [sessions, setSessions] = useState<readonly TerminalSessionSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [notice, setNotice] = useState("Loading encrypted terminal metadata…");
  const [syncing, setSyncing] = useState(false);

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

  const active = sessions.find(({ id }) => id === activeId);
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

  return (
    <section class="terminal-route" aria-labelledby="terminal-title">
      <header class="terminal-route__heading">
        <div><span class="eyebrow">Workspace · browser process room</span><h1 id="terminal-title">Terminal</h1><p>Real interactive Node processes run inside this page's WebContainer. This is not your device shell, host Bash, SSH, or a remote Airship backend.</p></div>
        <div class="terminal-route__actions">
          <button type="button" onClick={() => void sync()} disabled={syncing || !sessions.some(({ status }) => status === "running" || status === "exited")}><Icon name="cloud" size={16} />{syncing ? "Syncing…" : "Sync workspace"}</button>
          <button type="button" onClick={createTab} disabled={sessions.length >= 8}><span aria-hidden="true">＋</span> New terminal</button>
        </div>
      </header>

      <div class="terminal-assurance" role="note">
        <span><Icon name="terminal" size={16} /><strong>Browser Node shell</strong></span>
        <span>Processes stay hot while this page lives</span>
        <span>Reload requires process restart</span>
        <span>{threadId ? `Thread ${compactId(threadId)}` : "No conversation thread attached"}</span>
      </div>

      <div class="terminal-tabs" role="tablist" aria-label="Terminal tabs">
        {sessions.map((session) => <button key={session.id} type="button" role="tab" aria-selected={session.id === activeId} onClick={() => setActiveId(session.id)}>
          <span class={`terminal-status status-${session.status}`} aria-hidden="true" /><strong>{session.name}</strong><small>{statusLabel(session)}</small>
        </button>)}
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
  const fit = useRef<FitAddon>();
  const renderedOutput = useRef("");

  useEffect(() => manager.subscribe(session.id, (next) => {
    setSession(next);
    const emulator = terminal.current;
    if (!emulator || next.bufferedOutput === renderedOutput.current) return;
    if (next.bufferedOutput.startsWith(renderedOutput.current)) emulator.write(next.bufferedOutput.slice(renderedOutput.current.length));
    else { emulator.clear(); emulator.write(next.bufferedOutput); }
    renderedOutput.current = next.bufferedOutput;
  }), [manager, session.id]);

  useEffect(() => {
    if (!host.current) return;
    const emulator = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      screenReaderMode: true,
      theme: { background: "#0b0e0f", foreground: "#e6e0d2", cursor: "#d5b66f", selectionBackground: "#506a7655", black: "#111517", brightBlack: "#647078", red: "#d97767", green: "#83b99a", yellow: "#d5b66f", blue: "#79a9c8", magenta: "#b495cc", cyan: "#72bbb4", white: "#ded8ca" },
    });
    const fitter = new FitAddon();
    emulator.loadAddon(fitter);
    emulator.open(host.current);
    terminal.current = emulator;
    fit.current = fitter;
    if (session.bufferedOutput) {
      emulator.write(session.bufferedOutput);
      renderedOutput.current = session.bufferedOutput;
    }
    const resize = new ResizeObserver(() => {
      try { fitter.fit(); manager.resize(session.id, { cols: emulator.cols, rows: emulator.rows }); } catch { /* Hidden route or zero-size transition. */ }
    });
    resize.observe(host.current);
    requestAnimationFrame(() => { try { fitter.fit(); } catch { /* Initial route layout can still be settling. */ } });
    return () => { resize.disconnect(); emulator.dispose(); terminal.current = undefined; fit.current = undefined; };
  }, [manager, session.id]);

  const dimensions = () => ({ cols: terminal.current?.cols ?? 100, rows: terminal.current?.rows ?? 30 });
  const start = () => void manager.start(session.id, dimensions());
  const restart = () => void manager.restart(session.id, dimensions());
  const close = async () => { await manager.close(session.id); onNotice("Terminal tab closed. Its page-local process was terminated."); };
  const sendInput = (data: string) => {
    if (!data) return;
    void manager.write(session.id, data).catch((error) => onNotice(error instanceof Error ? error.message : "Terminal input failed safely."));
  };
  const keyDown = (event: KeyboardEvent) => {
    const data = terminalKeyData(event);
    if (data === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    sendInput(data);
  };
  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData?.getData("text/plain") ?? "";
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    sendInput(data);
  };
  const compositionEnd = (event: CompositionEvent) => sendInput(event.data);

  return <div class="terminal-panel">
    <div class="terminal-panel__bar">
      <div><span class={`terminal-status status-${session.status}`} aria-hidden="true" /><strong>{statusLabel(session)}</strong><code>{session.cwd}</code>{session.threadId ? <span title={session.threadId}>thread {compactId(session.threadId)}</span> : null}</div>
      <div>
        {session.status === "running" ? <button type="button" onClick={() => void manager.interrupt(session.id)} aria-label="Interrupt process">⌃C <span>Interrupt</span></button> : <button type="button" onClick={start}><Icon name="terminal" size={14} /> Start</button>}
        <button type="button" onClick={restart} disabled={session.status === "starting"}><Icon name="branch" size={14} /> Restart</button>
        <button type="button" onClick={() => void close()} aria-label="Close terminal tab">× <span>Close</span></button>
      </div>
    </div>
    <div
      class="terminal-emulator"
      ref={host}
      aria-label={`${session.name} browser terminal`}
      data-output-chars={session.bufferedOutput.length}
      onKeyDownCapture={keyDown}
      onPasteCapture={paste}
      onCompositionEndCapture={compositionEnd}
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

/** Translate the focused xterm surface into the WebContainer PTY explicitly. */
function terminalKeyData(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.key === "Process" || event.key === "Dead") return undefined;
  if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "v") && event.shiftKey) {
    return undefined;
  }
  if (event.metaKey) return undefined;
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  const sequences: Record<string, string> = {
    Enter: "\r",
    Backspace: "\x7f",
    Tab: "\t",
    Escape: "\x1b",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Home: "\x1b[H",
    End: "\x1b[F",
    Delete: "\x1b[3~",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
  };
  const sequence = sequences[event.key];
  if (sequence) return sequence;
  if (event.key.length !== 1 || event.ctrlKey) return undefined;
  return event.altKey ? `\x1b${event.key}` : event.key;
}
