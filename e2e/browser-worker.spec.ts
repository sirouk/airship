import { expect, test } from "@playwright/test";

test("strict Trusted Types still permits the bounded Airship execution worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#chat");

  const result = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    return module.runDisposableWorker(
      "console.log('worker-ready'); return { answer: 6 * 7 };",
      5_000,
      new AbortController().signal,
    );
  });

  expect(result).toEqual({ value: { answer: 42 }, logs: ["worker-ready"] });
  expect(errors.filter((message) => /TrustedScriptURL|Trusted Types|Worker/i.test(message))).toEqual([]);
});

test("the baseline tool proxy loads the execution pack only when invoked", async ({ page }) => {
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const [{ ToolRegistry }, { registerLazyExecutionTools }] = await Promise.all([
      import("/src/tools/registry.ts"),
      import("/src/tools/execution-tool-proxies.ts"),
    ]);
    const registry = new ToolRegistry();
    registerLazyExecutionTools(registry);
    return registry.get("execute_javascript")!.execute(
      { code: "return 20 + 22;", timeoutMs: 5_000 },
      {
        sessionId: "proxy-session",
        turnId: "proxy-turn",
        operationId: "proxy-operation",
        signal: new AbortController().signal,
      },
    );
  });

  expect(JSON.parse(result.content)).toEqual({ value: 42, logs: [] });
  expect(result.metadata).toEqual({ timeoutMs: 5_000, logs: 0 });
});

test("the built-in WASI tier executes a command artifact in a disposable worker", async ({ page }) => {
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    return module.runDisposableWasi(
      "AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIjARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADAgEBBQMBABEGGQN/AUGAgMAAC38AQZOAwAALfwBBoIDAAAsHLgQGbWVtb3J5AgAGX3N0YXJ0AAEKX19kYXRhX2VuZAMBC19faGVhcF9iYXNlAwIKUAFOAQF/I4CAgIAAQRBrIgAkgICAgAAgAEETNgIIIABBgIDAgAA2AgQgAEEANgIMQQEgAEEEakEBIABBDGoQgICAgAAaIABBEGokgICAgAALCxwBAEGAgMAACxNhaXJzaGlwLXdhc2ktcmVhZHkK",
      ["--version"],
      { AIRSHIP_TEST: "true" },
      5_000,
      new AbortController().signal,
    );
  });

  expect(result).toEqual({ runtime: "wasi-preview1", exitCode: 0, stdout: "airship-wasi-ready\n", stderr: "" });
});

test("runtime discovery distinguishes ready runtimes from optional packs", async ({ page }) => {
  await page.goto("/#chat");
  const capabilities = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    return module.getClientExecutionRuntime().capabilities();
  });

  expect(capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "javascript-worker", state: "ready" }),
    expect.objectContaining({ id: "wasi-preview1", state: "ready" }),
    expect.objectContaining({ id: "python-pyodide", state: "installable" }),
  ]));
  expect(capabilities.find(({ id }) => id === "node-webcontainer")?.state).not.toBe("ready");
});

test("the explicit Pyodide pack runs real Python in a fresh bounded worker", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const [module, workspaceModule] = await Promise.all([
      import("/src/tools/execution-tools.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const controller = new AbortController();
    await module.installPyodideExecutionRuntime(30_000, controller.signal);
    const before = module.getClientExecutionRuntime().capabilities()
      .find(({ id }) => id === "python-pyodide");
    const execution = await module.getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "import os, sys, statistics\nprint(sys.argv[1])\nprint(os.environ['AIRSHIP_MODE'])\nstatistics.mean([40, 42, 44])",
      args: ["browser-python"],
      env: { AIRSHIP_MODE: "ephemeral" },
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    const bounded = await module.getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "print('x' * 300_000)",
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    const workspace = new workspaceModule.MemoryWorkspace();
    await workspace.write("projects/python/main.py", "from pathlib import Path\nvalue = int(Path('input.txt').read_text())\nPath('result.txt').write_text(str(value * 2))\nprint(value)");
    await workspace.write("projects/python/input.txt", "21");
    const project = await module.getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      workspace,
      workspaceRoot: "/workspace/projects/python",
      sourcePath: "/workspace/projects/python/main.py",
      writeBack: true,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    return {
      before,
      execution,
      boundedOutputChars: bounded.stdout.length,
      project,
      writtenResult: (await workspace.read("projects/python/result.txt"))?.content,
    };
  });

  expect(result.before).toMatchObject({
    state: "ready",
    isolation: "disposable-worker",
    persistence: "ephemeral",
  });
  expect(result.execution).toMatchObject({
    runtime: "python-pyodide",
    exitCode: 0,
    value: 42,
  });
  expect(result.execution.stdout).toContain("browser-python");
  expect(result.execution.stdout).toContain("ephemeral");
  expect(result.boundedOutputChars).toBe(256 * 1_024);
  expect(result.project.workspace).toMatchObject({
    root: "/workspace/projects/python",
    mountedFiles: 2,
    changedPaths: ["/workspace/projects/python/result.txt"],
    writtenPaths: ["/workspace/projects/python/result.txt"],
    writeBack: true,
  });
  expect(result.writtenResult).toBe("42");
});
