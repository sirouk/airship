export const TERMINAL_DOCK_STORAGE_PREFIX = "airship.terminal.dock.v1";
export const TERMINAL_DOCK_DEFAULT_HEIGHT = 320;
export const TERMINAL_DOCK_MIN_HEIGHT = 220;
export const TERMINAL_DOCK_EDITOR_FLOOR = 144;
export const TERMINAL_DOCK_RESIZE_STEP = 24;

export type TerminalDockState = Readonly<{
  open: boolean;
  height: number;
  selectedSessionId?: string;
}>;

export type TerminalOpenRequest = Readonly<{
  id: string;
  cwd: string;
  name?: string;
  /** The cockpit that issued the request; it may never be replayed in another Profile. */
  profileId: string;
  /** The workspace authority that resolved the CWD. */
  workspaceIdentity: string;
}>;

const DEFAULT_STATE: TerminalDockState = Object.freeze({
  open: false,
  height: TERMINAL_DOCK_DEFAULT_HEIGHT,
});

/**
 * One collision-free browser-session key for a workspace/profile cockpit.
 * Length-prefixing keeps adversarial identifiers such as `a.bc` and `a.b/c`
 * from ever aliasing one another without leaking those identifiers into CSS.
 */
export function terminalDockStorageKey(workspaceIdentity: string, profileId: string): string {
  return `${TERMINAL_DOCK_STORAGE_PREFIX}.${storageSegment(workspaceIdentity, "Workspace identity")}.${storageSegment(profileId, "Profile ID")}`;
}

/** Fail closed when an async CWD request outlives the Profile/workspace that issued it. */
export function terminalOpenRequestForAuthority(
  request: TerminalOpenRequest | undefined,
  workspaceIdentity: string,
  profileId: string,
): TerminalOpenRequest | undefined {
  return request?.workspaceIdentity === workspaceIdentity && request.profileId === profileId
    ? request
    : undefined;
}

export function readTerminalDockState(
  storage: Pick<Storage, "getItem"> | undefined,
  workspaceIdentity: string,
  profileId: string,
  availableHeight?: number,
): TerminalDockState {
  if (!storage) return clampTerminalDockState(DEFAULT_STATE, availableHeight);
  try {
    const value = JSON.parse(storage.getItem(terminalDockStorageKey(workspaceIdentity, profileId)) ?? "{}") as Record<string, unknown>;
    const selectedSessionId = boundedSessionId(value.selectedSessionId);
    return clampTerminalDockState(Object.freeze({
      open: value.open === true,
      height: typeof value.height === "number" ? value.height : TERMINAL_DOCK_DEFAULT_HEIGHT,
      ...(selectedSessionId ? { selectedSessionId } : {}),
    }), availableHeight);
  } catch {
    return clampTerminalDockState(DEFAULT_STATE, availableHeight);
  }
}

/** Merge one surface update so the dock and full route cannot erase each other's selection/layout. */
export function updateTerminalDockState(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  workspaceIdentity: string,
  profileId: string,
  patch: Partial<TerminalDockState>,
  availableHeight?: number,
): TerminalDockState {
  const current = readTerminalDockState(storage, workspaceIdentity, profileId, availableHeight);
  const next = clampTerminalDockState(Object.freeze({ ...current, ...patch }), availableHeight);
  try {
    storage?.setItem(terminalDockStorageKey(workspaceIdentity, profileId), JSON.stringify(next));
  } catch { /* Browser-session UI state is optional; terminal authority is the workspace manager. */ }
  return next;
}

export function terminalDockHeight(height: number, availableHeight?: number): number {
  const finite = Number.isFinite(height) ? height : TERMINAL_DOCK_DEFAULT_HEIGHT;
  const lower = TERMINAL_DOCK_MIN_HEIGHT;
  const upper = typeof availableHeight === "number" && Number.isFinite(availableHeight)
    ? Math.max(lower, Math.floor(availableHeight) - TERMINAL_DOCK_EDITOR_FLOOR)
    : 720;
  return Math.min(upper, Math.max(lower, Math.round(finite)));
}

function clampTerminalDockState(state: TerminalDockState, availableHeight?: number): TerminalDockState {
  return Object.freeze({
    open: state.open,
    // There is no honest upper bound without a measured parent. The 720px
    // fallback answered that absence with a guess, and every selection-driven
    // update — which travels with no height argument — round-tripped a dock
    // taller than 720px back down to the guess. Trust the stored height here;
    // the dock re-clamps against the real parent before it renders anything.
    height: availableHeight === undefined ? storedTerminalDockHeight(state.height) : terminalDockHeight(state.height, availableHeight),
    ...(boundedSessionId(state.selectedSessionId) ? { selectedSessionId: state.selectedSessionId } : {}),
  });
}

/** Round-trip storage without an upper bound; the measured clamp is `terminalDockHeight`. */
function storedTerminalDockHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(height)) : TERMINAL_DOCK_DEFAULT_HEIGHT;
}

function storageSegment(value: string, label: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid for terminal dock state.`);
  return `${String([...value].length)}-${[...value].map((point) => point.codePointAt(0)!.toString(16)).join("-")}`;
}

function boundedSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
