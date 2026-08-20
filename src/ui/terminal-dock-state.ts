export const TERMINAL_DOCK_STORAGE_PREFIX = "airship.terminal.dock.v1";
export const TERMINAL_DOCK_DEFAULT_HEIGHT = 320;
/**
 * The height a dock opens to, and the shortest a reader may drag it to.
 *
 * It is chrome plus one row of output on a pointer that is not a finger,
 * measured on the shipped build at `comfortable`, which is the shipped density:
 * 1px of dock border, a 6px separator, a 43px toolbar, a 38px session strip,
 * 46px of process bar inside the card's borders, a 30px status line and 21px of
 * gaps and route padding come to 185px before one character of transcript, and
 * the emulator cell is 22px inside a 12px gutter. 185 + 34 = 219, and the dock
 * has shipped at 220 since it was written.
 *
 * It stays the resize floor and is deliberately not the gate below. A reader
 * dragging the separator down to 220 on a phone is doing something to their own
 * dock with their own finger and can drag it back; the product handing them a
 * box that size unasked is a different act, and it is the one that went wrong.
 */
export const TERMINAL_DOCK_MIN_HEIGHT = 220;
/**
 * The shortest box that can hold a terminal on the device where the dock's own
 * chrome is largest, which is the number a panel has to afford before an open
 * dock may be drawn in it at all.
 *
 * The same accounting as above, measured on a phone, where every part of the
 * frame is bigger: a 24px separator a finger can land on rather than 6, an 84px
 * toolbar wrapping the runtime boundary onto three lines rather than 43, 44px
 * touch targets on the session strip, and a status line that wraps. That comes
 * to 246px, and it was checked against the shipped build rather than summed
 * from the stylesheet — at 390x844 the dock's box is 320px and its emulator
 * measured 74px, which is 320 - 246 exactly. One 22px row inside its 12px
 * gutter makes 280.
 *
 * One number rather than one per device class, and it is the phone's, because
 * the failure it prevents is asymmetric: a fine-pointer panel between 376px and
 * 436px loses a two-line dock it could technically have drawn and gains a bar
 * that tells the truth, while a phone panel in that band without this number
 * draws a process card with its bottom border off the screen. No shipped device
 * class sits in that band on either pointer — the six panels that fit are 653px
 * and taller — so the number is not chosen to spare any of them.
 */
export const TERMINAL_DOCK_OPEN_HEIGHT = 280;
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
 * Whether a measured panel can hold an open dock at all.
 *
 * This is the question the clamp was answering with a number, and a number was
 * the wrong shape of answer. Ranking the editor's floor above the dock's
 * opening height was right and stays: on a 932x430 landscape phone the panel is
 * 327px, and returning the dock's 220px there left the workbench 107px for
 * 150px of chrome, with `.workbench-shell`'s `overflow: hidden` slicing the
 * theme picker, Keep open, Wrap and Save through the middle. What was wrong was
 * the second floor underneath it — 136px, "the dock's own controls and not a
 * pixel more" — because a dock the exact height of its own controls has no
 * output area by construction, and the clamp handed one back as though it were
 * a smaller terminal.
 *
 * Measured off the shipped frames at 932x430 and 320x568, the two panels the
 * clamp bound at. At 932x430 the dock's top border is at y=247 and the shell's
 * navigation band at y=386: 139px of screen for 246px of phone chrome, of which
 * the transcript was rows 369 to 385 — 17px, where one line needs 22 — and the
 * process card's bottom border was never drawn at all, because the card ends at
 * y=412, twenty-six pixels below the last row of the screen. At 320x568 the
 * same reading gives 175px and an 8px transcript. In both, `.terminal-tabs`'
 * own `overflow-x` zeroes its automatic minimum size, so the session strip was
 * the row that silently absorbed the shortfall and vanished.
 *
 * There is no redistribution of 139px that produces a terminal; the shortfall
 * is not air between the rows, it is about 75px of screen that does not exist.
 *
 * So a panel that cannot seat `TERMINAL_DOCK_OPEN_HEIGHT` beside the editor's
 * floor does not host an open dock, and `workspace-terminal-dock.tsx` renders
 * the closed bar and says why. It does not write `open: false`: the reader's
 * intent survives, and rotating the phone back to a panel that fits reopens the
 * dock exactly as they left it.
 *
 * With no measured parent there is no honest answer, and the honest default is
 * to believe the reader rather than close a dock they asked for.
 */
export function terminalDockFitsPanel(availableHeight?: number): boolean {
  return !isMeasuredPanel(availableHeight)
    || Math.floor(availableHeight) - TERMINAL_DOCK_EDITOR_FLOOR >= TERMINAL_DOCK_OPEN_HEIGHT;
}

/**
 * The tallest this dock may be inside a measured panel.
 *
 * The `Math.max` is no longer a floor being ranked against the editor's — it is
 * the statement that this function only ever describes a dock that is actually
 * rendered, and a dock is only rendered on a panel `terminalDockFitsPanel`
 * admitted. On any other panel the number would describe a terminal with no
 * transcript in it.
 *
 * The 720px arm is the unseen-viewport fallback: with no measured parent there
 * is no honest bound, and it is deliberately not a floor either.
 */
export function terminalDockMaximum(availableHeight?: number): number {
  return isMeasuredPanel(availableHeight)
    ? Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.floor(availableHeight) - TERMINAL_DOCK_EDITOR_FLOOR)
    : 720;
}

/**
 * The shortest the dock may be made, which no panel lowers any more.
 *
 * It took an `availableHeight` and returned `min(220, maximum)` so that the
 * separator could not report an `aria-valuemin` above its own `aria-valuemax`
 * on a panel too small for both surfaces. That range is now impossible to
 * state: every panel that renders a separator at all is one where the maximum
 * is at least 220, so the invariant holds by construction rather than by a
 * second clamp that could drift out of step with the first.
 */
export function terminalDockMinimum(): number {
  return TERMINAL_DOCK_MIN_HEIGHT;
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
    // taller than 720px back down to the guess. Use the stored height here;
    // the dock re-clamps against the real parent before it renders anything.
    height: availableHeight === undefined ? storedTerminalDockHeight(state.height) : terminalDockHeight(state.height, availableHeight),
    ...(boundedSessionId(state.selectedSessionId) ? { selectedSessionId: state.selectedSessionId } : {}),
  });
}

/** Round-trip storage without an upper bound; the measured clamp is `terminalDockHeight`. */
function storedTerminalDockHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(height)) : TERMINAL_DOCK_DEFAULT_HEIGHT;
}

function isMeasuredPanel(availableHeight?: number): availableHeight is number {
  return typeof availableHeight === "number" && Number.isFinite(availableHeight);
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
