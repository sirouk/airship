/**
 * The rail's three states, and the memory that keeps them from being guessed
 * twice.
 *
 * The rail used to have three *layouts* — a 232px desktop sidebar, a 104px
 * tablet icon column and no rail at all on a phone — chosen entirely by width,
 * with no way for a person to say which one they wanted. Two of the three were
 * width-derived guesses about intent, and the tablet one silently deleted the
 * conversation switcher and the profile switcher on the way through. This
 * module holds the whole decision: what the viewport suggests, what the user
 * chose, and which of the two wins.
 *
 * The rule is: the viewport picks the *first* state you see, and after that the
 * choice wins forever, per width band. A laptop and an external 4K display are
 * different working postures, so one preference for both would be a third
 * guess; two bands is the smallest split that stops the rail re-collapsing
 * every time a lid is opened at a desk.
 */

export type RailState = "standard" | "rail" | "focus";

/**
 * The two bands a preference is remembered against. `wide` is a viewport that
 * can hold the designed rail + measure + inspector layout at once; `narrow` is
 * everything below it that still shows a rail at all.
 */
export type RailBand = "wide" | "narrow";

/**
 * 232px rail + 820px measure + 310px inspector. Below this the designed layout
 * stops fitting, which is a fact about the layout rather than a taste.
 */
export const RAIL_WIDE_MIN_WIDTH = 1362;

/**
 * A touch tablet gets the 232px rail, not the 60px one, down to this width.
 *
 * The 60px rail's labels live in hover tooltips, and a coarse pointer has no
 * hover — so defaulting a tablet to `rail` would ship nine unlabelled icons.
 * The reason the old 104px tablet rail beat the 232px one was content volume,
 * and the content set is 429px now, so 232px fits an iPad with room to spare.
 */
export const RAIL_TOUCH_STANDARD_MIN_WIDTH = 861;

export type RailViewport = Readonly<{
  width: number;
  /** `matchMedia("(hover: hover)")`. False on a touch tablet. */
  hoverCapable: boolean;
}>;

export type RailPreference = Readonly<Partial<Record<RailBand, RailState>>>;

export const RAIL_PREFERENCE_STORAGE_KEY = "airship.rail-state.v1";

const EMPTY_PREFERENCE: RailPreference = Object.freeze({});

export function railBand(viewportWidth: number): RailBand {
  return viewportWidth >= RAIL_WIDE_MIN_WIDTH ? "wide" : "narrow";
}

/** What the viewport suggests before anyone has expressed a preference. */
export function defaultRailState(viewport: RailViewport): RailState {
  if (viewport.width >= RAIL_WIDE_MIN_WIDTH) return "standard";
  if (!viewport.hoverCapable && viewport.width >= RAIL_TOUCH_STANDARD_MIN_WIDTH) return "standard";
  return "rail";
}

/** The remembered choice for this band if there is one, else the default. */
export function resolveRailState(preference: RailPreference, viewport: RailViewport): RailState {
  return preference[railBand(viewport.width)] ?? defaultRailState(viewport);
}

/**
 * What the collapse control does.
 *
 * `focus` is not part of the cycle: it hides chrome that carries claims, so it
 * is only ever entered and left deliberately, and leaving it returns to the
 * rail you can actually navigate with.
 */
export function toggledRailState(state: RailState): RailState {
  return state === "standard" ? "rail" : "standard";
}

export function withRailState(
  preference: RailPreference,
  band: RailBand,
  state: RailState,
): RailPreference {
  return Object.freeze({ ...preference, [band]: state });
}

function parseRailState(value: unknown): RailState | undefined {
  return value === "standard" || value === "rail" || value === "focus" ? value : undefined;
}

export function loadRailPreference(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): RailPreference {
  if (!storage) return EMPTY_PREFERENCE;
  try {
    const value = JSON.parse(storage.getItem(RAIL_PREFERENCE_STORAGE_KEY) ?? "null") as Partial<Record<string, unknown>> | null;
    if (!value || typeof value !== "object") return EMPTY_PREFERENCE;
    const wide = parseRailState(value.wide);
    const narrow = parseRailState(value.narrow);
    return Object.freeze({ ...(wide ? { wide } : {}), ...(narrow ? { narrow } : {}) });
  } catch {
    // A corrupt preference must not cost the user a rail; fall back to the
    // viewport-derived default rather than throwing on first paint.
    return EMPTY_PREFERENCE;
  }
}

export function saveRailPreference(
  preference: RailPreference,
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): void {
  try {
    storage?.setItem(RAIL_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    /* The choice stays live for this page even when storage refuses it. */
  }
}

/**
 * Does this keystroke ask for the rail to collapse or expand?
 *
 * `Meta`/`Ctrl` + `\`, matching the shipped chord vocabulary. Kept here rather
 * than inline so the shortcut is assertable without a browser.
 */
export function isRailToggleChord(event: Readonly<{
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}>): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key === "\\";
}
