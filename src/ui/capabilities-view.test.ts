import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { BrowserCapabilityObservation, BrowserProbeEvidence } from "../capabilities/browser-runtime";
import { ClientExecutionRuntime, type ExecutionCapability } from "../execution/runtime-registry";
import {
  formatObservedAt,
  probeAction,
  probeNeedsAction,
  probePresentation,
  runtimeAction,
  runtimeBoundary,
  runtimeGlyph,
  sealStateForCapabilitySummary,
} from "./capabilities-view";

const source = await readFile(new URL("./capabilities-view.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./capabilities-view.css", import.meta.url), "utf8");
const appSource = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

function capability(overrides: Partial<ExecutionCapability> = {}): ExecutionCapability {
  return {
    id: "airship-sh",
    label: "POSIX sh · airship-sh",
    languages: ["sh"],
    state: "ready",
    tier: "web-baseline",
    isolation: "in-page-interpreter",
    persistence: "ephemeral",
    commandInterface: "posix-sh-script",
    shell: "airship-sh",
    workspaceAccess: "bounded-snapshot-writeback",
    output: "bounded-stream",
    cancellation: "abort-interpreter",
    detail: "Airship's own POSIX sh interpreter.",
    ...overrides,
  };
}

function observation(
  evidence: BrowserProbeEvidence,
  state: BrowserCapabilityObservation["state"] = "unavailable",
): BrowserCapabilityObservation {
  return { state, evidence, detail: "test observation" };
}

describe("capability summary evidence", () => {
  it("inspects page capabilities before a conversation exists", () => {
    expect(appSource).toContain('import("../execution/execution-runtime-pack")');
    expect(appSource).toContain("inspectBrowserExecutionCapabilities()");
    expect(appSource).not.toContain('if (!active || !sessionId) throw new Error("The active browser runtime is not ready.")');
  });

  it("does not verify a completed inspection unless every reported runtime is ready", () => {
    expect(sealStateForCapabilitySummary([])).toBe("checking");
    expect(sealStateForCapabilitySummary([{ state: "ready" }, { state: "ready" }])).toBe("verified");
    expect(sealStateForCapabilitySummary([{ state: "ready" }, { state: "installable" }])).toBe("asserted");
    expect(sealStateForCapabilitySummary([{ state: "unavailable" }, { state: "installable" }])).toBe("none");
    expect(sealStateForCapabilitySummary([{ state: "failed" }, { state: "unavailable" }])).toBe("failed");
  });

  it("surfaces inspection failure independently of cached runtime rows", () => {
    expect(sealStateForCapabilitySummary([{ state: "ready" }], true)).toBe("failed");
  });
});

describe("runtime card presentation", () => {
  it("gives every shell runtime the terminal mark and leaves the rest on the model mark", () => {
    expect(runtimeGlyph(capability())).toBe("terminal");
    expect(runtimeGlyph(capability({ id: "node-webcontainer", shell: "webcontainer-jsh" }))).toBe("terminal");
    expect(runtimeGlyph(capability({ id: "wasix", shell: "unavailable" }))).toBe("terminal");
    expect(runtimeGlyph(capability({ id: "javascript-worker", shell: "none" }))).toBe("model");
    expect(runtimeGlyph(capability({ id: "python-pyodide", shell: "none" }))).toBe("model");
    // Derived from the record, not from an id: nothing here may special-case a
    // runtime by name, which is what put the model mark on the shell.
    expect(source).not.toContain('runtime.id === "node-webcontainer" ? "terminal"');
  });

  it("offers a probe only where the command runs that runtime", () => {
    expect(runtimeAction(capability())).toEqual({
      label: "Run a probe",
      command: "/execute-shell --json '{\"script\":\"echo $((6 * 7))\"}'",
    });
    // Every ready runtime the registry can report, checked as a set: a card
    // labelled "Run a probe" must never hand back the inspector, which lists
    // every runtime and exercises none.
    for (const runtime of new ClientExecutionRuntime().capabilities()) {
      const action = runtimeAction({ ...runtime, state: "ready" });
      expect(action).toBeDefined();
      if (action!.label === "Run a probe") {
        expect(action!.command).not.toBe("/inspect-execution-runtimes");
      } else {
        expect(action!.label).toBe("Inspect runtime");
      }
    }
    expect(runtimeAction(capability({ id: "wasi-preview1", shell: "none" })))
      .toEqual({ label: "Inspect runtime", command: "/inspect-execution-runtimes" });
  });

  /*
   * The ellipsis is asserted, not incidental. The button prepares the command
   * and does not run it — measured, the page read "3/6 runtimes ready" verbatim
   * before and after a press — so a label that promises activation outright is
   * the defect this pins.
   */
  it("keeps the activation verbs for a runtime that has one, and says they open rather than act", () => {
    expect(runtimeAction(capability({ state: "installable" }))?.label).toBe("Activate in Chat…");
    expect(runtimeAction(capability({ state: "failed" }))?.label).toBe("Review and retry in Chat…");
    expect(runtimeAction(capability({ state: "activating" }))).toBeUndefined();
    expect(runtimeAction(capability({ state: "unavailable" }))).toBeUndefined();
  });
});

