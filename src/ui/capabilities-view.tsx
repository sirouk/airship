import { useEffect, useState } from "preact/hooks";
import type { ExecutionCapability, ExecutionRuntimeId } from "../execution/runtime-registry";
import { Icon } from "./icons";
import { Seal, type SealState } from "./seal";
import "./capabilities-view.css";

export type CapabilitiesViewProps = Readonly<{
  inspect(): Promise<readonly ExecutionCapability[]>;
  onCommand(command: string): void;
  onOpenSkills(): void;
}>;

export function CapabilitiesView({ inspect, onCommand, onOpenSkills }: CapabilitiesViewProps) {
  const [runtimes, setRuntimes] = useState<readonly ExecutionCapability[]>([]);
  const [status, setStatus] = useState("Inspecting this browser…");
  const [error, setError] = useState<string>();

  async function refresh(): Promise<void> {
    setError(undefined);
    setStatus("Inspecting this browser…");
    try {
      const next = await inspect();
      setRuntimes(next);
      setStatus(`${String(next.filter((runtime) => runtime.state === "ready").length)} ready · ${String(next.filter((runtime) => runtime.state === "installable").length)} available to activate`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runtime inspection failed safely.");
      setStatus("Runtime state unavailable");
    }
  }

  useEffect(() => { void refresh(); }, []);

  return (
    <section class="work-view capabilities-view" aria-labelledby="capabilities-title">
      <header class="page-heading capabilities-heading">
        <div><span class="eyebrow">Browser-owned execution</span><h1 id="capabilities-title">Capabilities</h1><p>Know exactly what this device can run, what must be activated, and what remains unavailable before asking the agent to act.</p></div>
        <button type="button" onClick={() => void refresh()}><Icon name="terminal" size={17} /> Refresh</button>
      </header>

      <div class="capability-summary" role="status">
        <Seal state={error ? "failed" : runtimes.length ? "verified" : "checking"} acting={!error && !runtimes.length} label={status} detail="Capability state is derived from the active in-page runtime registry." />
        <span>Execution still follows the active Ask First, Auto Approve, or Full Access policy.</span>
      </div>
      {error ? <div class="capability-error" role="alert"><Icon name="warning" />{error}</div> : null}

      <div class="capability-grid" aria-label="Browser execution runtimes">
        {runtimes.map((runtime) => <RuntimeCard key={runtime.id} runtime={runtime} onCommand={onCommand} />)}
      </div>

      <section class="capability-extension panel">
        <div><span class="eyebrow">Agent layer</span><h2>Tools and Skills</h2><p>Runtime availability is separate from the tool schemas and profile/global Skills that teach the agent when to use it.</p></div>
        <div><button type="button" onClick={() => onCommand("/help ")}><Icon name="terminal" /> Browse slash tools</button><button type="button" onClick={onOpenSkills}><Icon name="skills" /> Manage Skills</button></div>
      </section>
    </section>
  );
}

function RuntimeCard({ runtime, onCommand }: Readonly<{ runtime: ExecutionCapability; onCommand(command: string): void }>) {
  const action = runtimeAction(runtime);
  return <article class={`capability-runtime ${runtime.state}`}>
    <header><span class="capability-runtime__icon"><Icon name={runtime.id === "node-webcontainer" ? "terminal" : "model"} /></span><div><h2>{runtime.label}</h2><small>{runtime.languages.join(" · ")}</small></div><Seal state={runtimeSeal(runtime.state)} label={runtimeStateLabel(runtime.state)} detail={runtime.detail} size={15} compact /></header>
    <p>{runtime.detail}</p>
    <dl><div><dt>Isolation</dt><dd>{humanize(runtime.isolation)}</dd></div><div><dt>Persistence</dt><dd>{humanize(runtime.persistence)}</dd></div></dl>
    {action ? <button class="primary" type="button" onClick={() => onCommand(action.command)}>{action.label}<span aria-hidden="true">→</span></button> : <span class="capability-runtime__boundary">No activation path is advertised by this release.</span>}
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

function runtimeSeal(state: ExecutionCapability["state"]): SealState {
  if (state === "ready") return "verified";
  if (state === "activating") return "checking";
  if (state === "failed") return "failed";
  if (state === "installable") return "asserted";
  return "none";
}

function runtimeStateLabel(state: ExecutionCapability["state"]): string {
  if (state === "ready") return "Ready";
  if (state === "installable") return "Available";
  if (state === "activating") return "Activating";
  if (state === "failed") return "Activation failed";
  return "Unavailable";
}

function humanize(value: string): string { return value.replaceAll("-", " "); }
