import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import {
  getBrowserCapabilityRegistry,
  type BrowserRuntimeCapabilityReport,
} from "../capabilities/browser-runtime";
import type { ToolRegistry } from "./registry";

export type BrowserCapabilityInspector = () => Promise<BrowserRuntimeCapabilityReport>;

/** Read-only, live access to the same page-memory report shown in Profiles. */
export function registerBrowserCapabilityTool(
  registry: ToolRegistry,
  inspect: BrowserCapabilityInspector = () => getBrowserCapabilityRegistry().refresh(true),
): void {
  const tool: Tool = {
    definition: Object.freeze({
      name: "inspect_browser_capabilities",
      description: "Probe this page's actual WebGPU adapter, WebNN context, WebAssembly feature tier, OPFS root, browser primitives, coarse device signals, and adaptive scheduling policy. Availability is not an execution grant or proof that a workload is using an accelerator.",
      effect: "read" as const,
      inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    }),
    async execute(_argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult> {
      context.signal.throwIfAborted();
      const report = await inspect();
      context.signal.throwIfAborted();
      return Object.freeze({
        content: JSON.stringify(report, null, 2),
        metadata: {
          observedAt: report.observedAt,
          schedulingClass: report.scheduling.class,
          preferredSemanticBackend: report.scheduling.preferredSemanticBackend,
        } as JsonValue,
      });
    },
  };
  registry.register(Object.freeze(tool));
}
