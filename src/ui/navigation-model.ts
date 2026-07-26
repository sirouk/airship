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
  moreRoute("sessions", "All conversations", "chat"),
  moreRoute("editor", "Editor", "workspace"),
  moreRoute("terminal", "Terminal", "workspace"),
  moreRoute("memory", "Memory"),
  moreRoute("profiles", "Profiles"),
  moreRoute("vault", "Vault"),
  moreRoute("access", "Connection"),
  moreRoute("billing", "Account", "access"),
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
  parent?: CanonicalDestinationId,
): MobileMoreRouteEntry {
  return Object.freeze({
    id: view,
    label,
    kind: "route",
    view,
    hash: navigationHashForView(view),
    ...(parent ? { parent } : {}),
  });
}
