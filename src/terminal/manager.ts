import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { NodeWebContainerLifecycleEvent } from "../execution/node-webcontainer-pack";
import { randomUuid } from "../core/id";
import { normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import {
  TERMINAL_METADATA_PATH,
  TERMINAL_WORKSPACE_MOUNT,
  WEB_CONTAINER_TERMINAL_RUNTIME,
  type TerminalAuditRecord,
  type TerminalDimensions,
  type TerminalSessionOrigin,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
} from "./contracts";
import { publishTerminalAuditRecord } from "./audit-sink";
import {
  mountTerminalWorkspace,
  reconcileTerminalWorkspace,
  syncTerminalWorkspace,
  type TerminalWorkspaceSnapshot,
} from "./workspace-sync";

const MAX_SESSIONS_PER_PROFILE = 8;
const MAX_STORED_SESSIONS = 24;
const MAX_HISTORY = 100;
const MAX_HISTORY_CHARS = 8_192;
const MAX_AUDIT_RECORDS = 64;
const MAX_PERSISTED_AUDIT_BYTES = 32 * 1_024;
const MAX_AUDIT_COMMAND_CHARS = 1_024;
const MAX_AUDIT_OUTPUT_CHARS = 512;
const MAX_AUDIT_SUMMARY_CHARS = 512;
const MAX_AUDIT_CHANGED_PATHS = 64;
const MAX_OUTPUT_CHARS = 256 * 1_024;
const MAX_PERSISTED_OUTPUT_BYTES = 16 * 1_024;
const MAX_ACCEPTED_TRANSCRIPT_BYTES = 64 * 1_024;
const MAX_PERSISTED_HISTORY_BYTES = 8 * 1_024;
const MAX_METADATA_BYTES = 2 * 1_024 * 1_024;
const TRANSCRIPT_PERSIST_DELAY_MS = 100;
const MAX_METADATA_CAS_ATTEMPTS = 6;
const MAX_SESSION_TOMBSTONES = 4_096;
const TERMINAL_LEASE_ROOT = "/workspace/.airship/terminal/leases";
const TERMINAL_LEASE_TTL_MS = 45_000;
/** The writer-lease heartbeat interval; exported so tests drive the real one. */
export const TERMINAL_LEASE_RENEW_MS = 12_000;
/** How stale a takeover observation may be while this page is taking input. */
const TERMINAL_LEASE_OBSERVE_MS = 1_000;
const TRANSCRIPT_ENCODING_PREFIX = "airship-terminal-utf8-base64-v1:";
const MAX_ENCODED_TRANSCRIPT_CHARS = TRANSCRIPT_ENCODING_PREFIX.length + Math.ceil(MAX_ACCEPTED_TRANSCRIPT_BYTES / 3) * 4;
const DEFAULT_DIMENSIONS = Object.freeze({ cols: 100, rows: 30 });
const RECONSTRUCTION_MARKER = "\r\n\x1b[33mAirship restored the prior workspace-backed transcript, cwd, input history, and lineage. The prior browser process ended with the page; this is a fresh process.\x1b[0m\r\n";

type MutableSession = {
  id: string;
  name: string;
  profileId?: string;
  threadId?: string;
  origin: TerminalSessionOrigin;
  cwd: string;
  status: TerminalSessionStatus;
  createdAt: string;
  updatedAt: string;
  processEpoch: number;
  lastProcessStartedAt?: string;
  closedAt?: string;
  reconstructed: boolean;
  history: string[];
  audit: TerminalAuditRecord[];
  auditSequence: number;
  detail: string;
  exitCode?: number;
  bufferedOutput: string;
  /** Monotonic per append. The view uses it to know an append is an append. */
  outputSequence: number;
  /** Exactly the text the last append added, so no delta has to be inferred. */
  appendedOutput: string;
  inputLine: string;
  generation: number;
  /** Set after this page observes another durable writer; omission preserves the winner. */
  suppressPersistence: boolean;
  process?: WebContainerProcess;
  writer?: WritableStreamDefaultWriter<string>;
  inputTail: Promise<void>;
};

type StoredSession = Omit<TerminalSessionSnapshot, "bufferedOutput" | "outputSequence" | "appendedOutput"> & Readonly<{ transcriptTail: string }>;
type ParsedStoredSession = Omit<StoredSession, "transcriptTail"> & Readonly<{ transcriptTail: string }>;
type StoredSessionTombstone = Readonly<{ id: string; removedAt: string; reason: "bounded-closed-session-prune" }>;
type StoredManifest = Readonly<{
  version: 3;
  sessions: readonly StoredSession[];
  removedSessions: readonly StoredSessionTombstone[];
}>;
type SessionListener = (snapshot: TerminalSessionSnapshot) => void;
type ListListener = (sessions: readonly TerminalSessionSnapshot[]) => void;
type ListSubscription = Readonly<{ listener: ListListener; profileId?: string }>;
type WorkspaceListener = (changedPaths: readonly string[]) => void;
type HostLifecycle = Readonly<{
  generation(): number;
  subscribe(listener: (event: NodeWebContainerLifecycleEvent) => void): () => void;
}>;

class TerminalMetadataCapacityError extends Error {
  readonly name = "TerminalMetadataCapacityError";
}

const managers = new WeakMap<WorkspacePort, BrowserTerminalManager>();
let activeHostManager: BrowserTerminalManager | undefined;
let hostAuthorityTail: Promise<void> = Promise.resolve();

/**
 * The line that dates a process, so a tab cannot imply a continuity it lost.
 *
 * Two measured failures, one cause: a scrollback that never marks a process
 * boundary. After a Profile round trip the buffer read "Airship changed
 * terminal workspace authority; this terminal requires restart." and the very
 * next line — typed after it — was `echo STILL-ALIVE` answering "STILL-ALIVE",
 * because being shown auto-starts a `restart-required` tab and the new process
 * inherits the old one's scrollback. And after a reload the tab still read
 * "Terminal 1" with a green check over an empty buffer and "Input history · 0",
 * so a restart looked exactly like the session the reader left.
 *
 * Attributed to Airship on purpose. Everything else in this buffer is bytes the
 * shell wrote, and a sentence pretending to be shell output would be a second
 * lie about the same frame.
 */
export function terminalProcessBanner(input: Readonly<{
  processEpoch: number;
  priorStatus: TerminalSessionStatus;
  reconstructed: boolean;
  startedAt: string;
}>): string {
  const run = `jsh run ${input.processEpoch} started ${input.startedAt}`;
  if (input.reconstructed && input.processEpoch <= 1) {
    return `Airship · ${run}. This tab was rebuilt from saved metadata; the process that wrote everything above it ended with the previous page.`;
  }
  if (input.priorStatus === "idle") {
    return `Airship · ${run}. It lives in this page only: a reload ends the process, its scrollback and its input history.`;
  }
  return `Airship · ${run}. The process above this line has ended and is not running; input from here on goes to the new one.`;
}

export function getBrowserTerminalManager(workspace: WorkspacePort, defaultProfileId?: string): BrowserTerminalManager {
  const existing = managers.get(workspace);
  if (existing) return existing;
  const created = new BrowserTerminalManager(workspace, { ...(defaultProfileId ? { defaultProfileId } : {}) });
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

/**
 * Whether a terminal currently holds the page-global WebContainer.
 *
 * Read this *before* quiescing — the quiesce is what clears it. It exists so a
 * caller about to destroy the shared instance can tell "the terminal booted it"
 * from "this module booted it": a module-local handle on the runtime pack
 * answers only the second question, and mistaking the two means stopping a
 * terminal for a teardown that then never happens.
 */
export function browserTerminalHoldsSharedRuntime(): boolean {
  return activeHostManager !== undefined;
}

/**
 * Stop and reconcile whichever terminal currently holds the shared WebContainer,
 * before that instance is destroyed.
 *
 * Deliberately *not* keyed by workspace identity. `managers` is a WeakMap over
 * object identity, and a caller that reaches us from the tool layer does not
 * hold the same object the Terminal route mounted against: the tool registry is
 * built over `ClientContextRuntime.observeWorkspace()`'s frozen facade, wrapped
 * again in `GitSynchronizedWorkspace` when Git is bound, while the Terminal
 * route passes the raw provider. A lookup by the tool's workspace therefore
 * always misses and silently reconciles nothing — which is exactly the silent
 * data loss the quiesce exists to prevent.
 *
 * Host authority is the property that actually matters here: only one manager
 * can hold the page-global instance at a time, and it is the only one with
 * mount work to save. When nobody holds it — no terminal was ever started, or
 * the runtime was never activated — this is a no-op, so a caller need not (and
 * must not) guess at activation state of its own.
 */
export async function quiesceBrowserTerminalHost(
  reason = "The shared browser runtime is being deactivated; terminal work was reconciled first.",
): Promise<readonly string[]> {
  // Read before awaiting: `quiesce` takes the host-authority lock itself, and if
  // another manager wins that lock first it releases this one *with*
  // reconciliation, so no mount work is lost by the handoff either way.
  const manager = activeHostManager;
  return manager ? manager.quiesce(reason) : Object.freeze([]);
}

/** Page-lifetime owner of real WebContainer PTYs and durable tab metadata. */
export class BrowserTerminalManager {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly removedSessions = new Map<string, StoredSessionTombstone>();
  private readonly leaseOwnerId = randomUuid();
  private readonly sessionLeases = new Map<string, Readonly<{
    revision: string;
    timer?: ReturnType<typeof setTimeout>;
  }>>();
  private readonly observedForeignLeases = new Map<string, Readonly<{ revision: string; observedAt: number }>>();
  private readonly leaseRenewals = new Map<string, Promise<void>>();
  private readonly leaseOwnerProbes = new Map<string, Readonly<{ startedAt: number; inFlight: boolean }>>();
  private readonly sessionListeners = new Map<string, Set<SessionListener>>();
  private readonly listListeners = new Set<ListSubscription>();
  private readonly workspaceListeners = new Set<WorkspaceListener>();
  private metadataRevision?: string;
  private host?: WebContainer;
  private hostGeneration?: number;
  private unsubscribeHostLifecycle?: () => void;
  private baseline?: TerminalWorkspaceSnapshot;
  private syncTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistInFlight = false;
  private persistDirty = false;
  private lastPersistenceFailure?: string;
  private readonly persistenceListeners = new Set<(failure: string | undefined) => void>();
  private readonly reconcileListeners = new Set<(canReconcile: boolean) => void>();
  private reconcileAvailable = false;
  private transcriptPersistTimer?: ReturnType<typeof setTimeout>;
  readonly ready: Promise<void>;

  constructor(
    private readonly workspace: WorkspacePort,
    private readonly options: Readonly<{
      activateHost?: (signal: AbortSignal) => Promise<WebContainer>;
      hostLifecycle?: HostLifecycle;
      defaultProfileId?: string;
    }> = {},
  ) {
    this.ready = this.load();
  }

  list(profileId?: string): readonly TerminalSessionSnapshot[] {
    return Object.freeze([...this.sessions.values()]
      .filter((session) => !session.closedAt && session.profileId === profileId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(snapshot));
  }

  /** Closed tabs stay available to audit/proof integration until bounded pruning. */
  archived(profileId?: string): readonly TerminalSessionSnapshot[] {
    return Object.freeze([...this.sessions.values()]
      .filter((session) => Boolean(session.closedAt) && session.profileId === profileId)
      .sort((left, right) => (right.closedAt ?? "").localeCompare(left.closedAt ?? ""))
      .map(snapshot));
  }

  subscribeList(listener: ListListener, profileId?: string): () => void {
    const subscription: ListSubscription = Object.freeze({ listener, ...(profileId ? { profileId } : {}) });
    this.listListeners.add(subscription);
    listener(this.list(profileId));
    return () => this.listListeners.delete(subscription);
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

  create(args: Readonly<{ profileId?: string; threadId?: string; cwd?: string; name?: string; origin?: TerminalSessionOrigin }> = {}): TerminalSessionSnapshot {
    const profileId = args.profileId ? boundedProfile(args.profileId) : undefined;
    const scoped = [...this.sessions.values()].filter((session) => !session.closedAt && session.profileId === profileId);
    if (scoped.length >= MAX_SESSIONS_PER_PROFILE) throw new Error(`Terminal supports at most ${MAX_SESSIONS_PER_PROFILE} tabs per profile.`);
    this.pruneClosedSessions();
    if (this.sessions.size >= MAX_STORED_SESSIONS) throw new Error(`Terminal metadata supports at most ${MAX_STORED_SESSIONS} retained sessions across profiles. Export or clear older terminal lineage before creating another tab.`);
    const now = new Date().toISOString();
    const id = randomUuid();
    const session: MutableSession = {
      id,
      name: boundedName(args.name ?? `Terminal ${scoped.length + 1}`),
      ...(profileId ? { profileId } : {}),
      ...(args.threadId ? { threadId: boundedThread(args.threadId) } : {}),
      origin: boundedOrigin(args.origin ?? { kind: args.threadId ? "conversation" : "terminal-route" }),
      cwd: normalizeWorkspacePath(args.cwd ?? "/workspace"),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      processEpoch: 0,
      reconstructed: false,
      history: [],
      audit: [],
      auditSequence: 0,
      detail: "Ready to start an interactive WebContainer jsh process.",
      bufferedOutput: "",
      outputSequence: 0,
      appendedOutput: "",
      inputLine: "",
      generation: 0,
      suppressPersistence: false,
      inputTail: Promise.resolve(),
    };
    this.sessions.set(id, session);
    this.emit(session);
    this.queuePersist();
    return snapshot(session);
  }

  /** Return one session owned by this profile, creating its first tab if needed. */
  ensureProfileSession(args: Readonly<{ profileId?: string; threadId?: string; cwd?: string }> = {}): TerminalSessionSnapshot {
    const profileId = args.profileId ? boundedProfile(args.profileId) : undefined;
    const existing = [...this.sessions.values()].find((session) => !session.closedAt && session.profileId === profileId
      && (!args.threadId || session.threadId === args.threadId))
      ?? [...this.sessions.values()].find((session) => !session.closedAt && session.profileId === profileId);
    return existing ? snapshot(existing) : this.create({
      ...(profileId ? { profileId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      origin: args.threadId ? { kind: "conversation" } : { kind: "terminal-route" },
    });
  }

  /** Idempotently realize one Workspace "open terminal here" request. */
  openWorkspaceSession(args: Readonly<{
    requestId: string;
    profileId?: string;
    threadId?: string;
    cwd: string;
    name?: string;
  }>): TerminalSessionSnapshot {
    const requestId = boundedAssociation(args.requestId, "Terminal workspace request");
    const profileId = args.profileId ? boundedProfile(args.profileId) : undefined;
    const existing = [...this.sessions.values()].find((session) => !session.closedAt
      && session.profileId === profileId
      && session.origin.kind === "workspace-path"
      && session.origin.requestId === requestId);
    return existing ? snapshot(existing) : this.create({
      ...(profileId ? { profileId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      ...(args.name ? { name: args.name } : {}),
      cwd: args.cwd,
      origin: { kind: "workspace-path", path: args.cwd, requestId },
    });
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
    // Read before the transition, because the banner below has to say whether
    // this tab is picking up where a dead process left off or opening cold.
    const priorStatus = session.status;
    await this.acquireSessionLease(sessionId, signal);
    session.status = "starting";
    session.detail = "Cold-starting the in-browser WebContainer runtime…";
    session.updatedAt = new Date().toISOString();
    session.processEpoch += 1;
    const processEpoch = session.processEpoch;
    const generation = ++session.generation;
    this.emit(session);
    this.queuePersist();
    try {
      const hadMountedHost = Boolean(this.host && this.baseline);
      const host = await this.ensureHost(signal);
      // Reconciliation rebuilds the mount root by deleting it first, and the
      // rebuild cannot restore mount-only state (node_modules is excluded from
      // both export and mount). Another tab's live jsh has its cwd inside that
      // root, so a second tab only pushes its own deltas out while any process
      // is live; the mount is refreshed once the mount is quiescent.
      const mountRefreshed = !hadMountedHost || this.mountIsQuiescent(session.id);
      if (hadMountedHost) await this.runWorkspaceSync(undefined, mountRefreshed ? "reconcile" : "outgoing");
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
      session.detail = mountRefreshed
        ? "Interactive jsh process running inside this page's WebContainer."
        : "Interactive jsh process running inside this page's WebContainer. The workspace mount was not rebuilt because another terminal process is live; reconcile once it ends to pick up newer workspace revisions.";
      session.updatedAt = new Date().toISOString();
      session.lastProcessStartedAt = session.updatedAt;
      session.exitCode = undefined;
      // Written before the pump attaches, so it is the first thing under the
      // previous process's last line rather than racing the new prompt.
      this.appendOutput(session, `\r\n\x1b[36m${terminalProcessBanner({
        processEpoch,
        priorStatus,
        reconstructed: session.reconstructed,
        startedAt: new Date(session.lastProcessStartedAt).toLocaleTimeString(),
      })}\x1b[0m\r\n`);
      this.appendAudit(session, {
        kind: "process-start",
        outcome: "completed",
        processEpoch,
        summary: "Started an interactive WebContainer jsh process. This process is page-local.",
      });
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
      this.appendAudit(session, {
        kind: "process-start",
        outcome: "failed",
        processEpoch,
        summary: `Interactive WebContainer jsh failed to start: ${session.detail}`,
      });
      this.appendOutput(session, `\r\n\x1b[31mAirship terminal failed: ${session.detail}\x1b[0m\r\n`);
      this.emit(session);
      this.queuePersist();
      await this.releaseSessionLease(session.id);
    }
  }

  async write(sessionId: string, data: string): Promise<void> {
    if (data.length > 65_536) throw new Error("Terminal input chunk exceeds 64 KiB.");
    const session = this.requireSession(sessionId);
    if (session.status !== "running" || !session.writer) return;
    // The durable lease is a heartbeat, not a per-input transaction. Renewing
    // it here made every keystroke a compare-and-swap write, and two of those
    // in flight raced each other into a conflict this page then misread as a
    // foreign takeover — killing the process and latching the tab off. What
    // input still owes the operator is promptness, so it observes the lease by
    // a read instead of waiting out a whole heartbeat behind a live PTY.
    if (!this.sessionLeases.has(sessionId)) throw new Error("This page no longer owns the terminal writer lease; input was not submitted.");
    this.observeSessionLeaseOwner(sessionId);
    const committed = rememberInput(session, data);
    const writer = session.writer;
    const write = session.inputTail.then(() => writer.write(data));
    session.inputTail = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      // Losing the lease detaches this writer from its stream mid-flight. The
      // operator can act on why input stopped, not on a WritableStream state
      // error, so answer in the lease's own words when that is what happened.
      if (!this.sessionLeases.has(sessionId)) throw new Error("This page no longer owns the terminal writer lease; input was not submitted.", { cause: error });
      throw error;
    }
    if (committed.length) {
      for (const command of committed) this.appendAudit(session, {
        kind: "interactive-input",
        outcome: "submitted",
        command,
        processEpoch: session.processEpoch,
        summary: "Captured a line submitted to the interactive jsh PTY. Per-command completion is not exposed; resulting bytes remain in the retained transcript.",
      });
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
    this.appendAudit(session, {
      kind: "interactive-input",
      outcome: "submitted",
      processEpoch: session.processEpoch,
      summary: "Submitted an interrupt control byte to the interactive jsh PTY.",
    });
    session.updatedAt = new Date().toISOString();
    this.emit(session);
    this.queuePersist();
  }

  async restart(sessionId: string, dimensions: TerminalDimensions = DEFAULT_DIMENSIONS): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.status === "starting") {
      this.appendAudit(session, {
        kind: "process-exit",
        outcome: "completed",
        processEpoch: session.processEpoch,
        summary: "Stopped the page-local process to start a fresh terminal process epoch.",
      });
    }
    ++session.generation;
    session.process?.kill();
    releaseProcess(session);
    session.status = "idle";
    session.detail = "Previous process stopped; starting a fresh browser shell.";
    session.updatedAt = new Date().toISOString();
    this.emit(session);
    await this.start(sessionId, dimensions);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.status === "starting") {
      this.appendAudit(session, {
        kind: "process-exit",
        outcome: "completed",
        processEpoch: session.processEpoch,
        summary: "Stopped the page-local process because its terminal tab was closed.",
      });
    }
    ++session.generation;
    session.process?.kill();
    releaseProcess(session);
    try {
      await this.syncWorkspaceForSession(session.id);
    } catch (error) {
      session.status = "failed";
      session.detail = `Terminal stopped, but its tab remains open because workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      session.updatedAt = new Date().toISOString();
      this.emit(session);
      this.queuePersist();
      throw error;
    }
    session.closedAt = new Date().toISOString();
    session.status = "exited";
    session.detail = "Terminal tab closed. Its bounded transcript and lineage remain retained by the active workspace adapter.";
    session.updatedAt = session.closedAt;
    this.sessionListeners.delete(sessionId);
    this.emitList();
    this.queuePersist();
    await this.releaseSessionLease(sessionId);
  }

  /** The operator asked for it explicitly, so this is always the full reconcile. */
  syncWorkspace(sessionId?: string): Promise<readonly string[]> {
    return this.runWorkspaceSync(sessionId, "reconcile");
  }

  /**
   * Whether a reconcile could do anything at all: this manager holds the
   * page-global host authority and has a mounted baseline. Session status is
   * not a proxy for it — a failed tab's mount is still reconcilable, and a
   * running tab whose runtime was deactivated is not.
   */
  canReconcile(): boolean {
    return activeHostManager === this && Boolean(this.host && this.baseline);
  }

  /**
   * The predicate above, as a signal a view can hold.
   *
   * `canReconcile()` is a function of page-global host authority and this
   * manager's own mount — neither of which is session state — so a surface
   * that reads it during render is betting that every flip happens to coincide
   * with a session or list emission. It does not. `start` acquires the mount
   * inside `ensureHost` and does not emit again until the PTY has spawned, so
   * a cold WebContainer boot leaves a Reconcile control disabled for the whole
   * boot after the mount became reconcilable; a start abandoned by a
   * generation bump between those two points never emits at all.
   */
  subscribeReconcile(listener: (canReconcile: boolean) => void): () => void {
    this.reconcileListeners.add(listener);
    listener(this.canReconcile());
    return () => this.reconcileListeners.delete(listener);
  }

  /** Deduplicated so the mount's steady state costs subscribers nothing. */
  private publishReconcileAvailability(): void {
    const available = this.canReconcile();
    if (available === this.reconcileAvailable) return;
    this.reconcileAvailable = available;
    for (const listener of this.reconcileListeners) listener(available);
  }

  /**
   * The one place page-global host authority changes hands.
   *
   * Authority is half of `canReconcile()`, and it moves *between* managers:
   * the manager losing it is not the one running this code, so routing every
   * assignment through here is what keeps the loser's subscribers from holding
   * a stale "yes". Private-static, because it reaches into another instance's
   * publication path.
   */
  private static setActiveHostManager(next: BrowserTerminalManager | undefined): void {
    const previous = activeHostManager;
    if (previous === next) return;
    activeHostManager = next;
    previous?.publishReconcileAvailability();
    next?.publishReconcileAvailability();
  }

  /**
   * A lifecycle-driven sync, which may not rebuild the mount under another
   * tab's live process. See the quiescence note in `start`.
   */
  private syncWorkspaceForSession(sessionId: string): Promise<readonly string[]> {
    return this.runWorkspaceSync(sessionId, this.mountIsQuiescent(sessionId) ? "reconcile" : "outgoing");
  }

  /** No other tab is holding the mount open with a live or starting process. */
  private mountIsQuiescent(exceptSessionId: string): boolean {
    return ![...this.sessions.values()].some((other) => other.id !== exceptSessionId
      && (other.status === "running" || other.status === "starting"));
  }

  private runWorkspaceSync(sessionId: string | undefined, mode: "reconcile" | "outgoing"): Promise<readonly string[]> {
    let changed: readonly string[] = Object.freeze([]);
    const operation = this.syncTail.then(() => withHostAuthority(async () => {
      if (activeHostManager !== this || !this.host || !this.baseline) return;
      const result = mode === "reconcile"
        ? await reconcileTerminalWorkspace(this.host, this.workspace, this.baseline)
        : await syncTerminalWorkspace(this.host, this.workspace, this.baseline);
      this.baseline = result.snapshot;
      changed = result.changedPaths;
      this.emitWorkspaceChanges(changed);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (session && !session.closedAt) {
        this.appendAudit(session, {
          kind: "workspace-reconcile",
          outcome: "completed",
          processEpoch: session.processEpoch,
          summary: changed.length
            ? `${mode === "reconcile" ? "Reconciled" : "Adopted"} ${changed.length} revision-fenced workspace change${changed.length === 1 ? "" : "s"}.${mode === "outgoing" ? " The mount was not rebuilt because another terminal process is live." : ""}`
            : mode === "reconcile"
              ? "Reconciliation found no workspace changes."
              : "No terminal changes to adopt; the mount was not rebuilt because another terminal process is live.",
          changedPaths: Object.freeze(changed.slice(0, MAX_AUDIT_CHANGED_PATHS)),
        });
        this.emit(session);
        this.queuePersist();
      }
    }));
    this.syncTail = operation.then(() => undefined, () => undefined);
    return operation.then(() => changed, (error) => {
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (session && !session.closedAt) {
        this.appendAudit(session, {
          kind: "workspace-reconcile",
          outcome: "failed",
          processEpoch: session.processEpoch,
          summary: `Workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.emit(session);
        this.queuePersist();
      }
      throw error;
    });
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
      BrowserTerminalManager.setActiveHostManager(this);
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
        // The mount is reconcilable from here, and `start` says nothing more
        // until its PTY has spawned — seconds later on a cold boot, and never
        // at all if the start is abandoned by a generation bump in between.
        this.publishReconcileAvailability();
        return host;
      } catch (error) {
        if (activeHostManager === this) BrowserTerminalManager.setActiveHostManager(undefined);
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
    if (activeHostManager === this) BrowserTerminalManager.setActiveHostManager(undefined);
    this.clearHostBinding();
    // This path only ever runs *after* the host is gone, so nothing can be
    // reconciled from here. Airship's own deactivation quiesces first; an
    // external teardown does not, and the honest thing is to say so rather than
    // let a restart imply the mount survived.
    this.stopLiveSessions(
      "The shared browser runtime was deactivated. Terminal writes made since the last reconciliation were discarded with it. Start this terminal to acquire a fresh isolated host.",
      "Airship runtime deactivated; unreconciled terminal writes were discarded. This terminal requires restart.",
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
      if (activeHostManager === this) BrowserTerminalManager.setActiveHostManager(undefined);
      this.clearHostBinding();
      this.flushTranscriptPersist();
      // Handled, not awaited bare: a rejection here runs inside `finally` and
      // would replace the teardown error the caller actually needs to see.
      // `queuePersist` records the failure, so nothing is swallowed silently.
      await this.persistenceTail.catch(() => undefined);
      await Promise.all([...this.sessionLeases.keys()].map((sessionId) => this.releaseSessionLease(sessionId)));
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
      this.appendAudit(session, {
        kind: "process-exit",
        outcome: "failed",
        processEpoch: session.processEpoch,
        summary: detail,
      });
      this.appendOutput(session, `\r\n\x1b[33m${output}\x1b[0m\r\n`);
      this.emit(session);
      void this.releaseSessionLease(session.id);
    }
    if (changed) this.queuePersist();
  }

  private clearHostBinding(): void {
    const hadBinding = Boolean(this.host || this.baseline);
    this.unsubscribeHostLifecycle?.();
    this.unsubscribeHostLifecycle = undefined;
    this.host = undefined;
    this.baseline = undefined;
    this.hostGeneration = undefined;
    // Dropping the binding is what makes `canReconcile()` false, and a manager
    // whose tabs are all idle or failed loses it without any session changing
    // state — `stopLiveSessions` has nothing to emit. Publishing the predicate
    // itself is what a Reconcile control holds; the session and list emissions
    // below stay because the rest of the chrome is reading session state.
    this.publishReconcileAvailability();
    if (hadBinding) {
      for (const session of this.sessions.values()) this.emitSession(session);
      this.emitList();
    }
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
    this.appendAudit(session, {
      kind: "process-exit",
      outcome: "completed",
      processEpoch: session.processEpoch,
      exitCode,
      summary: `Interactive jsh process exited with code ${exitCode}.`,
    });
    this.emit(session);
    this.queuePersist();
    try {
      const changed = await this.syncWorkspaceForSession(session.id);
      if (changed.length) this.appendOutput(session, `\r\n\x1b[36mAirship synced ${changed.length} workspace change${changed.length === 1 ? "" : "s"}.\x1b[0m\r\n`);
    } catch (error) {
      this.appendOutput(session, `\r\n\x1b[33mWorkspace sync requires attention: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    } finally {
      await this.releaseSessionLease(session.id);
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
    this.appendAudit(session, {
      kind: "process-exit",
      outcome: "failed",
      processEpoch: session.processEpoch,
      summary: session.detail,
    });
    this.appendOutput(session, `\r\n\x1b[31m${session.detail}\x1b[0m\r\n`);
    this.emit(session);
    this.queuePersist();
    void this.releaseSessionLease(session.id);
  }

  private appendOutput(session: MutableSession, chunk: string): void {
    session.bufferedOutput = `${session.bufferedOutput}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    // `bufferedOutput` is a sliding tail, so past the cap it is no longer an
    // append-only buffer and a view cannot recover the delta by prefix match.
    // Publishing the appended text plus a sequence removes the inference: a
    // one-step advance is exactly `appendedOutput`, anything else is a redraw.
    session.outputSequence += 1;
    session.appendedOutput = chunk;
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
    this.scheduleTranscriptPersist();
  }

  private appendAudit(session: MutableSession, input: Omit<TerminalAuditRecord, "id" | "sequence" | "recordedAt">): void {
    const sequence = ++session.auditSequence;
    const record: TerminalAuditRecord = Object.freeze({
      ...input,
      summary: input.summary.slice(0, MAX_AUDIT_SUMMARY_CHARS),
      ...(input.command ? { command: input.command.slice(0, MAX_AUDIT_COMMAND_CHARS) } : {}),
      ...(input.outputTail ? { outputTail: utf8Tail(input.outputTail, MAX_AUDIT_OUTPUT_CHARS) } : {}),
      id: `${session.id}:${this.leaseOwnerId}:${String(sequence)}`,
      writerId: this.leaseOwnerId,
      sequence,
      recordedAt: new Date().toISOString(),
      ...(input.changedPaths ? { changedPaths: Object.freeze(input.changedPaths.slice(0, MAX_AUDIT_CHANGED_PATHS)) } : {}),
    });
    session.audit.push(record);
    session.audit = session.audit.slice(-MAX_AUDIT_RECORDS);
    // The manager's own record set is bounded to 64 and is page-local, so it is
    // a live view, not a ledger. Publishing here — the one place a record is
    // ever made — is what lets the shell put the same fact somewhere durable
    // before the ring buffer forgets it. Nothing about the terminal depends on
    // a subscriber existing; with none, this is a no-op and the manager behaves
    // exactly as it did before the seam existed.
    publishTerminalAuditRecord(record, snapshot(session));
  }

  private pruneClosedSessions(): void {
    if (this.sessions.size < MAX_STORED_SESSIONS) return;
    const oldest = [...this.sessions.values()]
      .filter((session) => Boolean(session.closedAt))
      .sort((left, right) => (left.closedAt ?? "").localeCompare(right.closedAt ?? ""))[0];
    if (oldest) {
      this.sessions.delete(oldest.id);
      this.removedSessions.set(oldest.id, Object.freeze({
        id: oldest.id,
        removedAt: new Date().toISOString(),
        reason: "bounded-closed-session-prune",
      }));
    }
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
      const manifest = parseManifest(file.content);
      for (const tombstone of manifest.removedSessions) this.removedSessions.set(tombstone.id, tombstone);
      for (const stored of manifest.sessions.slice(0, MAX_STORED_SESSIONS)) {
        const { transcriptTail, runtime: _runtime, ...metadata } = stored;
        const requiresRestart = !stored.closedAt && (stored.status === "running" || stored.status === "starting" || stored.status === "restart-required");
        this.sessions.set(stored.id, {
          ...metadata,
          status: requiresRestart ? "restart-required" : stored.status,
          detail: requiresRestart
            ? "Transcript, cwd, input history, and lineage were restored. A fresh interactive jsh process starts automatically; the prior process never survived reload."
            : stored.detail,
          history: [...stored.history],
          audit: [...stored.audit],
          auditSequence: stored.audit.reduce((maximum, record) => Math.max(maximum, record.sequence), 0),
          reconstructed: true,
          bufferedOutput: requiresRestart && transcriptTail
            ? `${transcriptTail}${RECONSTRUCTION_MARKER}`.slice(-MAX_OUTPUT_CHARS)
            : transcriptTail,
          outputSequence: 0,
          appendedOutput: "",
          inputLine: "",
          generation: 0,
          suppressPersistence: false,
          inputTail: Promise.resolve(),
        });
      }
    }
    const defaultProfileId = this.options.defaultProfileId ? boundedProfile(this.options.defaultProfileId) : undefined;
    if (this.list(defaultProfileId).length === 0) this.create({ ...(defaultProfileId ? { profileId: defaultProfileId } : {}) });
    this.emitList();
  }

  private queuePersist(): void {
    if (this.transcriptPersistTimer) {
      clearTimeout(this.transcriptPersistTimer);
      this.transcriptPersistTimer = undefined;
    }
    // Coalesce: at most one persist in flight. Sustained PTY output re-arms the
    // transcript timer on a ~100ms cadence, and a slow authority can take far
    // longer than that per read+CAS round — chaining one persist per tick grew
    // the tail without bound and kept every queued pass a full 2 MiB manifest.
    // A dirty flag plus a drain loop gives the trailing state exactly one
    // follow-up pass instead of one pass per tick.
    this.persistDirty = true;
    if (this.persistInFlight) return;
    this.persistInFlight = true;
    this.persistenceTail = this.persistenceTail.then(() => this.drainPersist());
  }

  private async drainPersist(): Promise<void> {
    try {
      // Mutations landing mid-pass raise the flag again; one trailing pass
      // coalesces all of them. Teardown awaits `persistenceTail`, which covers
      // this whole loop, so a trailing flush queued by `flushTranscriptPersist`
      // cannot be lost.
      while (this.persistDirty) {
        this.persistDirty = false;
        await this.persist();
      }
      this.recordPersistence(undefined);
    } catch (error) {
      // Terminate the pass rather than spinning on a failing authority: report
      // the observed outcome once (`recordPersistence` dedupes repeats) and
      // stay dirty so the next mutation retries. The failure was previously
      // discarded, so the retention claim shown to the user could never
      // disagree with it; recording it keeps the tail settled so no teardown
      // ever awaits a rejection.
      this.persistDirty = true;
      this.recordPersistence(error ?? new Error("Terminal metadata could not be persisted."));
    } finally {
      this.persistInFlight = false;
    }
  }

  /** The last durable-metadata write failure, or undefined while writes land. */
  persistenceFailure(): string | undefined {
    return this.lastPersistenceFailure;
  }

  /**
   * Durability is claimed from observed writes, never from the declared tier:
   * a surface that reads the tier alone cannot tell the user that persistence
   * has stopped working.
   */
  subscribePersistence(listener: (failure: string | undefined) => void): () => void {
    this.persistenceListeners.add(listener);
    listener(this.lastPersistenceFailure);
    return () => this.persistenceListeners.delete(listener);
  }

  private recordPersistence(error: unknown): void {
    const failure = error === undefined
      ? undefined
      : error instanceof Error ? error.message : String(error);
    if (failure === this.lastPersistenceFailure) return;
    this.lastPersistenceFailure = failure;
    for (const listener of this.persistenceListeners) {
      try {
        listener(failure);
      } catch {
        // Observation cannot change persistence truth: a throwing subscriber
        // used to escape into the drain pass, reject `persistenceTail`, and
        // silently no-op every chained persist after it.
      }
    }
  }

  private scheduleTranscriptPersist(): void {
    if (this.transcriptPersistTimer) return;
    this.transcriptPersistTimer = setTimeout(() => {
      this.transcriptPersistTimer = undefined;
      this.queuePersist();
    }, TRANSCRIPT_PERSIST_DELAY_MS);
  }

  private flushTranscriptPersist(): void {
    const pending = this.transcriptPersistTimer !== undefined;
    if (pending) {
      clearTimeout(this.transcriptPersistTimer);
      this.transcriptPersistTimer = undefined;
    }
    // Forwarding only the debounce timer abandoned the failed-pass retry: a
    // rejected drain re-arms `persistDirty` with `persistInFlight` already
    // clear and no timer pending, so teardown's `await persistenceTail`
    // resolved while the armed state never got its final attempt. A dirty
    // flag at flush time is the same trailing state and earns the same
    // single pass, chained on the tail the caller awaits next.
    if (pending || this.persistDirty) this.queuePersist();
  }

  private async persist(): Promise<void> {
    await this.ready.catch(() => undefined);
    for (let attempt = 0; attempt < MAX_METADATA_CAS_ATTEMPTS; attempt += 1) {
      const current = this.workspace.readBounded
        ? await this.workspace.readBounded(TERMINAL_METADATA_PATH, MAX_METADATA_BYTES)
        : await this.workspace.read(TERMINAL_METADATA_PATH);
      if (current && new TextEncoder().encode(current.content).byteLength > MAX_METADATA_BYTES) {
        throw new Error("Terminal metadata exceeds its 2 MiB reconstruction budget.");
      }
      const local = storedManifest([...this.sessions.values()], [...this.removedSessions.values()]);
      const remote = current
        ? (() => {
            const parsed = parseManifest(current.content);
            return storedManifestFromParsed(parsed.sessions, parsed.removedSessions);
          })()
        : Object.freeze({ version: 3 as const, sessions: Object.freeze([]), removedSessions: Object.freeze([]) });
      const manifest = mergeStoredManifests(remote, local);
      const content = `${JSON.stringify(manifest, null, 2)}\n`;
      if (new TextEncoder().encode(content).byteLength > MAX_METADATA_BYTES) {
        throw new Error("Terminal metadata exceeds its 2 MiB persistence budget.");
      }
      try {
        const written = await this.workspace.write(TERMINAL_METADATA_PATH, content, {
          expectedRevision: current?.revision ?? null,
        });
        this.metadataRevision = written.revision;
        return;
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError)) throw error;
      }
    }
    throw new WorkspaceConflictError("Terminal metadata kept changing; no terminal lineage was overwritten.");
  }

  private leasePath(sessionId: string): string {
    return `${TERMINAL_LEASE_ROOT}/${encodeURIComponent(sessionId)}.json`;
  }

  private async acquireSessionLease(sessionId: string, signal: AbortSignal): Promise<void> {
    if (this.sessions.get(sessionId)?.suppressPersistence) {
      throw new Error("This page previously lost the terminal writer lease. Reload the workspace to hydrate the authoritative transcript and lineage before starting this terminal again.");
    }
    for (let attempt = 0; attempt < MAX_METADATA_CAS_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      const path = this.leasePath(sessionId);
      const current = await this.workspace.read(path);
      const lease = current ? parseSessionLease(current.content, sessionId) : undefined;
      const now = Date.now();
      if (lease && lease.ownerId !== this.leaseOwnerId) {
        const observed = this.observedForeignLeases.get(sessionId);
        const monotonic = monotonicNow();
        if (!observed || observed.revision !== current?.revision || monotonic - observed.observedAt < TERMINAL_LEASE_TTL_MS) {
          this.observedForeignLeases.set(sessionId, Object.freeze({ revision: current!.revision, observedAt: monotonic }));
          throw new Error("This terminal has a writer heartbeat from another page or device. Stop it there, or retry after Airship has observed the same storage revision remain unchanged for 45 seconds.");
        }
      }
      const content = serializeSessionLease(sessionId, this.leaseOwnerId, now + TERMINAL_LEASE_TTL_MS);
      try {
        const written = await this.workspace.write(path, content, { expectedRevision: current?.revision ?? null });
        this.observedForeignLeases.delete(sessionId);
        this.installSessionLease(sessionId, written.revision);
        return;
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError)) throw error;
      }
    }
    throw new WorkspaceConflictError("Terminal writer lease kept changing; the process was not started.");
  }

  /**
   * Coalesce renewals behind one in-flight promise per session.
   *
   * Two heartbeats overlapping is a page racing itself on its own lease file,
   * and the loser of that compare-and-swap used to be treated as evidence of a
   * foreign writer. Concurrent callers now share the single renewal.
   */
  private renewSessionLease(sessionId: string): Promise<void> {
    const inFlight = this.leaseRenewals.get(sessionId);
    if (inFlight) return inFlight;
    const renewal = this.renewSessionLeaseNow(sessionId).finally(() => {
      if (this.leaseRenewals.get(sessionId) === renewal) this.leaseRenewals.delete(sessionId);
    });
    this.leaseRenewals.set(sessionId, renewal);
    return renewal;
  }

  /**
   * Notice a foreign takeover between heartbeats, without writing.
   *
   * Renewing the lease per keystroke raced this page against itself, but with
   * renewal left to the 12s heartbeat alone, input could keep reaching a live
   * PTY for that whole window after another page took the durable lease. A read
   * cannot lose a compare-and-swap, so this observes the takeover within a
   * second and never manufactures the conflict the renewal path had to unlearn.
   * It is deliberately not awaited: typing must not wait on storage, and the
   * heartbeat remains the guarantee for a tab nobody is typing into.
   */
  private observeSessionLeaseOwner(sessionId: string): void {
    const probe = this.leaseOwnerProbes.get(sessionId);
    const startedAt = monotonicNow();
    if (probe && (probe.inFlight || startedAt - probe.startedAt < TERMINAL_LEASE_OBSERVE_MS)) return;
    this.leaseOwnerProbes.set(sessionId, Object.freeze({ startedAt, inFlight: true }));
    void this.workspace.read(this.leasePath(sessionId)).then((current) => {
      // A missing or unreadable lease file is not evidence of another writer —
      // no other page can remove this page's lease — so only a named foreign
      // owner stops the process here. The heartbeat still handles the rest.
      if (!this.sessionLeases.has(sessionId) || !current) return;
      const owner = observedLeaseOwner(current.content, sessionId);
      if (owner && owner !== this.leaseOwnerId) this.loseSessionLease(sessionId);
    }, () => undefined).finally(() => {
      this.leaseOwnerProbes.set(sessionId, Object.freeze({ startedAt, inFlight: false }));
    });
  }

  private async renewSessionLeaseNow(sessionId: string): Promise<void> {
    const held = this.sessionLeases.get(sessionId);
    if (!held) throw new Error("This page no longer owns the terminal writer lease; its heartbeat stopped.");
    const path = this.leasePath(sessionId);
    const current = await this.workspace.read(path);
    const lease = current ? parseSessionLease(current.content, sessionId) : undefined;
    if (!current || !lease || lease.ownerId !== this.leaseOwnerId) {
      this.loseSessionLease(sessionId);
      throw new Error("This page lost the terminal writer lease; the page-local process was stopped.");
    }
    try {
      const written = await this.workspace.write(
        path,
        serializeSessionLease(sessionId, this.leaseOwnerId, Date.now() + TERMINAL_LEASE_TTL_MS),
        { expectedRevision: current.revision },
      );
      this.installSessionLease(sessionId, written.revision);
    } catch (error) {
      // A conflict alone is not evidence of a foreign writer: this page's own
      // renewal may have moved the revision. Only a different owner is a
      // takeover; otherwise adopt the observed revision and keep authority.
      if (error instanceof WorkspaceConflictError) {
        const observed = await this.workspace.read(path);
        if (observed && observedLeaseOwner(observed.content, sessionId) === this.leaseOwnerId) {
          this.installSessionLease(sessionId, observed.revision);
          return;
        }
      }
      this.loseSessionLease(sessionId);
      if (error instanceof WorkspaceConflictError) {
        throw new Error("This page lost the terminal writer lease; the page-local process was stopped.", { cause: error });
      }
      throw error;
    }
  }

  private installSessionLease(sessionId: string, revision: string): void {
    this.clearSessionLeaseTimer(sessionId);
    const timer = setTimeout(() => {
      void this.renewSessionLease(sessionId).catch(() => {
        this.loseSessionLease(sessionId);
      });
    }, TERMINAL_LEASE_RENEW_MS);
    this.sessionLeases.set(sessionId, Object.freeze({ revision, timer }));
  }

  private clearSessionLeaseTimer(sessionId: string): void {
    const held = this.sessionLeases.get(sessionId);
    if (held?.timer) clearTimeout(held.timer);
    this.sessionLeases.delete(sessionId);
    this.leaseOwnerProbes.delete(sessionId);
  }

  private loseSessionLease(sessionId: string): void {
    this.clearSessionLeaseTimer(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Once another writer owns the durable lease, this page's snapshot is a
    // stale presentation only. Excluding it from every later full-manifest
    // write lets the remote winner survive union merge unchanged.
    session.suppressPersistence = true;
    if (session.status !== "running" && session.status !== "starting") return;
    ++session.generation;
    try { session.process?.kill(); } catch { /* The lease loss is already authoritative. */ }
    releaseProcess(session);
    session.status = "failed";
    session.detail = "Terminal writer lease was lost; the page-local process was stopped before more input could be accepted.";
    session.updatedAt = new Date().toISOString();
    this.emit(session);
  }

  private async releaseSessionLease(sessionId: string): Promise<void> {
    this.clearSessionLeaseTimer(sessionId);
    const path = this.leasePath(sessionId);
    const current = await this.workspace.read(path);
    if (!current) return;
    const lease = parseSessionLease(current.content, sessionId);
    if (lease.ownerId !== this.leaseOwnerId) {
      this.loseSessionLease(sessionId);
      return;
    }
    try {
      await this.workspace.remove(path, { expectedRevision: current.revision });
    } catch (error) {
      if (!(error instanceof WorkspaceConflictError)) throw error;
    }
  }

  private requireSession(id: string): MutableSession {
    const session = this.sessions.get(id);
    if (!session || session.closedAt) throw new Error(`Unknown terminal tab: ${id}`);
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
    for (const subscription of this.listListeners) subscription.listener(this.list(subscription.profileId));
  }
}

function storedManifest(
  sessions: readonly MutableSession[],
  removedSessions: readonly StoredSessionTombstone[] = [],
): StoredManifest {
  return Object.freeze({
    version: 3,
    sessions: Object.freeze(sessions
      .filter((session) => !session.suppressPersistence)
      .map(snapshot)
      // `outputSequence`/`appendedOutput` are page-local render bookkeeping,
      // never lineage: the transcript tail below is the durable record.
      .map(({ bufferedOutput, outputSequence: _sequence, appendedOutput: _appended, ...item }): StoredSession => Object.freeze({
        ...item,
        history: boundedPersistedHistory(item.history),
        audit: boundedPersistedAudit(item.audit),
        transcriptTail: encodeStoredTranscript(bufferedOutput),
        status: item.status === "running" || item.status === "starting" ? "restart-required" : item.status,
        detail: item.status === "running" || item.status === "starting"
          ? "Process is active only while this page remains open; its transcript, cwd, input history, and lineage reconstruct after reload with a fresh process."
          : item.detail,
      }))
      .sort(compareStoredSessions)),
    removedSessions: Object.freeze([...removedSessions].sort((left, right) => left.id.localeCompare(right.id))),
  });
}

function storedManifestFromParsed(
  sessions: readonly ParsedStoredSession[],
  removedSessions: readonly StoredSessionTombstone[] = [],
): StoredManifest {
  return Object.freeze({
    version: 3,
    sessions: Object.freeze(sessions.map(({ transcriptTail, ...item }): StoredSession => Object.freeze({
      ...item,
      history: boundedPersistedHistory(item.history),
      audit: boundedPersistedAudit(item.audit),
      transcriptTail: encodeStoredTranscript(transcriptTail),
    })).sort(compareStoredSessions)),
    removedSessions: Object.freeze([...removedSessions].sort((left, right) => left.id.localeCompare(right.id))),
  });
}

/**
 * Terminal tabs have immutable UUID identities. A CAS retry must merge the
 * authoritative manifest, never merely advance the revision and replay a
 * stale full snapshot (which loses another page's tabs and audit lineage).
 */
function mergeStoredManifests(remote: StoredManifest, local: StoredManifest): StoredManifest {
  const removed = new Map<string, StoredSessionTombstone>();
  for (const tombstone of [...remote.removedSessions, ...local.removedSessions]) {
    const existing = removed.get(tombstone.id);
    if (!existing || tombstone.removedAt > existing.removedAt) removed.set(tombstone.id, tombstone);
  }
  if (removed.size > MAX_SESSION_TOMBSTONES) {
    throw new Error(`Terminal prune ledger reached its ${MAX_SESSION_TOMBSTONES}-entry safety limit. Airship refused to discard tombstones or risk resurrecting retired lineage; export and rotate this workspace's terminal archive.`);
  }
  const byId = new Map<string, StoredSession>();
  for (const session of [...remote.sessions, ...local.sessions]) {
    const tombstone = removed.get(session.id);
    if (tombstone && tombstone.removedAt >= session.updatedAt) continue;
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? mergeStoredSession(existing, session) : session);
  }
  if (byId.size > MAX_STORED_SESSIONS) {
    throw new Error(`Concurrent terminal metadata contains ${byId.size} sessions, above the ${MAX_STORED_SESSIONS}-session retention boundary; Airship refused to discard lineage.`);
  }
  return Object.freeze({
    version: 3,
    sessions: Object.freeze([...byId.values()].sort(compareStoredSessions)),
    removedSessions: Object.freeze([...removed.values()].sort((left, right) => left.id.localeCompare(right.id))),
  });
}

function mergeStoredSession(left: StoredSession, right: StoredSession): StoredSession {
  if (left.profileId !== right.profileId
    || left.createdAt !== right.createdAt
    || JSON.stringify(left.origin) !== JSON.stringify(right.origin)) {
    throw new Error(`Terminal session identity collision: ${left.id}`);
  }
  const leftAuditIds = new Set(left.audit.map((record) => record.id));
  const rightAuditIds = new Set(right.audit.map((record) => record.id));
  const leftOnly = left.audit.filter((record) => !rightAuditIds.has(record.id));
  const rightOnly = right.audit.filter((record) => !leftAuditIds.has(record.id));
  const divergentWriters = new Set([...leftOnly, ...rightOnly]
    .map((record) => record.writerId)
    .filter((writerId): writerId is string => Boolean(writerId)));
  const divergent = leftOnly.length > 0 && rightOnly.length > 0 && divergentWriters.size > 1;
  if (divergent) {
    throw new WorkspaceConflictError(`Concurrent terminal writers diverged for ${left.id}; Airship retained the authoritative manifest instead of collapsing lineage.`);
  }
  const winner = compareStoredFreshness(left, right) >= 0 ? left : right;
  const audit = new Map<string, TerminalAuditRecord>();
  for (const record of [...left.audit, ...right.audit]) {
    const existing = audit.get(record.id);
    if (!existing || compareAuditFreshness(record, existing) > 0) audit.set(record.id, record);
  }
  const closedAt = [left.closedAt, right.closedAt].filter((value): value is string => Boolean(value)).sort().at(-1);
  const lastProcessStartedAt = [left.lastProcessStartedAt, right.lastProcessStartedAt]
    .filter((value): value is string => Boolean(value)).sort().at(-1);
  return Object.freeze({
    ...winner,
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
    processEpoch: Math.max(left.processEpoch, right.processEpoch),
    ...(lastProcessStartedAt ? { lastProcessStartedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    audit: boundedPersistedAudit([...audit.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))),
  });
}

function compareStoredSessions(left: StoredSession, right: StoredSession): number {
  return left.createdAt.localeCompare(right.createdAt)
    || (left.profileId ?? "").localeCompare(right.profileId ?? "")
    || left.id.localeCompare(right.id);
}

function compareStoredFreshness(left: StoredSession, right: StoredSession): number {
  return left.updatedAt.localeCompare(right.updatedAt) || JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function compareAuditFreshness(left: TerminalAuditRecord, right: TerminalAuditRecord): number {
  return left.recordedAt.localeCompare(right.recordedAt) || JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function snapshot(session: MutableSession): TerminalSessionSnapshot {
  return Object.freeze({
    id: session.id,
    name: session.name,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    ...(session.threadId ? { threadId: session.threadId } : {}),
    origin: Object.freeze({ ...session.origin }),
    runtime: WEB_CONTAINER_TERMINAL_RUNTIME,
    cwd: session.cwd,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    processEpoch: session.processEpoch,
    ...(session.lastProcessStartedAt ? { lastProcessStartedAt: session.lastProcessStartedAt } : {}),
    ...(session.closedAt ? { closedAt: session.closedAt } : {}),
    reconstructed: session.reconstructed,
    history: Object.freeze([...session.history]),
    audit: Object.freeze(session.audit.map((record) => Object.freeze({
      ...record,
      ...(record.changedPaths ? { changedPaths: Object.freeze([...record.changedPaths]) } : {}),
    }))),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    detail: session.detail,
    bufferedOutput: session.bufferedOutput,
    outputSequence: session.outputSequence,
    appendedOutput: session.appendedOutput,
  });
}

function releaseProcess(session: MutableSession): void {
  void session.writer?.close().catch(() => undefined);
  session.writer?.releaseLock();
  session.writer = undefined;
  session.process = undefined;
}

function rememberInput(session: MutableSession, data: string): readonly string[] {
  const committed: string[] = [];
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = session.inputLine.trim();
      if (command) {
        const bounded = command.slice(0, MAX_HISTORY_CHARS);
        session.history.push(bounded);
        committed.push(bounded);
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
  return Object.freeze(committed);
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

function parseManifest(content: string): Readonly<{
  sessions: readonly ParsedStoredSession[];
  removedSessions: readonly StoredSessionTombstone[];
}> {
  try {
    const value = JSON.parse(content) as { version?: unknown; sessions?: unknown; removedSessions?: unknown };
    if ((value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.sessions)) throw new Error();
    const sessions = value.sessions.map((session) => parseStoredSession(session, value.version as 1 | 2 | 3));
    const removedSessions = value.version === 3 && value.removedSessions !== undefined
      ? Array.isArray(value.removedSessions)
        ? value.removedSessions.map(parseStoredSessionTombstone)
        : (() => { throw new Error(); })()
      : [];
    if (removedSessions.length > MAX_SESSION_TOMBSTONES) {
      throw new TerminalMetadataCapacityError(
        `Terminal prune ledger exceeds its ${MAX_SESSION_TOMBSTONES}-entry safety limit. Airship refused to discard tombstones or risk resurrecting retired lineage; export and rotate this workspace's terminal archive.`,
      );
    }
    return Object.freeze({
      sessions: Object.freeze(sessions.filter((session) => {
        const tombstone = removedSessions.find((candidate) => candidate.id === session.id);
        return !tombstone || tombstone.removedAt < session.updatedAt;
      })),
      removedSessions: Object.freeze(removedSessions),
    });
  } catch (error) {
    if (error instanceof TerminalMetadataCapacityError) throw error;
    throw new Error("Terminal metadata is malformed; Airship refused to guess process state.");
  }
}

function parseStoredSessionTombstone(value: unknown): StoredSessionTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 128
    || typeof item.removedAt !== "string" || !Number.isFinite(Date.parse(item.removedAt))
    || item.reason !== "bounded-closed-session-prune") throw new Error();
  return Object.freeze({ id: item.id, removedAt: item.removedAt, reason: item.reason });
}

function parseSessionLease(content: string, expectedSessionId: string): Readonly<{
  ownerId: string;
  expiresAt: number;
}> {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value.version !== 1
      || value.sessionId !== expectedSessionId
      || typeof value.ownerId !== "string" || !value.ownerId || value.ownerId.length > 128
      || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) throw new Error();
    return Object.freeze({ ownerId: value.ownerId, expiresAt: value.expiresAt });
  } catch {
    throw new Error(`Terminal writer lease is malformed for ${expectedSessionId}; Airship refused to take it over.`);
  }
}

/** The owner a lease file names, or undefined when it cannot be trusted at all. */
function observedLeaseOwner(content: string, sessionId: string): string | undefined {
  try { return parseSessionLease(content, sessionId).ownerId; }
  catch { return undefined; }
}

function serializeSessionLease(sessionId: string, ownerId: string, expiresAt: number): string {
  return `${JSON.stringify({ version: 1, sessionId, ownerId, expiresAt }, null, 2)}\n`;
}

function parseStoredSession(value: unknown, version: 1 | 2 | 3): ParsedStoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 128
    || typeof item.name !== "string" || !item.name || item.name.length > 80
    || typeof item.cwd !== "string" || !item.cwd.startsWith("/workspace")
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))
    || typeof item.detail !== "string" || item.detail.length > 1_024
    || !Array.isArray(item.history) || !item.history.every((entry) => typeof entry === "string")
    || !["idle", "starting", "running", "exited", "failed", "restart-required"].includes(String(item.status))) throw new Error();
  if (item.transcriptTail !== undefined && (typeof item.transcriptTail !== "string" || item.transcriptTail.length > MAX_ENCODED_TRANSCRIPT_CHARS)) throw new Error();
  if (item.profileId !== undefined && typeof item.profileId !== "string") throw new Error();
  if (item.threadId !== undefined && typeof item.threadId !== "string") throw new Error();
  if (item.exitCode !== undefined && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode))) throw new Error();
  if (item.lastProcessStartedAt !== undefined && (typeof item.lastProcessStartedAt !== "string" || !Number.isFinite(Date.parse(item.lastProcessStartedAt)))) throw new Error();
  if (item.closedAt !== undefined && (typeof item.closedAt !== "string" || !Number.isFinite(Date.parse(item.closedAt)))) throw new Error();

  const profileId = typeof item.profileId === "string" ? boundedProfile(item.profileId) : undefined;
  const threadId = typeof item.threadId === "string" ? boundedThread(item.threadId) : undefined;
  const processEpoch = version === 3 ? item.processEpoch : 0;
  const reconstructed = version === 3 ? item.reconstructed : false;
  const auditValue = version === 3 ? item.audit : [];
  if (typeof processEpoch !== "number" || !Number.isSafeInteger(processEpoch) || processEpoch < 0 || typeof reconstructed !== "boolean" || !Array.isArray(auditValue)) throw new Error();
  if (version === 3) assertStoredRuntime(item.runtime);
  const origin = version === 3
    ? parseStoredOrigin(item.origin)
    : boundedOrigin({ kind: threadId ? "conversation" : "terminal-route" });
  const audit = auditValue.map(parseAuditRecord);
  return Object.freeze({
    id: item.id,
    name: boundedName(item.name),
    ...(profileId ? { profileId } : {}),
    ...(threadId ? { threadId } : {}),
    origin,
    runtime: WEB_CONTAINER_TERMINAL_RUNTIME,
    cwd: normalizeWorkspacePath(item.cwd),
    status: item.status as TerminalSessionStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    processEpoch,
    ...(typeof item.lastProcessStartedAt === "string" ? { lastProcessStartedAt: item.lastProcessStartedAt } : {}),
    ...(typeof item.closedAt === "string" ? { closedAt: item.closedAt } : {}),
    reconstructed,
    history: boundedPersistedHistory(item.history as string[]),
    audit: Object.freeze(audit),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    detail: item.detail,
    transcriptTail: version >= 2 && typeof item.transcriptTail === "string"
      ? decodeStoredTranscript(item.transcriptTail)
      : "",
  });
}

