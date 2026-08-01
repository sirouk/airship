import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAIL_RECENT_LIMIT, railCurrentHint, railRowFor, railStandInFor, rovingKey } from "./rail";
import { destinationLabel, railTraversal, type NavigationView } from "./navigation-model";

/*
 * The returning person's most important object may not need a click to exist.
 *
 * Measured on every cold open: `button[aria-label="Expand recent conversations"]`
 * present on a profile that already held conversations, because the disclosure
 * was seeded `useState(false)` and the list arrives asynchronously — so mount
 * was always empty and the seed always said "closed".
 */
describe("the conversation disclosure's default", () => {
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");

  it("opens itself the first time the profile turns out to have conversations", () => {
    expect(source).toContain("if (recentsChoice.current !== undefined || visibleConversations.length === 0) return;");
    expect(source).toContain("setRecentsOpen(true);");
  });

  it("lets a stated choice outrank the default, and remembers it", () => {
    expect(source).toContain("const recentsChoice = useRef<boolean | undefined>(loadRecentsPreference());");
    expect(source).toContain("saveRecentsPreference(open);");
    expect(source).toContain("onClick={() => chooseRecentsOpen(!recentsOpen)}");
  });

  it("marks the conversation that will not reopen, in words and not only in colour", () => {
    expect(source).toContain("Needs review · could not be reopened");
    expect(source).toContain("— needs review; this conversation could not be reopened.");
  });
});

describe("the shortcut's size", () => {
  it("lists the same ten conversations the rail list did", () => {
    // The ledger is `All conversations`; this is the shortcut. A larger number
    // here would rebuild the 250px scroller that was the defect.
    expect(RAIL_RECENT_LIMIT).toBe(10);
  });
});

/**
 * The rail promises one tab stop, always. A composite widget with zero tab
 * stops is not a keyboard-reachable widget at all, and five of the fourteen
 * `NavigationView`s are not rail rows — so a deep link to any of them used to
 * seed the roving key with a row that does not exist.
 */
describe("the rail's single tab stop", () => {
  const closed = railTraversal({});
  const open = railTraversal({ workspace: true });
  const everyView: readonly NavigationView[] = [
    "chat", "sessions", "workspace", "editor", "terminal", "memory", "context",
    "profiles", "capabilities", "skills", "vault", "billing", "proof", "access",
  ];

  it("resolves to a row the rail actually renders, for every view", () => {
    for (const view of everyView) {
      expect(closed, `${view} seeds an existing row`).toContain(rovingKey(view, closed));
      expect(open, `${view} seeds an existing row with Workspace open`).toContain(rovingKey(view, open));
    }
  });

  it("lands on the row an off-rail destination is filed under", () => {
    // The five that are legal views and not rail rows. `sessions` is the last
    // entry of Chat's own disclosure; `context` is filed under Memory.
    expect(rovingKey("sessions", closed)).toBe("chat");
    expect(rovingKey("context", closed)).toBe("memory");
    // Profiles and its two subroutes are a rail *control*, not a rail row, so
    // there is no parent row to land on and the first row is the answer.
    for (const view of ["profiles", "skills", "capabilities"] as const) {
      expect(rovingKey(view, closed), view).toBe(closed[0]);
    }
  });

  it("keeps a rendered row as the stop and never returns a withdrawn one", () => {
    // A navigation to somewhere off-rail leaves the stop where the user put it.
    expect(rovingKey("profiles", closed, "vault")).toBe("vault");
    // ...but collapsing Workspace withdraws Terminal, and the stop has to move
    // rather than name a row that is no longer in the tree.
    expect(rovingKey("terminal", open, "terminal")).toBe("terminal");
    expect(rovingKey("terminal", closed, "terminal")).toBe("workspace");
    expect(closed).not.toContain("terminal");
  });

  it("agrees with the filing `railRowFor` reports", () => {
    expect(railRowFor("terminal")?.id).toBe("workspace");
    expect(railRowFor("sessions")).toBeUndefined();
  });
});

/**
 * Every view marks something on the desktop rail.
 *
 * Measured: `#context`, `#skills` and `#capabilities` are legal hashes with
 * routes of their own and no rail row, and the desktop rail showed no
 * current-page state at all on all three — while the phone's bottom bar marked
 * every one of them through `More`. The phone signal is untouched; this is the
 * rail growing the same one.
 */
describe("the rail's you-are-here state", () => {
  const everyView: readonly NavigationView[] = [
    "chat", "sessions", "workspace", "editor", "terminal", "memory", "context",
    "profiles", "capabilities", "skills", "vault", "billing", "proof", "access",
  ];
  const source = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");
  const railKeys = new Set<string>([...railTraversal({ workspace: true }), "profiles"]);

  it("marks a control for every one of the fourteen views", () => {
    for (const view of everyView) {
      expect(railKeys, `${view} marks a rail control`).toContain(railStandInFor(view));
    }
  });

  it("keeps a nested row marking its parent, and never re-parents a row of its own", () => {
    expect(railStandInFor("editor")).toBe("workspace");
    expect(railStandInFor("terminal")).toBe("workspace");
    // Account is a rail row in its own right, not a sub-page of a connection
    // method. Standing on it must not light Connection up.
    expect(railStandInFor("billing")).toBe("billing");
    expect(railStandInFor("access")).toBe("access");
  });

  it("stands Memory in for its index and Profiles in for its two subroutes", () => {
    expect(railStandInFor("context")).toBe("memory");
    expect(railStandInFor("skills")).toBe("profiles");
    expect(railStandInFor("capabilities")).toBe("profiles");
    expect(railStandInFor("sessions")).toBe("chat");
  });

  it("names the live route wherever the stand-in's own label does not", () => {
    // The same test the phone band makes before describing its current control.
    for (const view of ["skills", "capabilities", "sessions"] as const) {
      expect(railCurrentHint(view), view).toBe(destinationLabel(view));
    }
    for (const view of ["chat", "workspace", "editor", "profiles", "billing"] as const) {
      expect(railCurrentHint(view), view).toBeUndefined();
    }
  });

  it("answers #context exactly as it answers #memory, because it renders that route", () => {
    /*
     * `#context` opens the Memory route at its Index tab — same component, same
     * `<h1>Memory</h1>`. The rail row it marks is Memory's, and it marks it as
     * the page rather than as the page's container: a row reading one rung
     * weaker than the heading beside it is a third answer to one question. No
     * hint either, because "Current page: Context" would name a word the screen
     * does not contain — the defect this whole batch exists to remove.
     */
    expect(railStandInFor("context")).toBe(railStandInFor("memory"));
    expect(railCurrentHint("context")).toBeUndefined();
    expect(source).toContain("const active = view === row.id || (railStandInFor(view) === row.id && !rendersOwnRoute(view));");
  });

  it("does not pay for the desktop signal by removing the phone's", () => {
    // "Hide it on a phone" is never the fix, and neither is its inverse.
    expect(readFileSync(new URL("./mobile-navigation.tsx", import.meta.url), "utf8"))
      .toContain('aria-current={current ? "page" : undefined}');
    expect(source).toContain('aria-describedby={childActive && currentHint ? CURRENT_HINT_ID : undefined}');
  });
});
