import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import {
  TERMINAL_METADATA_PATH,
  TERMINAL_WORKSPACE_MOUNT,
  type TerminalDimensions,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from "./contracts";
import { mountTerminalWorkspace, syncTerminalWorkspace, type TerminalWorkspaceSnapshot } from "./workspace-sync";

const MAX_SESSIONS = 8;
const MAX_HISTORY = 100;
const MAX_HISTORY_CHARS = 8_192;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const DEFAULT_DIMENSIONS = Object.freeze({ cols: 100, rows: 30 });

type MutableSession = {
  id: string;
  name: string;
  threadId?: string;
  cwd: string;
  status: TerminalSessionStatus;
  createdAt: string;
  updatedAt: string;
  history: string[];
  detail: string;
  exitCode?: number;
  bufferedOutput: string;
  inputLine: string;
  generation: number;
  process?: WebContainerProcess;
  writer?: WritableStreamDefaultWriter<string>;
  inputTail: Promise<void>;
};

type StoredSession = Omit<TerminalSessionSnapshot, "bufferedOutput">;
type StoredManifest = Readonly<{ version: 1; sessions: readonly StoredSession[] }>;
type SessionListener = (snapshot: TerminalSessionSnapshot) => void;
type ListListener = (sessions: readonly TerminalSessionSnapshot[]) => void;

const managers = new WeakMap<WorkspacePort, BrowserTerminalManager>();

export function getBrowserTerminalManager(workspace: WorkspacePort): BrowserTerminalManager {
  const existing = managers.get(workspace);
  if (existing) return existing;
  const created = new BrowserTerminalManager(workspace);
  managers.set(workspace, created);
  return created;
}

/** Page-lifetime owner of real WebContainer PTYs and durable tab metadata. */
export class BrowserTerminalManager {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly sessionListeners = new Map<string, Set<SessionListener>>();
  private readonly listListeners = new Set<ListListener>();
  private metadataRevision?: string;
  private host?: WebContainer;
  private baseline?: TerminalWorkspaceSnapshot;
  private syncTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly workspace: WorkspacePort,
    private readonly options: Readonly<{ activateHost?: (signal: AbortSignal) => Promise<WebContainer> }> = {},
  ) {
    this.ready = this.load();
  }

  list(): readonly TerminalSessionSnapshot[] {
    return Object.freeze([...this.sessions.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(snapshot));
  }

  subscribeList(listener: ListListener): () => void {
    this.listListeners.add(listener);
    listener(this.list());
    return () => this.listListeners.delete(listener);
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set<SessionListener>();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    const session = this.requireSession(sessionId);
    listener(snapshot(session));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  create(args: Readonly<{ threadId?: string; cwd?: string; name?: string }> = {}): TerminalSessionSnapshot {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`Terminal supports at most ${MAX_SESSIONS} page-lifetime tabs.`);
    const now = new Date().toISOString();
    const id = uuid();
    const session: MutableSession = {
      id,
      name: boundedName(args.name ?? `Terminal ${this.sessions.size + 1}`),
      ...(args.threadId ? { threadId: boundedThread(args.threadId) } : {}),
      cwd: normalizeWorkspacePath(args.cwd ?? "/workspace"),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      history: [],
      detail: "Ready to start a browser-owned Node shell.",
      bufferedOutput: "",
      inputLine: "",
      generation: 0,
      inputTail: Promise.resolve(),
    };
    this.sessions.set(id, session);
    this.emit(session);
    this.queuePersist();
    return snapshot(session);
  }

  rename(sessionId: string, name: string): TerminalSessionSnapshot {
    const session = this.requireSession(sessionId);
    session.name = boundedName(name);
    session.updatedAt = new Date().toISOString();
    this.emit(session);
    this.queuePersist();
    return snapshot(session);
  }

  async start(sessionId: string, dimensions: TerminalDimensions = DEFAULT_DIMENSIONS, signal = new AbortController().signal): Promise<void> {
    await this.ready;
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.status === "starting") return;
    session.status = "starting";
    session.detail = "Cold-starting the in-browser WebContainer runtime…";
    session.updatedAt = new Date().toISOString();
    const generation = ++session.generation;
    this.emit(session);
    this.queuePersist();
    try {
      const host = await this.ensureHost(signal);
      if (generation !== session.generation) return;
      const process = await host.spawn("jsh", [], {
        cwd: hostCwd(session.cwd),
        terminal: boundedDimensions(dimensions),
        env: { TERM: "xterm-256color", AIRSHIP_TERMINAL: "browser-webcontainer" },
      });
      if (generation !== session.generation) { process.kill(); return; }
      session.process = process;
      session.writer = process.input.getWriter();
      session.status = "running";
      session.detail = "Interactive jsh process running inside this page's WebContainer.";
      session.updatedAt = new Date().toISOString();
      session.exitCode = undefined;
      this.emit(session);
      this.queuePersist();
      void this.pumpOutput(session, process, generation);
      void process.exit.then((exitCode) => this.processExited(session, process, generation, exitCode));
    } catch (error) {
      if (generation !== session.generation) return;
      session.status = "failed";
      session.detail = error instanceof Error ? error.message : "The browser terminal could not start.";
      session.updatedAt = new Date().toISOString();
      this.appendOutput(session, `\r\n\x1b[31mAirship terminal failed: ${session.detail}\x1b[0m\r\n`);
      this.emit(session);
      this.queuePersist();
    }
  }

  async write(sessionId: string, data: string): Promise<void> {
    if (data.length > 65_536) throw new Error("Terminal input chunk exceeds 64 KiB.");
    const session = this.requireSession(sessionId);
    if (session.status !== "running" || !session.writer) return;
    const commandCommitted = rememberInput(session, data);
    const writer = session.writer;
    const write = session.inputTail.then(() => writer.write(data));
    session.inputTail = write.catch(() => undefined);
    await write;
    if (commandCommitted) {
      session.updatedAt = new Date().toISOString();
      this.emit(session);
      this.queuePersist();
    }
  }

  resize(sessionId: string, dimensions: TerminalDimensions): void {
    const session = this.requireSession(sessionId);
    session.process?.resize(boundedDimensions(dimensions));
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status !== "running" || !session.writer) return;
    await this.write(sessionId, "\x03");
  }

  async restart(sessionId: string, dimensions: TerminalDimensions = DEFAULT_DIMENSIONS): Promise<void> {
    const session = this.requireSession(sessionId);
    ++session.generation;
    session.process?.kill();
    releaseProcess(session);
    session.status = "idle";
    session.detail = "Previous process stopped; starting a fresh browser shell.";
    this.emit(session);
    await this.start(sessionId, dimensions);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    ++session.generation;
    session.process?.kill();
    releaseProcess(session);
    this.sessions.delete(sessionId);
    this.sessionListeners.delete(sessionId);
    this.emitList();
    this.queuePersist();
  }

  syncWorkspace(): Promise<readonly string[]> {
    let changed: readonly string[] = Object.freeze([]);
    const operation = this.syncTail.then(async () => {
      if (!this.host || !this.baseline) return;
      const result = await syncTerminalWorkspace(this.host, this.workspace, this.baseline);
      this.baseline = result.snapshot;
      changed = result.changedPaths;
    });
    this.syncTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => changed);
  }

  private async ensureHost(signal: AbortSignal): Promise<WebContainer> {
    if (this.host && this.baseline) return this.host;
    const host = this.options.activateHost
      ? await this.options.activateHost(signal)
      : await (await import("../execution/node-webcontainer-pack")).activateNodeWebContainerHost(signal);
    const baseline = await mountTerminalWorkspace(host, this.workspace);
    this.host = host;
    this.baseline = baseline;
    return host;
  }

  private async pumpOutput(session: MutableSession, process: WebContainerProcess, generation: number): Promise<void> {
    const reader = process.output.getReader();
    try {
      while (generation === session.generation) {
        const chunk = await reader.read();
        if (chunk.done) return;
        updateCwdFromOsc(session, chunk.value);
        this.appendOutput(session, chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async processExited(session: MutableSession, process: WebContainerProcess, generation: number, exitCode: number): Promise<void> {
    if (generation !== session.generation || session.process !== process) return;
    releaseProcess(session);
    session.status = "exited";
    session.exitCode = exitCode;
    session.detail = `Browser process exited with code ${exitCode}.`;
    session.updatedAt = new Date().toISOString();
    this.emit(session);
    this.queuePersist();
    try {
      const changed = await this.syncWorkspace();
      if (changed.length) this.appendOutput(session, `\r\n\x1b[36mAirship synced ${changed.length} workspace change${changed.length === 1 ? "" : "s"}.\x1b[0m\r\n`);
    } catch (error) {
      this.appendOutput(session, `\r\n\x1b[33mWorkspace sync requires attention: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    }
  }

  private appendOutput(session: MutableSession, chunk: string): void {
    session.bufferedOutput = `${session.bufferedOutput}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
  }

  private async load(): Promise<void> {
    const file = await this.workspace.read(TERMINAL_METADATA_PATH);
    this.metadataRevision = file?.revision;
    if (file) {
      for (const stored of parseManifest(file.content).sessions.slice(0, MAX_SESSIONS)) {
        this.sessions.set(stored.id, {
          ...stored,
          status: stored.status === "running" || stored.status === "starting" ? "restart-required" : stored.status,
          detail: stored.status === "running" || stored.status === "starting"
            ? "The prior page ended. Start a new process; terminal processes never survive reload."
            : stored.detail,
          history: [...stored.history],
          bufferedOutput: "",
          inputLine: "",
          generation: 0,
          inputTail: Promise.resolve(),
        });
      }
    }
    if (this.sessions.size === 0) this.create();
    this.emitList();
  }

  private queuePersist(): void {
    this.persistenceTail = this.persistenceTail.then(() => this.persist(), () => this.persist());
  }

  private async persist(): Promise<void> {
    await this.ready.catch(() => undefined);
    const manifest: StoredManifest = Object.freeze({
      version: 1,
      sessions: Object.freeze(this.list().map(({ bufferedOutput: _output, ...item }) => Object.freeze({
        ...item,
        status: item.status === "running" || item.status === "starting" ? "restart-required" : item.status,
        detail: item.status === "running" || item.status === "starting"
          ? "Process is active only while this page remains open; restart is required after reload."
          : item.detail,
      }))),
    });
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    try {
      const written = await this.workspace.write(TERMINAL_METADATA_PATH, content, {
        expectedRevision: this.metadataRevision ?? null,
      });
      this.metadataRevision = written.revision;
    } catch (error) {
      if (!(error instanceof WorkspaceConflictError)) throw error;
      const current = await this.workspace.read(TERMINAL_METADATA_PATH);
      if (!current) throw error;
      this.metadataRevision = current.revision;
      const written = await this.workspace.write(TERMINAL_METADATA_PATH, content, { expectedRevision: current.revision });
      this.metadataRevision = written.revision;
    }
  }

  private requireSession(id: string): MutableSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown terminal tab: ${id}`);
    return session;
  }

  private emit(session: MutableSession): void {
    this.emitSession(session);
    this.emitList();
  }

  private emitSession(session: MutableSession): void {
    const value = snapshot(session);
    for (const listener of this.sessionListeners.get(session.id) ?? []) listener(value);
  }

  private emitList(): void {
    const value = this.list();
    for (const listener of this.listListeners) listener(value);
  }
}

function snapshot(session: MutableSession): TerminalSessionSnapshot {
  return Object.freeze({
    id: session.id,
    name: session.name,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    cwd: session.cwd,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    history: Object.freeze([...session.history]),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    detail: session.detail,
    bufferedOutput: session.bufferedOutput,
  });
}

function releaseProcess(session: MutableSession): void {
  void session.writer?.close().catch(() => undefined);
  session.writer?.releaseLock();
  session.writer = undefined;
  session.process = undefined;
}

function rememberInput(session: MutableSession, data: string): boolean {
  let commandCommitted = false;
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = session.inputLine.trim();
      if (command) {
        session.history.push(command.slice(0, MAX_HISTORY_CHARS));
        commandCommitted = true;
      }
      session.history = session.history.slice(-MAX_HISTORY);
      session.inputLine = "";
    } else if (character === "\x7f" || character === "\b") {
      session.inputLine = session.inputLine.slice(0, -1);
    } else if (character === "\x03") {
      session.inputLine = "";
    } else if (character >= " " && character !== "\x7f") {
      session.inputLine = `${session.inputLine}${character}`.slice(-MAX_HISTORY_CHARS);
    }
  }
  return commandCommitted;
}

function updateCwdFromOsc(session: MutableSession, output: string): void {
  const matches = [...output.matchAll(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/gu)];
  const path = matches.at(-1)?.[1];
  if (!path) return;
  const marker = `/${TERMINAL_WORKSPACE_MOUNT}`;
  const offset = path.indexOf(marker);
  if (offset < 0) return;
  const relative = path.slice(offset + marker.length).replace(/^\/+/, "");
  session.cwd = normalizeWorkspacePath(relative ? `/workspace/${relative}` : "/workspace");
}

function hostCwd(cwd: string): string {
  const relative = cwd === "/workspace" ? "" : cwd.slice("/workspace/".length);
  return relative ? `${TERMINAL_WORKSPACE_MOUNT}/${relative}` : TERMINAL_WORKSPACE_MOUNT;
}

function boundedDimensions(value: TerminalDimensions): { cols: number; rows: number } {
  const cols = Math.max(20, Math.min(400, Math.floor(value.cols)));
  const rows = Math.max(5, Math.min(200, Math.floor(value.rows)));
  return { cols, rows };
}

function parseManifest(content: string): StoredManifest {
  try {
    const value = JSON.parse(content) as Partial<StoredManifest>;
    if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error();
    const sessions = value.sessions.filter(validStoredSession).map((session) => Object.freeze({
      ...session,
      cwd: normalizeWorkspacePath(session.cwd),
      history: Object.freeze(session.history.slice(-MAX_HISTORY).map((item) => item.slice(0, MAX_HISTORY_CHARS))),
    }));
    return Object.freeze({ version: 1, sessions: Object.freeze(sessions) });
  } catch {
    throw new Error("Terminal metadata is malformed; Airship refused to guess process state.");
  }
}

function validStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredSession>;
  return typeof item.id === "string" && item.id.length <= 128
    && typeof item.name === "string" && item.name.length <= 80
    && typeof item.cwd === "string" && item.cwd.startsWith("/workspace")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    && typeof item.detail === "string" && item.detail.length <= 1_024
    && Array.isArray(item.history) && item.history.every((entry) => typeof entry === "string")
    && ["idle", "starting", "running", "exited", "failed", "restart-required"].includes(item.status ?? "");
}

function boundedName(value: string): string {
  const name = value.trim().slice(0, 80);
  if (!name || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Terminal tab name is invalid.");
  return name;
}

function boundedThread(value: string): string {
  const thread = value.trim();
  if (!thread || thread.length > 256 || /[\u0000-\u001f\u007f]/u.test(thread)) throw new Error("Terminal thread association is invalid.");
  return thread;
}

function uuid(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
