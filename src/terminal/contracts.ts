export type TerminalSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "restart-required";

export type TerminalSessionSnapshot = Readonly<{
  id: string;
  name: string;
  threadId?: string;
  cwd: string;
  status: TerminalSessionStatus;
  createdAt: string;
  updatedAt: string;
  history: readonly string[];
  exitCode?: number;
  detail: string;
  bufferedOutput: string;
}>;

export type TerminalDimensions = Readonly<{ cols: number; rows: number }>;

export const TERMINAL_METADATA_PATH = "/workspace/.airship/terminal/sessions.v1.json";
export const TERMINAL_WORKSPACE_MOUNT = "airship-workspace";
