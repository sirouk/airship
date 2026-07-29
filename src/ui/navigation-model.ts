import type { IconName } from "./icons";

export type NavigationView =
  | "chat"
  | "sessions"
  | "workspace"
  | "editor"
  | "terminal"
  | "memory"
  | "context"
  | "profiles"
  | "capabilities"
  | "skills"
  | "vault"
  | "billing"
  | "proof"
  | "access";

export type CanonicalDestinationId = Exclude<NavigationView, "sessions" | "editor" | "terminal" | "context" | "capabilities" | "skills" | "billing">;
export type NestedDestinationId = Extract<NavigationView, "sessions" | "editor" | "terminal" | "capabilities" | "skills" | "billing">;
export type NavigationGroup = "Work" | "Agent" | "Trust";
export type NavigationScope = "session" | "workspace" | "profile" | "global";
export type MobilePrimaryControlId = "chat" | "workspace" | "trust" | "more";
export type NavigationHash =
  | "#chat"
  | "#sessions"
  | "#workspace"
  | "#editor"
  | "#terminal"
  | "#memory"
  | "#context"
  | "#profiles"
  | "#capabilities"
  | "#skills"
  | "#vault"
  | "#account"
  | "#proof"
  | "#connection";

export type NestedDestination = Readonly<{
  id: NestedDestinationId;
  label: string;
  hash: NavigationHash;
  scope: NavigationScope;
}>;

export type CanonicalDestination = Readonly<{
  id: CanonicalDestinationId;
  label: string;
  hash: NavigationHash;
  group: NavigationGroup;
  scope: NavigationScope;
  nested: readonly NestedDestination[];
}>;

export type MobilePrimaryControl = Readonly<
  | {
      id: Exclude<MobilePrimaryControlId, "more">;
      label: string;
      kind: "route";
      view: NavigationView;
    }
  | {
      id: "more";
      label: "More";
      kind: "overlay";
      overlay: "more";
    }
>;

export type MobileMoreRouteEntry = Readonly<{
  id: NavigationView;
  label: string;
  description: string;
  kind: "route";
  view: NavigationView;
  hash: NavigationHash;
  parent?: CanonicalDestinationId;
}>;

export type NavigationOverlayEntry = Readonly<{
  id: "settings";
  label: "Settings";
  kind: "overlay";
  overlay: "settings";
  hash: "#settings";
}>;

export type MobileMoreEntry = MobileMoreRouteEntry | NavigationOverlayEntry;

const noNestedDestinations = Object.freeze([]) as readonly NestedDestination[];

const VIEW_HASHES: Readonly<Record<NavigationView, NavigationHash>> = Object.freeze({
  chat: "#chat",
  sessions: "#sessions",
  workspace: "#workspace",
  editor: "#editor",
  terminal: "#terminal",
  memory: "#memory",
  context: "#context",
  profiles: "#profiles",
  capabilities: "#capabilities",
  skills: "#skills",
  vault: "#vault",
  billing: "#account",
  proof: "#proof",
  access: "#connection",
});

const navigationViews = new Set<NavigationView>(Object.keys(VIEW_HASHES) as NavigationView[]);

export const CANONICAL_DESTINATIONS: readonly CanonicalDestination[] = Object.freeze([
  destination("chat", "Chat", "Work", "session", [
    nestedDestination("sessions", "All conversations", "global"),
  ]),
  destination("workspace", "Workspace", "Work", "workspace", [
    nestedDestination("editor", "Editor", "workspace"),
    nestedDestination("terminal", "Terminal", "workspace"),
  ]),
  destination("memory", "Memory", "Work", "session"),
  destination("profiles", "Profiles", "Agent", "profile"),
  destination("proof", "Proof", "Trust", "session"),
  destination("vault", "Vault", "Trust", "global"),
  destination("access", "Connection", "Trust", "global", [
    nestedDestination("billing", "Account", "global"),
  ]),
]);

export type RailSectionId = "work" | "receipts";

/**
 * A nested row carries an icon of its own.
 *
 * The 40 brass `↳` glyphs are gone, and a nested row in the collapsed rail
 * would otherwise be a blank 44px box: the label is clipped there, so the
 * glyph is the only thing left to identify the destination by.
 */
export type RailNestedDestination = NestedDestination & Readonly<{ icon: IconName }>;

export type RailRow = Readonly<{
  id: NavigationView;
  label: string;
  hash: NavigationHash;
  scope: NavigationScope;
  icon: IconName;
  /** Rows filed under this one, revealed by the row's own expander. */
  nested: readonly RailNestedDestination[];
}>;

