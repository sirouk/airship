import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DESTINATIONS,
  MOBILE_MORE_ENTRIES,
  MOBILE_PRIMARY_CONTROLS,
  RAIL_SECTIONS,
  SETTINGS_OVERLAY_ENTRY,
  canonicalParentForView,
  destinationLabel,
  mobilePrimaryControlForView,
  navigationHashForView,
  navigationViewFromHash,
  railTraversal,
  type NavigationView,
} from "./navigation-model";
import { workbenchIdentity } from "./workbench-model";

const allViews: readonly NavigationView[] = [
  "chat",
  "sessions",
  "workspace",
  "editor",
  "terminal",
  "memory",
  "context",
  "profiles",
  "capabilities",
  "skills",
  "vault",
  "billing",
  "proof",
  "access",
];

describe("canonical navigation model", () => {
  it("models conversation and workspace subroutes under their canonical parents", () => {
    expect(CANONICAL_DESTINATIONS.map((entry) => entry.id)).toEqual([
      "chat",
      "workspace",
      "memory",
      "profiles",
      "proof",
      "vault",
      "access",
    ]);
    expect(CANONICAL_DESTINATIONS).toHaveLength(7);

    const chat = CANONICAL_DESTINATIONS.find((entry) => entry.id === "chat");
    const workspace = CANONICAL_DESTINATIONS.find((entry) => entry.id === "workspace");
    const profiles = CANONICAL_DESTINATIONS.find((entry) => entry.id === "profiles");
    const connection = CANONICAL_DESTINATIONS.find((entry) => entry.id === "access");
    expect(chat?.nested).toEqual([
      // `global` here was the parent-agnostic default, and the palette prints
      // the tag verbatim: the route enforces profile scope, so the tag has to.
      expect.objectContaining({ id: "sessions", label: "All conversations", hash: "#sessions", scope: "profile" }),
    ]);
    expect(workspace?.nested).toEqual([
      expect.objectContaining({ id: "editor", label: "Editor", hash: "#editor" }),
      expect.objectContaining({ id: "terminal", label: "Terminal", hash: "#terminal" }),
    ]);
    // Both were legal views with legal hashes and no entry point on desktop
    // until they were filed here; the rail, the palette and the jump chords
    // all read this one table.
    expect(profiles?.nested).toEqual([
      expect.objectContaining({ id: "skills", label: "Skills", hash: "#skills" }),
      expect.objectContaining({ id: "capabilities", label: "Capabilities", hash: "#capabilities" }),
    ]);
    expect(connection?.nested).toEqual([
      expect.objectContaining({ id: "billing", label: "Account", hash: "#account" }),
    ]);
    expect(canonicalParentForView("skills")).toBe("profiles");
    expect(canonicalParentForView("capabilities")).toBe("profiles");
    expect(canonicalParentForView("billing")).toBe("access");
    expect(canonicalParentForView("sessions")).toBe("chat");
    expect(canonicalParentForView("editor")).toBe("workspace");
    expect(canonicalParentForView("terminal")).toBe("workspace");
    expect(canonicalParentForView("context")).toBe("memory");
  });

  it("emits label-aligned hashes and preserves legacy route aliases", () => {
    for (const view of allViews) {
      const expectedHash = view === "access" ? "#connection" : view === "billing" ? "#account" : `#${view}`;
      expect(navigationHashForView(view)).toBe(expectedHash);
      expect(navigationViewFromHash(expectedHash)).toBe(view);
      expect(navigationViewFromHash(`${expectedHash}?selection=current`)).toBe(view);
    }
    expect(navigationViewFromHash("#access")).toBe("access");
    expect(navigationViewFromHash("#billing")).toBe("billing");
    expect(navigationViewFromHash("#sources")).toBe("editor");
    expect(navigationViewFromHash("#attestations")).toBe("proof");
    expect(navigationViewFromHash("#chat/018f40e0-7c62-7c70-9db7-6d5de37ae52c")).toBe("chat");
    expect(navigationViewFromHash("#unknown")).toBe("chat");
  });

  it("defines five fixed mobile controls with conversations available through More", () => {
    // Memory before Trust, and in the band rather than behind the overflow
    // glyph. The slot it takes was the live-load reading's, which counted
    // execution-pack runs and therefore read `0 · Idle` on a phone forever.
    expect(MOBILE_PRIMARY_CONTROLS).toEqual([
      { id: "chat", label: "Chat", kind: "route", view: "chat" },
      { id: "workspace", label: "Workspace", kind: "route", view: "workspace" },
      { id: "memory", label: "Memory", kind: "route", view: "memory" },
      { id: "trust", label: "Trust", kind: "route", view: "proof" },
      { id: "more", label: "More", kind: "overlay", overlay: "more" },
    ]);
    expect(MOBILE_PRIMARY_CONTROLS).toHaveLength(5);
    expect(mobilePrimaryControlForView("proof")).toBe("trust");
    expect(mobilePrimaryControlForView("memory")).toBe("memory");
  });

  it("keeps nested destinations attached to their primary mobile parent", () => {
    expect(Object.fromEntries(allViews.map((view) => [view, mobilePrimaryControlForView(view)]))).toEqual({
      chat: "chat",
      sessions: "chat",
      workspace: "workspace",
      editor: "workspace",
      terminal: "workspace",
      memory: "memory",
      // Memory's index tab, so it highlights Memory rather than the overflow.
      context: "memory",
      profiles: "more",
      capabilities: "more",
      skills: "more",
      vault: "trust",
      billing: "trust",
      proof: "trust",
      access: "trust",
    });
  });

  it("provides the complete More sheet order and a distinct Settings overlay", () => {
    expect(MOBILE_MORE_ENTRIES.map((entry) => entry.id)).toEqual([
      "sessions",
      "editor",
      "terminal",
      // Memory has a band slot *and* a sheet row: the sheet is the phone's full
      // index, and a promotion is not a reason to take a learned path away.
      "memory",
      "profiles",
      "skills",
      "capabilities",
      "vault",
      "access",
      "billing",
      "settings",
    ]);
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "skills")).toEqual(
      expect.objectContaining({ parent: "profiles", label: "Skills", hash: "#skills", description: "Reusable instructions across profiles" }),
    );
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "capabilities")).toEqual(
      expect.objectContaining({ parent: "profiles", label: "Capabilities", hash: "#capabilities", description: "Detected device and runtime support" }),
    );
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "billing")).toEqual(
      expect.objectContaining({ parent: "access", label: "Account", hash: "#account" }),
    );
    expect(MOBILE_MORE_ENTRIES.find((entry) => entry.id === "sessions")).toEqual(
      expect.objectContaining({ parent: "chat", label: "All conversations", hash: "#sessions", description: "Search and resume past chats" }),
    );
    const routeDescriptions = MOBILE_MORE_ENTRIES
      .filter((entry) => entry.kind === "route")
      .map((entry) => entry.description);
    expect(routeDescriptions.every((description) => description.length > 0)).toBe(true);
    expect(routeDescriptions).not.toContain("Destination");
    expect(new Set(routeDescriptions).size).toBe(routeDescriptions.length);
    expect(SETTINGS_OVERLAY_ENTRY).toEqual({
      id: "settings",
      label: "Settings",
      kind: "overlay",
      overlay: "settings",
    });
    expect(CANONICAL_DESTINATIONS.map((entry) => String(entry.id))).not.toContain(SETTINGS_OVERLAY_ENTRY.id);
  });

  it("advertises a hash only where the router can honour one", () => {
    // `#settings` was modelled, exported and asserted, and the router has never
    // known the token: `navigationViewFromHash` fell it through to Chat, so a
    // shared link silently rewrote the reader's location. Every hash this model
    // publishes has to round-trip, and an overlay — which opens over whatever
    // route is current — publishes none.
    for (const entry of MOBILE_MORE_ENTRIES) {
      if (entry.kind !== "route") {
        expect(entry, `${entry.id} is an overlay and must not advertise an address`).not.toHaveProperty("hash");
        continue;
      }
      expect(navigationViewFromHash(entry.hash), `${entry.hash} round-trips`).toBe(entry.view);
    }
  });
});

