import { useEffect, useId, useRef } from "preact/hooks";
import {
  CANONICAL_DESTINATIONS,
  canonicalParentForView,
  MOBILE_MORE_ENTRIES,
  MOBILE_PRIMARY_CONTROLS,
  mobilePrimaryControlForView,
  type MobilePrimaryControlId,
  type NavigationView,
} from "./navigation-model";
import { Icon, type IconName } from "./icons";
import { trapFocus } from "./focus-trap";
import { RuntimeLoadIndicator } from "./runtime-load-indicator";

export type MobileNavigationProps = Readonly<{
  view: NavigationView;
  moreOpen: boolean;
  /**
   * Set while any other modal surface owns the page. The bar is a sibling of
   * every dialog, so without this it stays tabbable behind a scrim that claims
   * the rest of the shell is inert.
   */
  chromeInert?: boolean;
  chatPending?: boolean | number;
  proofPending?: boolean | number;
  attestationPending?: boolean | number;
  onNavigate(view: NavigationView): void;
  onOpenMore(): void;
  onCloseMore(): void;
  onOpenCommandPalette(): void;
  onOpenSettings(): void;
}>;

const primaryIcons: Readonly<Record<MobilePrimaryControlId, IconName>> = Object.freeze({
  chat: "chat",
  workspace: "workspace",
  trust: "proof",
  more: "plus",
});

const routeIcons: Readonly<Record<NavigationView, IconName>> = Object.freeze({
  chat: "chat",
  sessions: "sessions",
  workspace: "workspace",
  editor: "source",
  terminal: "terminal",
  memory: "memory",
  context: "context",
  profiles: "profiles",
  capabilities: "terminal",
  skills: "skills",
  vault: "cloud",
  billing: "billing",
  proof: "proof",
  access: "access",
});