describe("browser capability currency", () => {
  it("observes the registry rather than keeping a copy taken at mount", () => {
    // The registry re-probes on pageshow/online/visibility/connection/battery
    // and publishes to `subscribe`. Without a subscriber this route's private
    // copy silently diverged from the generation the agent reads, while the
    // summary asserted the probe was current.
    expect(source).toContain("subscribeBrowser?(listener: (report: BrowserRuntimeCapabilityReport) => void): () => void;");
    expect(source).toContain("return subscribeBrowser(setBrowser);");
    // The teardown is the subscription's own return value, so unmounting
    // empties the registry's listener set instead of leaking a dead component.
    expect(source).toContain("if (!subscribeBrowser) return;");
  });

  it("dates the summary from the rendered report instead of asserting currency", () => {
    expect(source).not.toContain("probe current");
    expect(source).toContain("runtimes ready`");
    expect(source).toContain("`${status} · observed ${formatObservedAt(browser.observedAt)}`");
  });

  it("reads an observation time in the same shape billing states one, and refuses to invent one", () => {
    const observed = formatObservedAt("2026-07-22T12:00:00.000Z");
    expect(observed).not.toBe("an unreadable time");
    expect(observed).toBe(new Date(Date.parse("2026-07-22T12:00:00.000Z")).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }));
    // A report with an unparseable stamp may not render as an epoch date.
    expect(formatObservedAt("not-a-time")).toBe("an unreadable time");
  });
});

describe("unavailable runtime boundary copy", () => {
  it("states the host condition and its remedy instead of a claim about the release", () => {
    const blocked = capability({
      id: "node-webcontainer",
      state: "unavailable",
      blocker: { condition: "This page is not cross-origin isolated.", remedy: "Serve Airship with its COOP and COEP headers, then reload." },
    });
    expect(runtimeBoundary(blocked)).toEqual({
      condition: "This page is not cross-origin isolated.",
      remedy: "Serve Airship with its COOP and COEP headers, then reload.",
    });
    // Rendered at the top level of the article, not inside the collapsed
    // technical boundary: the card reads the helper before the `<details>`.
    const article = source.slice(source.indexOf("capability-runtime__boundary"));
    expect(article.indexOf("boundary!.condition")).toBeLessThan(article.indexOf("capability-runtime__details"));
  });

  it("does not tell a runtime that is mid-activation that no path was advertised", () => {
    // `runtimeAction` returns nothing while a pack is activating, because there
    // is nothing to press. That is not the same claim as "this release ships no
    // path", which is what the single fallback sentence used to assert beside
    // an "Activating" seal.
    expect(runtimeAction(capability({ state: "activating" }))).toBeUndefined();
    const boundary = runtimeBoundary(capability({ state: "activating" }));
    expect(boundary.condition).toBe("Activation is running now.");
    expect(boundary.condition).not.toContain("advertised");
    expect(boundary.remedy).toBeTruthy();
    // An activating runtime that also carries a stale host blocker still reads
    // as activating: the run in progress is the newer fact.
    expect(runtimeBoundary(capability({ state: "activating", blocker: { condition: "stale", remedy: "stale" } })).condition)
      .toBe("Activation is running now.");
  });

  it("reserves the release-level sentence for a runtime the release genuinely does not offer", () => {
    // wasix is declared unavailable in the static table, so it carries no host
    // blocker and keeps reading as unadvertised.
    const wasix = new ClientExecutionRuntime().capabilities().find(({ id }) => id === "wasix");
    expect(wasix?.state).toBe("unavailable");
    expect(wasix?.blocker).toBeUndefined();
    expect(runtimeBoundary(wasix!)).toEqual({ condition: "No activation path is advertised by this release." });
  });

  it("names the cross-origin isolation blocker on a page that is not isolated", () => {
    // Node has no `document`, so node-webcontainer resolves to the first host
    // branch; the point under test is that a host branch produces a structured
    // blocker at all rather than a sentence buried in `detail`.
    const webcontainer = new ClientExecutionRuntime().capabilities().find(({ id }) => id === "node-webcontainer");
    expect(webcontainer?.state).toBe("unavailable");
    expect(webcontainer?.blocker?.condition).toBeTruthy();
    expect(webcontainer?.blocker?.remedy).toBeTruthy();
    expect(webcontainer?.detail).toContain(webcontainer!.blocker!.condition);
  });
});

