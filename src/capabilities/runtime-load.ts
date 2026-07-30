/**
 * Live utilisation, limited to what Airship itself owns and can therefore state.
 *
 * `BrowserCapabilityRegistry` answers what this device *can* do; it is a
 * one-shot capacity probe and its `AdaptiveSchedulingPolicy` numbers are
 * ceilings, never counts — see the invariant on `maxWorkerConcurrency`. This
 * monitor is the other half: it counts the runs this page actually started and
 * has not yet finished, per execution runtime, and it reports nothing else as a
 * number. Browser CPU load is not observable from a page, so it is absent
 * rather than synthesised; memory and storage are reported only where the realm
 * exposes a real measurement, and carry an explicit `not-measurable` state
 * otherwise.
 */

export type RuntimeLoadLane = Readonly<{
  /** Execution runtime id. Kept as a string so this module owes nothing to the execution registry. */
  id: string;
  current: number;
  peak: number;
}>;

export type MeasuredBytes =
  | Readonly<{ state: "measured"; bytes: number; detail: string }>
  | Readonly<{ state: "not-measurable"; detail: string }>;

export type RuntimeLoadReport = Readonly<{
  observedAt: string;
  /** In-flight runs this page started, summed across runtimes. */
  current: number;
  /** High-water mark of `current` since this page loaded. Not persisted. */
  peak: number;
  lanes: readonly RuntimeLoadLane[];
  memory: MeasuredBytes;
  storage: MeasuredBytes;
}>;

export type RuntimeLoadHost = Readonly<{
  /** `performance.measureUserAgentSpecificMemory()`, where the realm has it. */
  measureMemory?: () => Promise<Readonly<{ bytes: number }>>;
  /** `navigator.storage.estimate()`, where the realm has it. */
  estimateStorage?: () => Promise<Readonly<{ usage?: number; quota?: number }>>;
  now(): Date;
}>;

const NOT_MEASURABLE_MEMORY = Object.freeze({
  state: "not-measurable" as const,
  detail: "performance.measureUserAgentSpecificMemory() is not exposed to this page, so no page-memory figure exists to report.",
});

const NOT_MEASURABLE_STORAGE = Object.freeze({
  state: "not-measurable" as const,
  detail: "navigator.storage.estimate() is not exposed to this page, so no origin-usage figure exists to report.",
});

/**
 * Counts in-flight work; measurements are refreshed only when asked.
 *
 * `begin` is called by `ClientExecutionRuntime.execute` around the adapter call
 * itself, so a run that was refused before any adapter ran is never counted as
 * load. The returned finisher is idempotent: a double-call from a retry wrapper
 * must not drive the count below the work that is genuinely still running.
 */
export class RuntimeLoadMonitor {
  private readonly current = new Map<string, number>();
  private readonly peaks = new Map<string, number>();
  private readonly listeners = new Set<(report: RuntimeLoadReport) => void>();
  private total = 0;
  private totalPeak = 0;
  private memory: MeasuredBytes = NOT_MEASURABLE_MEMORY;
  private storage: MeasuredBytes = NOT_MEASURABLE_STORAGE;

  constructor(private readonly host: RuntimeLoadHost = defaultLoadHost()) {}

  begin(id: string): () => void {
    const next = (this.current.get(id) ?? 0) + 1;
    this.current.set(id, next);
    this.peaks.set(id, Math.max(this.peaks.get(id) ?? 0, next));
    this.total += 1;
    this.totalPeak = Math.max(this.totalPeak, this.total);
    this.publish();
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const remaining = (this.current.get(id) ?? 1) - 1;
      if (remaining > 0) this.current.set(id, remaining);
      else this.current.delete(id);
      this.total = Math.max(0, this.total - 1);
      this.publish();
    };
  }

  snapshot(): RuntimeLoadReport {
    // Every runtime that has ever run stays in the report at current 0, so a
    // lane that just went quiet reads as idle rather than disappearing.
    const lanes = [...this.peaks.keys()].sort().map((id) => Object.freeze({
      id,
      current: this.current.get(id) ?? 0,
      peak: this.peaks.get(id) ?? 0,
    }));
    return Object.freeze({
      observedAt: this.host.now().toISOString(),
      current: this.total,
      peak: this.totalPeak,
      lanes: Object.freeze(lanes),
      memory: this.memory,
      storage: this.storage,
    });
  }

  subscribe(listener: (report: RuntimeLoadReport) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /**
   * Refresh the optional measured values. Both are host measurements: a
   * rejection or an absent API leaves the field `not-measurable` rather than
   * falling back to an estimate this page did not observe.
   */
  async measure(): Promise<RuntimeLoadReport> {
    this.memory = await measuredBytes(
      this.host.measureMemory,
      (value) => value.bytes,
      "JavaScript memory this page's own realm reports; it is not a device-wide figure.",
      NOT_MEASURABLE_MEMORY,
    );
    this.storage = await measuredBytes(
      this.host.estimateStorage,
      (value) => value.usage,
      "Origin storage the browser reports Airship using; the browser rounds this figure.",
      NOT_MEASURABLE_STORAGE,
    );
    this.publish();
    return this.snapshot();
  }

  private publish(): void {
    if (!this.listeners.size) return;
    const report = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(report); } catch { /* Presentation observers are non-authoritative. */ }
    }
  }
}

