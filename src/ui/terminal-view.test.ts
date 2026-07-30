import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import {
  TERMINAL_CONTAINER_SCOPE_NOTICE,
  TERMINAL_SETUP_STORAGE_KEY,
  inferredTerminalDurability,
  readTerminalSetupOpen,
  terminalEmulatorWrite,
  terminalFooterNotice,
  terminalPanelAutoStart,
  terminalPersistenceNotice,
  terminalSealState,
  terminalTypography,
} from "./terminal-view";

describe("terminal runtime band", () => {
  it("starts closed unless this browser stored a choice to open it", () => {
    expect(readTerminalSetupOpen(undefined)).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => null })).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => "closed" })).toBe(false);
    expect(readTerminalSetupOpen({ getItem: () => "open" })).toBe(true);
  });

  it("reads the choice under one stable key", () => {
    const seen: string[] = [];
    readTerminalSetupOpen({ getItem: (key) => { seen.push(key); return null; } });
    expect(seen).toEqual([TERMINAL_SETUP_STORAGE_KEY]);
  });

  it("treats a blocked storage as closed rather than as an error", () => {
    expect(readTerminalSetupOpen({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("terminal status in the one seal vocabulary", () => {
  it("maps every lifecycle state without inventing a verdict", () => {
    expect(terminalSealState("running")).toBe("verified");
    expect(terminalSealState("starting")).toBe("checking");
    expect(terminalSealState("failed")).toBe("failed");
    expect(terminalSealState("restart-required")).toBe("attention");
    // An exited process is a finished process, not a broken one.
    expect(terminalSealState("exited")).toBe("none");
  });
});

describe("terminal panel auto-start", () => {
  it("lets selection wake only sessions that were never or still alive", () => {
    // idle: never started. restart-required: was live when the page reloaded.
    expect(terminalPanelAutoStart("idle")).toBe(true);
    expect(terminalPanelAutoStart("restart-required")).toBe(true);
    // running/starting short-circuit inside manager.start anyway.
    expect(terminalPanelAutoStart("running")).toBe(true);
    expect(terminalPanelAutoStart("starting")).toBe(true);
    // Ended sessions own the explicit Restart control: selecting their tab is
    // for reading final output, not for silently spending it on a respawn.
    expect(terminalPanelAutoStart("exited")).toBe(false);
    expect(terminalPanelAutoStart("failed")).toBe(false);
  });
});

describe("terminal typography", () => {
  it("tracks the density preference", () => {
    expect(terminalTypography("comfortable").fontSize).toBe(15);
    expect(terminalTypography("compact").fontSize).toBe(12);
    expect(terminalTypography(undefined).fontSize).toBe(13);
  });
});

describe("terminal durability wording", () => {
  it("treats an unmarked workspace as ephemeral instead of claiming encryption", () => {
    const durability = inferredTerminalDurability(new MemoryWorkspace());
    expect(durability.state).toBe("ephemeral");
    expect(durability.detail).toContain("No durable or client-encrypted workspace capability");
    expect(terminalPersistenceNotice(durability, "profile-a")).toContain("Reload loses them");
    expect(terminalPersistenceNotice(durability, "profile-a")).not.toContain("retained through the active encrypted workspace");
  });

  it("recognizes only the explicit client-encryption marker without inventing its backing tier", () => {
    const workspace = Object.assign(new MemoryWorkspace(), {
      encryptionBoundary: "airship-client-envelope-v1" as const,
    });
    const durability = inferredTerminalDurability(workspace);
    expect(durability.state).toBe("local");
    expect(durability.label).toBe("Client-encrypted workspace · tier unknown");
    expect(durability.detail).toContain("backing tier was not supplied");
    expect(durability.detail).toContain("does not claim device or cloud synchronization");
    expect(terminalPersistenceNotice(durability, "profile-a")).toContain("Processes still restart after reload");
  });

  it("stops claiming retention the moment a durable write is observed to fail", () => {
    const retained = terminalPersistenceNotice(
      Object.freeze({ state: "local" as const, label: "Client-encrypted workspace" }),
      "profile-a",
    );
    expect(retained).toContain("are retained through the active encrypted workspace");

    const failing = terminalFooterNotice(retained, "The workspace storage quota is exhausted.");
    expect(failing).not.toContain("are retained through the active encrypted workspace");
    expect(failing).toContain("The workspace storage quota is exhausted.");
    // And the claim's only licence to return is the failure clearing.
    expect(terminalFooterNotice(retained, undefined)).toBe(retained);
  });
});

describe("terminal transcript rendering", () => {
  const capped = "y".repeat(256 * 1_024);

  it("writes only the appended chunk once the published tail has started sliding", () => {
    expect(terminalEmulatorWrite(41, { outputSequence: 42, appendedOutput: "0123456789", bufferedOutput: capped }))
      .toEqual({ kind: "append", text: "0123456789" });
  });

  it("says nothing when the sequence has not moved", () => {
    // Status, cwd and audit changes all re-emit the snapshot; none of them is
    // an append, and re-writing the buffer for one is how a redraw storm starts.
    expect(terminalEmulatorWrite(42, { outputSequence: 42, appendedOutput: "0123456789", bufferedOutput: capped }))
      .toEqual({ kind: "none" });
  });

  it("redraws exactly once for a first mount and for a reconstructed session", () => {
    expect(terminalEmulatorWrite(undefined, { outputSequence: 0, appendedOutput: "", bufferedOutput: "restored" }))
      .toEqual({ kind: "redraw", text: "restored" });
    // A discontinuity — a resubscribe that missed chunks — is the only other
    // case worth a full write.
    expect(terminalEmulatorWrite(10, { outputSequence: 14, appendedOutput: "late", bufferedOutput: capped }))
      .toEqual({ kind: "redraw", text: capped });
  });
});

describe("terminal profile boundary", () => {
  it("names the container filesystem outside the mount as page-shared", () => {
    // The mount is what a Profile handoff unmounts; the container around it is
    // booted once per page. Saying only the first half is the drift this guards.
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("Only the workspace mount is Profile-owned");
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("page-shared");
    expect(TERMINAL_CONTAINER_SCOPE_NOTICE).toContain("survives a Profile switch");
    expect(readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8"))
      .toContain("{TERMINAL_CONTAINER_SCOPE_NOTICE}");
  });
});

describe("the terminal tab strip", () => {
  it("takes tabs.tsx's rules rather than growing a second copy of them", () => {
    // The strip cannot adopt `Tabs` itself — a tab being renamed is replaced by
    // a text input and `TabItem` has no shape for that, while its one secondary
    // action hard-renders a close `×`. What it must not do is reimplement the
    // behaviour: movement and active-tab-into-view are one rule each, and they
    // live in `tabs.tsx` where they are measured and tested.
    const source = terminalViewCode();
    expect(source).toMatch(/import \{[^}]*nextTabId[^}]*\} from "\.\/tabs";/u);
    expect(source).toMatch(/import \{[^}]*tabScrollLeft[^}]*\} from "\.\/tabs";/u);
    // `scrollIntoView` is the tempting shortcut that also scrolls every
    // scrollable ancestor, so a strip below the fold takes the page with it.
    expect(source).not.toContain("scrollIntoView");
  });

  it("holds the reconcile predicate from the manager's signal, never a render-time read", () => {
    // Host authority and the mount are not session state; a render-time
    // `canReconcile()` is only ever right when some other emission happens to
    // land at the same moment, and on a cold boot it does not.
    const source = terminalViewCode();
    expect(source).toContain("manager.subscribeReconcile(setReconcilable)");
    expect(source).not.toMatch(/disabled=\{[^}]*manager\.canReconcile\(\)/u);
  });
});

/**
 * The view's code without its prose.
 *
 * This repo explains itself in comments, and the comments here name the very
 * API the checks above forbid — `scrollIntoView` is banned in the code and
 * quoted in the reason. Reading the file raw would make the explanation the
 * violation.
 */
function terminalViewCode(): string {
  return readFileSync(new URL("./terminal-view.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/[^\n]*/gu, "$1");
}

describe("terminal panel bar at phone width", () => {
  it("sheds the labels without shedding the glyph that stands in for them", () => {
    // `button span` also hid the `＋` of "New here", whose mark happens to live
    // in a span — an empty 44px box on every phone and in the workspace dock.
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    expect(css).toContain('.terminal-panel__bar button span:not([aria-hidden="true"]){display:none}');
    expect(css).not.toMatch(/\.terminal-panel__bar button span\{display:none\}/u);
  });
});

describe("the tab rename affordance on touch surfaces", () => {
  /*
   * 34px wide, no height, and invisible until hover: the rename control had
   * no reachable path on a device that cannot hover. The phone block lifts it
   * to the same 44px square as its neighbours, and a coarse pointer anywhere
   * keeps it painted — an affordance that only exists under hover is an
   * affordance a touchscreen never sees.
   */
  it("grows to the 44px phone floor and shows itself without a hover", () => {
    const css = readFileSync(new URL("./terminal-view.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media(max-width:760px)"));
    expect(phone).toContain(".terminal-tab .terminal-tab__rename{min-width:44px;min-height:44px;opacity:1}");
    expect(css).toContain("@media(pointer:coarse){.terminal-tab .terminal-tab__rename{opacity:1}}");
  });
});