describe("live load surface", () => {
  it("prints counts this page owns and never a scheduling ceiling", () => {
    // The figures and their wording are derived beside the monitor and asserted
    // there; the route renders them without reformatting, so a "not measurable"
    // reading cannot become a number on the way to the screen.
    expect(source).toContain("runtimeLoadFigures(report).map");
    expect(source).toContain("runtimeLoadLaneSummary(report)");
    expect(source).toContain("RUNTIME_LOAD_BOUNDARY");
    // The invariant at browser-runtime.ts: maxWorkerConcurrency sizes nothing
    // by itself and must never be rendered as a count of running workers.
    expect(source).not.toContain("scheduling.maxWorkerConcurrency");
  });

  it("raises every disclosure summary on this route to the touch target, not only its buttons", () => {
    const mobile = styles.slice(styles.indexOf("@media (max-width: 760px)"));
    for (const selector of [
      ".capability-runtime__details > summary",
      ".capability-device-card details summary",
      ".capability-policy-row details summary",
    ]) {
      expect(mobile).toContain(selector);
    }
    const rule = mobile.slice(mobile.indexOf(".capability-runtime__details > summary"));
    expect(rule).toContain("min-height: 44px");
    // …without dropping the disclosure triangle to get there. A `summary` is
    // `display: list-item`, and that box type is what paints the marker in
    // Chromium and WebKit; sizing it with `display: flex` enlarges the target
    // and removes the affordance, on the touch surface this rule exists for.
    const declarations = rule.slice(0, rule.indexOf("}"));
    expect(declarations).not.toContain("display:");
    // The card's own remediation control is a button and is sized with them.
    expect(mobile).toContain(".capability-probe-action { min-height: 44px; }");
  });
});

describe("extension capability surface", () => {
  it("uses the same live bridge observer as the rest of the app and renders cache and compute facts", () => {
    expect(source).toContain("inspectExtension(): Promise<ExtensionBridgeObservation>");
    expect(source).toContain("inspectExtension()]);");
    expect(source).toContain("Airship Companion");
    expect(source).toContain("Ciphertext cache");
    expect(source).toContain("Background compute");
  });

  /*
   * The card used to print "Live bridge handshake · this page" under every
   * observation — including the ones where the probe said no extension
   * answered at all. Claiming a live handshake the probe explicitly
   * disproved is the one statement this surface may never make, so the
   * detail is gated on `available` exactly like the WebGPU sibling card.
   */
  it("claims a live bridge handshake only when the probe actually answered", () => {
    expect(source).toContain('detail={extension.state === "available" ? "Live bridge handshake · this page" : undefined}');
    expect(source).not.toContain('detail="Live bridge handshake · this page"');
    const card = source.slice(source.indexOf("Airship Companion"), source.indexOf("</DeviceCard>", source.indexOf("Airship Companion")));
    expect(card).toContain('extension.state === "available"');
  });
});