export type RailSection = Readonly<{
  id: RailSectionId;
  /** Absent on the first section: there is nothing above it to distinguish. */
  label?: string;
  rows: readonly RailRow[];
}>;

/**
 * The rail's own glyph vocabulary, and the only thing it states for itself.
 *
 * Labels, hashes and scopes are read back out of `CANONICAL_DESTINATIONS`
 * rather than restated here: two tables of destination names is how a rail row
 * and a command-palette entry end up disagreeing about what a route is called.
 */
const RAIL_ICONS: Readonly<Partial<Record<NavigationView, IconName>>> = Object.freeze({
  chat: "chat", workspace: "workspace", editor: "file", terminal: "terminal", memory: "memory",
  proof: "proof", vault: "cloud", access: "access", billing: "billing", profiles: "profiles",
});

/**
 * The rail, as a person files it rather than as the code is arranged.
 *
 * `WORK` / `AGENT` / `TRUST` were three group labels over 3 / 1 / 3 rows. The
 * first had nothing above it to be disambiguated from; the second was a group
 * of exactly one whose children duplicated the pinned profile card; and the
 * third asked for the one word Airship's posture is that it does not need —
 * this product shows receipts instead of requesting trust.
 *
 * Two destinations moved *out* of the rail without leaving the product, and
 * both gained room by doing it: `All conversations` is the last row of the
 * recent-conversations disclosure (which is where a person is already looking
 * when they want it) and `Profiles` is the `Manage profiles` control on the
 * pinned profile row. Both remain in the command palette, both keep their
 * hash, and neither is behind a removed destination.
 *
 * `Account` is un-nested here. It was drawn as a child of the provider
 * connector, which made it invisible at 1440x900 with the parent collapsed; it
 * is a destination in its own right, not a sub-page of a connection method.
 */
const RAIL_LAYOUT: readonly Readonly<{
  id: RailSectionId;
  label?: string;
  rows: readonly Readonly<{ id: NavigationView; nested?: readonly NestedDestinationId[] }>[];
}>[] = Object.freeze([
  Object.freeze({
    id: "work",
    rows: Object.freeze([
      Object.freeze({ id: "chat" as const }),
      Object.freeze({ id: "workspace" as const, nested: Object.freeze(["editor", "terminal"] as const) }),
      Object.freeze({ id: "memory" as const }),
      Object.freeze({ id: "proof" as const }),
    ]),
  }),
  Object.freeze({
    id: "receipts",
    label: "Global",
    rows: Object.freeze([
      Object.freeze({ id: "vault" as const }),
      Object.freeze({ id: "access" as const }),
      Object.freeze({ id: "billing" as const }),
    ]),
  }),
]);

function railDestination(id: NavigationView): Readonly<{ label: string; scope: NavigationScope }> {
  for (const destination of CANONICAL_DESTINATIONS) {
    if (destination.id === id) return destination;
    for (const nested of destination.nested) if (nested.id === id) return nested;
  }
  throw new Error(`No navigation destination named ${id}`);
}

export const RAIL_SECTIONS: readonly RailSection[] = Object.freeze(RAIL_LAYOUT.map((section) => Object.freeze({
  id: section.id,
  ...(section.label ? { label: section.label } : {}),
  rows: Object.freeze(section.rows.map((row) => Object.freeze({
    id: row.id,
    ...railDestination(row.id),
    hash: navigationHashForView(row.id),
    icon: RAIL_ICONS[row.id]!,
    nested: Object.freeze((row.nested ?? []).map((id) => Object.freeze({
      id,
      ...railDestination(id),
      hash: navigationHashForView(id),
      icon: RAIL_ICONS[id]!,
    }))),
  }))),
})));

/**
 * Every rail row in the order a roving `ArrowDown` walks them, with nested
 * rows folded in only while their parent is expanded. The traversal order is
 * the visual order — anything else makes the keyboard and the eye disagree.
 */
export function railTraversal(expanded: Readonly<Record<string, boolean>>): readonly NavigationView[] {
  const order: NavigationView[] = [];
  for (const section of RAIL_SECTIONS) {
    for (const row of section.rows) {
      order.push(row.id);
      if (row.nested.length > 0 && expanded[row.id]) for (const nested of row.nested) order.push(nested.id);
    }
  }
  return Object.freeze(order);
}