/**
 * The attribute block of every `<RouteHeader>` and `<RouteBar>` in a file.
 *
 * Quote- and brace-aware rather than "up to the next `>`", because these
 * headers put whole elements in their props — `status={<Popover …>}`,
 * `notes={<p …>}` — and a regex stops at the first of those.
 */
function headerProps(source: string): readonly string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/<Route(?:Header|Bar)(?=[\s/>])/gu)) {
    let depth = 0;
    let quote = "";
    const start = match.index + match[0].length;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) { found.push(source.slice(start, index)); break; }
    }
  }
  return found;
}

type RouteHeading = Readonly<{ file: string; view: NavigationView; title: string | undefined }>;

/**
 * Every route heading in `src/ui` whose `routeId` names a real destination.
 *
 * `routeId` is the route's hash without its `#`, so it round-trips through the
 * navigation model. The round-trip is asserted rather than assumed, which is
 * what excludes `sources-view.tsx`: `#sources` is a retained legacy alias that
 * resolves to Editor, and its panel header is not that route's `<h1>`.
 */
function routeHeadings(): readonly RouteHeading[] {
  const directory = new URL("./", import.meta.url);
  const found: RouteHeading[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(new URL(file, directory), "utf8");
    for (const props of headerProps(source)) {
      const routeId = /\brouteId="([^"]+)"/u.exec(props)?.[1];
      if (routeId === undefined) continue;
      const view = navigationViewFromHash(`#${routeId}`);
      if (navigationHashForView(view) !== `#${routeId}`) continue;
      // Either spelling resolves: the literal a route still types, or the
      // lookup this contract exists to make routes use. Anything else stays
      // `undefined` and is reported — a title this cannot read is a title
      // nothing is checking.
      const literal = /\btitle="([^"]+)"/u.exec(props)?.[1];
      const lookup = /\btitle=\{destinationLabel\("([^"]+)"\)\}/u.exec(props)?.[1];
      found.push(Object.freeze({
        file,
        view,
        title: literal ?? (lookup === undefined ? undefined : destinationLabel(lookup as NavigationView)),
      }));
    }
  }
  return Object.freeze(found);
}