export function MobileNavigation({
  view,
  moreOpen,
  chromeInert = false,
  chatPending = false,
  proofPending = false,
  attestationPending = false,
  onNavigate,
  onOpenMore,
  onCloseMore,
  onOpenCommandPalette,
  onOpenSettings,
}: MobileNavigationProps) {
  const moreButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const activeControl = mobilePrimaryControlForView(view);
  const overflowHintId = useId();
  /**
   * Which overflow route is live, when one is. This is a *description*, not part
   * of the trigger's name: "More" is the name every caller and test knows the
   * control by, and appending a destination to it would rename a control that
   * has not changed. `aria-describedby` states the fact without moving it.
   */
  const overflowDestination = activeControl === "more" ? overflowDestinationLabel(view) : undefined;
  const proofNoticeCount = pendingCount(proofPending);
  const attestationNoticeCount = pendingCount(attestationPending);
  const chatNoticeCount = pendingCount(chatPending);

  useEffect(() => {
    if (!moreOpen) return;
    const restoreTarget = moreButton.current ?? activeElement();
    const frame = window.requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(frame);
      restoreTarget?.focus({ preventScroll: true });
    };
  }, [moreOpen]);

  function restoreMoreFocus(): void {
    moreButton.current?.focus({ preventScroll: true });
  }

  function closeMore(): void {
    onCloseMore();
    restoreMoreFocus();
  }

  function navigateFromMore(next: NavigationView): void {
    onCloseMore();
    onNavigate(next);
    restoreMoreFocus();
  }

  function openSettingsFromMore(): void {
    onCloseMore();
    onOpenSettings();
    restoreMoreFocus();
  }

  return (
    <>
      <nav class="mobile-nav fixed-mobile-nav" aria-label="Mobile navigation" inert={moreOpen || chromeInert} aria-hidden={moreOpen || chromeInert || undefined}>
        {/* The live-load reading rides this band for the same reason it rides
            the rail on desktop: below the phone breakpoint `.sidebar` is
            `display: none`, so a rail-only indicator is removed from the render
            tree *and* the accessibility tree exactly where the reader has the
            least room to go looking for it. This bar is the only band a phone
            renders on every route. It is not a destination and takes no tap
            target — it gets the nav grid's leading track and sizes itself, so
            the four destinations keep equal shares and do not resize under a
            finger when the count changes. */}
        <RuntimeLoadIndicator placement="nav" />
        {MOBILE_PRIMARY_CONTROLS.map((control) => {
          const current = activeControl === control.id;
          const open = control.id === "more" && moreOpen;
          const notice = control.id === "chat"
            ? chatNoticeCount
            : control.id === "trust"
              ? attestationNoticeCount
              : 0;
          const noticeLabel = control.id === "chat"
            ? completedTurnLabel(chatNoticeCount)
            : control.id === "trust"
              ? evidenceRecordLabel(attestationNoticeCount)
              : undefined;
          const proofPresence = control.id === "trust" && proofNoticeCount > 0 && notice === 0;

          if (control.kind === "overlay") {
            /*
             * The trigger keeps the location claim, and names the destination.
             *
             * Five of fourteen routes — memory, context, profiles, capabilities
             * and skills — map to this control and to no other, so dropping
             * `aria-current` here left the runtime's location unstated for
             * assistive tech on all five while `.is-current` still highlighted
             * the tab: the eye and the screen reader disagreeing about where
             * the reader is. The double claim that removal was meant to prevent
             * cannot happen: the sheet's entry only asserts current while the
             * sheet is open, and this whole `<nav>` is `inert` + `aria-hidden`
             * exactly then, so at most one current control is ever in the
             * accessibility tree.
             *
             * The description is the part the old markup lacked either way:
             * "More, current page" says a route inside the overflow is active
             * without saying which one, so the sr-only hint below names it.
             */
            return (
              <button
                ref={moreButton}
                key={control.id}
                class={navClass(current, open)}
                type="button"
                aria-current={current ? "page" : undefined}
                aria-controls="airship-mobile-more"
                aria-expanded={moreOpen}
                aria-haspopup="dialog"
                aria-describedby={overflowDestination ? overflowHintId : undefined}
                onClick={() => moreOpen ? closeMore() : onOpenMore()}
              >
                <Icon name={primaryIcons[control.id]} size={20} />
                <span>{control.label}</span>
                <NavigationBadge count={notice} label={noticeLabel} presence={proofPresence} />
              </button>
            );
          }

          return (
            <button
              key={control.id}
              class={navClass(current, false)}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => onNavigate(control.view)}
            >
              <Icon name={primaryIcons[control.id]} size={20} />
              <span>{control.label}</span>
              <NavigationBadge count={notice} label={noticeLabel} presence={proofPresence} />
            </button>
          );
        })}
        {/* Out of flow (`.sr-only` is absolutely positioned), so it consumes
            none of the nav's five grid tracks. */}
        {overflowDestination ? <span id={overflowHintId} class="sr-only">{`Current page: ${overflowDestination}`}</span> : null}
      </nav>

      {moreOpen ? (
        <div
          class="mobile-sheet-scrim"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMore();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeMore();
              return;
            }
            if (event.key === "Tab" && dialog.current) trapFocus(event, dialog.current);
          }}
        >
          <div
            ref={dialog}
            id="airship-mobile-more"
            class="mobile-sheet more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="airship-mobile-more-title"
            aria-describedby="airship-mobile-more-description"
            tabIndex={-1}
          >
            <header class="mobile-sheet__header">
              <div>
                <span class="eyebrow">Navigate</span>
                <h2 id="airship-mobile-more-title">More</h2>
                <p id="airship-mobile-more-description">Additional Airship destinations and settings.</p>
              </div>
              <button class="mobile-sheet__close" type="button" onClick={closeMore}>Close</button>
            </header>

            <button
              class="more-sheet__command"
              type="button"
              onClick={() => { onCloseMore(); onOpenCommandPalette(); }}
            >
              <span aria-hidden="true">⌘</span>
              <span><strong>Command Center</strong><small>Search every route, recent session, and slash command</small></span>
              <span aria-hidden="true">→</span>
            </button>

            <div class="more-sheet__grid">
              {MOBILE_MORE_ENTRIES.map((entry) => {
                if (entry.kind === "overlay") {
                  return (
                    <button
                      key={entry.id}
                      class="more-sheet__entry"
                      type="button"
                      onClick={openSettingsFromMore}
                    >
                      <Icon name="model" size={21} />
                      <span>{entry.label}</span>
                      <small>Preferences</small>
                    </button>
                  );
                }

                const current = entry.view === view;
                return (
                  <button
                    key={entry.id}
                    class={`more-sheet__entry${current ? " active is-current" : ""}`}
                    type="button"
                    aria-current={current ? "page" : undefined}
                    onClick={() => navigateFromMore(entry.view)}
                  >
                    <Icon name={routeIcons[entry.view]} size={21} />
                    <span>{entry.label}</span>
                    <small>{entry.description}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function NavigationBadge({ count, label, presence = false }: { count: number; label?: string; presence?: boolean }) {
  if (presence) return <><span class="mobile-nav__badge mobile-nav__badge--presence" aria-hidden="true" /><span class="sr-only">Proof available</span></>;
  if (count === 0 || !label) return null;
  return (
    <>
      <span class="mobile-nav__badge" aria-hidden="true">{count}</span>
      <span class="sr-only">{label}</span>
    </>
  );
}

function pendingCount(value: boolean | number): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(99, Math.floor(value));
}

export function completedTurnLabel(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count} completed turn${count === 1 ? "" : "s"}`;
}

export function evidenceRecordLabel(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count} evidence record${count === 1 ? "" : "s"}`;
}

/**
 * What the active overflow route is called, in the words the sheet uses.
 *
 * Read out of `MOBILE_MORE_ENTRIES` first, so the trigger and the entry it
 * highlights can never disagree about a route's name. `context` has no entry of
 * its own — it is Memory's index tab — so it falls back to the canonical
 * parent's label rather than inventing a name only this file knows.
 */
export function overflowDestinationLabel(view: NavigationView): string | undefined {
  for (const entry of MOBILE_MORE_ENTRIES) {
    if (entry.kind === "route" && entry.view === view) return entry.label;
  }
  const parent = canonicalParentForView(view);
  return CANONICAL_DESTINATIONS.find((destination) => destination.id === parent)?.label;
}

function navClass(current: boolean, open: boolean): string {
  return ["mobile-nav__tab", current ? "active is-current" : "", open ? "is-open" : ""]
    .filter(Boolean)
    .join(" ");
}

function activeElement(): HTMLElement | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
}
