import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { semanticWasmThreadCount, type BrowserCapabilityObservation, type BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";
import type { ExtensionBridgeObservation } from "../capabilities/extension-bridge";
import {
  RUNTIME_LOAD_BOUNDARY,
  getRuntimeLoadMonitor,
  runtimeLoadFigures,
  runtimeLoadLaneSummary,
  type ExecutionCapability,
  type ExecutionRuntimeId,
  type RuntimeLoadMonitor,
  type RuntimeLoadReport,
} from "../execution/runtime-registry";
import { Icon } from "./icons";
import { RouteHeader } from "./route-header";
import { StatusMark, type StatusMarkState } from "./status-mark";
import "./capabilities-view.css";

export type CapabilitiesViewProps = Readonly<{
  inspect(): Promise<readonly ExecutionCapability[]>;
  inspectBrowser(): Promise<BrowserRuntimeCapabilityReport>;
  inspectExtension(): Promise<ExtensionBridgeObservation>;
  /**
   * The registry's publish side. `inspectBrowser` is a pull, and a pull cannot
   * hear the registry re-probe when a device changes — the route kept a private
   * copy that silently diverged from the generation the agent reads. Subscribing
   * makes this surface an observer of the canonical report rather than the owner
   * of a snapshot. Optional so a harness can drive the panel without a registry.
   */
  subscribeBrowser?(listener: (report: BrowserRuntimeCapabilityReport) => void): () => void;
  onCommand(command: string): void;
  onOpenSkills(): void;
  /** Injectable for tests; the page monitor is a singleton like the capability registry. */
  loadMonitor?: RuntimeLoadMonitor;
}>;

/**
 * Lives here rather than in `status-mark.tsx` because this surface is its only
 * consumer and `status-mark.tsx` is reachable from the entry chunk: a mapping only the
 * Capabilities route reads should not be paid for at first paint.
 */
export function statusStateForCapabilitySummary(
  runtimes: readonly Readonly<{ state: string }>[],
  failed = false,
): StatusMarkState {
  if (failed) return "failed";
  if (!runtimes.length) return "checking";
  const ready = runtimes.filter(({ state }) => state === "ready").length;
  if (!ready) return runtimes.some(({ state }) => state === "failed") ? "failed" : "none";
  return ready === runtimes.length ? "verified" : "asserted";
}

export function CapabilitiesView({ inspect, inspectBrowser, inspectExtension, subscribeBrowser, onCommand, onOpenSkills, loadMonitor }: CapabilitiesViewProps) {
  const [runtimes, setRuntimes] = useState<readonly ExecutionCapability[]>([]);
  const [browser, setBrowser] = useState<BrowserRuntimeCapabilityReport>();
  const [extension, setExtension] = useState<ExtensionBridgeObservation>();
  const [load, setLoad] = useState<RuntimeLoadReport>();
  const [status, setStatus] = useState("Inspecting this browser…");
  const [error, setError] = useState<string>();

  async function refresh(): Promise<void> {
    setError(undefined);
    setStatus("Inspecting this browser…");
    try {
      const [next, report, extensionObservation] = await Promise.all([inspect(), inspectBrowser(), inspectExtension()]);
      setRuntimes(next);
      setBrowser(report);
      setExtension(extensionObservation);
      // The count is what this line owns. When the browser report was observed
      // is the report's own fact, read at render from whichever generation is
      // on screen — a status string baked at probe time could only ever say
      // "current", which is exactly the claim that stopped being true the
      // moment the registry re-probed behind this route's back.
      setStatus(`${next.filter((runtime) => runtime.state === "ready").length}/${next.length} runtimes ready`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime inspection failed safely.");
      setStatus("Runtime state unavailable");
    }
  }

  useEffect(() => { void refresh(); }, []);

  // The registry publishes on its own lifecycle triggers (pageshow, online,
  // visibility, network and battery change), and `subscribe` either replays the
  // cached report immediately or starts a probe. Nothing here re-pulls.
  useEffect(() => {
    if (!subscribeBrowser) return;
    return subscribeBrowser(setBrowser);
  }, [subscribeBrowser]);

  // Load is a live subscription rather than part of `refresh`: it changes when
  // work starts and stops, not when the capability probe runs. The measured
  // values are asked for once, because measuring page memory is itself work.
  useEffect(() => {
    const monitor = loadMonitor ?? getRuntimeLoadMonitor();
    const unsubscribe = monitor.subscribe(setLoad);
    void monitor.measure().catch(() => undefined);
    return unsubscribe;
  }, [loadMonitor]);

  return (
    <section class="work-view capabilities-view" aria-labelledby="capabilities-title">
      <RouteHeader
        routeId="capabilities"
        density="tool"
        title="Capabilities"
        headingId="capabilities-title"
        eyebrow="Browser-owned execution"
        description="No inference provider is required for local activation."
        actions={<button class="capabilities-refresh" type="button" onClick={() => void refresh()}><Icon name="terminal" size={17} /> Refresh</button>}
      />

      <div class="capability-summary" role="status">
        <StatusMark state={statusStateForCapabilitySummary(runtimes, Boolean(error))} acting={!error && !runtimes.length} label={browser && !error ? `${status} · observed ${formatObservedAt(browser.observedAt)}` : status} detail="Live in-page runtime state." />
        <span>Every effect still follows the active approval policy.</span>
      </div>
      {error ? <div class="capability-error" role="alert"><Icon name="warning" />{error}</div> : null}

      {load ? <RuntimeLoadPanel report={load} /> : null}

      {/* The re-probe a device card offers is this route's own Refresh verb,
          not a second one: a card that granted permission needs the same probe
          re-run, and two spellings of one action is how a surface ends up with
          two answers on screen. */}
      {browser ? <BrowserCapabilityPanel report={browser} onReprobe={() => void refresh()} /> : null}

      {extension ? <section class="capability-extension-surface" aria-labelledby="extension-capability-title">
        <div class="capability-section-heading"><span class="eyebrow">Extension-enhanced device</span><h2 id="extension-capability-title">Airship Companion</h2></div>
        <DeviceCard
          title={extension.extensionVersion ? `Airship Companion ${extension.extensionVersion}` : "Airship Companion"}
          observation={extension}
          detail={extension.state === "available" ? "Live bridge handshake · this page" : undefined}
        >
          {extension.state === "available" ? <dl class="capability-signal-strip">
            <div><dt>Provider relay</dt><dd>{extension.providers.length ? extension.providers.join(", ") : "No provider routes"}</dd></div>
            <div><dt>Ciphertext cache</dt><dd>{extension.companion?.storage.state === "available" ? extension.companion.storage.enabled ? "Enabled" : "Available" : "Unavailable"}</dd></div>
            <div><dt>Background compute</dt><dd>{extension.companion?.compute.state === "available" ? extension.companion.compute.operations.join(", ") : "Unavailable"}</dd></div>
          </dl> : <p>Install or enable the Airship Companion from <code>/extension/</code>, then refresh this probe.</p>}
        </DeviceCard>
      </section> : null}

      <div class="capability-section-heading"><span class="eyebrow">Executable now or on activation</span><h2>Language runtimes</h2></div>
      <div class="capability-grid" role="group" aria-label="Browser execution runtimes">
        {runtimes.map((runtime) => <RuntimeCard key={runtime.id} runtime={runtime} onCommand={onCommand} />)}
      </div>

      <section class="capability-extension panel">
        <div><span class="eyebrow">Agent layer</span><h2>Tools and Skills</h2><p>Runtime availability is separate from tool schemas and Skills. Local slash commands remain usable while inference is disconnected.</p></div>
        <div><button type="button" onClick={() => onCommand("/help ")}><Icon name="terminal" /> Browse slash tools</button><button type="button" onClick={onOpenSkills}><Icon name="skills" /> Manage Skills</button></div>
      </section>
    </section>
  );
}

/**
 * Live utilisation, kept to what this page can count or measure.
 *
 * Every figure here is either a run Airship started (a count it owns) or a
 * value a browser API returned. Nothing derived from `AdaptiveSchedulingPolicy`
 * appears: those are ceilings, and `maxWorkerConcurrency` in particular must
 * never be rendered as a number of running workers.
 */
function RuntimeLoadPanel({ report }: Readonly<{ report: RuntimeLoadReport }>) {
  return <section class="capability-load" aria-label="Live in-page load">
    <dl class="capability-signal-strip">
      {runtimeLoadFigures(report).map(([label, value]) => <div><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <p>{runtimeLoadLaneSummary(report)}</p>
    <p>{RUNTIME_LOAD_BOUNDARY}</p>
  </section>;
}

function BrowserCapabilityPanel({ report, onReprobe }: Readonly<{ report: BrowserRuntimeCapabilityReport; onReprobe(): void }>) {
  const primitives = [
    ["Service Worker", report.serviceWorker],
    ["Cache Storage", report.cacheStorage],
    ["WebCodecs", report.webCodecs],
    ["WebTransport", report.webTransport],
  ] as const;
  const signals = [
    ["CPU", report.signals.logicalProcessors ? `${report.signals.logicalProcessors} logical cores` : "Not reported"],
    ["Memory", report.signals.deviceMemoryGiB ? `${report.signals.deviceMemoryGiB} GiB estimate` : "Not reported"],
    ["Isolation", report.crossOriginIsolated ? "Cross-origin isolated" : "Not isolated"],
    ["Network", connectionLabel(report)],
  ] as const;
  const wasmFeatures = Object.entries(report.wasm.features).filter(([, supported]) => supported).map(([feature]) => feature);
  const ortThreads = semanticWasmThreadCount(report.scheduling);
  return <section class="capability-device" aria-labelledby="device-capability-title">
    <header>
      <div><span class="eyebrow">Live page-memory probe</span><h2 id="device-capability-title">Device acceleration</h2><p>Probes select preferences; each workload reports its active backend.</p></div>
      <StatusMark state="asserted" label={`${humanize(report.scheduling.class)} schedule`} detail={report.scheduling.reasons.join(" · ")} compact />
    </header>

    <dl class="capability-signal-strip" aria-label="Adaptive scheduling signals">
      {signals.map(([label, value]) => <div><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>

    <div class="capability-device-grid">
      <DeviceCard title="WebGPU" observation={report.webgpu} onReprobe={onReprobe} detail={report.webgpu.state === "available"
        ? `${report.webgpu.features.length ? `${report.webgpu.features.length} optional features` : "Core adapter"} · ${report.webgpu.powerPreference} preference`
        : undefined}>
        {report.webgpu.features.length ? <div class="capability-tags" role="group" aria-label="Observed WebGPU features">{report.webgpu.features.slice(0, 8).map((feature) => <span>{feature}</span>)}</div> : null}
        {Object.keys(report.webgpu.limits).length || Object.keys(report.webgpu.adapterInfo).length ? <details><summary>Adapter facts</summary><dl>{Object.entries({ ...report.webgpu.adapterInfo, ...report.webgpu.limits }).map(([name, value]) => <div><dt>{humanize(name)}</dt><dd>{String(value)}</dd></div>)}</dl></details> : null}
      </DeviceCard>
      <DeviceCard title="WebNN" observation={report.webnn} onReprobe={onReprobe} detail="Context creation probe" />
      <DeviceCard title="OPFS" observation={report.opfs} onReprobe={onReprobe} detail={report.opfs.syncAccessHandle === "api-exposed" ? "Root + sync interface observed" : "Root availability only"} />
      <DeviceCard title="WebAssembly" observation={report.wasm} onReprobe={onReprobe} detail={wasmFeatures.length ? `${wasmFeatures.length} advanced features` : "Portable baseline"}>
        {wasmFeatures.length ? <div class="capability-tags" role="group" aria-label="Validated WebAssembly features">{wasmFeatures.map((feature) => <span>{feature}</span>)}</div> : null}
      </DeviceCard>
    </div>

    <div class="capability-policy-row">
      <div>
        <span class="eyebrow">Adaptive policy</span>
        {/* Each number names the thing it actually sizes: indexing lanes reach
            concurrentMap. The power preference is split on "default" because
            that value is the probe expressing NO preference — browser-runtime's
            probeWebGpu calls requestAdapter({}) rather than passing the word
            "default", which GPUPowerPreference does not accept — so claiming it
            was "requested" would invent a request that never happened. The ONNX
            Runtime thread count stays in the conditional mood because this
            panel cannot observe whether the semantic pack has ever been loaded,
            and naming a pool that may not exist would be a claim the page has
            not earned. */}
        <strong>{report.scheduling.maxIndexingConcurrency} indexing lanes · {report.scheduling.preferredSemanticBackend} semantic backend · {report.scheduling.embeddingBatchSize} vector batch</strong>
        <small>{report.scheduling.yieldEveryMs} ms cooperative yield · {report.scheduling.powerPreference === "default"
          ? "no GPU power preference requested — the adapter probe asked for any adapter"
          : `${humanize(report.scheduling.powerPreference)} GPU power preference requested by the adapter probe`}</small>
        <small class="capability-policy-inert">{report.scheduling.preferredWasmTier} WASM tier would request {ortThreads} ONNX Runtime thread{ortThreads === 1 ? "" : "s"} the next time the semantic pack loads. This panel does not observe whether that pack is loaded now.</small>
        {/* These two are derived postures, not activations. Naming them that
            way keeps the panel from implying a download or storage adapter
            promised something a workload has not reported. */}
        <small class="capability-policy-inert">{humanize(report.scheduling.heavyPackLoading)} heavy-pack posture · {humanize(report.scheduling.preferredWorkspaceStorage)} workspace-storage preference — observations, not activations.</small>
      </div>
      {/* The two probes that actually report a refusal in practice are in this
          list, not on the cards above: `refusalEvidence` maps NotAllowedError
          and SecurityError, and the paths that raise them are the service
          worker and Cache Storage probes. So the list renders the same control
          the cards do — a refusal the reader can clear is worth nothing behind
          a label — and the disclosure opens itself when one is present, because
          an action nobody can see is the collapsed twin of no action at all. */}
      <details open={primitives.some(([, observation]) => probeNeedsAction(observation))}>
        <summary>Browser primitives</summary>
        <ul>{primitives.map(([label, observation]) => {
          const action = probeAction(observation, onReprobe);
          return <li>
            <span>{label}</span>
            <strong>{probePresentation(observation)[1]}</strong>
            <small>{observation.detail}</small>
            {action ? <button class="capability-probe-action" type="button" onClick={action.onSelect}>{action.label}</button> : null}
          </li>;
        })}</ul>
        <p>{report.signals.thermal.detail}</p>
      </details>
    </div>
  </section>;
}

function DeviceCard({ title, observation, detail, onReprobe, children }: Readonly<{
  title: string;
  observation: BrowserCapabilityObservation;
  detail?: string;
  /** Absent for a card a harness drives without a registry behind it. */
  onReprobe?: () => void;
  children?: ComponentChildren;
}>) {
  const [state, label] = probePresentation(observation);
  const action = onReprobe ? probeAction(observation, onReprobe) : undefined;
  return <article class={`capability-device-card ${observation.state}`}>
    <header><div><h3>{title}</h3>{detail ? <small>{detail}</small> : null}</div><StatusMark state={state} label={label} detail={observation.detail} compact /></header>
    {children}
    <p>{observation.detail}</p>
    {action ? <button class="capability-probe-action" type="button" onClick={action.onSelect}>{action.label}</button> : null}
  </article>;
}

/**
 * When the rendered report was observed. Kept local so importing a formatter
 * across a route boundary does not merge chunks that the release gate keeps
 * separate.
 */
export function formatObservedAt(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "an unreadable time";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function connectionLabel(report: BrowserRuntimeCapabilityReport): string {
  if (report.signals.online === false) return "Offline";
  const connection = report.signals.connection;
  if (connection.state !== "available") return report.signals.online === true ? "Online · unreported" : "Not reported";
  return `${connection.effectiveType ?? "Online"}${connection.saveData ? " · data saver" : ""}`;
}

/**
 * Cause is read before strength, because a refusal is not a fault.
 *
 * `state` grades the outcome and `evidence` grades the observation, and neither
 * on its own can tell a browser that withheld permission from a probe that
 * broke — which is how four different worlds arrived on screen as the single
 * word "Unavailable" with nothing the reader could do next. The two refusal
 * evidences are therefore checked first: both arrive carrying a `failed` or
 * `unavailable` state that would otherwise swallow them.
 */
export function probePresentation(observation: BrowserCapabilityObservation): readonly [StatusMarkState, string] {
  if (observation.evidence === "permission-needed") return ["attention", "Permission needed"];
  if (observation.evidence === "disabled") return ["attention", "Switched off here"];
  if (observation.state === "failed") return ["failed", "Probe failed"];
  if (observation.evidence === "probe-passed") return ["verified", "Probe passed"];
  if (observation.evidence === "api-exposed") return ["asserted", "API observed"];
  return ["none", "Unavailable"];
}

/**
 * The one control an observation may offer, and only where acting can change
 * the answer.
 *
 * A probe that broke, a feature this engine does not ship, and a capability
 * that simply passed all get no button: an affordance that cannot work is worse
 * than none, and four buttons on four cards that each re-run the same probe is
 * the "Refresh" verb duplicated four times. Only `permission-needed` and
 * `disabled` name something the reader owns, so only they earn a control.
 */
/**
 * Whether acting could change this observation's answer.
 *
 * Split out of `probeAction` because a container also has to know: the
 * browser-primitives disclosure opens itself when one of its rows carries a
 * refusal, and asking that question by constructing four throwaway actions
 * would make the predicate depend on a re-probe callback it never calls.
 */
export function probeNeedsAction(observation: BrowserCapabilityObservation): boolean {
  return observation.evidence === "permission-needed" || observation.evidence === "disabled";
}

export function probeAction(
  observation: BrowserCapabilityObservation,
  onReprobe: () => void,
): Readonly<{ label: string; onSelect(): void }> | undefined {
  if (observation.evidence === "permission-needed") {
    return Object.freeze({ label: "Grant access, then re-probe", onSelect: onReprobe });
  }
  if (observation.evidence === "disabled") {
    return Object.freeze({ label: "Enable it, then re-probe", onSelect: onReprobe });
  }
  return undefined;
}

function RuntimeCard({ runtime, onCommand }: Readonly<{ runtime: ExecutionCapability; onCommand(command: string): void }>) {
  const action = runtimeAction(runtime);
  const boundary = action ? undefined : runtimeBoundary(runtime);
  const [state, label] = runtimePresentation(runtime.state);
  return <article class={`capability-runtime ${runtime.state}`}>
    <header><span class="capability-runtime__icon"><Icon name={runtimeGlyph(runtime)} /></span><div><h2>{runtime.label}</h2><small>{runtime.languages.join(" · ")}</small></div><StatusMark state={state} label={label} detail={runtime.detail} size={15} compact /></header>
    {action
      ? <button class="primary" type="button" onClick={() => onCommand(action.command)}>{action.label}<span aria-hidden="true">→</span></button>
      : <p class="capability-runtime__boundary">{boundary!.condition}{boundary!.remedy ? <span>{boundary!.remedy}</span> : null}</p>}
    <details class="capability-runtime__details">
      <summary>Technical boundary</summary>
      <p>{runtime.detail}</p>
      <dl><div><dt>Isolation</dt><dd>{humanize(runtime.isolation)}</dd></div><div><dt>Persistence</dt><dd>{humanize(runtime.persistence)}</dd></div></dl>
    </details>
  </article>;
}

/**
 * Follows the capability record rather than an id: `shell` already names which
 * runtimes present a command line, so a new shell pack gets the terminal mark
 * without this file learning its id. Card-by-id is what put the model glyph on
 * airship-sh, the one shell that is always ready.
 */
export function runtimeGlyph(runtime: Pick<ExecutionCapability, "shell">): "terminal" | "model" {
  return runtime.shell === "none" ? "model" : "terminal";
}

export function runtimeAction(runtime: ExecutionCapability): Readonly<{ label: string; command: string }> | undefined {
  if (runtime.state === "unavailable" || runtime.state === "activating") return undefined;
  if (runtime.state === "installable" || runtime.state === "failed") {
    /*
     * The ellipsis is the whole of the claim.
     *
     * "Activate in Chat →" activated nothing: it opened a conversation with
     * `/install-execution-runtime` typed into the composer and left it there,
     * and the page it came from still read "3/6 runtimes ready · observed …"
     * word for word afterwards. Auto-sending an install is a side effect nobody
     * consented to, so the preparation is right and the label was wrong — an
     * ellipsis is the shipped convention for "this opens the thing that asks".
     */
    return { label: runtime.state === "failed" ? "Review and retry in Chat…" : "Activate in Chat…", command: `/install-execution-runtime ${runtime.id}` };
  }
  // "Run a probe" must run something on *this* runtime. A runtime with no entry
  // here can only be inspected, so it says so instead of offering a probe that
  // would have listed every runtime and exercised none.
  const probes: Partial<Record<ExecutionRuntimeId, string>> = {
    "javascript-worker": "/execute-code --json '{\"runtime\":\"javascript-worker\",\"code\":\"return 6 * 7\"}'",
    "python-pyodide": "/execute-code --json '{\"runtime\":\"python-pyodide\",\"code\":\"print(6 * 7)\"}'",
    "node-webcontainer": "/execute-node-project --json '{\"workspaceRoot\":\"/workspace\",\"command\":\"node\",\"args\":[\"-e\",\"console.log(6 * 7)\"]}'",
    "airship-sh": "/execute-shell --json '{\"script\":\"echo $((6 * 7))\"}'",
  };
  const probe = probes[runtime.id];
  return probe ? { label: "Run a probe", command: probe } : { label: "Inspect runtime", command: "/inspect-execution-runtimes" };
}

/**
 * What a card says when `runtimeAction` has nothing to offer.
 *
 * "No action available" is not one fact, and three different worlds used to
 * share one sentence. `activating` has no action precisely because the
 * activation is already running — telling that reader the release advertises no
 * path contradicts the "Activating" status mark beside it. A host blocker states a
 * condition the reader can usually clear, and carries its own remedy. Only a
 * runtime this release genuinely never shipped earns the release-level
 * sentence, which is the one claim none of the other two may make.
 */
export function runtimeBoundary(
  runtime: Pick<ExecutionCapability, "state" | "blocker">,
): Readonly<{ condition: string; remedy?: string }> {
  if (runtime.state === "activating") {
    return Object.freeze({
      condition: "Activation is running now.",
      remedy: "This card updates when the runtime reports ready or reports a failure.",
    });
  }
  if (runtime.blocker) return Object.freeze({ condition: runtime.blocker.condition, remedy: runtime.blocker.remedy });
  return Object.freeze({ condition: "No activation path is advertised by this release." });
}

function runtimePresentation(state: ExecutionCapability["state"]): readonly [StatusMarkState, string] {
  if (state === "ready") return ["verified", "Ready"];
  if (state === "installable") return ["asserted", "Available"];
  if (state === "activating") return ["checking", "Activating"];
  if (state === "failed") return ["failed", "Activation failed"];
  return ["none", "Unavailable"];
}

function humanize(value: string): string { return value.replaceAll("-", " "); }
