export type TerminalSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "restart-required";

/** The only interactive runtime this manager has actually live-probed. */
export const WEB_CONTAINER_TERMINAL_RUNTIME = Object.freeze({
  engine: "webcontainer-node" as const,
  engineLabel: "Node.js · WebContainer",
  shell: "webcontainer-jsh" as const,
  shellLabel: "jsh",
  interaction: "interactive-pty" as const,
  processLifetime: "page" as const,
  filesystemLifetime: "workspace-snapshot" as const,
});

export type TerminalRuntimeIdentity = typeof WEB_CONTAINER_TERMINAL_RUNTIME;

export type TerminalSessionOrigin = Readonly<{
  kind: "terminal-route" | "workspace-path" | "conversation";
  path?: string;
  /** Idempotence key supplied by a Workspace "open terminal here" request. */
  requestId?: string;
}>;

export type TerminalAuditRecord = Readonly<{
  id: string;
  /** Page-unique writer identity used to detect split terminal lineage. */
  writerId?: string;
  sequence: number;
  kind: "interactive-input" | "process-start" | "process-exit" | "workspace-reconcile" | "browser-git";
  outcome: "submitted" | "completed" | "failed";
  recordedAt: string;
  processEpoch: number;
  summary: string;
  /** Interactive-input record answered by an Airship-owned sideband. */
  sourceRecordId?: string;
  command?: string;
  outputTail?: string;
  exitCode?: number;
  changedPaths?: readonly string[];
}>;

/** One current-page PTY line that Airship's browser-owned Git can answer. */
export type TerminalBrowserGitIntent = Readonly<{
  sessionId: string;
  sourceRecordId: string;
  command: string;
  cwd: string;
}>;

export type TerminalSessionSnapshot = Readonly<{
  id: string;
  name: string;
  /** Absent only for v1/v2 metadata created before profile ownership existed. */
  profileId?: string;
  threadId?: string;
  origin: TerminalSessionOrigin;
  runtime: TerminalRuntimeIdentity;
  cwd: string;
  status: TerminalSessionStatus;
  createdAt: string;
  updatedAt: string;
  /** Monotonic within this durable session identity; processes never survive a page. */
  processEpoch: number;
  lastProcessStartedAt?: string;
  /** Closing removes the tab, not its bounded lineage record. */
  closedAt?: string;
  reconstructed: boolean;
  history: readonly string[];
  audit: readonly TerminalAuditRecord[];
  exitCode?: number;
  detail: string;
  /** A sliding tail, capped: past the cap this is no longer append-only. */
  bufferedOutput: string;
  /**
   * Monotonic, incremented once per appended PTY chunk.
   *
   * A consumer that advanced by exactly one may write `appendedOutput` alone;
   * any other step (first mount, resubscribe, reconstruction) means it has to
   * redraw from `bufferedOutput`. Page-local render bookkeeping, never lineage.
   */
  outputSequence: number;
  /** Exactly the text the append that produced `outputSequence` added. */
  appendedOutput: string;
}>;

export type TerminalDimensions = Readonly<{ cols: number; rows: number }>;

export const TERMINAL_METADATA_PATH = "/workspace/.airship/terminal/sessions.v1.json";
export const TERMINAL_WORKSPACE_MOUNT = "airship-workspace";
