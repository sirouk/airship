import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../core/contracts";
import type { WorkspacePort } from "../workspace/contracts";
import type { ToolRegistry } from "./registry";

const MAX_CODE_CHARS = 64 * 1_024;
const MAX_WASM_BASE64_CHARS = 5_600_000;

const CODE_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: MAX_CODE_CHARS } as const);
const STRING_1024_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: 1_024 } as const);
const STRING_4096_SCHEMA = Object.freeze({ type: "string", maxLength: 4_096 } as const);
const ARGUMENTS_SCHEMA = Object.freeze({ type: "array", maxItems: 64, items: STRING_4096_SCHEMA } as const);
const ENVIRONMENT_SCHEMA = Object.freeze({ type: "object", maxProperties: 64, additionalProperties: STRING_4096_SCHEMA } as const);

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
          code: CODE_SCHEMA,
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
          code: CODE_SCHEMA,
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
      description: "Cold-start an optional browser runtime; it reports ready only after a real probe, then it is usable immediately in this conversation.",
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
          code: CODE_SCHEMA,
          wasmBase64: { type: "string", minLength: 12, maxLength: MAX_WASM_BASE64_CHARS },
          wasmPath: STRING_1024_SCHEMA,
          args: ARGUMENTS_SCHEMA,
          env: ENVIRONMENT_SCHEMA,
          workspaceRoot: STRING_1024_SCHEMA,
          sourcePath: STRING_1024_SCHEMA,
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 10_000, description: "Bounds the job's own statements only. A python-pyodide cold start is bounded separately (up to 30 s) and reported as bootMs, so total wall clock can exceed this." },
        },
        required: ["runtime"],
        additionalProperties: false,
      },
    },
    /**
     * The one shell surface Airship can honestly offer on every browser.
     *
     * The description names the engine and its boundary in the same sentence,
     * so a model reading the manifest cannot conclude that Bash, a subprocess,
     * or a host filesystem is reachable. `effect` is `write` because an
     * approved run with `writeBack` adopts workspace files through the ordinary
     * revision-checked path; nothing here bypasses the approval gate.
     */
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
          script: CODE_SCHEMA,
          workspaceRoot: STRING_1024_SCHEMA,
          args: ARGUMENTS_SCHEMA,
          env: ENVIRONMENT_SCHEMA,
          writeBack: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 50, maximum: 30_000 },
        },
        required: ["script"],
        additionalProperties: false,
      },
    },
    {
      name: "deactivate_execution_runtime",
      description: "Terminate an optional runtime and release its in-tab processes and memory. The Workspace Terminal shares this runtime: any live terminal session is reconciled into the workspace and then stopped, and the reconciled paths are named in the result.",
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
      description: "Spawn one finite Node/npm-family process in an activated in-browser WebContainer. Commands for the same workspace root reuse page-local dependencies, so install then build/test works in this conversation; use Workspace Terminal for a long-running dev server. node_modules is never persisted. No host Bash is involved; writeBack preflights the full source snapshot, then adopts revision-checked text changes.",
      effect: "network",
      inputSchema: {
        type: "object",
        properties: {
          workspaceRoot: STRING_1024_SCHEMA,
          command: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          args: ARGUMENTS_SCHEMA,
          env: ENVIRONMENT_SCHEMA,
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
