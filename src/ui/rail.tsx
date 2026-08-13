import type { Ref } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import {
  CANONICAL_DESTINATIONS,
  MOBILE_MORE_ENTRIES,
  RAIL_SECTIONS,
  canonicalParentForView,
  destinationLabel,
  railTraversal,
  type NavigationScope,
  type NavigationView,
  type RailNestedDestination,
  type RailRow,
} from "./navigation-model";
import { loadRecentsPreference, saveRecentsPreference, type RailState } from "./rail-state";
import { RuntimeLoadIndicator } from "./runtime-load-indicator";
import type { SessionActivityReport } from "../capabilities/runtime-load";

/**
 * The left rail.
 *
 * What it was: 232px carrying eleven destinations, a 250px scrolling
 * conversation list, a 310px scrolling profile list and a 120px profile card —
 * 785 to 943px of content inside a 501 to 701px box. It scrolled at every
 * laptop height, which meant Proof, Vault, Connection and Account were below
 * the fold on the default viewport, and it cost 20 tab stops (29 with eight
 * conversations) to cross on the way to the composer.
 *
 * What it is: a profile-first cockpit. The active profile is the first control,
 * Chat expands its profile-local favorites and recent threads in place, and
 * the global Vault, Connections, and Account services are filed separately.
 * The full conversation ledger and profile manager remain one action away.
 *
 * The rail has three states on one width token, and the state is remembered
 * per width band rather than re-derived from the viewport on every load.
 */

export type RailConversation = Readonly<{
  id: string;
  profileId: string;
  title: string;
  preview: string;
  updatedAt: string;
  favorite: boolean;
  /**
   * Branches of this row's lineage the shortcut collapsed behind it. Stated on
   * the row rather than merely acted on: a hidden conversation that is not
   * counted is one the shortcut silently lost.
   */
  hiddenBranchCount?: number;
  open(): void;
  toggleFavorite(): void;
  /** Omitted anchor means move after every current favorite. */
  moveFavorite(beforeSessionId?: string): void;
}>;

export type RailProfile = Readonly<{
  profileId: string;
  name: string;
  description?: string;
}>;

/** Theme-derived paint for the profile mark, kept optional for old catalogs. */
export type ProfileBadgeStyle = Readonly<Record<string, string>>;

export type RailProps = Readonly<{
  view: NavigationView;
  state: RailState;
  navRef: Ref<HTMLElement>;
  inert: boolean;
  busy: boolean;
  /** Aggregated model-turn activity for every conversation this page owns. */
  activity?: SessionActivityReport;
  unreadTurnCount: number;
  /** A receipt exists for the active session, so Proof has something to show. */
  hasReceipt: boolean;
  conversations: readonly RailConversation[];
  activeConversationId: string;
  /**
   * The conversation the runtime refused to reopen, if there is one.
   *
   * Measured on a return after an interrupted approval: the blocked row and the
   * healthy row were the same title, the same timestamp and the same shape, and
   * the only place the difference existed was a badge inside the `#sessions`
   * detail panel — three navigations from the list a person actually scans.
   */
  unresumableConversationId?: string;
  formatTime(value: string): string;
  profiles: readonly RailProfile[];
  profileId: string;
  /** The shell's one monogram implementation, passed rather than re-derived. */
  monogram(name: string): string;
  /** Paint each profile's mark with the theme that profile actually selects. */
  profileBadgeStyle?: (profileId: string) => ProfileBadgeStyle | undefined;
  onNavigate(view: NavigationView): void;
  /**
   * Opens the profile manager scoped to the pinned profile.
   *
   * Separate from `onNavigate("profiles")` because this row is a *profile*,
   * not the catalog: the scoped entry point carries the unsaved-draft guard
   * and lands on the profile the row is showing.
   */
  onManageProfiles(): void;
  onNewConversation(): void;
  onChangeProfile(profileId: string): void;
  onToggleState(): void;
  onInteractionError(message: string): void;
}>;

/** The disclosure key that sits in the roving order beside the Chat row. */
const RECENTS_KEY = "recents";

/**
 * The conversation subtree's keys.
 *
 * The disclosure was added as free-form markup inside a `role="group"` and was
 * never given keys in the destination-only traversal model, so opening it — which
 * clicking Chat forces — added one tab stop per thread plus the ledger link, and
 * the "one composite widget, not twenty tab stops" contract in the header
 * comment stopped being true of the widget it describes.
 *
 * A row is one stop. Its favorite and reorder buttons are reached with
 * `ArrowRight`, which is the same nesting gesture `onNavKeyDown` already
 * implements for a rail row's nested destinations.
 */
const CONVERSATION_PREFIX = "conversation:";
const NEW_CONVERSATION_KEY = "new-conversation";
const ALL_CONVERSATIONS_KEY = "all-conversations";

/**
 * The rail row an id belongs to: the row itself, or the row it is filed under.
 *
 * One lookup rather than two, because "which row owns this key" is the only
 * question the roving traversal and the default expansion both ask.
 */
export function railRowFor(id: string): RailRow | undefined {
  for (const section of RAIL_SECTIONS) {
    for (const row of section.rows) {
      if (row.id === id || row.nested.some((nested) => nested.id === id)) return row;
    }
  }
  return undefined;
}

/**
 * The rail control that carries "you are here" for a view, which is not always
 * a row the rail draws.
 *
 * Measured: three of the fourteen views left the desktop rail with no
 * current-page state at all — `#context`, `#skills` and `#capabilities` are
 * legal hashes with no rail row, so a person who arrived at one by deep link,
 * by the command palette or by Memory's own Index tab saw a rail with nothing
 * marked anywhere. The phone's bottom bar has always marked all three through
 * `More`; this is the same signal, not a replacement for it.
 *
 * The stand-in is the canonical parent, which is the rule the mobile band's
 * `currentDestinationLabel` already uses. A view the rail *does* draw resolves
 * to its own row or to the row it is nested under, so this never re-parents a
 * real row: `Account` is its own row rather than a child of `Connection`, and
 * standing on it must not light `Connection` up.
 */
