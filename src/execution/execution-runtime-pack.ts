/**
 * Second-level optional execution pack. This facade gives the production chunk
 * a stable auditable name while keeping Worker/WASI source out of the agent's
 * baseline capability download.
 */
export {
  executeExecutionTool,
  getClientExecutionRuntime,
  installExecutionAdapter,
  installPyodideExecutionRuntime,
  runDisposablePyodide,
  runDisposableWasi,
  runDisposableWorker,
} from "../tools/execution-tools";
