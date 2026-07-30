import type { Ref } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import {
  MOBILE_MORE_ENTRIES,
  RAIL_SECTIONS,
  canonicalParentForView,
  destinationLabel,
  railTraversal,
  type NavigationView,
  type RailNestedDestination,
  type RailRow,
} from "./navigation-model";
import type { RailState } from "./rail-state";
import { RuntimeLoadIndicator } from "./runtime-load-indicator";

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

export type RailProps = Readonly<{
  view: NavigationView;
  state: RailState;
  navRef: Ref<HTMLElement>;
  inert: boolean;
  busy: boolean;
  unreadTurnCount: number;
  /** A receipt exists for the active session, so Proof has something to show. */
  hasReceipt: boolean;
  conversations: readonly RailConversation[];
  activeConversationId: string;
  formatTime(value: string): string;
  profiles: readonly RailProfile[];
  profileId: string;
  /** The shell's one monogram implementation, passed rather than re-derived. */
  monogram(name: string): string;
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
 */
export function railCurrentHint(view: NavigationView): string | undefined {
  if (railRowFor(view) || canonicalParentForView(view) === view || !rendersOwnRoute(view)) return undefined;
  return destinationLabel(view);
}

/** Names the sr-only line the stand-in row points at. One per rail. */
const CURRENT_HINT_ID = "rail-current-destination";

/**
 * How many conversations the disclosure lists.
 *
 * Unchanged from the rail list it replaces — the ledger is `All conversations`,
 * and this is the shortcut. A larger number here would recreate the scroller
 * that was the defect.
 */
export const RAIL_RECENT_LIMIT = 10;

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
  unreadTurnCount,
  hasReceipt,
  conversations,
  activeConversationId,
  formatTime,
  profiles,
  profileId,
  monogram,
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
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [draggingFavoriteId, setDraggingFavoriteId] = useState<string>();
  // Seeded through the traversal, not from `view` directly: `view` is only
  // sometimes a rail key, and a seed that names a row the rail does not render
  // leaves the whole nav with no tab stop at all.
  const [activeKey, setActiveKey] = useState<string>(() =>
    rovingKey(view, railTraversal({ workspace: railRowFor(view)?.id === "workspace" })));
  const items = useRef(new Map<string, HTMLButtonElement>());
  const recentsTrigger = useRef<HTMLButtonElement>(null);
  // The rail's half of the phone band's "Current page: …" line. Undefined on
  // the eleven views that have a row of their own to be marked.
  const currentHint = railCurrentHint(view);

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
            if (row.id === "chat") setRecentsOpen(true);
            if (row.nested.length > 0) setRowExpanded(row.id, true);
            onNavigate(row.id);
          }}
          onDblClick={() => {
            if (row.id === "chat") setRecentsOpen((value) => !value);
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
        <button
          class={session.id === activeConversationId ? "recent-conversation recent-conversation--thread active" : "recent-conversation recent-conversation--thread"}
          type="button"
          title={session.title}
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
          <span class="recent-conversation__mark" aria-hidden="true">{session.id === activeConversationId ? "●" : "○"}</span>
          <span class="recent-conversation__copy">
            <strong>{session.title}</strong>
            <small>{session.preview}</small>
            {/* The rows this one stands for. The shortcut shows one row per
                lineage so three retries cannot evict three unrelated threads,
                and this line is what stops that from being a silent deletion:
                the branches are all in All conversations, below. */}
            {session.hiddenBranchCount ? <small class="recent-conversation__branches">
              {session.hiddenBranchCount} more branch{session.hiddenBranchCount === 1 ? "" : "es"} in All conversations
            </small> : null}
          </span>
          <time dateTime={session.updatedAt}>{formatTime(session.updatedAt)}</time>
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
        <button
          class="recent-conversation__favorite"
          type="button"
          tabIndex={-1}
          aria-pressed={session.favorite}
          aria-label={`${session.favorite ? "Remove from favorites" : "Add to favorites"} ${session.title}`}
          onClick={session.toggleFavorite}
        >★</button>
      </div>
    );
    return (
      <div class="rail-recents">
        <button
          class="chat-nav-disclosure"
          type="button"
          aria-label={`${recentsOpen ? "Collapse" : "Expand"} recent conversations`}
          aria-expanded={recentsOpen}
          aria-controls="airship-recent-conversations"
          onClick={() => setRecentsOpen((open) => !open)}
          {...itemProps(RECENTS_KEY)}
          ref={(element: HTMLButtonElement | null) => {
            recentsTrigger.current = element;
            if (element) items.current.set(RECENTS_KEY, element);
            else items.current.delete(RECENTS_KEY);
          }}
        ><span aria-hidden="true">›</span></button>
        {recentsOpen ? (
          <div
            id="airship-recent-conversations"
            class="recent-conversations"
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
                onClick={() => { setRecentsOpen(false); onNewConversation(); }}
                {...itemProps(NEW_CONVERSATION_KEY)}
              ><span aria-hidden="true">+</span></button>
            </div>
            {favorites.length ? <div class="rail-conversation-group">Favorites</div> : null}
            {favorites.map(conversationRow)}
            {recent.length ? <div class="rail-conversation-group">Recent</div> : null}
            {recent.map(conversationRow)}
            <button
              class={view === "sessions" ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"}
              type="button"
              aria-current={view === "sessions" ? "page" : undefined}
              onClick={() => onNavigate("sessions")}
              {...itemProps(ALL_CONVERSATIONS_KEY)}
            ><span class="nav-item__label">All conversations</span></button>
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
          leading={(option) => <span class="profile-monogram" aria-hidden="true">{monogram(option.label)}</span>}
          onChange={onChangeProfile}
        />
        {/* Skills and Capabilities are filed under Profiles and have no rail
            row, so this control is their stand-in the way a rail row is
            Context's — see `railStandInFor`. */}
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
          <Icon name="profiles" />
          <span class="profile-manage-link__label">Profiles</span>
        </button>
      </div>
    );
  }

  return (
    <aside class="sidebar" data-rail-state={state} inert={inert} aria-hidden={inert || undefined}>
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
        {/* The live-utilisation reading the shell carries on desktop. It lives
            here rather than on the Capabilities route alone because "what is
            this running right now" is a question asked while doing something
            else, and the rail is the band every route renders at this width.
            Below the phone breakpoint the rail is `display: none` and the same
            component rides the mobile tab bar instead. */}
        <RuntimeLoadIndicator placement="rail" />
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
