import { describe, expect, it } from "vitest";
import { RAIL_RECENT_LIMIT, railRowFor, rovingKey } from "./rail";
import { railTraversal, type NavigationView } from "./navigation-model";

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
