import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;

type ExecutionPack = typeof import("../execution/execution-runtime-pack");
let executionPack: Promise<ExecutionPack> | undefined;

/** Register stable schemas while leaving the Worker/WASI implementation cold. */
export function registerLazyExecutionTools(registry: ToolRegistry, workspace?: WorkspacePort): void {
  for (const definition of EXECUTION_TOOL_DEFINITIONS) registry.register(proxy(definition, workspace));
}

const EXECUTION_TOOL_DEFINITIONS = Object.freeze([
    {
      name: "execute_javascript",
      description: "Run bounded JavaScript in a disposable browser worker with no workspace, DOM, storage, or network binding; return or log the result.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
    {
      name: "install_execution_runtime",
      description: "Cold-start an optional browser runtime; it reports ready only after a real probe.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["python-pyodide", "node-webcontainer"] },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 30_000 },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    {
      name: "inspect_execution_runtimes",
      description: "Report the coding runtimes this browser can execute now, activate explicitly, or cannot provide in this release.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "execute_code",
      description: "Execute code in a ready client-side runtime. JavaScript Worker and compact WASI Preview 1 are built in; install Python explicitly first. Node/npm projects use the separately activated execute_node_project path.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["javascript-worker", "wasi-preview1", "python-pyodide"] },
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          wasmBase64: { type: "string", minLength: 12, maxLength: MAX_WASM_BASE64_CHARS },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          sourcePath: { type: "string", minLength: 1, maxLength: 1_024 },
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    {
      name: "deactivate_execution_runtime",
      description: "Terminate an optional runtime and release its in-tab processes and memory.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: { runtime: { type: "string", enum: ["node-webcontainer"] } },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    {
      name: "execute_node_project",
      description: "Run a direct Node/npm command in the in-browser WebContainer on a bounded workspace snapshot; writeBack adopts revision-checked text changes.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          command: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
          writeBack: { type: "boolean" },
        },
        required: ["workspaceRoot", "command"],
        additionalProperties: false,
      },
    },
]) as unknown as readonly Tool["definition"][];

function proxy(definition: Tool["definition"], workspace?: WorkspacePort): Tool {
  return Object.freeze({
    definition: Object.freeze(definition),
    async execute(argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult> {
      const pack = await loadExecutionPack();
      return pack.executeExecutionTool(definition.name, argumentsValue, context, workspace);
    },
  });
}

function loadExecutionPack(): Promise<ExecutionPack> {
  executionPack ??= import("../execution/execution-runtime-pack");
  return executionPack;
}
