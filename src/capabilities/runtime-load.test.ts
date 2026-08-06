import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatBytes } from "../core/bytes";
import { ClientExecutionRuntime, type ExecutionAdapter, type ExecutionResult } from "../execution/runtime-registry";
import {
  RUNTIME_LOAD_BOUNDARY,
  RuntimeLoadMonitor,
  measuredBytesLabel,
  runtimeLoadFigures,
  runtimeLoadIndicatorLabel,
  runtimeLoadLaneSummary,
  type RuntimeLoadHost,
} from "./runtime-load";

function monitor(host: Partial<RuntimeLoadHost> = {}): RuntimeLoadMonitor {
  return new RuntimeLoadMonitor({ now: () => new Date("2026-07-28T12:00:00.000Z"), ...host });
}

function adapter(id: "javascript-worker" | "airship-sh", run: () => Promise<void>): ExecutionAdapter {
  return {
    capability: {
      id,
      label: id,
      languages: ["javascript"],
      state: "ready",
      tier: "web-baseline",
      isolation: "disposable-worker",
      persistence: "ephemeral",
      commandInterface: "javascript-function",
      shell: "none",
      workspaceAccess: "none",
      output: "bounded-stream",
      cancellation: "terminate-worker",
      detail: "test adapter",
    },
    async execute(): Promise<ExecutionResult> {
      await run();
      return {
        runtime: id,
        exitCode: 0,
        stdout: "",
        stderr: "",
        provenance: { capabilityTier: "web-baseline", authority: "browser", engine: "test", artifactKind: "source" },
      };
    },
  };
}

describe("runtime load monitor", () => {
  it("counts the runs this page started, per runtime, and returns to zero when they settle", async () => {
    const load = monitor();
    const releases: Array<() => void> = [];
    const runtime = new ClientExecutionRuntime([], load);
    runtime.register(adapter("javascript-worker", () => new Promise<void>((resolve) => releases.push(resolve))));
    runtime.register(adapter("airship-sh", () => new Promise<void>((resolve) => releases.push(resolve))));

    const signal = new AbortController().signal;
    const first = runtime.execute({ runtime: "javascript-worker", timeoutMs: 1_000, signal });
    const second = runtime.execute({ runtime: "airship-sh", timeoutMs: 1_000, signal });
    await Promise.resolve();

    const busy = load.snapshot();
    expect(busy.current).toBe(2);
    expect(busy.peak).toBeGreaterThanOrEqual(2);
    expect(busy.lanes).toEqual([
      { id: "airship-sh", current: 1, peak: 1 },
      { id: "javascript-worker", current: 1, peak: 1 },
    ]);

    for (const release of releases) release();
    await Promise.all([first, second]);
    const idle = load.snapshot();
    expect(idle.current).toBe(0);
    // The high-water mark survives the runs it measured; the lanes stay visible
    // as idle rather than vanishing the moment work ends.
    expect(idle.peak).toBe(2);
    expect(idle.lanes.every(({ current }) => current === 0)).toBe(true);
  });

  it("releases the count when a run throws, and never counts a refused request", async () => {
    const load = monitor();
    const runtime = new ClientExecutionRuntime([], load);
    const signal = new AbortController().signal;
    runtime.register({
      ...adapter("javascript-worker", async () => undefined),
      async execute(): Promise<ExecutionResult> { throw new Error("worker died"); },
    });

    await expect(runtime.execute({ runtime: "javascript-worker", timeoutMs: 1_000, signal })).rejects.toThrow("worker died");
    expect(load.snapshot().current).toBe(0);
    // No adapter is registered for python-pyodide, so nothing ran: an intention
    // that was refused must not appear as utilisation.
    await expect(runtime.execute({ runtime: "python-pyodide", timeoutMs: 1_000, signal })).rejects.toThrow();
    expect(load.snapshot().lanes.some(({ id }) => id === "python-pyodide")).toBe(false);
  });

  it("publishes every change to subscribers and stops on unsubscribe", () => {
    const load = monitor();
    const seen: number[] = [];
    const unsubscribe = load.subscribe((report) => seen.push(report.current));
    const finish = load.begin("airship-sh");
    finish();
    // Idempotent: a double finish must not push the count below the work that
    // is still running.
    finish();
    unsubscribe();
    load.begin("airship-sh");
    expect(seen).toEqual([0, 1, 0]);
  });

  it("reports memory as not-measurable rather than inventing a number", async () => {
    const load = monitor();
    const report = await load.measure();
    expect(report.memory.state).toBe("not-measurable");
    expect(report.storage.state).toBe("not-measurable");
    expect(measuredBytesLabel(report.memory)).toBe("Not measurable in this browser");
    expect(measuredBytesLabel(report.storage)).toBe("Not measurable in this browser");
    // The rendered strip says so in words. A surface may print these verbatim
    // and never has to decide what an unmeasured value looks like.
    expect(runtimeLoadFigures(report)).toEqual([
      ["Running now", "0 execution runs"],
      ["Peak this page", "0 concurrent"],
      ["Page memory", "Not measurable in this browser"],
      ["Origin storage", "Not measurable in this browser"],
    ]);
    expect(runtimeLoadLaneSummary(report)).toBe("No execution runtime has been asked to run anything in this page yet.");
    expect(RUNTIME_LOAD_BOUNDARY).toContain("Browser-wide CPU load is not observable from a page");
  });

  it("states each lane's current and peak once work has run", () => {
    const load = monitor();
    const finish = load.begin("airship-sh");
    expect(runtimeLoadFigures(load.snapshot())[0]).toEqual(["Running now", "1 execution run"]);
    expect(runtimeLoadLaneSummary(load.snapshot())).toBe("airship-sh · 1 now · peak 1");
    finish();
    expect(runtimeLoadLaneSummary(load.snapshot())).toBe("airship-sh · 0 now · peak 1");
  });

  it("reports a measured figure only when the realm actually measured one", async () => {
    const measured = await monitor({
      measureMemory: async () => ({ bytes: 41_943_040 }),
      estimateStorage: async () => ({ usage: 1_536, quota: 100_000 }),
    }).measure();
    expect(measured.memory).toMatchObject({ state: "measured", bytes: 41_943_040 });
    // Asserted against the shared formatter rather than a copied literal: the
    // defect this replaces was 268,435,456 bytes reading "256 MB" here and
    // "256 MiB" on #vault, which no pair of copied literals could catch.
    expect(measuredBytesLabel(measured.memory)).toBe(formatBytes(41_943_040));
    expect(measuredBytesLabel(measured.memory)).toBe("40 MiB");
    expect(measuredBytesLabel(measured.storage)).toBe(formatBytes(1_536));
    expect(measuredBytesLabel(measured.storage)).toBe("1.5 KiB");
    expect(measuredBytesLabel({ state: "measured", bytes: 268_435_456, detail: "origin usage" })).toBe("256 MiB");

    // A rejecting or empty measurement is not a zero.
    const failed = await monitor({
      measureMemory: async () => { throw new DOMException("cross-origin isolation required", "SecurityError"); },
      estimateStorage: async () => ({}),
    }).measure();
    expect(failed.memory.state).toBe("not-measurable");
    expect(failed.storage.state).toBe("not-measurable");
  });
});