function assertStoredRuntime(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (item.engine !== WEB_CONTAINER_TERMINAL_RUNTIME.engine
    || item.engineLabel !== WEB_CONTAINER_TERMINAL_RUNTIME.engineLabel
    || item.shell !== WEB_CONTAINER_TERMINAL_RUNTIME.shell
    || item.shellLabel !== WEB_CONTAINER_TERMINAL_RUNTIME.shellLabel
    || item.interaction !== WEB_CONTAINER_TERMINAL_RUNTIME.interaction
    || item.processLifetime !== WEB_CONTAINER_TERMINAL_RUNTIME.processLifetime
    || item.filesystemLifetime !== WEB_CONTAINER_TERMINAL_RUNTIME.filesystemLifetime) throw new Error();
}

function parseStoredOrigin(value: unknown): TerminalSessionOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (item.kind !== "terminal-route" && item.kind !== "workspace-path" && item.kind !== "conversation") throw new Error();
  if (item.path !== undefined && typeof item.path !== "string") throw new Error();
  if (item.requestId !== undefined && typeof item.requestId !== "string") throw new Error();
  return boundedOrigin({
    kind: item.kind,
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(typeof item.requestId === "string" ? { requestId: item.requestId } : {}),
  });
}

function parseAuditRecord(value: unknown): TerminalAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || item.id.length > 256
    || typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence < 1
    || !["interactive-input", "process-start", "process-exit", "workspace-reconcile"].includes(String(item.kind))
    || !["submitted", "completed", "failed"].includes(String(item.outcome))
    || typeof item.recordedAt !== "string" || !Number.isFinite(Date.parse(item.recordedAt))
    || typeof item.processEpoch !== "number" || !Number.isSafeInteger(item.processEpoch) || item.processEpoch < 0
    || typeof item.summary !== "string"
    || (item.writerId !== undefined && (typeof item.writerId !== "string" || !item.writerId || item.writerId.length > 128))
    || (item.command !== undefined && typeof item.command !== "string")
    || (item.outputTail !== undefined && typeof item.outputTail !== "string")
    || (item.exitCode !== undefined && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)))
    || (item.changedPaths !== undefined && (!Array.isArray(item.changedPaths) || !item.changedPaths.every((path) => typeof path === "string")))) throw new Error();
  return Object.freeze({
    id: item.id,
    ...(typeof item.writerId === "string" ? { writerId: item.writerId } : {}),
    sequence: item.sequence,
    kind: item.kind as TerminalAuditRecord["kind"],
    outcome: item.outcome as TerminalAuditRecord["outcome"],
    recordedAt: item.recordedAt,
    processEpoch: item.processEpoch,
    summary: item.summary.slice(0, MAX_AUDIT_SUMMARY_CHARS),
    ...(typeof item.command === "string" ? { command: item.command.slice(0, MAX_AUDIT_COMMAND_CHARS) } : {}),
    ...(typeof item.outputTail === "string" ? { outputTail: utf8Tail(item.outputTail, MAX_AUDIT_OUTPUT_CHARS) } : {}),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(Array.isArray(item.changedPaths) ? { changedPaths: Object.freeze((item.changedPaths as string[]).slice(0, MAX_AUDIT_CHANGED_PATHS).map((path) => path.slice(0, 512))) } : {}),
  });
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

