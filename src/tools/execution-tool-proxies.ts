import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;

type ExecutionPack = typeof import("../execution/execution-runtime-pack");
let executionPack: Promise<ExecutionPack> | undefined;

/** Register stable schemas while leaving the Worker/WASI implementation cold. */
export function registerLazyExecutionTools(registry: ToolRegistry, workspace?: WorkspacePort): void {
  for (const definition of EXECUTION_TOOL_DEFINITIONS) registry.register(proxy(definition, workspace, registry));
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
      name: "execute_workspace_program",
      description: "Run bounded JavaScript that may invoke only exact predeclared workspace file calls in its approval-bound manifest. It exposes no ambient DOM, storage, network, shell, or undeclared tool access.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          calls: {
            type: "array",
            maxItems: 16,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                tool: { type: "string", enum: ["list_files", "read_file", "stat_path", "search_text", "text_editor"] },
                arguments: { type: "object" },
              },
              required: ["id", "tool", "arguments"],
              additionalProperties: false,
            },
          },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000 },
        },
        required: ["code", "calls"],
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
          timeoutMs: { type: "integer", minimum: 1_000, maximum: 30_000, description: "Bounds the whole activation, cold start included." },
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
      description: "Execute one strictly typed browser job in a ready runtime: JavaScript source; a precompiled WASI Preview 1 command (including Rust compiled elsewhere for wasm32-wasip1) supplied as a workspace wasmPath or inline wasmBase64, with optional bounded workspace snapshot/writeback; or explicitly installed Pyodide Python. This is not Bash, rustc, Cargo, or host execution. Inspect runtimes first; Node projects use execute_node_project.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          runtime: { type: "string", enum: ["javascript-worker", "wasi-preview1", "python-pyodide"] },
          code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          wasmBase64: { type: "string", minLength: 12, maxLength: MAX_WASM_BASE64_CHARS },
          wasmPath: { type: "string", minLength: 1, maxLength: 1_024 },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          sourcePath: { type: "string", minLength: 1, maxLength: 1_024 },
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000, description: "Bounds the job's own statements only. A python-pyodide cold start is bounded separately (up to 30 s) and reported as bootMs, so total wall clock can exceed this." },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    {
      name: "execute_shell",
      description:
        "Run one POSIX sh script in airship-sh, Airship's own in-browser shell interpreter, over a bounded snapshot of a "
        + "workspace directory. Real shell semantics: single/double/backslash quoting, $VAR and ${VAR:-x}/${VAR:=x}/"
        + "${VAR:?x}/${VAR:+x}/${VAR#p}/${VAR%p}/${#VAR}, $(...) and backticks, $((...)) arithmetic, tilde and IFS field "
        + "splitting, * ? [...] globbing against the real workspace, pipelines, ! && || ;, ( ) subshells, { } groups, "
        + "if/for/while/until/case, functions, > >> < 2> 2>&1 >& redirection, << and <<- here-documents, and utilities "
        + "including ls cat cp mv rm mkdir rmdir touch head tail wc grep sed sort uniq cut tr find basename dirname "
        + "realpath xargs env date seq diff stat du. It is NOT GNU Bash and has no subprocesses: no job control or `&`, "
        + "no signals other than trap EXIT, no arrays, no process substitution, no [[ ]], no host filesystem, no network, "
        + "and no git/python/node commands. Unsupported syntax is a parse error and an unimplemented utility flag is an "
        + "error, never a silent no-op. Files change only when writeBack is true and the script exits 0.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
          workspaceRoot: { type: "string", minLength: 1, maxLength: 1_024 },
          args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4_096 } },
          env: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 4_096 } },
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 30_000 },
        },
        required: ["script"],
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
      description: "Spawn one direct Node/npm-family process in an activated in-browser WebContainer over a bounded workspace snapshot. No shell string or host Bash is involved; writeBack adopts revision-checked text changes.",
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

function proxy(definition: Tool["definition"], workspace: WorkspacePort | undefined, hostRegistry: ToolRegistry): Tool {
  return Object.freeze({
    definition: Object.freeze(definition),
    async execute(argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult> {
      const pack = await loadExecutionPack();
      return pack.executeExecutionTool(definition.name, argumentsValue, context, workspace, hostRegistry);
    },
  });
}

function loadExecutionPack(): Promise<ExecutionPack> {
  executionPack ??= import("../execution/execution-runtime-pack");
  return executionPack;
}

/** Loads no optional language/provider pack; it only probes the baseline broker. */
export async function inspectBrowserExecutionTier() {
  return (await loadExecutionPack()).getCurrentBrowserExecutionTier();
}
