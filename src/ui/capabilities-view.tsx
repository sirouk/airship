import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BrowserCapabilityObservation, BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";
import type { ExecutionCapability, ExecutionRuntimeId } from "../execution/runtime-registry";
import { Icon } from "./icons";
import { Seal, sealStateForCapabilitySummary, type SealState } from "./seal";
import "./capabilities-view.css";

export type CapabilitiesViewProps = Readonly<{
  inspect(): Promise<readonly ExecutionCapability[]>;
  inspectBrowser(): Promise<BrowserRuntimeCapabilityReport>;
  onCommand(command: string): void;
  onOpenSkills(): void;
}>;

export function CapabilitiesView({ inspect, inspectBrowser, onCommand, onOpenSkills }: CapabilitiesViewProps) {
  const [runtimes, setRuntimes] = useState<readonly ExecutionCapability[]>([]);
  const [browser, setBrowser] = useState<BrowserRuntimeCapabilityReport>();
  const [status, setStatus] = useState("Inspecting this browser…");
  const [error, setError] = useState<string>();

  async function refresh(): Promise<void> {
    setError(undefined);
    setStatus("Inspecting this browser…");
    try {
      const [next, report] = await Promise.all([inspect(), inspectBrowser()]);
      setRuntimes(next);
      setBrowser(report);
      setStatus(`${next.filter((runtime) => runtime.state === "ready").length}/${next.length} runtimes ready · probe current`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime inspection failed safely.");
      setStatus("Runtime state unavailable");
    }
  }

  useEffect(() => { void refresh(); }, []);

  return (
    <section class="work-view capabilities-view" aria-labelledby="capabilities-title">
      <header class="page-heading capabilities-heading">
        <div><span class="eyebrow">Browser-owned execution</span><h1 id="capabilities-title">Capabilities</h1><p>No inference provider is required for local activation.</p></div>
        <button type="button" onClick={() => void refresh()}><Icon name="terminal" size={17} /> Refresh</button>
      </header>

      <div class="capability-summary" role="status">
        <Seal state={sealStateForCapabilitySummary(runtimes, Boolean(error))} acting={!error && !runtimes.length} label={status} detail="Live in-page runtime state." />
        <span>Every effect still follows the active approval policy.</span>
      </div>
      {error ? <div class="capability-error" role="alert"><Icon name="warning" />{error}</div> : null}

      {browser ? <BrowserCapabilityPanel report={browser} /> : null}

      <div class="capability-section-heading"><span class="eyebrow">Executable now or on activation</span><h2>Language runtimes</h2></div>
      <div class="capability-grid" aria-label="Browser execution runtimes">
        {runtimes.map((runtime) => <RuntimeCard key={runtime.id} runtime={runtime} onCommand={onCommand} />)}
      </div>

      <section class="capability-extension panel">
        <div><span class="eyebrow">Agent layer</span><h2>Tools and Skills</h2><p>Runtime availability is separate from tool schemas and Skills. Local slash commands remain usable while inference is disconnected.</p></div>
        <div><button type="button" onClick={() => onCommand("/help ")}><Icon name="terminal" /> Browse slash tools</button><button type="button" onClick={onOpenSkills}><Icon name="skills" /> Manage Skills</button></div>
      </section>
    </section>
  );
}

function BrowserCapabilityPanel({ report }: Readonly<{ report: BrowserRuntimeCapabilityReport }>) {
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
  return <section class="capability-device" aria-labelledby="device-capability-title">
    <header>
      <div><span class="eyebrow">Live page-memory probe</span><h2 id="device-capability-title">Device acceleration</h2><p>Probes select preferences; each workload reports its active backend.</p></div>
      <Seal state="asserted" label={`${humanize(report.scheduling.class)} schedule`} detail={report.scheduling.reasons.join(" · ")} compact />
    </header>

    <dl class="capability-signal-strip" aria-label="Adaptive scheduling signals">
      {signals.map(([label, value]) => <div><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>

    <div class="capability-device-grid">
      <DeviceCard title="WebGPU" observation={report.webgpu} detail={report.webgpu.state === "available"
        ? `${report.webgpu.features.length ? `${report.webgpu.features.length} optional features` : "Core adapter"} · ${report.webgpu.powerPreference} preference`
        : undefined}>
        {report.webgpu.features.length ? <div class="capability-tags" aria-label="Observed WebGPU features">{report.webgpu.features.slice(0, 8).map((feature) => <span>{feature}</span>)}</div> : null}
        {Object.keys(report.webgpu.limits).length || Object.keys(report.webgpu.adapterInfo).length ? <details><summary>Adapter facts</summary><dl>{Object.entries({ ...report.webgpu.adapterInfo, ...report.webgpu.limits }).map(([name, value]) => <div><dt>{humanize(name)}</dt><dd>{String(value)}</dd></div>)}</dl></details> : null}
      </DeviceCard>
      <DeviceCard title="WebNN" observation={report.webnn} detail="Context creation probe" />
      <DeviceCard title="OPFS" observation={report.opfs} detail={report.opfs.syncAccessHandle === "api-exposed" ? "Root + sync interface observed" : "Root availability only"} />
      <DeviceCard title="WebAssembly" observation={report.wasm} detail={wasmFeatures.length ? `${wasmFeatures.length} advanced features` : "Portable baseline"}>
        {wasmFeatures.length ? <div class="capability-tags" aria-label="Validated WebAssembly features">{wasmFeatures.map((feature) => <span>{feature}</span>)}</div> : null}
      </DeviceCard>
    </div>

    <div class="capability-policy-row">
      <div><span class="eyebrow">Adaptive policy</span><strong>{report.scheduling.maxWorkerConcurrency} workers · {report.scheduling.preferredSemanticBackend} preference · {report.scheduling.preferredWasmTier} WASM</strong><small>{report.scheduling.embeddingBatchSize} vector batch · {report.scheduling.yieldEveryMs} ms cooperative yield · {humanize(report.scheduling.heavyPackLoading)}</small></div>
      <details><summary>Browser primitives</summary><ul>{primitives.map(([label, observation]) => <li><span>{label}</span><strong>{probePresentation(observation)[1]}</strong></li>)}</ul><p>{report.signals.thermal.detail}</p></details>
    </div>
  </section>;
}

function DeviceCard({ title, observation, detail, children }: Readonly<{
  title: string;
  observation: BrowserCapabilityObservation;
  detail?: string;
  children?: ComponentChildren;
}>) {
  const [state, label] = probePresentation(observation);
  return <article class={`capability-device-card ${observation.state}`}>
    <header><div><h3>{title}</h3>{detail ? <small>{detail}</small> : null}</div><Seal state={state} label={label} detail={observation.detail} compact /></header>
    {children}
    <p>{observation.detail}</p>
  </article>;
}

function connectionLabel(report: BrowserRuntimeCapabilityReport): string {
  if (report.signals.online === false) return "Offline";
  const connection = report.signals.connection;
  if (connection.state !== "available") return report.signals.online === true ? "Online · unreported" : "Not reported";
  return `${connection.effectiveType ?? "Online"}${connection.saveData ? " · data saver" : ""}`;
}

function probePresentation(observation: BrowserCapabilityObservation): readonly [SealState, string] {
  if (observation.state === "failed") return ["failed", "Probe failed"];
  if (observation.evidence === "probe-passed") return ["verified", "Probe passed"];
  if (observation.evidence === "api-exposed") return ["asserted", "API observed"];
  return ["none", "Unavailable"];
}

function RuntimeCard({ runtime, onCommand }: Readonly<{ runtime: ExecutionCapability; onCommand(command: string): void }>) {
  const action = runtimeAction(runtime);
  const [state, label] = runtimePresentation(runtime.state);
  return <article class={`capability-runtime ${runtime.state}`}>
    <header><span class="capability-runtime__icon"><Icon name={runtime.id === "node-webcontainer" ? "terminal" : "model"} /></span><div><h2>{runtime.label}</h2><small>{runtime.languages.join(" · ")}</small></div><Seal state={state} label={label} detail={runtime.detail} size={15} compact /></header>
    {action ? <button class="primary" type="button" onClick={() => onCommand(action.command)}>{action.label}<span aria-hidden="true">→</span></button> : <span class="capability-runtime__boundary">No activation path is advertised by this release.</span>}
    <details class="capability-runtime__details">
      <summary>Technical boundary</summary>
      <p>{runtime.detail}</p>
      <dl><div><dt>Isolation</dt><dd>{humanize(runtime.isolation)}</dd></div><div><dt>Persistence</dt><dd>{humanize(runtime.persistence)}</dd></div></dl>
    </details>
  </article>;
}

function runtimeAction(runtime: ExecutionCapability): Readonly<{ label: string; command: string }> | undefined {
  if (runtime.state === "unavailable" || runtime.state === "activating") return undefined;
  if (runtime.state === "installable" || runtime.state === "failed") {
    return { label: runtime.state === "failed" ? "Review and retry in Chat" : "Activate in Chat", command: `/install-execution-runtime ${runtime.id}` };
  }
  const probes: Partial<Record<ExecutionRuntimeId, string>> = {
    "javascript-worker": "/execute-code --json '{\"runtime\":\"javascript-worker\",\"code\":\"return 6 * 7\"}'",
    "wasi-preview1": "/inspect-execution-runtimes",
    "python-pyodide": "/execute-code --json '{\"runtime\":\"python-pyodide\",\"code\":\"print(6 * 7)\"}'",
    "node-webcontainer": "/execute-node-project --json '{\"workspaceRoot\":\"/workspace\",\"command\":\"node\",\"args\":[\"-e\",\"console.log(6 * 7)\"]}'",
  };
  return { label: runtime.id === "wasi-preview1" ? "Inspect runtime" : "Run a probe", command: probes[runtime.id] ?? "/inspect-execution-runtimes" };
}

function runtimePresentation(state: ExecutionCapability["state"]): readonly [SealState, string] {
  if (state === "ready") return ["verified", "Ready"];
  if (state === "installable") return ["asserted", "Available"];
  if (state === "activating") return ["checking", "Activating"];
  if (state === "failed") return ["failed", "Activation failed"];
  return ["none", "Unavailable"];
}

function humanize(value: string): string { return value.replaceAll("-", " "); }
