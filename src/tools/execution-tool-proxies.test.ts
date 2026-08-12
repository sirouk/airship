import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry";
import * as proxies from "./execution-tool-proxies";
import { registerLazyExecutionTools } from "./execution-tool-proxies";
import { MAX_SHELL_TIMEOUT_MS, WORKSPACE_PROGRAM_TOOL_EFFECTS } from "./execution-tools";

describe("lazy execution tool proxies", () => {
  it("publishes stable schemas and loads the runtime pack only on execution", async () => {
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      "deactivate_execution_runtime",
      "execute_code",
      "execute_javascript",
      "execute_node_project",
      "execute_shell",
      "execute_workspace_program",
      "inspect_execution_runtimes",
      "install_execution_runtime",
    ]);

    const inspect = registry.get("inspect_execution_runtimes");
    const result = await inspect!.execute({}, {
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      signal: new AbortController().signal,
    });
    expect(JSON.parse(result.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "python-pyodide" }),
      expect.objectContaining({ id: "wasix", state: "unavailable" }),
    ]));
  });

  it("approval-binds only exact workspace-file calls and does not advertise unpromoted WASIX", () => {
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    const definition = registry.get("execute_workspace_program")!.definition;
    const schema = definition.inputSchema as {
      properties: { calls: { items: { properties: { tool: { enum: string[] } } } } };
    };

    expect(definition.effect).toBe("write");
    expect(schema.properties.calls.items.properties.tool.enum).toEqual([
      "list_files",
      "read_file",
      "stat_path",
      "search_text",
      "text_editor",
    ]);
    expect(schema.properties.calls.items.properties.tool.enum).not.toContain("execute_workspace_program");
    expect(registry.get("execute_wasix_shell")).toBeUndefined();

    const installSchema = registry.get("install_execution_runtime")!.definition.inputSchema as {
      properties: { runtime: { enum: string[] } };
    };
    const deactivateSchema = registry.get("deactivate_execution_runtime")!.definition.inputSchema as {
      properties: { runtime: { enum: string[] } };
    };
    expect(installSchema.properties.runtime.enum).toEqual(["python-pyodide", "node-webcontainer"]);
    expect(deactivateSchema.properties.runtime.enum).toEqual(["node-webcontainer"]);
  });

  it("publishes the limits the runtime pack actually enforces, not a transcription of them", () => {
    // These schemas are declared here so the Worker/WASI implementation stays
    // cold, which means the numbers the model reads live in a different file
    // from the numbers that are enforced. A test is the only thing holding the
    // two together: a tool added to the enforcement map but not to this enum is
    // a capability the model is never told it has, and a raised shell timeout
    // that never reaches the schema is a bound the model cannot ask for.
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    const programSchema = registry.get("execute_workspace_program")!.definition.inputSchema as {
      properties: { calls: { items: { properties: { tool: { enum: string[] } } } } };
    };
    const shellSchema = registry.get("execute_shell")!.definition.inputSchema as {
      properties: { timeoutMs: { maximum: number } };
    };

    expect(programSchema.properties.calls.items.properties.tool.enum).toEqual([...WORKSPACE_PROGRAM_TOOL_EFFECTS.keys()]);
    expect(shellSchema.properties.timeoutMs.maximum).toBe(MAX_SHELL_TIMEOUT_MS);
  });

  it("exports the registration seam and nothing else", () => {
    // A second reader of the browser execution tier used to be exported from
    // here, duplicating `load-execution-runtime.ts` — the one the shell imports
    // — and offering a maintainer a way to pull the whole tool-registry graph
    // into a chunk the startup-boundary test does not guard.
    expect(Object.keys(proxies)).toEqual(["registerLazyExecutionTools"]);
  });

  it("tells the model that execute_code's timeoutMs excludes the interpreter cold start", () => {
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    const timeouts = (name: string) => ((registry.get(name)!.definition.inputSchema as {
      properties: { timeoutMs: { maximum: number; description?: string } };
    }).properties.timeoutMs);

    // A 10 s job bound on a runtime whose boot is separately bounded at 30 s
    // is a ~40 s wall clock. The schema the model reads has to say so.
    expect(timeouts("execute_code").maximum).toBe(10_000);
    expect(timeouts("execute_code").description).toMatch(/cold start is bounded separately/u);
    expect(timeouts("execute_code").description).toMatch(/bootMs/u);
    // install_execution_runtime does nothing but boot, so its budget is total.
    expect(timeouts("install_execution_runtime").description).toMatch(/whole activation, cold start included/u);
  });
});
