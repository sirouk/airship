import { useEffect, useRef } from "preact/hooks";
import {
  CANONICAL_DESTINATIONS,
  MOBILE_MORE_ENTRIES,
  MOBILE_PRIMARY_CONTROLS,
  mobilePrimaryControlForView,
  type CanonicalDestinationId,
  type MobilePrimaryControlId,
  type NavigationView,
} from "./navigation-model";
import { Icon, type IconName } from "./icons";
import { trapFocus } from "./focus-trap";

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

const parentLabels = Object.freeze(Object.fromEntries(
  CANONICAL_DESTINATIONS.map((destination) => [destination.id, destination.label]),
)) as Readonly<Record<CanonicalDestinationId, string>>;

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
        {MOBILE_PRIMARY_CONTROLS.map((control) => {
          const current = activeControl === control.id;
          const open = control.id === "more" && moreOpen;
          const notice = control.id === "chat"
            ? chatNoticeCount
            : control.id === "trust"
            ? proofNoticeCount
            : control.id === "more"
              ? attestationNoticeCount
              : 0;
          const noticeLabel = control.id === "chat"
            ? pendingLabel(chatNoticeCount, "completed turn")
            : control.id === "trust"
            ? pendingLabel(proofNoticeCount, "proof item")
            : control.id === "more"
              ? pendingLabel(attestationNoticeCount, "attestation item")
              : undefined;

          if (control.kind === "overlay") {
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
                onClick={() => moreOpen ? closeMore() : onOpenMore()}
              >
                <Icon name={primaryIcons[control.id]} size={20} />
                <span>{control.label}</span>
                <PendingBadge count={notice} label={noticeLabel} />
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
              <PendingBadge count={notice} label={noticeLabel} />
            </button>
          );
        })}
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
                const notice = entry.view === "proof" ? attestationNoticeCount : 0;
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
                    <small>{entry.parent ? `${parentLabels[entry.parent]} view` : "Destination"}</small>
                    <PendingBadge
                      count={notice}
                      label={pendingLabel(notice, "attestation item")}
                    />
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

function PendingBadge({ count, label }: { count: number; label?: string }) {
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

function pendingLabel(count: number, noun: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} pending ${noun}${count === 1 ? "" : "s"}`;
}

function navClass(current: boolean, open: boolean): string {
  return ["mobile-nav__tab", current ? "active is-current" : "", open ? "is-open" : ""]
    .filter(Boolean)
    .join(" ");
}

function activeElement(): HTMLElement | undefined {
  return document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
}
