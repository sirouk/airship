import type { Ref } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import {
  RAIL_SECTIONS,
  railTraversal,
  type NavigationView,
  type RailNestedDestination,
  type RailRow,
} from "./navigation-model";
import type { RailState } from "./rail-state";

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
 * How many conversations the disclosure lists.
 *
 * Unchanged from the rail list it replaces — the ledger is `All conversations`,
 * and this is the shortcut. A larger number here would recreate the scroller
 * that was the defect.
 */
export const RAIL_RECENT_LIMIT = 10;

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
  const [activeKey, setActiveKey] = useState<string>(view);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const recentsTrigger = useRef<HTMLButtonElement>(null);

  const order = useMemo(() => {
    const destinations = railTraversal(expanded);
    const keys: string[] = [];
    for (const id of destinations) {
      keys.push(id);
      // The disclosure belongs beside the row it discloses, so `ArrowDown` from
      // Chat reaches the conversation list rather than skipping past it.
      if (id === "chat") keys.push(RECENTS_KEY);
    }
    return keys;
  }, [expanded]);

  // A route can change from the palette, a hash, or a link inside the page.
  // The roving stop follows it so `Tab` into the rail always lands on where the
  // user actually is, not on wherever they last arrowed to.
  useEffect(() => { setActiveKey((current) => (order.includes(view) ? view : current)); }, [view, order]);

  // Props can retain the previous async read for one render while a profile
  // switches. Filtering by the row's bound profile makes that frame empty
  // instead of exposing another profile's titles or favorite order.
  const scopedConversations = conversations.filter((conversation) => conversation.profileId === profileId);

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
   */
  function onNavKeyDown(event: KeyboardEvent) {
    const key = (event.target as HTMLElement | null)?.dataset?.railKey;
    if (!key) return;
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); step(key, 1); return;
      case "ArrowUp": event.preventDefault(); step(key, -1); return;
      case "Home": event.preventDefault(); focusKey(order[0]!); return;
      case "End": event.preventDefault(); focusKey(order[order.length - 1]!); return;
      case "ArrowRight": {
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
    const active = view === row.id;
    const childActive = row.nested.some((nested) => nested.id === view);
    const open = Boolean(expanded[row.id]);
    return [
      <div class="rail-row" key={row.id}>
        <button
          class={active ? "nav-item active" : childActive ? "nav-item has-active-child" : "nav-item"}
          type="button"
          aria-current={active ? "page" : undefined}
          data-scope={row.scope}
          title={`${row.label} · ${row.scope} scope`}
          onClick={() => { if (row.id === "chat") setRecentsOpen(true); onNavigate(row.id); }}
          {...itemProps(row.id)}
        >
          <Icon name={row.icon} />
          <span class="nav-item__label">{row.label}</span>
          {row.id === "chat" && unreadTurnCount > 0
            ? <span class="nav-turn-badge" aria-label={`${String(unreadTurnCount)} completed turn${unreadTurnCount === 1 ? "" : "s"}`}>{unreadTurnCount}</span>
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
    const favorites = scopedConversations.filter((session) => session.favorite);
    const recent = scopedConversations.filter((session) => !session.favorite).slice(0, RAIL_RECENT_LIMIT);
    const visible = [...favorites, ...recent];
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
          </span>
          <time dateTime={session.updatedAt}>{formatTime(session.updatedAt)}</time>
        </button>
        {session.favorite ? (
          <span class="recent-conversation__order" aria-label={`Reorder favorite ${session.title}`}>
            <button
              type="button"
              aria-label={`Move favorite ${session.title} up`}
              disabled={favoriteIds[0] === session.id}
              onClick={() => moveFavorite(session, -1)}
            >↑</button>
            <button
              type="button"
              aria-label={`Move favorite ${session.title} down`}
              disabled={favoriteIds.at(-1) === session.id}
              onClick={() => moveFavorite(session, 1)}
            >↓</button>
          </span>
        ) : null}
        <button
          class="recent-conversation__favorite"
          type="button"
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
        <button
          type="button"
          class={view === "profiles" ? "profile-manage-link active" : "profile-manage-link"}
          title="Manage profiles · profile scope"
          aria-label="Manage profiles"
          aria-current={view === "profiles" ? "page" : undefined}
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
