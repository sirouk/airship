import type { JsonValue, ToolContext, ToolExecutionResult } from "../core/contracts";
import type { BrowserExecutionTier, ExecutionCapability } from "./runtime-registry";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "../tools/registry";

type ExecutionImplementation = typeof import("./execution-engine");

let implementation: Promise<ExecutionImplementation> | undefined;

/**
 * Small second-level broker. Stable schemas can load without the worker-source,
 * WASI and Pyodide implementation; those bytes arrive only when capability
 * inspection or an execution call crosses this boundary.
 */
export async function executeExecutionTool(
  name: string,
  argumentsValue: JsonValue,
  context: ToolContext,
  workspace?: WorkspacePort,
  hostRegistry?: ToolRegistry,
): Promise<ToolExecutionResult> {
  return (await loadImplementation()).executeExecutionTool(name, argumentsValue, context, workspace, hostRegistry);
}

export async function getCurrentBrowserExecutionTier(): Promise<BrowserExecutionTier> {
  return (await loadImplementation()).getCurrentBrowserExecutionTier();
}

/**
 * Inspecting the browser is not a conversation turn.
 *
 * The Capabilities route can mount before profile/session bootstrap completes,
 * so making this read travel through an active profile tool produced a false
 * "runtime is not ready" state on cold deep links. The same deferred runtime
 * singleton remains authoritative; this seam merely reads it without inventing
 * session identity or an unaudited tool call.
 */
export async function inspectBrowserExecutionCapabilities(): Promise<readonly ExecutionCapability[]> {
  return (await loadImplementation()).inspectCurrentBrowserExecutionCapabilities();
}

function loadImplementation(): Promise<ExecutionImplementation> {
  implementation ??= import("./execution-engine");
  return implementation;
}