export function railStandInFor(view: NavigationView): NavigationView {
  return railRowFor(view)?.id ?? canonicalParentForView(view);
}

/**
 * Whether a view is a destination in its own right, or a tab of its parent's
 * route wearing a hash.
 *
 * The product lists every destination it will send a person *to* in
 * `MOBILE_MORE_ENTRIES`, and `#context` is deliberately absent: the shell
 * renders the Memory route with its Index tab selected for that hash, same
 * component and same `<h1>`. So Memory reads `active` on `#context` exactly as
 * it does on `#memory` — marking it as merely *containing* the current page,
 * while the page's own heading says `Memory`, would be a third answer — and no
 * hint is owed, because naming it `Context` would name something the screen
 * does not say. Read from the table rather than listed here: a view that gains
 * a destination entry gains the stronger treatment with it.
 */
function rendersOwnRoute(view: NavigationView): boolean {
  return MOBILE_MORE_ENTRIES.some((entry) => entry.kind === "route" && entry.view === view);
}

/**
 * The route's real name, for the rail control standing in for it — or nothing
 * when that control's own label already says it.
 *
 * Same test the phone band makes before describing its current control: a hint
 * is owed exactly when the stand-in's destination is not the live view.
 * `Profiles` on `#profiles` needs none; `Profiles` on `#skills` does.
 *
 * `expanded` is the third input, because a nested row is only *drawn* while its
 * parent is open. Standing on `#editor` or `#terminal` with Workspace collapsed
 * left the whole rail saying "you are here" in a single colour step on
 * `.nav-item.has-active-child` — no `aria-current` anywhere, no row carrying the
 * word `Editor`, and a distinction carried solely by colour on the surface that
 * spells its blocked conversations out for exactly that reason. That is the same
 * silence `#skills` and `#capabilities` were fixed for, on two routes the phone
 * band already names under its Workspace control. An open parent does draw
 * `Editor` with `aria-current="page"`, so there the hint would be a second
 * answer to one question and is owed nothing.
 */
export function railCurrentHint(
  view: NavigationView,
  expanded: Readonly<Record<string, boolean>> = {},
): string | undefined {
  const row = railRowFor(view);
  if (row?.id === view || (row && expanded[row.id]) || canonicalParentForView(view) === view || !rendersOwnRoute(view)) return undefined;
  return destinationLabel(view);
}

/** Names the sr-only line the stand-in row points at. One per rail. */
const CURRENT_HINT_ID = "rail-current-destination";

/**
 * The ledger row's scope, read from the destination table rather than restated.
 *
 * `data-scope` is what draws a row's left-edge mark (`.nav-item[data-scope]`
 * in platform-shell.css) — the thick, inset tab mark every destination row
 * carries and this row did not, which is why it had to draw a hairline box of
 * its own to say anything at all about itself. Three left-edge languages in one
 * rail was the defect; this is the one the owner named as the reference.
 */
const ALL_CONVERSATIONS_SCOPE: NavigationScope | undefined = CANONICAL_DESTINATIONS
  .flatMap((destination) => destination.nested)
  .find((nested) => nested.id === "sessions")?.scope;

/**
 * How many conversations the disclosure lists.
 *
 * Unchanged from the rail list it replaces — the ledger is `All conversations`,
 * and this is the shortcut. A larger number here would recreate the scroller
 * that was the defect.
 */
/**
 * How much rail a self-opening recents list has to have before it opens itself.
 *
 * The list costs about 200px. Below this the rail cannot show it and the Global
 * group at the same time, and a navigation rail that hides its destinations to
 * advertise a shortcut has made the wrong trade.
 */
const RAIL_RECENTS_AUTO_OPEN_MIN_HEIGHT = 560;

export const RAIL_RECENT_LIMIT = 10;

/**
 * The panel's id, shared by `aria-controls`, the `id` attribute and the pointer
 * dismissal that has to know what "inside the panel" means.
 */
const RECENTS_PANEL_ID = "airship-recent-conversations";

/**
 * Which row holds the rail's single tab stop, for a view that may not be a row.
 *
 * The roving seed treated `view` as if it were always a rail key. Five of the
 * fourteen `NavigationView`s are not — `sessions`, `profiles`, `skills`,
 * `capabilities`, `context` — so a deep link to any of them named a row that
 * does not exist, no row matched the `tabIndex 0` test, and the primary nav had
 * zero tab stops: unreachable by keyboard until the user navigated elsewhere.
 *
 * `order` is the authority, so the answer is resolved through it: the view if
 * the rail renders it, else whatever stop we already had, else the row the view
 * is filed under (Chat for `sessions`, Memory for `context`), else the first
 * row. The last two arms are what make this correct for the *initial* seed,
 * where `current` is itself the off-rail value.
 */
export function rovingKey(view: NavigationView, order: readonly string[], current?: string): string {
  if (order.includes(view)) return view;
  if (current !== undefined && order.includes(current)) return current;
  const parent = canonicalParentForView(view);
  return order.includes(parent) ? parent : order[0] ?? view;
}