/** The one sentence a surface may print when nothing was measured. */
export function measuredBytesLabel(value: MeasuredBytes): string {
  return value.state === "measured" ? formatBytes(value.bytes) : "Not measurable in this browser";
}

/**
 * The report as text, derived beside the report itself.
 *
 * A surface that formats these numbers on its own is a surface that can drift
 * into claiming more than was counted, and the wording of "not measurable" in
 * particular is a truthfulness guarantee rather than a style choice.
 */
export function runtimeLoadFigures(report: RuntimeLoadReport): readonly (readonly [string, string])[] {
  return Object.freeze([
    Object.freeze(["Running now", `${report.current} execution ${report.current === 1 ? "run" : "runs"}`] as const),
    Object.freeze(["Peak this page", `${report.peak} concurrent`] as const),
    Object.freeze(["Page memory", measuredBytesLabel(report.memory)] as const),
    Object.freeze(["Origin storage", measuredBytesLabel(report.storage)] as const),
  ]);
}

/** Per-runtime lanes, or the fact that nothing has run yet. */
export function runtimeLoadLaneSummary(report: RuntimeLoadReport): string {
  if (!report.lanes.length) return "No execution runtime has been asked to run anything in this page yet.";
  return report.lanes.map((lane) => `${lane.id} · ${lane.current} now · peak ${lane.peak}`).join(" — ");
}

/** The boundary this monitor never crosses, stated wherever it is rendered. */
export const RUNTIME_LOAD_BOUNDARY =
  "Counts the runs this page started and has not yet finished. Browser-wide CPU load is not observable from a page, so it is absent rather than estimated.";

/**
 * The shell's one-line reading of the same report the Capabilities panel
 * expands.
 *
 * Derived here, beside the counts, for the reason the panel's figures are: a
 * surface that composes its own sentence is a surface that can start implying
 * device load it never measured.
 *
 * `reading` and the boundary are deliberately two strings rather than one. The
 * indicator is a live region, so `reading` is re-announced every time a run
 * starts or ends; concatenating the boundary onto it would replay the same
 * caveat on every announcement, which is how a reader learns to talk over the
 * region entirely. The boundary is rendered as a static sibling inside the same
 * region instead — read whenever the region itself is read, never re-announced,
 * because its text never changes.
 */
export function runtimeLoadIndicatorLabel(report: RuntimeLoadReport): Readonly<{ text: string; reading: string }> {
  return Object.freeze({
    text: report.current === 0 ? "Idle" : `${report.current} running`,
    reading: report.current === 0
      ? `No execution run is in flight. Peak ${report.peak} this page.`
      : `${report.current} execution ${report.current === 1 ? "run" : "runs"} in flight. Peak ${report.peak} this page.`,
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Not measurable in this browser";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1)} ${units[unit]}`;
}

let pageMonitor: RuntimeLoadMonitor | undefined;

/** One page-memory monitor, shared by the execution registry and any surface. */
export function getRuntimeLoadMonitor(): RuntimeLoadMonitor {
  pageMonitor ??= new RuntimeLoadMonitor();
  return pageMonitor;
}

async function measuredBytes<T>(
  measure: (() => Promise<T>) | undefined,
  read: (value: T) => number | undefined,
  detail: string,
  absent: MeasuredBytes,
): Promise<MeasuredBytes> {
  if (!measure) return absent;
  try {
    const bytes = read(await measure());
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return absent;
    return Object.freeze({ state: "measured" as const, bytes, detail });
  } catch {
    return absent;
  }
}

function defaultLoadHost(): RuntimeLoadHost {
  const performanceRecord = typeof performance === "undefined"
    ? undefined
    : performance as unknown as Record<string, unknown>;
  // Chromium exposes this only to a cross-origin-isolated page, and it is the
  // only real page-memory reading a browser offers. Everything else on offer
  // (performance.memory) is a heap-size hint, not memory the page used, so it
  // is deliberately not read here.
  const measureMemory = typeof performanceRecord?.measureUserAgentSpecificMemory === "function"
    ? () => (performanceRecord.measureUserAgentSpecificMemory as () => Promise<{ bytes: number }>)()
    : undefined;
  const storage = typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } }).storage;
  return Object.freeze({
    ...(measureMemory ? { measureMemory } : {}),
    ...(typeof storage?.estimate === "function" ? { estimateStorage: () => storage.estimate!() } : {}),
    now: () => new Date(),
  });
}
