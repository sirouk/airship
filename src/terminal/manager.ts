import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { NodeWebContainerLifecycleEvent } from "../execution/node-webcontainer-pack";
import { normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import {
  TERMINAL_METADATA_PATH,
  TERMINAL_WORKSPACE_MOUNT,
  type TerminalDimensions,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from "./contracts";
import {
  mountTerminalWorkspace,
  reconcileTerminalWorkspace,
  syncTerminalWorkspace,
  type TerminalWorkspaceSnapshot,
} from "./workspace-sync";

const MAX_SESSIONS = 8;
const MAX_HISTORY = 100;
const MAX_HISTORY_CHARS = 8_192;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1_024;
const MAX_PERSISTED_HISTORY_BYTES = 64 * 1_024;
const MAX_METADATA_BYTES = 2 * 1_024 * 1_024;
const TRANSCRIPT_PERSIST_DELAY_MS = 100;
const TRANSCRIPT_ENCODING_PREFIX = "airship-terminal-utf8-base64-v1:";
const MAX_ENCODED_TRANSCRIPT_CHARS = TRANSCRIPT_ENCODING_PREFIX.length + Math.ceil(MAX_PERSISTED_OUTPUT_BYTES / 3) * 4;
const DEFAULT_DIMENSIONS = Object.freeze({ cols: 100, rows: 30 });
const RECONSTRUCTION_MARKER = "\r\n\x1b[33mAirship restored the prior encrypted transcript, cwd, and command history. The prior browser process ended with the page; this is a fresh process.\x1b[0m\r\n";

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

type StoredSession = Omit<TerminalSessionSnapshot, "bufferedOutput"> & Readonly<{ transcriptTail: string }>;
type ParsedStoredSession = Omit<StoredSession, "transcriptTail"> & Readonly<{ transcriptTail: string }>;
type StoredManifest = Readonly<{ version: 2; sessions: readonly StoredSession[] }>;
type SessionListener = (snapshot: TerminalSessionSnapshot) => void;
type ListListener = (sessions: readonly TerminalSessionSnapshot[]) => void;
type WorkspaceListener = (changedPaths: readonly string[]) => void;
type HostLifecycle = Readonly<{
  generation(): number;
  subscribe(listener: (event: NodeWebContainerLifecycleEvent) => void): () => void;
}>;

const managers = new WeakMap<WorkspacePort, BrowserTerminalManager>();
let activeHostManager: BrowserTerminalManager | undefined;
let hostAuthorityTail: Promise<void> = Promise.resolve();

export function getBrowserTerminalManager(workspace: WorkspacePort): BrowserTerminalManager {
  const existing = managers.get(workspace);
  if (existing) return existing;
  const created = new BrowserTerminalManager(workspace);
  managers.set(workspace, created);
  return created;
}

/**
 * Stop and reconcile the page-global browser terminal before a workspace
 * provider is replaced. Terminal tab metadata remains in the workspace, but
 * no process or mount is allowed to retain the old storage authority.
 */
export async function quiesceBrowserTerminalWorkspace(
  workspace: WorkspacePort,
  reason = "The active workspace provider changed; restart this terminal against the new workspace.",
): Promise<readonly string[]> {
  const manager = managers.get(workspace);
  return manager ? manager.quiesce(reason) : Object.freeze([]);
}

/** Page-lifetime owner of real WebContainer PTYs and durable tab metadata. */
export class BrowserTerminalManager {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly sessionListeners = new Map<string, Set<SessionListener>>();
  private readonly listListeners = new Set<ListListener>();
  private readonly workspaceListeners = new Set<WorkspaceListener>();
  private metadataRevision?: string;
  private host?: WebContainer;
  private hostGeneration?: number;
  private unsubscribeHostLifecycle?: () => void;
  private baseline?: TerminalWorkspaceSnapshot;
  private syncTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private transcriptPersistTimer?: ReturnType<typeof setTimeout>;
  readonly ready: Promise<void>;

  constructor(
    private readonly workspace: WorkspacePort,
    private readonly options: Readonly<{
      activateHost?: (signal: AbortSignal) => Promise<WebContainer>;
      hostLifecycle?: HostLifecycle;
    }> = {},
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

  subscribeWorkspace(listener: WorkspaceListener): () => void {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
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
      const hadMountedHost = Boolean(this.host && this.baseline);
      const host = await this.ensureHost(signal);
      if (hadMountedHost) await this.syncWorkspace();
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
      void this.pumpOutput(session, process, generation).catch((error) => {
        this.outputFailed(session, process, generation, error);
      });
      void process.exit.then((exitCode) => this.processExited(session, process, generation, exitCode));
    } catch (error) {
      if (generation !== session.generation) return;
      try { session.process?.kill(); } catch { /* A partially started provider process may already be gone. */ }
      releaseProcess(session);
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

  /** Record output from a page-owned command bridge beside PTY output. */
  recordBridgeCommand(sessionId: string, command: string, output: string): void {
    const session = this.requireSession(sessionId);
    const normalized = command.trim().slice(0, MAX_HISTORY_CHARS);
    if (!normalized) throw new Error("Terminal bridge command cannot be empty.");
    session.history.push(normalized);
    session.history = session.history.slice(-MAX_HISTORY);
    this.appendOutput(session, `\r\n\x1b[36m$ ${normalized}\x1b[0m\r\n${output.replaceAll("\n", "\r\n")}`);
    session.updatedAt = new Date().toISOString();
    this.emit(session);
    this.queuePersist();
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
    const operation = this.syncTail.then(() => withHostAuthority(async () => {
      if (activeHostManager !== this || !this.host || !this.baseline) return;
      const result = await reconcileTerminalWorkspace(this.host, this.workspace, this.baseline);
      this.baseline = result.snapshot;
      changed = result.changedPaths;
      this.emitWorkspaceChanges(changed);
    }));
    this.syncTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => changed);
  }

  async quiesce(reason: string): Promise<readonly string[]> {
    await this.ready;
    await this.syncTail;
    return withHostAuthority(() => this.releaseAuthorityWithinLock(reason, activeHostManager === this));
  }

  private ensureHost(signal: AbortSignal): Promise<WebContainer> {
    return withHostAuthority(async () => {
      if (activeHostManager === this && this.host && this.baseline) return this.host;
      if (activeHostManager && activeHostManager !== this) {
        await activeHostManager.releaseAuthorityWithinLock(
          "Another workspace acquired the page-global browser runtime. Restart this terminal to switch authority back.",
          true,
        );
      }
      activeHostManager = this;
      let lifecycle = this.options.hostLifecycle;
      try {
        let host: WebContainer;
        if (this.options.activateHost) {
          host = await this.options.activateHost(signal);
        } else {
          const pack = await import("../execution/node-webcontainer-pack");
          host = await pack.activateNodeWebContainerHost(signal);
          lifecycle = {
            generation: pack.getNodeWebContainerHostGeneration,
            subscribe: pack.subscribeNodeWebContainerLifecycle,
          };
        }
        const baseline = await mountTerminalWorkspace(host, this.workspace);
        this.host = host;
        this.baseline = baseline;
        if (lifecycle) this.bindHostLifecycle(lifecycle);
        return host;
      } catch (error) {
        if (activeHostManager === this) activeHostManager = undefined;
        this.clearHostBinding();
        throw error;
      }
    });
  }

  private bindHostLifecycle(lifecycle: HostLifecycle): void {
    this.unsubscribeHostLifecycle?.();
    this.hostGeneration = lifecycle.generation();
    this.unsubscribeHostLifecycle = lifecycle.subscribe((event) => {
      if (!this.host) return;
      if (event.state === "ready" && event.generation === this.hostGeneration) return;
      this.invalidateHost(event);
    });
  }

  private invalidateHost(event: NodeWebContainerLifecycleEvent): void {
    if (activeHostManager === this) activeHostManager = undefined;
    this.clearHostBinding();
    this.stopLiveSessions(
      "The shared browser runtime was deactivated. Start this terminal to acquire a fresh isolated host.",
      "Airship runtime deactivated; this terminal requires restart.",
    );
  }

  private async releaseAuthorityWithinLock(reason: string, reconcile: boolean): Promise<readonly string[]> {
    const host = this.host;
    const baseline = this.baseline;
    this.stopLiveSessions(reason, "Airship changed terminal workspace authority; this terminal requires restart.");
    let changed: readonly string[] = Object.freeze([]);
    let failure: unknown;
    try {
      if (reconcile && host && baseline) {
        const result = await syncTerminalWorkspace(host, this.workspace, baseline);
        changed = result.changedPaths;
        this.emitWorkspaceChanges(changed);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (host) {
        try {
          await host.fs.rm(TERMINAL_WORKSPACE_MOUNT, { recursive: true, force: true });
        } catch (error) {
          failure ??= error;
        }
      }
      if (activeHostManager === this) activeHostManager = undefined;
      this.clearHostBinding();
      this.flushTranscriptPersist();
      await this.persistenceTail;
    }
    if (failure) throw failure;
    return Object.freeze([...changed]);
  }

  private stopLiveSessions(detail: string, output: string): void {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.status !== "running" && session.status !== "starting") continue;
      changed = true;
      ++session.generation;
      try { session.process?.kill(); } catch { /* The provider host is already torn down. */ }
      releaseProcess(session);
      session.status = "restart-required";
      session.detail = detail;
      session.updatedAt = new Date().toISOString();
      this.appendOutput(session, `\r\n\x1b[33m${output}\x1b[0m\r\n`);
      this.emit(session);
    }
    if (changed) this.queuePersist();
  }

  private clearHostBinding(): void {
    this.unsubscribeHostLifecycle?.();
    this.unsubscribeHostLifecycle = undefined;
    this.host = undefined;
    this.baseline = undefined;
    this.hostGeneration = undefined;
  }

  private emitWorkspaceChanges(changed: readonly string[]): void {
    if (!changed.length) return;
    const stable = Object.freeze([...changed]);
    for (const listener of this.workspaceListeners) listener(stable);
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

  private outputFailed(
    session: MutableSession,
    process: WebContainerProcess,
    generation: number,
    error: unknown,
  ): void {
    if (generation !== session.generation || session.process !== process) return;
    ++session.generation;
    try { process.kill(); } catch { /* The provider may have failed together with its output stream. */ }
    releaseProcess(session);
    session.status = "failed";
    session.detail = error instanceof Error
      ? `Terminal output failed: ${error.message}`
      : "Terminal output failed before the process completed.";
    session.updatedAt = new Date().toISOString();
    this.appendOutput(session, `\r\n\x1b[31m${session.detail}\x1b[0m\r\n`);
    this.emit(session);
    this.queuePersist();
  }

  private appendOutput(session: MutableSession, chunk: string): void {
    session.bufferedOutput = `${session.bufferedOutput}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
    this.scheduleTranscriptPersist();
  }

  private async load(): Promise<void> {
    const file = this.workspace.readBounded
      ? await this.workspace.readBounded(TERMINAL_METADATA_PATH, MAX_METADATA_BYTES)
      : await this.workspace.read(TERMINAL_METADATA_PATH);
    if (file && new TextEncoder().encode(file.content).byteLength > MAX_METADATA_BYTES) {
      throw new Error("Terminal metadata exceeds its 2 MiB reconstruction budget.");
    }
    this.metadataRevision = file?.revision;
    if (file) {
      for (const stored of parseManifest(file.content).sessions.slice(0, MAX_SESSIONS)) {
        const requiresRestart = stored.status === "running" || stored.status === "starting" || stored.status === "restart-required";
        this.sessions.set(stored.id, {
          ...stored,
          status: requiresRestart ? "restart-required" : stored.status,
          detail: requiresRestart
            ? "Transcript, cwd, and history were restored. A fresh browser process starts automatically; the prior process never survived reload."
            : stored.detail,
          history: [...stored.history],
          bufferedOutput: requiresRestart && stored.transcriptTail
            ? `${stored.transcriptTail}${RECONSTRUCTION_MARKER}`.slice(-MAX_OUTPUT_CHARS)
            : stored.transcriptTail,
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
    if (this.transcriptPersistTimer) {
      clearTimeout(this.transcriptPersistTimer);
      this.transcriptPersistTimer = undefined;
    }
    this.persistenceTail = this.persistenceTail.then(() => this.persist(), () => this.persist());
  }

  private scheduleTranscriptPersist(): void {
    if (this.transcriptPersistTimer) return;
    this.transcriptPersistTimer = setTimeout(() => {
      this.transcriptPersistTimer = undefined;
      this.queuePersist();
    }, TRANSCRIPT_PERSIST_DELAY_MS);
  }

  private flushTranscriptPersist(): void {
    if (!this.transcriptPersistTimer) return;
    clearTimeout(this.transcriptPersistTimer);
    this.transcriptPersistTimer = undefined;
    this.queuePersist();
  }

  private async persist(): Promise<void> {
    await this.ready.catch(() => undefined);
    const manifest: StoredManifest = Object.freeze({
      version: 2,
      sessions: Object.freeze(this.list().map(({ bufferedOutput, ...item }) => Object.freeze({
        ...item,
        history: boundedPersistedHistory(item.history),
        transcriptTail: encodeStoredTranscript(bufferedOutput),
        status: item.status === "running" || item.status === "starting" ? "restart-required" : item.status,
        detail: item.status === "running" || item.status === "starting"
          ? "Process is active only while this page remains open; its transcript, cwd, and history reconstruct after reload with a fresh process."
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

function parseManifest(content: string): Readonly<{ sessions: readonly ParsedStoredSession[] }> {
  try {
    const value = JSON.parse(content) as { version?: unknown; sessions?: unknown };
    if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.sessions)) throw new Error();
    if (!value.sessions.every(validStoredSession)) throw new Error();
    const sessions = value.sessions.map((session) => Object.freeze({
      ...session,
      cwd: normalizeWorkspacePath(session.cwd),
      history: boundedPersistedHistory(session.history),
      transcriptTail: value.version === 2 && typeof session.transcriptTail === "string"
        ? decodeStoredTranscript(session.transcriptTail)
        : "",
    }));
    return Object.freeze({ sessions: Object.freeze(sessions) });
  } catch {
    throw new Error("Terminal metadata is malformed; Airship refused to guess process state.");
  }
}

function validStoredSession(value: unknown): value is Omit<StoredSession, "transcriptTail"> & Readonly<{ transcriptTail?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredSession>;
  return typeof item.id === "string" && item.id.length <= 128
    && typeof item.name === "string" && item.name.length <= 80
    && typeof item.cwd === "string" && item.cwd.startsWith("/workspace")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    && typeof item.detail === "string" && item.detail.length <= 1_024
    && Array.isArray(item.history) && item.history.every((entry) => typeof entry === "string")
    && (item.transcriptTail === undefined || (typeof item.transcriptTail === "string" && item.transcriptTail.length <= MAX_ENCODED_TRANSCRIPT_CHARS))
    && ["idle", "starting", "running", "exited", "failed", "restart-required"].includes(item.status ?? "");
}

function boundedPersistedHistory(history: readonly string[]): readonly string[] {
  const selected: string[] = [];
  let remaining = MAX_PERSISTED_HISTORY_BYTES;
  for (let index = history.length - 1; index >= 0 && selected.length < MAX_HISTORY && remaining > 0; index -= 1) {
    const command = utf8Tail((history[index] ?? "").slice(0, MAX_HISTORY_CHARS), remaining);
    if (!command) continue;
    selected.unshift(command);
    remaining -= new TextEncoder().encode(command).byteLength;
  }
  return Object.freeze(selected);
}

function encodeStoredTranscript(value: string): string {
  const bytes = new TextEncoder().encode(utf8Tail(value, MAX_PERSISTED_OUTPUT_BYTES));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `${TRANSCRIPT_ENCODING_PREFIX}${btoa(binary)}`;
}

function decodeStoredTranscript(value: string): string {
  // The short-lived development v2 plaintext spelling is accepted so an
  // operator does not lose a transcript while updating to the encoded format.
  if (!value.startsWith(TRANSCRIPT_ENCODING_PREFIX)) return utf8Tail(value, MAX_PERSISTED_OUTPUT_BYTES);
  let binary: string;
  try { binary = atob(value.slice(TRANSCRIPT_ENCODING_PREFIX.length)); }
  catch { throw new Error("Terminal transcript encoding is malformed."); }
  if (binary.length > MAX_PERSISTED_OUTPUT_BYTES) throw new Error("Terminal transcript exceeds its 64 KiB reconstruction budget.");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function utf8Tail(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const reversed: string[] = [];
  let bytes = 0;
  for (const character of [...value].reverse()) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > maxBytes) break;
    reversed.push(character);
    bytes += width;
  }
  return reversed.reverse().join("");
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

function withHostAuthority<T>(operation: () => Promise<T>): Promise<T> {
  const result = hostAuthorityTail.then(operation, operation);
  hostAuthorityTail = result.then(() => undefined, () => undefined);
  return result;
}