function boundedPersistedAudit(records: readonly TerminalAuditRecord[]): readonly TerminalAuditRecord[] {
  const selected: TerminalAuditRecord[] = [];
  const encoder = new TextEncoder();
  let remaining = MAX_PERSISTED_AUDIT_BYTES;
  for (let index = records.length - 1; index >= 0 && selected.length < MAX_AUDIT_RECORDS && remaining > 0; index -= 1) {
    const source = records[index]!;
    let candidate: TerminalAuditRecord = Object.freeze({
      ...source,
      summary: source.summary.slice(0, MAX_AUDIT_SUMMARY_CHARS),
      ...(source.command ? { command: source.command.slice(0, MAX_AUDIT_COMMAND_CHARS) } : {}),
      ...(source.outputTail ? { outputTail: utf8Tail(source.outputTail, MAX_AUDIT_OUTPUT_CHARS) } : {}),
      ...(source.changedPaths ? { changedPaths: Object.freeze(source.changedPaths.slice(0, MAX_AUDIT_CHANGED_PATHS).map((path) => path.slice(0, 512))) } : {}),
    });
    let width = encoder.encode(JSON.stringify(candidate)).byteLength;
    if (width > remaining) {
      candidate = Object.freeze({
        id: source.id,
        ...(source.writerId ? { writerId: source.writerId } : {}),
        sequence: source.sequence,
        kind: source.kind,
        outcome: source.outcome,
        recordedAt: source.recordedAt,
        processEpoch: source.processEpoch,
        summary: source.summary.slice(0, 256),
        ...(source.command ? { command: source.command.slice(0, 256) } : {}),
        ...(source.exitCode === undefined ? {} : { exitCode: source.exitCode }),
      });
      width = encoder.encode(JSON.stringify(candidate)).byteLength;
    }
    if (width > remaining) break;
    selected.unshift(candidate);
    remaining -= width;
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
  if (binary.length > MAX_ACCEPTED_TRANSCRIPT_BYTES) throw new Error("Terminal transcript exceeds its 64 KiB migration budget.");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return utf8Tail(new TextDecoder("utf-8", { fatal: true }).decode(bytes), MAX_PERSISTED_OUTPUT_BYTES);
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
  return boundedAssociation(value, "Terminal thread association");
}

function boundedProfile(value: string): string {
  return boundedAssociation(value, "Terminal profile association");
}

function boundedAssociation(value: string, label: string): string {
  const association = value.trim();
  if (!association || association.length > 256 || /[\u0000-\u001f\u007f]/u.test(association)) throw new Error(`${label} is invalid.`);
  return association;
}

function boundedOrigin(value: TerminalSessionOrigin): TerminalSessionOrigin {
  if (!value || !["terminal-route", "workspace-path", "conversation"].includes(value.kind)) {
    throw new Error("Terminal origin is invalid.");
  }
  const path = value.path ? normalizeWorkspacePath(value.path) : undefined;
  const requestId = value.requestId ? boundedAssociation(value.requestId, "Terminal workspace request") : undefined;
  if (value.kind === "workspace-path" && !path) throw new Error("A workspace terminal origin requires a path.");
  if (requestId && value.kind !== "workspace-path") throw new Error("Only a workspace terminal origin can carry a request ID.");
  return Object.freeze({ kind: value.kind, ...(path ? { path } : {}), ...(requestId ? { requestId } : {}) });
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function withHostAuthority<T>(operation: () => Promise<T>): Promise<T> {
  const result = hostAuthorityTail.then(operation, operation);
  hostAuthorityTail = result.then(() => undefined, () => undefined);
  return result;
}
