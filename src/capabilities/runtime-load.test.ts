import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
    expect(measuredBytesLabel(measured.memory)).toBe("40 MB");
    expect(measuredBytesLabel(measured.storage)).toBe("1.5 KB");

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
const rail = await readFile(new URL("../ui/rail.tsx", import.meta.url), "utf8");
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
    // Peak survives the runs that set it, and the boundary travels with the
    // reading: a bare number in a rail is exactly what a reader mistakes for a
    // CPU meter, so the accessible name says what was and was not counted.
    const spoken = runtimeLoadIndicatorLabel(load.snapshot()).spoken;
    expect(spoken).toContain("Peak 2 this page");
    expect(spoken).toContain(RUNTIME_LOAD_BOUNDARY);
  });

  it("uses the singular only for a single run", () => {
    const load = monitor();
    load.begin("airship-sh");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).spoken).toContain("1 execution run in flight");
    load.begin("airship-sh");
    expect(runtimeLoadIndicatorLabel(load.snapshot()).spoken).toContain("2 execution runs in flight");
  });

  it("rides the rail, so it is in the DOM on every route rather than on #capabilities alone", () => {
    // The finding this closes was that the only live reading lived on the route
    // a reader has to navigate to. The rail is the one band every route
    // renders, and the shell renders it unconditionally — no `view ===` guard,
    // no route list — which is what makes the indicator global rather than a
    // second copy of the Capabilities panel.
    expect(rail).toContain("<RuntimeLoadIndicator />");
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

  it("renders counts, not a meter, and reads its words from the monitor", () => {
    expect(indicator).toContain("runtimeLoadIndicatorLabel(report)");
    expect(indicator).toContain("RUNTIME_LOAD_BOUNDARY");
    // The invariant from browser-runtime: a scheduling ceiling is not a count
    // of running workers, and this chip is the surface most tempted to blur it.
    expect(indicator).not.toContain("maxWorkerConcurrency");
    expect(indicator).not.toContain("%");
  });
});