export function Rail({
  view,
  state,
  navRef,
  inert,
  busy,
  activity,
  unreadTurnCount,
  hasReceipt,
  conversations,
  activeConversationId,
  unresumableConversationId,
  formatTime,
  profiles,
  profileId,
  monogram,
  profileBadgeStyle,
  onNavigate,
  onManageProfiles,
  onNewConversation,
  onChangeProfile,
  onToggleState,
  onInteractionError,
}: RailProps) {
  // Editor and Terminal are collapsed by default and remembered for the rest of
  // the page: this is the one nesting the current model gets right, and a
  // person who opened it once is telling us they work there. "Default" means
  // *from somewhere else* — standing inside the Workspace and being shown no
  // way to its two panes would be a collapse that hides a destination rather
  // than one that saves a row.
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.freeze({ workspace: railRowFor(view)?.id === "workspace" }));
  // Seeded from the remembered choice, and opened by the list itself below when
  // nobody has made one: a returning person's conversations must not need a
  // disclosure click before they exist. See `loadRecentsPreference`.
  const recentsChoice = useRef<boolean | undefined>(loadRecentsPreference());
  /** True while the open state is the rail's own doing rather than a person's. */
  const autoOpened = useRef(false);
  const [recentsOpen, setRecentsOpen] = useState(recentsChoice.current ?? false);
  const chooseRecentsOpen = (open: boolean) => {
    // The moment a person touches the disclosure it stops being the rail's to
    // close: `autoOpened` is what the height gate is allowed to reverse, and a
    // deliberate choice is never that.
    autoOpened.current = false;
    recentsChoice.current = open;
    saveRecentsPreference(open);
    setRecentsOpen(open);
  };
  const [draggingFavoriteId, setDraggingFavoriteId] = useState<string>();
  /*
   * The conversation list cannot live in-flow inside a 60px rail.
   *
   * Measured at 1440x1000 with four threads and `data-rail="rail"`: the rail is
   * 60px, `.recent-conversations` was still an in-flow block, so every row was
   * 67px wide starting at x=13 — 20px past the rail's own right edge — and the
   * title element had `clientWidth: 29` against `scrollWidth: 132`. "General
   * conversation" printed as "Ge", the timestamp as "2", the group label
   * "RECENT" as "RECE", and the `All conversations` row as an empty bordered
   * box with neither glyph nor text. 290px of the collapsed rail were spent on
   * four unreadable rows.
   *
   * `.rail-recents`' own comment named the obstacle correctly — `.primary-nav`
   * is a block-axis scroller and a block-axis scroller clips the inline axis
   * too — and proposed measuring the trigger's rect in script to escape it.
   * That is not necessary: `.sidebar` is already `position: relative` and
   * `.primary-nav` sits *inside* it, so an absolutely positioned panel whose
   * containing block is the sidebar is not clipped by the scroller between
   * them. The placement is therefore three CSS declarations and no script —
   * which also means it cannot drift on scroll, cannot need a resize listener,
   * and costs the entry chunk (a first-paint budget) nothing but an attribute.
   */
  const flyout = state !== "standard";
  // Seeded through the traversal, not from `view` directly: `view` is only
  // sometimes a rail key, and a seed that names a row the rail does not render
  // leaves the whole nav with no tab stop at all.
  const [activeKey, setActiveKey] = useState<string>(() =>
    rovingKey(view, railTraversal({ workspace: railRowFor(view)?.id === "workspace" })));
  const items = useRef(new Map<string, HTMLButtonElement>());
  const recentsTrigger = useRef<HTMLButtonElement>(null);
  // The rail's half of the phone band's "Current page: …" line. Undefined on
  // every view the rail already draws a marked row for — which includes a
  // nested Editor or Terminal only while `expanded` is what draws it.
  const currentHint = railCurrentHint(view, expanded);

  // Props can retain the previous async read for one render while a profile
  // switches. Filtering by the row's bound profile makes that frame empty
  // instead of exposing another profile's titles or favorite order.
  const scopedConversations = conversations.filter((conversation) => conversation.profileId === profileId);
  const favorites = scopedConversations.filter((session) => session.favorite);
  const recent = scopedConversations.filter((session) => !session.favorite).slice(0, RAIL_RECENT_LIMIT);
  const visibleConversations = [...favorites, ...recent];
  // Depended on as a string so the memo is not invalidated by a fresh array
  // holding the same threads in the same order, which every parent re-render
  // would otherwise produce.
  const conversationKeys = visibleConversations.map((session) => `${CONVERSATION_PREFIX}${session.id}`).join("\n");

  /*
   * The list decides its own default, once.
   *
   * Conversations arrive asynchronously, so mount is always empty and a seed
   * taken there would always say "closed". This opens the disclosure the first
   * time the profile turns out to have something in it, and only while nobody
   * has expressed a choice — a person who collapses it mid-session is not
   * fought on the next render, and the choice survives the reload.
  */
  useEffect(() => {
    // The collapsed state owns a closed panel. Without this guard, sessions
    // arriving in the same frame as a collapse could run this effect after the
    // state-transition effect below and throw a 320px flyout over the page.
    // `autoOpened` is what makes this "once" now that the effect no longer
    // stamps the person's slot to stop itself: the rail decides its own default
    // one time, and the height gate below owns every later correction.
    if (state !== "standard" || autoOpened.current || recentsChoice.current !== undefined || visibleConversations.length === 0) return;
    /*
     * …and only where the rail can afford it.
     *
     * Opening the list adds about 200px. Measured on this build, the rail's
     * content is 559px with it open, which fits only at a window height of
     * roughly 900px and above: at 1440x800 — a 13" laptop — Vault, Connection
     * and Account went below the fold and the overflow fade was the only thing
     * saying so. Coming forward is worth doing where there is room and is not
     * worth pushing the global destinations off the screen for.
     *
     * The person's own choice still wins in both directions: this only ever
     * runs while nobody has expressed one.
     */
    const nav = typeof navRef === "object" && navRef !== null ? navRef.current : undefined;
    const room = nav?.clientHeight ?? 0;
    if (room > 0 && room < RAIL_RECENTS_AUTO_OPEN_MIN_HEIGHT) return;
    // `recentsChoice` is the person's slot and stays theirs: `undefined` there
    // means nobody has chosen, which `loadRecentsPreference` documents as a
    // different state from having chosen "closed". Writing `true` into it here
    // signed a choice nobody made — and, because nothing persisted it, one that
    // a reload would immediately contradict.
    autoOpened.current = true;
    setRecentsOpen(true);
  }, [conversationKeys, navRef, state]);

  /*
   * What it opened on its own, it gives back on its own.
   *
   * The height gate above only ran once, at the moment the list decided to
   * open, so a rail that auto-opened on a tall window and was then resized
   * smaller kept the list and pushed Vault, Connection and Account below the
   * fold — the overflow fade was the only thing saying so, which is exactly the
   * trade the gate exists to refuse. Measured across a resize from 1080 to 700.
   *
   * Only what the rail opened by itself is closed by itself: `autoOpened` is
   * cleared the moment a person touches the disclosure, and after that the rail
   * never fights them in either direction.
   *
   * It is also the only place the rail's own answer is re-decided, so it has to
   * be two-way. Gating on `recentsOpen` made it a ratchet: closing the list
   * unsubscribed the very listener that would have re-opened it, so the same
   * window at the same height showed the list after a reload and not after a
   * resize down and back up. It stays subscribed while the rail owns the state
   * and simply answers the height each time it is asked.
   */
  useEffect(() => {
    if (!autoOpened.current || state !== "standard") return;
    const nav = typeof navRef === "object" && navRef !== null ? navRef.current : undefined;
    const measure = () => {
      const room = nav?.clientHeight ?? 0;
      if (room > 0) setRecentsOpen(room >= RAIL_RECENTS_AUTO_OPEN_MIN_HEIGHT);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `recentsOpen` is a dependency for the unsubscribe rather than the measure:
    // a deliberate click clears `autoOpened` and changes the open state in the
    // same gesture, and this re-run is what hands both directions back.
  }, [navRef, recentsOpen, state]);

  /*
   * Collapsing the rail does not throw a panel over the page.
   *
   * `Collapse navigation rail` is a request for room. Honouring it by turning
   * the in-flow list into a 320px flyout the same frame gives back none of it,
   * and the person did not ask to open anything. The panel closes with the
   * rail and comes back with it — `recentsChoice` is untouched, so the
   * remembered preference decides the restored state, not this.
   *
   * Where nobody has chosen, the fallback is what the rail itself was showing:
   * `autoOpened` restores the panel it opened rather than a hard `false`, which
   * is what made ⌘\ flash the list open and shut once the height gate had
   * closed it.
   */
  const previousState = useRef(state);
  useEffect(() => {
    const was = previousState.current;
    previousState.current = state;
    if (was === state) return;
    setRecentsOpen(state === "standard" ? recentsChoice.current ?? autoOpened.current : false);
  }, [state]);

  /*
   * A panel over the page is dismissed by the page.
   *
   * Escape is handled on the panel itself and returns focus to the trigger;
   * this is the pointer half. It deliberately ignores the rail: clicking
   * another rail row navigates, and a panel closing under that click would eat
   * the gesture rather than complete it.
   */
  useEffect(() => {
    if (!flyout || !recentsOpen) return;
    const dismiss = ({ target }: Event) => {
      if (target instanceof Node
        && !recentsTrigger.current?.contains(target)
        && !document.getElementById(RECENTS_PANEL_ID)?.contains(target)) setRecentsOpen(false);
    };
    addEventListener("pointerdown", dismiss, true);
    return () => removeEventListener("pointerdown", dismiss, true);
  }, [flyout, recentsOpen]);

  const order = useMemo(() => {
    const destinations = railTraversal(expanded);
    const keys: string[] = [];
    for (const id of destinations) {
      keys.push(id);
      // The disclosure belongs beside the row it discloses, so `ArrowDown` from
      // Chat reaches the conversation list rather than skipping past it.
      if (id !== "chat") continue;
      keys.push(RECENTS_KEY);
      // Only while it is open: a closed disclosure's rows are not in the tree,
      // and arrowing to a row nobody can see is the same defect as arrowing to
      // a collapsed nested destination.
      if (!recentsOpen) continue;
      keys.push(NEW_CONVERSATION_KEY, ...(conversationKeys ? conversationKeys.split("\n") : []), ALL_CONVERSATIONS_KEY);
    }
    return keys;
  }, [expanded, recentsOpen, conversationKeys]);


  // A route can change from the palette, a hash, or a link inside the page.
  // The roving stop follows it so `Tab` into the rail always lands on where the
  // user actually is, not on wherever they last arrowed to.
  // `order` is a dependency as well as `view`: collapsing Workspace while the
  // stop sits on Terminal withdraws the stop's own row, and keeping `current`
  // unconditionally would leave the nav with none.
  useEffect(() => { setActiveKey((current) => rovingKey(view, order, current)); }, [view, order]);

  function focusKey(key: string) {
    setActiveKey(key);
    items.current.get(key)?.focus();
  }

  function step(from: string, delta: number) {
    if (order.length === 0) return;
    const index = order.indexOf(from);
    const next = index < 0 ? 0 : (index + delta + order.length) % order.length;
    focusKey(order[next]!);
  }

  function setRowExpanded(id: string, next: boolean) {
    setExpanded((current) => Object.freeze({ ...current, [id]: next }));
  }

  /**
   * One composite widget, not twenty tab stops.
   *
   * `Tab` reaches the rail once and lands on the destination you are on;
   * arrows walk it. This is the standard tree/toolbar contract, and it is
   * added to the existing reach rather than substituted for it — every row is
   * still a real `<button>` with its own accessible name and `aria-current`.
   *
   * The promise covers the conversation disclosure too, which it did not when
   * that subtree was added: its rows were free-form markup with no keys in the
   * traversal model, so opening it — which clicking Chat forces — put one tab
   * stop per thread back into the rail, plus the ledger link and the new-thread
   * button. A conversation row is one stop; its favorite and reorder buttons
   * are one `ArrowRight` away, the same nesting gesture a rail row's nested
   * destinations use.
   */
  function onNavKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const key = target?.dataset?.railKey;
    // A conversation row's favorite and reorder buttons carry no key: they are
    // the row's secondary actions, reached from the row itself rather than
    // being stops of their own.
    if (!key) { onConversationActionKeyDown(event, target); return; }
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); step(key, 1); return;
      case "ArrowUp": event.preventDefault(); step(key, -1); return;
      case "Home": event.preventDefault(); focusKey(order[0]!); return;
      case "End": event.preventDefault(); focusKey(order[order.length - 1]!); return;
      case "ArrowRight": {
        if (key.startsWith(CONVERSATION_PREFIX)) {
          const action = conversationRowActions(target)[0];
          if (!action) return;
          event.preventDefault();
          action.focus();
          return;
        }
        const row = railRowFor(key);
        if (!row || row.id !== key || row.nested.length === 0) return;
        event.preventDefault();
        if (!expanded[key]) setRowExpanded(key, true);
        else focusKey(row.nested[0]!.id);
        return;
      }
      case "ArrowLeft": {
        const row = railRowFor(key);
        if (row && row.id !== key) { event.preventDefault(); focusKey(row.id); return; }
        if (row?.nested.length && expanded[key]) { event.preventDefault(); setRowExpanded(key, false); }
        return;
      }
      default:
    }
  }

  /**
   * Arrow behaviour inside a conversation row's secondary actions.
   *
   * `ArrowLeft` returns to the row — the same escape the nested-destination
   * arm gives — and `ArrowDown`/`ArrowUp` resume the walk from the row, so a
   * person who stepped sideways into the star is never stranded there.
   */
  function onConversationActionKeyDown(event: KeyboardEvent, target: HTMLElement | null) {
    const actions = conversationRowActions(target);
    const index = actions.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    const thread = target?.closest(".recent-conversation-row")?.querySelector<HTMLElement>(".recent-conversation--thread");
    const rowKey = thread?.dataset.railKey;
    if (event.key === "ArrowRight" && actions[index + 1]) { event.preventDefault(); actions[index + 1]!.focus(); return; }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      (index === 0 ? thread : actions[index - 1])?.focus();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rowKey) {
      event.preventDefault();
      step(rowKey, event.key === "ArrowDown" ? 1 : -1);
    }
  }

  /** A row's enabled secondary buttons, in visual order. Disabled edges of the
      reorder pair are excluded: an unfocusable stop is not a stop. */
  function conversationRowActions(target: HTMLElement | null): readonly HTMLButtonElement[] {
    const row = target?.closest(".recent-conversation-row");
    if (!row) return [];
    return [...row.querySelectorAll<HTMLButtonElement>("button:not(.recent-conversation--thread)")]
      .filter((button) => !button.disabled);
  }

  function itemProps(key: string) {
    return {
      "data-rail-key": key,
      tabIndex: activeKey === key ? 0 : -1,
      ref: (element: HTMLButtonElement | null) => {
        if (element) items.current.set(key, element);
        else items.current.delete(key);
      },
      onFocus: () => setActiveKey(key),
    };
  }

  function destinationRow(row: RailRow) {
    // `#context` is not a route of its own: it renders this row's route, so it
    // marks this row the way `#memory` does rather than one rung weaker.
    const active = view === row.id || (railStandInFor(view) === row.id && !rendersOwnRoute(view));
    // Also true for the views the rail draws no row for, which is the point of
    // `railStandInFor`: an expanded `Editor` marks `Workspace` exactly as
    // before, and `#skills` now marks something at all.
    const childActive = !active && railStandInFor(view) === row.id;
    const open = Boolean(expanded[row.id]);
    return [
      <div class="rail-row" key={row.id}>
        <button
          class={active ? "nav-item active" : childActive ? "nav-item has-active-child" : "nav-item"}
          type="button"
          aria-current={active ? "page" : undefined}
          aria-describedby={childActive && currentHint ? CURRENT_HINT_ID : undefined}
          data-scope={row.scope}
          title={`${row.label} · ${row.scope} scope`}
          /*
           * One click goes somewhere AND shows what is inside: Chat opens its
           * conversation list, a row with children expands them. The reader
           * asked for the destination; the disclosure is how they see what the
           * destination contains. Double-click is the inverse gesture — it
           * toggles the disclosure back shut, matching the caret's own verb.
           * Because click fires twice before dblclick, the toggle reads the
           * state at dispatch time, so the pair lands on the same answer the
           * caret would give from there.
           */
          onClick={() => {
            if (row.id === "chat") chooseRecentsOpen(true);
            if (row.nested.length > 0) setRowExpanded(row.id, true);
            onNavigate(row.id);
          }}
          onDblClick={() => {
            if (row.id === "chat") chooseRecentsOpen(!recentsOpen);
            if (row.nested.length > 0) setRowExpanded(row.id, !open);
          }}
          {...itemProps(row.id)}
        >
          <Icon name={row.icon} />
          <span class="nav-item__label">{row.label}</span>
          {/* `role="img"` so the count reaches the button's name as "3 completed
              turns" rather than a bare "3": a name on a generic span is dropped,
              and only the ancestor's name-from-content walk was rescuing it. */}
          {row.id === "chat" && unreadTurnCount > 0
            ? <span class="nav-turn-badge" role="img" aria-label={`${String(unreadTurnCount)} completed turn${unreadTurnCount === 1 ? "" : "s"}`}>{unreadTurnCount}</span>
            : null}
          {row.id === "proof" && hasReceipt ? <span class="nav-proof-dot" /> : null}
        </button>
        {row.nested.length > 0 ? (
          <button
            class="rail-expander"
            type="button"
            tabIndex={-1}
            aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`}
            aria-expanded={open}
            onClick={() => setRowExpanded(row.id, !open)}
          ><span aria-hidden="true">›</span></button>
        ) : null}
        {row.id === "chat" ? recentsDisclosure() : null}
      </div>,
      ...(open ? row.nested.map((nested) => nestedRow(nested)) : []),
    ];
  }

  function nestedRow(nested: RailNestedDestination) {
    const active = view === nested.id;
    return (
      <button
        key={nested.id}
        class={active ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"}
        type="button"
        aria-current={active ? "page" : undefined}
        aria-level={2}
        data-scope={nested.scope}
        title={`${nested.label} · ${nested.scope} scope`}
        onClick={() => onNavigate(nested.id)}
        {...itemProps(nested.id)}
      >
        <Icon name={nested.icon} />
        <span class="nav-item__label">{nested.label}</span>
      </button>
    );
  }

  /**
   * The conversation list, re-homed.
   *
   * Favorites stay visible ahead of recency, while the bounded list expands
   * directly beneath Chat. The complete profile-scoped ledger remains at the
   * end of the tree instead of becoming another permanent rail destination.
   */
  function recentsDisclosure() {
    const visible = visibleConversations;
    const favoriteIds = favorites.map((session) => session.id);
    const reportFavoriteLoadFailure = (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      onInteractionError(`Favorite reorder could not load: ${detail || "unknown deferred-pack failure"}. Retry the gesture.`);
    };
    const moveFavorite = (session: RailConversation, direction: -1 | 1) => {
      void import("./session-pins").then(({ favoriteDirectionalMove }) => {
        const move = favoriteDirectionalMove(favoriteIds, session.id, direction);
        if (move.changed) session.moveFavorite(move.beforeSessionId);
      }).catch(reportFavoriteLoadFailure);
    };
    const conversationRow = (session: RailConversation) => (
      <div
        class="recent-conversation-row"
        key={session.id}
        data-session-id={session.id}
        data-favorite={session.favorite ? "true" : "false"}
        data-dragging={draggingFavoriteId === session.id ? "true" : undefined}
        draggable={session.favorite}
        onDragStart={(event) => {
          if (!session.favorite || !event.dataTransfer) { event.preventDefault(); return; }
          setDraggingFavoriteId(session.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", session.id);
        }}
        onDragEnd={() => setDraggingFavoriteId(undefined)}
        onDragOver={(event) => {
          if (!session.favorite || !draggingFavoriteId || draggingFavoriteId === session.id || !event.dataTransfer) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = draggingFavoriteId || event.dataTransfer?.getData("text/plain");
          setDraggingFavoriteId(undefined);
          const source = favorites.find((favorite) => favorite.id === sourceId);
          if (!source) return;
          void import("./session-pins").then(({ favoriteDropMove }) => {
            const move = favoriteDropMove(favoriteIds, source.id, session.id);
            if (move.changed) source.moveFavorite(move.beforeSessionId);
          }).catch(reportFavoriteLoadFailure);
        }}
      >
        {/*
         * The favorite action lives in the mark, not in a 30px tail column.
         *
         * A trailing star used to be the price of the title — ~30px of the
         * rail's 230px was spent on a button you press at most twice per
         * conversation, which is why 'Gener…' was the desktop default. The
         * mark was already right there telling the active story; the favorite
         * toggle now rides it: a star means the row is pinned, a ring means
         * plain recent, and hovering the mark of an unstarred row offers the
         * star it would set. Both states keep their accessible names, which
         * is the ledger every e2e reading of this surface ever used.
         */}
        <button
          class="recent-conversation__mark"
          type="button"
          tabIndex={-1}
          aria-pressed={session.favorite}
          aria-label={`${session.favorite ? "Remove from favorites" : "Add to favorites"} ${session.title}`}
          title={session.favorite ? `Remove from favorites: ${session.title}` : `Add to favorites: ${session.title}`}
          onClick={session.toggleFavorite}
        >
          <span class={session.id === activeConversationId ? "recent-conversation__mark-ring recent-conversation__mark-ring--active" : "recent-conversation__mark-ring"} aria-hidden="true">{session.id === activeConversationId ? "●" : "○"}</span>
          <span class="recent-conversation__mark-star" aria-hidden="true">★</span>
        </button>
        {/* Under the mark, not beside the preview.
            The mark was given its own full-height column and the time stayed
            on the preview line, so the column was a tall stripe holding one
            glyph while the row's two facts about recency sat on opposite
            sides. They are one fact — when, and whether it is pinned — so they
            share one narrow trailing column and the copy keeps the rest. */}
        <time class="recent-conversation__time" dateTime={session.updatedAt} title={session.updatedAt}>
          {formatTime(session.updatedAt)}
        </time>
        <button
          class={[
            "recent-conversation recent-conversation--thread",
            session.id === activeConversationId ? "active" : "",
            session.id === unresumableConversationId ? "is-blocked" : "",
          ].filter(Boolean).join(" ")}
          type="button"
          title={session.id === unresumableConversationId
            ? `${session.title} — needs review; this conversation could not be reopened`
            : session.title}
          // Named on the row, not only styled on it: the difference between a
          // conversation that opens and one that does not may not be carried by
          // colour, and the row is where the choice is made.
          aria-label={session.id === unresumableConversationId
            ? `${session.title} — needs review; this conversation could not be reopened.`
            : undefined}
          aria-current={session.id === activeConversationId ? "page" : undefined}
          aria-keyshortcuts={session.favorite ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          {...itemProps(`${CONVERSATION_PREFIX}${session.id}`)}
          onClick={session.open}
          onKeyDown={(event) => {
            if (!session.favorite || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            event.stopPropagation();
            moveFavorite(session, event.key === "ArrowUp" ? -1 : 1);
          }}
        >
          <span class="recent-conversation__copy">
            <strong title={session.title}>{session.title}</strong>
            <span class="recent-conversation__meta">
              <small>{session.preview}</small>
            </span>
            {/* The rows this one stands for. The shortcut shows one row per
                lineage so three retries cannot evict three unrelated threads,
                and this line is what stops that from being a silent deletion:
                the branches are all in All conversations, below. */}
            {session.id === unresumableConversationId ? (
              <small class="recent-conversation__blocked">Needs review · could not be reopened</small>
            ) : null}
            {session.hiddenBranchCount ? <small class="recent-conversation__branches">
              {session.hiddenBranchCount} more branch{session.hiddenBranchCount === 1 ? "" : "es"} in All conversations
            </small> : null}
          </span>
        </button>
        {/* `tabIndex -1` on the secondary actions is what makes the row one
            stop rather than four. They keep their accessible names and their
            pointer behaviour, and `ArrowRight` from the row walks them. */}
        {session.favorite ? (
          <span class="recent-conversation__order" role="group" aria-label={`Reorder favorite ${session.title}`}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Move favorite ${session.title} up`}
              disabled={favoriteIds[0] === session.id}
              onClick={() => moveFavorite(session, -1)}
            >↑</button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Move favorite ${session.title} down`}
              disabled={favoriteIds.at(-1) === session.id}
              onClick={() => moveFavorite(session, 1)}
            >↓</button>
          </span>
        ) : null}
      </div>
    );
    return (
      <div class="rail-recents">
        <button
          class="chat-nav-disclosure"
          type="button"
          aria-label={`${recentsOpen ? "Collapse" : "Expand"} recent conversations`}
          aria-expanded={recentsOpen}
          aria-controls={RECENTS_PANEL_ID}
          // The accessible name is the ledger every e2e reading of this rail
          // uses, so the count rides `title` and a badge instead of being
          // spliced into it.
          title={`${recentsOpen ? "Collapse" : "Expand"} recent conversations · ${visible.length} in this profile`}
          onClick={() => chooseRecentsOpen(!recentsOpen)}
          {...itemProps(RECENTS_KEY)}
          ref={(element: HTMLButtonElement | null) => {
            recentsTrigger.current = element;
            if (element) items.current.set(RECENTS_KEY, element);
            else items.current.delete(RECENTS_KEY);
          }}
        ><span aria-hidden="true">›</span>{/*
          * The count badge the collapsed rail is priced at.
          *
          * A 60px rail cannot print "General conversations 4", so the number is
          * what survives — the same number `.rail-recents__header small` prints
          * inside the panel, from the same array. It is `aria-hidden` because
          * the trigger's `title` already says it in words and a bare digit
          * announced after "Expand recent conversations" is noise.
          */}
          {visible.length > 0 ? <span class="rail-recents__badge" aria-hidden="true">{visible.length}</span> : null}
        </button>
        {recentsOpen ? (
          <div
            id={RECENTS_PANEL_ID}
            class="recent-conversations"
            // The whole of the collapsed placement: one attribute, and the
            // stylesheet does the rest against `.sidebar`'s own box.
            data-flyout={flyout ? "true" : undefined}
            role="group"
            aria-label="Profile conversations"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setRecentsOpen(false);
              recentsTrigger.current?.focus();
            }}
          >
            <div class="rail-recents__header">
              <strong>{profiles.find((profile) => profile.profileId === profileId)?.name ?? "Profile"} conversations</strong>
              {/* The affordance states its own cost: this is how many of the
                  ledger's conversations the shortcut is showing. */}
              <small>{visible.length}</small>
              <button
                class="chat-nav-new"
                type="button"
                aria-label="New conversation"
                title="New conversation"
                disabled={busy}
                // The list stays up where it is part of the rail: you have just
                // made a conversation and its row is about to appear in it, and
                // closing here also latched the disclosure shut for the rest of
                // the page against the default `loadRecentsPreference` sets.
                // Where the rail is collapsed this panel is a flyout over the
                // page, so it still yields once its verb has been used.
                onClick={() => { if (state !== "standard") setRecentsOpen(false); onNewConversation(); }}
                {...itemProps(NEW_CONVERSATION_KEY)}
              ><span aria-hidden="true">+</span></button>
            </div>
            {/*
              * The threads scroll; the panel does not.
              *
              * The scroll box used to be this panel, with `All conversations`
              * as its last child — so the ledger link was the row after the
              * last thread inside a 420px clip. Measured at 1440x1000 with
              * nine threads: the box ran 250→670 with a 520px scrollHeight and
              * the link's own rect was 730→766, entirely below the clip and
              * invisible on screen. The only in-rail route to the library
              * disappeared at exactly the thread count that makes a library
              * worth having. Moving the overflow one level down pins the
              * header above the scroll and the ledger link below it.
              */}
            <div class="recent-conversations__list">
              {favorites.length ? <div class="rail-conversation-group">Favorites</div> : null}
              {favorites.map(conversationRow)}
              {recent.length ? <div class="rail-conversation-group">Recent</div> : null}
              {recent.map(conversationRow)}
            </div>
            {/* A destination row, in the destination rows' own language. It was
                a bordered button nested inside the thread list — a hairline box
                where every row above it carries an inset tab mark — which made
                the rail speak three visual dialects at once. Same node, same
                name, same count; it is the mark that changed, and `data-scope`
                is the whole of it. */}
            <button
              class={view === "sessions" ? "nav-item active" : "nav-item"}
              type="button"
              data-scope={ALL_CONVERSATIONS_SCOPE}
              aria-current={view === "sessions" ? "page" : undefined}
              /* The accessible name stays exactly the destination. The count is
                 the row's description rather than part of its name, so it is
                 announced without turning the destination into a sentence that
                 changes every time a conversation is made. */
              aria-label="All conversations"
              title={`All conversations · ${String(scopedConversations.length)} in this profile`}
              onClick={() => onNavigate("sessions")}
              {...itemProps(ALL_CONVERSATIONS_KEY)}
            >
              <span class="nav-item__label">All conversations</span>
              {/* It earns its permanent row by carrying what the clipped list
                  cannot: how many threads there are in total, including the
                  ones the shortcut is not showing. */}
              <span class="rail-recents__ledger-count" aria-hidden="true">{scopedConversations.length}</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function profileSwitcher() {
    return (
      <div class="profile-switcher">
        <MenuSelect
          className="profile-menu"
          ariaLabel="Agent profile"
          value={profileId}
          disabled={busy}
          placement="down"
          options={profiles.map((profile) => ({ value: profile.profileId, label: profile.name, description: profile.description }))}
          leading={(option) => <span class="profile-monogram" style={profileBadgeStyle?.(option.value)} aria-hidden="true">{monogram(option.label)}</span>}
          onChange={onChangeProfile}
        />
        <button
          type="button"
          class={view === "profiles"
            ? "profile-manage-link active"
            : railStandInFor(view) === "profiles" ? "profile-manage-link has-active-child" : "profile-manage-link"}
          title="Manage profiles · profile scope"
          aria-label="Manage profiles"
          aria-current={view === "profiles" ? "page" : undefined}
          aria-describedby={view !== "profiles" && railStandInFor(view) === "profiles" && currentHint ? CURRENT_HINT_ID : undefined}
          onClick={onManageProfiles}
        >
          {/* The word `Profiles` used to ride beside this glyph, and the row it
              shares is 232px wide holding a monogram, a profile name, a caret
              and this control: `General` fit and `Research` printed `Resear…`.
              A label on a control whose glyph, `title` and `aria-label` all say
              the same word is the cheapest 60px in the rail to give back, and
              it is given to the name. Nothing is lost — `aria-label="Manage
              profiles"` above is unchanged, which is the name every reading of
              this control has ever used. */}
          <Icon name="profiles" />
        </button>
      </div>
    );
  }

  return (
    // `data-recents` stands the focus-peek down while the flyout is up. Both
    // are the same answer to "show me the labels", and running them together
    // draws a 268px peek panel underneath a 320px flyout on the same pixels.
    <aside class="sidebar" data-rail-state={state} data-recents={flyout && recentsOpen ? "flyout" : undefined} inert={inert} aria-hidden={inert || undefined}>
      <div class="rail">
        {/* The visible stand-in highlight says "a page under this row"; this
            says which one, in the same words the phone band uses. Without it a
            screen-reader user on #skills hears "Manage profiles" and nothing
            that names where they actually are. */}
        {currentHint ? <span id={CURRENT_HINT_ID} class="sr-only">{`Current page: ${currentHint}`}</span> : null}
        {profileSwitcher()}
        <nav
          ref={navRef}
          class="primary-nav"
          aria-label="Primary"
          onKeyDown={onNavKeyDown}
        >
          {RAIL_SECTIONS.map((section) => (
            <div class="nav-group" key={section.id}>
              {section.label ? <span class="nav-group-label">{section.label}</span> : null}
              {section.rows.map((row) => destinationRow(row))}
            </div>
          ))}
        </nav>
        <div class="sidebar-spacer" />
        {/* The live conversation-activity reading the shell carries on desktop.
            It lives here rather than on the Sessions route alone because
            "what is happening right now" is a question asked while doing
            something else, and the rail is the band every route renders at
            this width. It aggregates the durable events represented by the
            conversations in this rail. */}
        <RuntimeLoadIndicator placement="rail" activity={activity} />
        {/* The drawer handle on the seam. It was a chevron pinned at the rail's
            bottom-left corner — the shipped design, and the owner's verdict on
            it once built was that the affordance belongs in the middle of the
            seam between the rail and the page. It is the same button with the
            same name and the same `⌘\` twin; only where it is painted moved,
            which is `.rail-collapse` in shell.css. It stays a child of `.rail`
            deliberately: `.rail` is the box whose width changes, so the handle
            tracks the seam in all three states without measuring anything. */}
        <button
          class="rail-collapse"
          type="button"
          aria-label={state === "standard" ? "Collapse navigation rail" : "Expand navigation rail"}
          aria-expanded={state === "standard"}
          title={state === "standard" ? "Collapse navigation rail · ⌘\\" : "Expand navigation rail · ⌘\\"}
          onClick={onToggleState}
        ><span aria-hidden="true">{state === "standard" ? "‹" : "›"}</span></button>
      </div>
    </aside>
  );
}
