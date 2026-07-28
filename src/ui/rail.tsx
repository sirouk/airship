import type { Ref } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { trapFocus } from "./focus-trap";
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
 * What it is: 429px of destinations that fit without scrolling at every height
 * this product is used at, three tab stops, and two catalogs re-homed into
 * disclosures anchored where a person is already pointing. Nothing was deleted
 * — the same ten conversations, the same profile catalog, the same eleven
 * destinations — but the two lists that were *permanently* spending rail height
 * now spend it only while they are being read, and they get 320px of width to
 * do it in instead of 105px.
 *
 * The rail has three states on one width token, and the state is remembered
 * per width band rather than re-derived from the viewport on every load.
 */

export type RailConversation = Readonly<{
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  open(): void;
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
}>;

/** The disclosure key that sits in the roving order beside the Chat row. */
const RECENTS_KEY = "recents";

/** Panel geometry, in the same units the stylesheet declares it in. */
export const RAIL_RECENTS_WIDTH = 320;
export const RAIL_RECENTS_MAX_HEIGHT = 420;
const RAIL_RECENTS_GUTTER = 8;

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
 * Where the conversation panel opens.
 *
 * It is `position: fixed` because `.primary-nav` is a real scroll container —
 * the measured overflow mask has to keep working at short viewports — and a
 * block-axis scroller clips the inline axis too, which would slice a 320px
 * panel hanging off a 60px rail. Kept free of the DOM so the flip is assertable
 * without a browser: a panel that runs off the bottom of the screen is a list
 * of conversations nobody can reach.
 */
export function recentsPanelAnchor(input: Readonly<{
  trigger: Readonly<{ top: number; right: number }>;
  viewportWidth: number;
  viewportHeight: number;
}>): Readonly<{ top: number; left: number }> {
  const width = Math.min(RAIL_RECENTS_WIDTH, input.viewportWidth - RAIL_RECENTS_GUTTER * 2);
  const height = Math.min(RAIL_RECENTS_MAX_HEIGHT, input.viewportHeight * 0.6);
  const left = Math.max(
    RAIL_RECENTS_GUTTER,
    Math.min(input.trigger.right + RAIL_RECENTS_GUTTER, input.viewportWidth - width - RAIL_RECENTS_GUTTER),
  );
  const top = Math.max(
    RAIL_RECENTS_GUTTER,
    Math.min(input.trigger.top, input.viewportHeight - height - RAIL_RECENTS_GUTTER),
  );
  return Object.freeze({ top, left });
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
  const [recentsAnchor, setRecentsAnchor] = useState<Readonly<{ top: number; left: number }>>(() =>
    Object.freeze({ top: 0, left: 0 }));
  const [activeKey, setActiveKey] = useState<string>(view);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const recentsHost = useRef<HTMLDivElement>(null);
  const recentsPanel = useRef<HTMLDivElement>(null);
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

  const recents = conversations.slice(0, RAIL_RECENT_LIMIT);

  useEffect(() => {
    if (!recentsOpen) return;
    const trigger = recentsTrigger.current;
    if (trigger) setRecentsAnchor(recentsPanelAnchor({
      trigger: trigger.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
    function onPointerDown(event: PointerEvent) {
      if (!recentsHost.current?.contains(event.target as Node)) setRecentsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setRecentsOpen(false);
        recentsTrigger.current?.focus();
        return;
      }
      if (event.key === "Tab" && recentsHost.current?.contains(document.activeElement)) {
        trapFocus(event, recentsPanel.current);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [recentsOpen]);

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
          onClick={() => onNavigate(row.id)}
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
   * Same ten sessions, same rows, same ordering — but as a 320px panel over the
   * conversation instead of a 250px scroller permanently occupying the rail.
   * The title column goes from roughly 105px to 232px, which is the difference
   * between thirteen characters and thirty-four, and the `All conversations`
   * ledger link stops being the sixth row of a clipped scroller.
   */
  function recentsDisclosure() {
    return (
      <div class="rail-recents" ref={recentsHost}>
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
            aria-label="Recent conversations"
            ref={recentsPanel}
            style={{ top: `${recentsAnchor.top}px`, left: `${recentsAnchor.left}px` }}
          >
            <div class="rail-recents__header">
              <strong>Recent conversations</strong>
              {/* The affordance states its own cost: this is how many of the
                  ledger's conversations the shortcut is showing. */}
              <small>{recents.length}</small>
              <button
                class="chat-nav-new"
                type="button"
                aria-label="New conversation"
                title="New conversation"
                disabled={busy}
                onClick={() => { setRecentsOpen(false); onNewConversation(); }}
              ><span aria-hidden="true">+</span></button>
            </div>
            {recents.map((session) => (
              <button
                key={session.id}
                class={session.id === activeConversationId ? "recent-conversation recent-conversation--thread active" : "recent-conversation recent-conversation--thread"}
                type="button"
                title={session.title}
                aria-current={session.id === activeConversationId ? "page" : undefined}
                onClick={() => { setRecentsOpen(false); session.open(); }}
              >
                <span class="recent-conversation__mark" aria-hidden="true">{session.id === activeConversationId ? "●" : "○"}</span>
                <span class="recent-conversation__copy">
                  <strong>{session.title}</strong>
                  <small>{session.preview}</small>
                </span>
                <time dateTime={session.updatedAt}>{formatTime(session.updatedAt)}</time>
              </button>
            ))}
            <button
              class={view === "sessions" ? "nav-item nav-item--nested active" : "nav-item nav-item--nested"}
              type="button"
              aria-current={view === "sessions" ? "page" : undefined}
              onClick={() => { setRecentsOpen(false); onNavigate("sessions"); }}
            ><span class="nav-item__label">All conversations</span></button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <aside class="sidebar" data-rail-state={state} inert={inert} aria-hidden={inert || undefined}>
      <div class="rail">
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
        {/* 48px, was 120px. The eyebrow became this control's accessible name,
            `Manage profiles` kept its own row, and the profile descriptions the
            rail used to drop are rendered by the menu. */}
        <div class="profile-switcher">
          <MenuSelect
            className="profile-menu"
            ariaLabel="Agent profile"
            value={profileId}
            disabled={busy}
            options={profiles.map((profile) => ({ value: profile.profileId, label: profile.name, description: profile.description }))}
            leading={(option) => <span class="profile-monogram" aria-hidden="true">{monogram(option.label)}</span>}
            onChange={onChangeProfile}
          />
          <button
            type="button"
            class={view === "profiles" ? "profile-manage-link active" : "profile-manage-link"}
            title="Manage profiles · profile scope"
            /* The visible word is the destination's own name so the row reads
               in the rail's vocabulary; the accessible name keeps the verb the
               card used, and 232px cannot hold `[GE] General ⌄` and a
               fifteen-character link without truncating the profile itself. */
            aria-label="Manage profiles"
            aria-current={view === "profiles" ? "page" : undefined}
            onClick={onManageProfiles}
          >
            <Icon name="profiles" />
            <span class="profile-manage-link__label">Profiles</span>
          </button>
        </div>
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
