export const TERMINAL_DOCK_STORAGE_PREFIX = "airship.terminal.dock.v1";
export const TERMINAL_DOCK_DEFAULT_HEIGHT = 320;
/** The height a dock opens to when the panel can afford it — comfort, not a floor. */
export const TERMINAL_DOCK_MIN_HEIGHT = 220;
/**
 * The room the surface above the dock keeps, whatever the dock was resized to.
 *
 * It is the workbench's own chrome, measured on the shipped build at 932x430
 * with the dock open: the document tab strip is 51px and the file strip beneath
 * the code — the verdict chip, the path, the revision line and the
 * theme/Keep-open/Wrap/Save row it wraps to at that width — is 99px. 150px of
 * controls, none of which the code frame can be asked to give back, because
 * `.code-editor-frame` is already at zero by then. This was 144px, and 144 is
 * what sliced the Save row in half under the dock's top edge.
 */
export const TERMINAL_DOCK_EDITOR_FLOOR = 156;
/**
 * And the room the dock keeps for its own controls, so honouring the floor
 * above can never bury the terminal instead. Measured at 932x430: a 24px resize
 * handle on a coarse pointer, a 43px toolbar (Reconcile / New / Full view /
 * Collapse), a 27px session strip and a 40px session header — 134px.
 *
 * It is the controls and not a pixel more, deliberately. A more generous number
 * reads as kinder to the terminal and is the opposite: at 932x430 the route is
 * 32px taller than the room it is drawn in (`.editor-route`'s `min-height:
 * 22rem` against a 342px `.main`, with the route not scrolling), so the panel
 * measures 327px while only 295px of it is on screen. A dock floor of 160 fits
 * the panel and would slice the editor's controls again the day that 32px is
 * given back; 136 leaves both surfaces whole at either reading. It does not
 * bind at any measured viewport — `available - TERMINAL_DOCK_EDITOR_FLOOR` is
 * the larger term at every one of the eight — and exists so that a panel
 * shorter than any of them still cannot leave the terminal unoperable.
 */
export const TERMINAL_DOCK_FLOOR_HEIGHT = 136;
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

/**
 * The tallest this dock may be inside a measured panel, and the one place the
 * two floors are ranked against each other.
 *
 * `Math.max(TERMINAL_DOCK_MIN_HEIGHT, …)` stood where the dock's floor stands
 * now, which made the dock's opening comfort outrank the editor's controls: on
 * a 932x430 landscape phone the panel is 327px, so the editor floor asked for
 * 171px and the old expression returned 220px anyway. The workbench was left
 * 107px for 150px of chrome and `.workbench-shell`'s `overflow: hidden` cut the
 * difference off — the theme picker, Keep open, Wrap and Save sliced through
 * the middle by the dock's top edge, with nothing on the route scrolling and no
 * way to reach them but to collapse the dock. A comfortable default is not a
 * reason to bury another surface's only controls, so the editor floor wins and
 * the dock keeps its own floor rather than a preference.
 *
 * The 720px arm is the unseen-viewport fallback: with no measured parent there
 * is no honest bound, and it is deliberately not a floor either.
 */
export function terminalDockMaximum(availableHeight?: number): number {
  return typeof availableHeight === "number" && Number.isFinite(availableHeight)
    ? Math.max(TERMINAL_DOCK_FLOOR_HEIGHT, Math.floor(availableHeight) - TERMINAL_DOCK_EDITOR_FLOOR)
    : 720;
}

/** The shortest the dock may be made, which a panel too small for both lowers. */
export function terminalDockMinimum(availableHeight?: number): number {
  return Math.min(TERMINAL_DOCK_MIN_HEIGHT, terminalDockMaximum(availableHeight));
}

export function terminalDockHeight(height: number, availableHeight?: number): number {
  const finite = Number.isFinite(height) ? height : TERMINAL_DOCK_DEFAULT_HEIGHT;
  return Math.min(terminalDockMaximum(availableHeight), Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(finite)));
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
