/**
 * Runtime-only surface. Keeping this facade narrower than the source module
 * lets Rollup discard legacy registration helpers and direct test exports.
 */
export {
  executeExecutionTool,
  getCurrentBrowserExecutionTier,
  inspectCurrentBrowserExecutionCapabilities,
} from "../tools/execution-tools";
