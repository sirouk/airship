import type { BrowserExecutionTier } from "./execution/runtime-registry";

type ExecutionRuntimePack = typeof import("./execution/execution-runtime-pack");

let executionRuntimePack: Promise<ExecutionRuntimePack> | undefined;

/**
 * Read the browser execution tier without pulling the installed execution-tool
 * schemas or worker implementations into the application shell. The runtime
 * pack is fetched only when a new immutable session needs its capability pin.
 */
export async function inspectBrowserExecutionTier(): Promise<BrowserExecutionTier> {
  executionRuntimePack ??= import("./execution/execution-runtime-pack");
  return (await executionRuntimePack).getCurrentBrowserExecutionTier();
}