export const MOBILE_PRIMARY_CONTROLS: readonly MobilePrimaryControl[] = Object.freeze([
  Object.freeze({ id: "chat", label: "Chat", kind: "route", view: "chat" }),
  Object.freeze({ id: "workspace", label: "Workspace", kind: "route", view: "workspace" }),
  Object.freeze({ id: "trust", label: "Trust", kind: "route", view: "proof" }),
  Object.freeze({ id: "more", label: "More", kind: "overlay", overlay: "more" }),
]);

export const SETTINGS_OVERLAY_ENTRY: NavigationOverlayEntry = Object.freeze({
  id: "settings",
  label: "Settings",
  kind: "overlay",
  overlay: "settings",
  hash: "#settings",
});

export const MOBILE_MORE_ENTRIES: readonly MobileMoreEntry[] = Object.freeze([
  moreRoute("sessions", "All conversations", "Search and resume past chats", "chat"),
  moreRoute("editor", "Editor", "Files and code", "workspace"),
  moreRoute("terminal", "Terminal", "Sandboxed command sessions", "workspace"),
  moreRoute("memory", "Memory", "Recall, sources, and relationships"),
  moreRoute("profiles", "Profiles", "Agent behavior and approvals"),
  moreRoute("skills", "Skills", "Reusable instructions across profiles", "profiles"),
  moreRoute("capabilities", "Capabilities", "Detected device and runtime support", "profiles"),
  moreRoute("vault", "Vault", "Where your work is stored"),
  moreRoute("access", "Connection", "Model providers and credentials"),
  moreRoute("billing", "Account", "Chutes balance and usage", "access"),
  SETTINGS_OVERLAY_ENTRY,
]);

const MOBILE_CONTROL_BY_VIEW: Readonly<Record<NavigationView, MobilePrimaryControlId>> = Object.freeze({
  chat: "chat",
  sessions: "chat",
  workspace: "workspace",
  proof: "trust",
  editor: "workspace",
  terminal: "workspace",
  memory: "more",
  context: "more",
  profiles: "more",
  capabilities: "more",
  skills: "more",
  vault: "trust",
  billing: "trust",
  access: "trust",
});

const PARENT_BY_VIEW: Readonly<Record<NavigationView, CanonicalDestinationId>> = Object.freeze({
  chat: "chat",
  sessions: "chat",
  workspace: "workspace",
  editor: "workspace",
  terminal: "workspace",
  memory: "memory",
  context: "memory",
  profiles: "profiles",
  capabilities: "profiles",
  skills: "profiles",
  proof: "proof",
  vault: "vault",
  access: "access",
  billing: "access",
});

export function mobilePrimaryControlForView(view: NavigationView): MobilePrimaryControlId {
  return MOBILE_CONTROL_BY_VIEW[view];
}

export function canonicalParentForView(view: NavigationView): CanonicalDestinationId {
  return PARENT_BY_VIEW[view];
}

export function navigationHashForView(view: NavigationView): NavigationHash {
  return VIEW_HASHES[view];
}

export function navigationViewFromHash(hash: string): NavigationView {
  const candidate = hash.replace(/^#/u, "").split(/[/?]/u, 1)[0];
  if (candidate === "connection") return "access";
  if (candidate === "account") return "billing";
  // Preserve already-shipped deep links while emitting only label-aligned hashes.
  if (candidate === "access") return "access";
  if (candidate === "billing") return "billing";
  // Sources shipped as a standalone route before source control moved into
  // the Workspace Editor. Keep old bookmarks useful without retaining a
  // second destination or a split-brain workbench.
  if (candidate === "sources") return "editor";
  if (candidate === "attestations") return "proof";
  return navigationViews.has(candidate as NavigationView) ? candidate as NavigationView : "chat";
}

function destination(
  id: CanonicalDestinationId,
  label: string,
  group: NavigationGroup,
  scope: NavigationScope,
  nested: readonly NestedDestination[] = noNestedDestinations,
): CanonicalDestination {
  return Object.freeze({ id, label, hash: navigationHashForView(id), group, scope, nested: Object.freeze([...nested]) });
}

function nestedDestination(
  id: NestedDestinationId,
  label: string,
  scope: NavigationScope,
): NestedDestination {
  return Object.freeze({ id, label, hash: navigationHashForView(id), scope });
}

function moreRoute(
  view: NavigationView,
  label: string,
  description: string,
  parent?: CanonicalDestinationId,
): MobileMoreRouteEntry {
  return Object.freeze({
    id: view,
    label,
    description,
    kind: "route",
    view,
    hash: navigationHashForView(view),
    ...(parent ? { parent } : {}),
  });
}
