import type { JsonValue, ToolContext, ToolExecutionResult } from "../core/contracts";
import type { BrowserExecutionTier } from "./runtime-registry";
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

function loadImplementation(): Promise<ExecutionImplementation> {
  implementation ??= import("./execution-engine");
  return implementation;
}
