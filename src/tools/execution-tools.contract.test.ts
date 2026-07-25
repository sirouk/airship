import { describe, expect, it } from "vitest";
import type { ToolContext } from "../core/contracts";
import { executeExecutionTool } from "./execution-tools";
import { ToolRegistry } from "./registry";

const context: ToolContext = {
  sessionId: "contract-session",
  turnId: "contract-turn",
  operationId: "contract-operation",
  capabilityTier: "web-baseline",
  signal: new AbortController().signal,
};

describe("execute_code discriminated contract", () => {
  it("does not imply argv, environment, workspace, or an artifact for a JavaScript Worker", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "javascript-worker",
      code: "return 42;",
      args: ["unexpected"],
    }, context)).rejects.toThrow(/accepts only code and timeoutMs/u);
  });

  it("accepts only a precompiled command artifact for WASI while preserving the bounded workspace contract", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmBase64: "AAAAAAAAAAAA",
      code: "fn main() {}",
    }, context)).rejects.toThrow(/precompiled command artifact, not source code, Bash, rustc, or Cargo.*bounded workspace mount is optional/u);

    await expect(executeExecutionTool("execute_code", {
      runtime: "wasi-preview1",
      wasmBase64: "AAAAAAAAAAAA",
      writeBack: true,
    }, context)).rejects.toThrow(/WASI writeBack requires a workspaceRoot/u);
  });

  it("requires exactly one Python source and a root for workspace-backed source", async () => {
    await expect(executeExecutionTool("execute_code", {
      runtime: "python-pyodide",
      code: "40 + 2",
      sourcePath: "/workspace/main.py",
      workspaceRoot: "/workspace",
    }, context)).rejects.toThrow(/exactly one of code or sourcePath/u);

    await expect(executeExecutionTool("execute_code", {
      runtime: "python-pyodide",
      sourcePath: "/workspace/main.py",
    }, context)).rejects.toThrow(/require a workspaceRoot/u);
  });
});

describe("manifest-bound workspace programs", () => {
  it("rejects unpromoted shell calls and recursive tools", async () => {
    const host = new ToolRegistry();
    host.register({
      definition: {
        name: "execute_wasix_shell",
        description: "test WASIX boundary",
        effect: "network",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      },
      async execute() { return { content: "ok" }; },
    });

    await expect(executeExecutionTool("execute_workspace_program", {
      code: "return await airship.call('shell');",
      calls: [{ id: "shell", tool: "execute_wasix_shell", arguments: { code: "printf ok" } }],
    }, context, undefined, host)).rejects.toThrow(/cannot invoke execute_wasix_shell/u);

    host.register({
      definition: {
        name: "execute_workspace_program",
        description: "must not recurse",
        effect: "network",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async execute() { return { content: "no" }; },
    });
    await expect(executeExecutionTool("execute_workspace_program", {
      code: "return await airship.call('recursive');",
      calls: [{ id: "recursive", tool: "execute_workspace_program", arguments: {} }],
    }, context, undefined, host)).rejects.toThrow(/cannot invoke execute_workspace_program/u);
  });

  it("fails closed for direct calls to the unpromoted WASIX implementation", async () => {
    await expect(executeExecutionTool("install_execution_runtime", {
      runtime: "wasix",
    }, context)).rejects.toThrow(/not promoted.*nonzero Bash status.*mounted-workspace mutations/u);
    await expect(executeExecutionTool("execute_wasix_shell", {
      code: "printf ok",
    }, context)).rejects.toThrow(/not promoted.*Rust compiler remain unavailable/u);
  });
});