describe("a destination is called one thing, on the way in and after arrival", () => {
  const headings = routeHeadings();

  it("finds the route headings it is meant to police", () => {
    // Without this the assertion below passes on an empty scan, which is how a
    // naming contract quietly stops being one.
    expect(headings.length).toBeGreaterThanOrEqual(10);
    expect(headings.map((heading) => heading.view)).toContain("access");
    expect(headings.map((heading) => heading.view)).toContain("billing");
  });

  it("titles every route with its canonical destination label", () => {
    /*
     * The two that renamed themselves on arrival: the rail row, the command
     * palette, the Trust hub tab and the More sheet all read "Connection" and
     * "Account" from `CANONICAL_DESTINATIONS`, and the pages under them read
     * "Connect models" and "Account standing". A person taps a word and has to
     * land on a screen that contains it. Both extra phrases survive — in the
     * eyebrow, which is the rung that exists for a route's second line.
     */
    const disagreements = headings
      .filter((heading) => heading.title !== destinationLabel(heading.view))
      .map((heading) => `${heading.file}: ${String(heading.title)} ≠ ${destinationLabel(heading.view)}`);
    expect(disagreements).toEqual([]);
  });

  it("names the workbench's two routes out of the same table", () => {
    // One component serves `#workspace` and `#editor` and titles itself from
    // the hash, so its two answers are asserted rather than scanned.
    expect(workbenchIdentity("#workspace").title).toBe(destinationLabel("workspace"));
    expect(workbenchIdentity("#editor").title).toBe(destinationLabel("editor"));
  });

  it("leaves only the views that draw no route heading at all uncovered", () => {
    const covered = new Set<NavigationView>([...headings.map((heading) => heading.view), "workspace", "editor"]);
    const uncovered = allViews.filter((view) => !covered.has(view));
    // Chat is the conversation itself and carries no route heading; Vault still
    // hand-rolls its `<h1>`. A bound rather than a list: the next route to
    // adopt the shared header must not turn this test red.
    expect(uncovered.length, `uncovered: ${uncovered.join(", ")}`).toBeLessThanOrEqual(2);
  });
});

describe("the rail's filing", () => {
  const rows = RAIL_SECTIONS.flatMap((section) => section.rows);

  it("keeps profile work together and labels only the global services", () => {
    expect(RAIL_SECTIONS.map((section) => section.label)).toEqual([undefined, "Global"]);
    // The three internal-architecture group names are gone as *labels*. "Work"
    // had nothing above it to be distinguished from, "Agent" was a group of
    // one, and this product shows receipts rather than asking for trust.
    expect(RAIL_SECTIONS.map((section) => section.label ?? "")).not.toContain("Work");
    expect(RAIL_SECTIONS.map((section) => section.label ?? "")).not.toContain("Trust");
    expect(RAIL_SECTIONS[0]?.rows.map((row) => row.id)).toEqual(["chat", "workspace", "memory", "proof"]);
    expect(RAIL_SECTIONS[1]?.rows.map((row) => row.id)).toEqual(["vault", "access", "billing"]);
  });

  it("un-nests Account and keeps Workspace as the one correct nesting", () => {
    expect(rows.map((row) => row.id)).toEqual(["chat", "workspace", "memory", "proof", "vault", "access", "billing"]);
    expect(rows.find((row) => row.id === "billing")?.hash).toBe("#account");
    expect(rows.flatMap((row) => row.nested.map((nested) => nested.id))).toEqual(["editor", "terminal"]);
  });

  it("gives every row and every nested row a glyph, because the 60px rail has only glyphs", () => {
    for (const row of rows) {
      expect(row.icon, `${row.label} needs an icon`).toBeTruthy();
      for (const nested of row.nested) expect(nested.icon, `${nested.label} needs an icon`).toBeTruthy();
    }
  });

  it("does not file All conversations or Profiles as rail rows — both are disclosures now", () => {
    const ids = rows.map((row) => String(row.id));
    expect(ids).not.toContain("sessions");
    expect(ids).not.toContain("profiles");
    // ...and both remain reachable destinations with their own hashes.
    expect(navigationHashForView("sessions")).toBe("#sessions");
    expect(navigationHashForView("profiles")).toBe("#profiles");
  });

  it("walks the visual order, folding nested rows in only while their parent is open", () => {
    expect(railTraversal({})).toEqual(["chat", "workspace", "memory", "proof", "vault", "access", "billing"]);
    expect(railTraversal({ workspace: true })).toEqual([
      "chat", "workspace", "editor", "terminal", "memory", "proof", "vault", "access", "billing",
    ]);
    // A collapsed parent must not leave its children in the arrow-key order:
    // focus would move to a row nobody can see.
    expect(railTraversal({ workspace: false })).not.toContain("editor");
  });
});