describe("probe evidence a reader can act on", () => {
  it("names the two refusals instead of collapsing them into Unavailable", () => {
    // Both refusals arrive carrying a state that would otherwise swallow them:
    // `permission-needed` on a failed probe, `disabled` on an unavailable one.
    expect(probePresentation(observation("permission-needed", "failed"))).toEqual(["attention", "Permission needed"]);
    expect(probePresentation(observation("disabled"))).toEqual(["attention", "Switched off here"]);
    for (const [, label] of [
      probePresentation(observation("permission-needed", "failed")),
      probePresentation(observation("disabled")),
    ]) {
      expect(label).not.toBe("Unavailable");
      expect(label).not.toBe("Probe failed");
    }
    // The graded evidences are untouched.
    expect(probePresentation(observation("probe-passed", "available"))).toEqual(["verified", "Probe passed"]);
    expect(probePresentation(observation("api-exposed", "available"))).toEqual(["asserted", "API observed"]);
    expect(probePresentation(observation("probe-failed", "failed"))).toEqual(["failed", "Probe failed"]);
    expect(probePresentation(observation("not-observed"))).toEqual(["none", "Unavailable"]);
  });

  it("offers exactly one control, and only where acting could change the answer", () => {
    let reprobes = 0;
    const reprobe = () => { reprobes += 1; };
    const action = probeAction(observation("permission-needed", "failed"), reprobe);
    expect(action).toBeDefined();
    action!.onSelect();
    expect(reprobes).toBe(1);

    expect(probeAction(observation("disabled"), reprobe)).toBeDefined();
    // Nothing the reader does clears these, so none of them draws a button.
    for (const evidence of ["probe-passed", "api-exposed", "not-observed", "probe-failed"] as const) {
      expect(probeAction(observation(evidence), reprobe)).toBeUndefined();
    }
    expect(reprobes).toBe(1);
  });

  it("offers the control on the primitives that actually report a refusal, not only on the cards", () => {
    // `refusalEvidence` in browser-runtime maps NotAllowedError and
    // SecurityError, and the two probe paths that raise them are the service
    // worker and Cache Storage probes — both of which render in the browser
    // primitives list, not in the four DeviceCards. A remediation slot that
    // exists only on the cards is therefore a slot nothing in this build can
    // ever fill, which is the defect the evidence variants were added to close.
    const list = source.slice(source.indexOf("<summary>Browser primitives</summary>"), source.indexOf("</details>", source.indexOf("<summary>Browser primitives</summary>")));
    expect(list).toContain("probeAction(observation, onReprobe)");
    expect(list).toContain("capability-probe-action");
    // …and the row is not hidden behind a closed disclosure while it asks for
    // something. The predicate is the same evidence test the button uses.
    const disclosure = source.slice(source.indexOf("<details open="), source.indexOf("<summary>Browser primitives</summary>"));
    expect(disclosure).toContain("primitives.some(([, observation]) => probeNeedsAction(observation))");
  });

  it("agrees with the control about which evidences a reader can clear", () => {
    // One predicate behind the button and the disclosure: if these two ever
    // disagree, a list opens with no control in it or hides one that exists.
    for (const evidence of ["permission-needed", "disabled"] as const) {
      expect(probeNeedsAction(observation(evidence))).toBe(true);
      expect(probeAction(observation(evidence), () => undefined)).toBeDefined();
    }
    for (const evidence of ["probe-passed", "api-exposed", "not-observed", "probe-failed"] as const) {
      expect(probeNeedsAction(observation(evidence))).toBe(false);
      expect(probeAction(observation(evidence), () => undefined)).toBeUndefined();
    }
  });

  it("wires the card's control to this route's own probe rather than a second one", () => {
    // One verb, one probe: the card's button re-runs `refresh`, the same call
    // the route header's Refresh makes, so a granted permission cannot produce
    // two differently-aged reports on one screen.
    expect(source).toContain("onReprobe={() => void refresh()}");
    expect(source).toContain("probeAction(observation, onReprobe)");
  });
});
