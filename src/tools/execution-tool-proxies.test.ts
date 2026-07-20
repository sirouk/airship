import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry";
import { registerLazyExecutionTools } from "./execution-tool-proxies";

describe("lazy execution tool proxies", () => {
  it("publishes stable schemas and loads the runtime pack only on execution", async () => {
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      "deactivate_execution_runtime",
      "execute_code",
      "execute_javascript",
      "execute_node_project",
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
      expect.objectContaining({ id: "wasix" }),
    ]));
  });
});