const indicator = await readFile(new URL("../ui/runtime-load-indicator.tsx", import.meta.url), "utf8");
const indicatorStyles = await readFile(new URL("../ui/runtime-load-indicator.css", import.meta.url), "utf8");
const rail = await readFile(new URL("../ui/rail.tsx", import.meta.url), "utf8");
const mobileNav = await readFile(new URL("../ui/mobile-navigation.tsx", import.meta.url), "utf8");
const routeStyles = await readFile(new URL("../ui/routes.css", import.meta.url), "utf8");
const app = await readFile(new URL("../ui/app.tsx", import.meta.url), "utf8");

describe("shell load indicator", () => {
  it("states a count that changes when a run starts, and never a share of the machine", () => {
    const load = monitor();
    expect(runtimeLoadIndicatorLabel(load.snapshot()).text).toBe("Idle");
    const finish = load.begin("airship-sh");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).text).toBe("1 running");
    const second = load.begin("javascript-worker");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).text).toBe("2 running");
    second();
    finish();
    expect(runtimeLoadIndicatorLabel(load.snapshot()).text).toBe("Idle");
    // Peak survives the runs that set it, and it travels with the spoken
    // reading: a bare number in a rail is exactly what a reader mistakes for a
    // CPU meter, so the announced sentence says what was counted.
    expect(runtimeLoadIndicatorLabel(load.snapshot()).reading).toContain("Peak 2 this page");
  });

  it("keeps the live activity reading atomic and explicit", () => {
    expect(indicator).toContain("<span class=\"sr-only\">{text}</span>");
    expect(indicator).toContain("aria-atomic=\"false\"");
  });

  it("puts real text in the live region instead of an aria-label over hidden children", () => {
    // A live region is announced from its accessible contents, and `aria-hidden`
    // descendants are not in the accessibility tree. The earlier shape — an
    // `aria-label` over two `aria-hidden` spans — therefore announced nothing on
    // change and left a browse-mode reader on an empty status container. The
    // visible glyphs stay hidden (so the count is not read twice); the
    // `sr-only` sentence is the region's content.
    expect(indicator).toContain("role=\"status\"");
    // Sliced from the rendered element rather than the file: the docblock above
    // it names the defect, and naming it is not committing it.
    const region = indicator.slice(indicator.indexOf("role=\"status\""));
    expect(region).not.toContain("aria-label");
    const hidden = region.match(/aria-hidden="true"/gu) ?? [];
    const spoken = region.match(/class="sr-only"/gu) ?? [];
    expect(hidden).toHaveLength(2);
    expect(spoken.length).toBeGreaterThanOrEqual(1);
  });

  it("uses the singular only for a single run", () => {
    const load = monitor();
    load.begin("airship-sh");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).reading).toContain("1 execution run in flight");
    load.begin("airship-sh");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).reading).toContain("2 execution runs in flight");
  });

  it("rides the rail, so it is in the DOM on every route rather than on #capabilities alone", () => {
    // The finding this closes was that the only live reading lived on the route
    // a reader has to navigate to. The rail is the band every route renders at
    // desktop width, and the shell renders it unconditionally — no `view ===`
    // guard, no route list — which is what makes the indicator global rather
    // than a second copy of the Capabilities panel.
    expect(rail).toContain("<RuntimeLoadIndicator placement=\"rail\" activity={activity} />");
    // One rail, mounted as a sibling of the route outlet rather than inside it,
    // so every destination the outlet can show has the indicator beside it.
    // `<Rail\b` rather than `indexOf("<Rail")`: the shell also declares a
    // `useState<RailPreference>` several thousand lines earlier.
    expect(app.match(/<Rail\b/gu)).toHaveLength(1);
    const mounted = app.search(/<Rail\b/u);
    const outlet = app.indexOf("<ViewErrorBoundary");
    expect(mounted).toBeLessThan(outlet);
    const mount = app.slice(mounted, outlet);
    expect(mount).not.toContain("view ===");
    expect(mount).not.toContain("view !==");
  });

  it("does not spend a phone nav slot on a count only an execution pack can move", () => {
    /*
     * REVERSED, on measurement rather than on taste.
     *
     * This used to assert the indicator into the phone tab bar, on the argument
     * that `.sidebar { display: none }` takes the rail's copy out of both trees
     * below the breakpoint. The argument was sound and the placement was still
     * wrong, because of what the number actually counts: `begin()` has exactly
     * one caller, `ClientExecutionRuntime.execute`, wrapped around the adapter
     * call. Sending a prompt, running a tool, indexing a workspace and querying
     * memory are all invisible to it. On a phone that has activated no optional
     * execution pack — which is every phone, since none of them is promoted
     * there — the band read `0 · Idle` from first paint until the tab closed.
     *
     * A permanent constant is not an indicator, and this one was holding the
     * leading track of the most constrained band in the product. The reading is
     * not deleted: the rail still mounts it on every desktop route (asserted
     * above) and #capabilities still expands the whole report. What is asserted
     * here is that the phone band is destinations only.
     */
    // The element, not the identifier: the file still names the component in
    // the comment that records why it left.
    expect(mobileNav).not.toContain("<RuntimeLoadIndicator");
    const phone = routeStyles.slice(routeStyles.indexOf("@media (max-width: 640px)"));
    expect(phone).toContain(".sidebar {");
    const navRule = phone.slice(phone.indexOf("  .mobile-nav {"));
    // Equal shares for every destination and no leading non-destination track.
    expect(navRule.slice(0, navRule.indexOf("}"))).toMatch(/grid-template-columns: repeat\(\d+, minmax\(0, 1fr\)\);/u);
    // The `nav` placement rules stay in the sheet: `RuntimeLoadPlacement` still
    // declares the variant, and a sheet that forgets it is how a re-mount lands
    // unstyled. Deleting the rules is a separate decision from this one.
    expect(indicatorStyles).toContain("[data-placement=\"nav\"]");
  });

  it("renders active turns and durable events, not a meter", () => {
    expect(indicator).toContain("activity?.[0]");
    expect(indicator).toContain("activity?.[1]");
    expect(indicator).not.toContain("maxWorkerConcurrency");
    expect(indicator).not.toContain("%");
  });

  it("describes active conversations and their durable events on the rail", () => {
    expect(indicator).toContain("activity?.[1]");
    expect(app).toContain("durableEventCount: item.headSequence");
    expect(app).toContain("recentDurableEventCount");
  });
});
