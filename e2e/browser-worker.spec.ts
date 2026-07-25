import { expect, test } from "@playwright/test";
import { RUST_WASI_PREVIEW1_BASE64 } from "./fixtures/rust-wasi-preview1";

test("strict Trusted Types still permits the bounded Airship execution worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#chat");

  const observed = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    const chunks: Array<{ stream: string; text: string }> = [];
    const result = await module.runDisposableWorker(
      "console.log('worker-ready'); return { answer: 6 * 7, rawPostMessage: typeof postMessage, wrapperPost: typeof __post };",
      5_000,
      new AbortController().signal,
      (chunk) => chunks.push(chunk),
    );
    return { result, chunks };
  });

  expect(observed.result).toEqual({ value: { answer: 42, rawPostMessage: "undefined", wrapperPost: "undefined" }, logs: ["worker-ready"], errors: [] });
  expect(observed.chunks).toEqual([{ stream: "stdout", text: "worker-ready\n" }]);
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

  expect(JSON.parse(result.content)).toEqual({ value: 42, logs: [], errors: [] });
  expect(result.metadata).toMatchObject({
    timeoutMs: 5_000,
    logs: 0,
    capabilityTier: "web-baseline",
    authority: "browser",
  });
});

test("the built-in WASI tier executes a command artifact in a disposable worker", async ({ page }) => {
  await page.goto("/#chat");
  const observed = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    const chunks: Array<{ stream: string; text: string }> = [];
    const result = await module.runDisposableWasi(
      "AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIjARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADAgEBBQMBABEGGQN/AUGAgMAAC38AQZOAwAALfwBBoIDAAAsHLgQGbWVtb3J5AgAGX3N0YXJ0AAEKX19kYXRhX2VuZAMBC19faGVhcF9iYXNlAwIKUAFOAQF/I4CAgIAAQRBrIgAkgICAgAAgAEETNgIIIABBgIDAgAA2AgQgAEEANgIMQQEgAEEEakEBIABBDGoQgICAgAAaIABBEGokgICAgAALCxwBAEGAgMAACxNhaXJzaGlwLXdhc2ktcmVhZHkK",
      ["--version"],
      { AIRSHIP_TEST: "true" },
      5_000,
      new AbortController().signal,
      (chunk) => chunks.push(chunk),
    );
    return { result, chunks };
  });

  expect(observed.result).toMatchObject({
    runtime: "wasi-preview1",
    exitCode: 0,
    stdout: "airship-wasi-ready\n",
    stderr: "",
    provenance: { capabilityTier: "web-baseline", authority: "browser", artifactKind: "wasi-command" },
  });
  expect(observed.chunks).toEqual([{ stream: "stdout", text: "airship-wasi-ready\n" }]);
});

test("precompiled Rust WASI streams, preserves status, mutates a bounded workspace, and hard-cancels", async ({ page }) => {
  await page.goto("/#chat");
  const observed = await page.evaluate(async ({ wasmBase64 }) => {
    const [execution, workspaceModule] = await Promise.all([
      import("/src/tools/execution-tools.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const runtime = execution.getClientExecutionRuntime();
    const workspace = new workspaceModule.MemoryWorkspace();
    await workspace.write("/workspace/rust/input.txt", "browser workspace input\n");

    const successChunks: Array<{ stream: string; text: string }> = [];
    const success = await runtime.execute({
      runtime: "wasi-preview1",
      wasmBase64,
      args: ["workspace"],
      env: {},
      workspace,
      workspaceRoot: "/workspace/rust",
      writeBack: true,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onOutput: (chunk) => successChunks.push(chunk),
    });

    const failureChunks: Array<{ stream: string; text: string }> = [];
    const failure = await runtime.execute({
      runtime: "wasi-preview1",
      wasmBase64,
      args: ["fail"],
      env: {},
      workspace,
      workspaceRoot: "/workspace/rust",
      writeBack: true,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onOutput: (chunk) => failureChunks.push(chunk),
    });

    const controller = new AbortController();
    const cancellationChunks: Array<{ stream: string; text: string }> = [];
    const started = performance.now();
    let cancellation = "completed";
    try {
      await runtime.execute({
        runtime: "wasi-preview1",
        wasmBase64,
        args: ["loop"],
        env: {},
        timeoutMs: 5_000,
        signal: controller.signal,
        onOutput(chunk) {
          cancellationChunks.push(chunk);
          if (chunk.text.includes("rust-cancel-ready")) {
            controller.abort(new DOMException("Rust WASI cancellation gate", "AbortError"));
          }
        },
      });
    } catch (error) {
      cancellation = error instanceof DOMException ? error.name : error instanceof Error ? error.message : String(error);
    }

    return {
      success,
      successChunks,
      output: (await workspace.read("/workspace/rust/output.txt"))?.content,
      failure,
      failureChunks,
      failedOutputAdopted: Boolean(await workspace.read("/workspace/rust/must-not-adopt.txt")),
      cancellation,
      cancellationChunks,
      cancellationElapsed: performance.now() - started,
      capability: runtime.capabilities().find(({ id }) => id === "wasi-preview1"),
    };
  }, { wasmBase64: RUST_WASI_PREVIEW1_BASE64 });

  expect(observed.success).toMatchObject({
    runtime: "wasi-preview1",
    exitCode: 0,
    stdout: "rust-stdout:workspace\n",
    stderr: "rust-stderr:workspace\n",
    provenance: {
      authority: "browser",
      engine: "browser-wasi-shim-0.4.2-worker",
      artifactKind: "wasi-command",
    },
    workspace: {
      mountedFiles: 1,
      changedPaths: ["/workspace/rust/output.txt"],
      writtenPaths: ["/workspace/rust/output.txt"],
      writeBackRequested: true,
      adopted: true,
    },
  });
  expect(observed.successChunks).toEqual([
    { stream: "stdout", text: "rust-stdout:workspace\n" },
    { stream: "stderr", text: "rust-stderr:workspace\n" },
  ]);
  expect(observed.output).toBe("browser workspace input\n");
  expect(observed.failure).toMatchObject({
    exitCode: 23,
    stdout: "rust-before-failure\n",
    stderr: "rust-failure-detail\n",
    workspace: {
      changedPaths: ["/workspace/rust/must-not-adopt.txt"],
      writtenPaths: [],
      writeBackRequested: true,
      adopted: false,
    },
  });
  expect(observed.failureChunks).toEqual([
    { stream: "stdout", text: "rust-before-failure\n" },
    { stream: "stderr", text: "rust-failure-detail\n" },
  ]);
  expect(observed.failedOutputAdopted).toBe(false);
  expect(observed.cancellation).toBe("AbortError");
  expect(observed.cancellationChunks).toContainEqual({ stream: "stdout", text: "rust-cancel-ready\n" });
  expect(observed.cancellationElapsed).toBeLessThan(1_000);
  expect(observed.capability).toMatchObject({
    state: "ready",
    languages: ["compiled-wasm", "rust-wasm32-wasip1"],
    commandInterface: "precompiled-wasi-command",
    shell: "none",
    workspaceAccess: "bounded-snapshot-writeback",
    cancellation: "terminate-worker",
  });
  expect(observed.capability?.detail).toContain("not Bash, rustc, Cargo");
});

test("abort hard-terminates a runaway disposable worker", async ({ page }) => {
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const module = await import("/src/tools/execution-tools.ts");
    const controller = new AbortController();
    const started = performance.now();
    const execution = module.runDisposableWorker("while (true) {}", 5_000, controller.signal);
    setTimeout(() => controller.abort(new DOMException("Stopped by test", "AbortError")), 30);
    try {
      await execution;
      return { stopped: false, elapsed: performance.now() - started };
    } catch (error) {
      return { stopped: error instanceof DOMException && error.name === "AbortError", elapsed: performance.now() - started };
    }
  });
  expect(result.stopped).toBe(true);
  expect(result.elapsed).toBeLessThan(1_000);
});

test("an approval-bound workspace program can invoke only its exact declared text-editor calls", async ({ page }) => {
  await page.goto("/#chat");
  const observed = await page.evaluate(async () => {
    const [{ createWorkspaceToolRegistry }, { registerLazyExecutionTools }, { MemoryWorkspace }] = await Promise.all([
      import("/src/tools/workspace-tools.ts"),
      import("/src/tools/execution-tool-proxies.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    const registry = createWorkspaceToolRegistry(workspace);
    registerLazyExecutionTools(registry, workspace);
    const argumentsValue = {
      code: "await airship.call('edit'); const read = await airship.call('verify'); console.log(read.content); return read.content;",
      calls: [
        { id: "edit", tool: "text_editor", arguments: { edits: [{ path: "/workspace/generated.txt", oldText: null, newText: "browser-owned\n", expectedRevision: null }] } },
        { id: "verify", tool: "read_file", arguments: { path: "/workspace/generated.txt" } },
      ],
      timeoutMs: 5_000,
    };
    const context = {
      sessionId: "workspace-program",
      turnId: "turn",
      operationId: "approved-program",
      signal: new AbortController().signal,
    };
    let reviewedEffect = "";
    const decision = await registry.review("execute_workspace_program", argumentsValue, context, {
      async review(definition) { reviewedEffect = definition.effect; return "allow"; },
    });
    const result = decision === "allow"
      ? await registry.executeApproved("execute_workspace_program", argumentsValue, context)
      : undefined;
    const fireAndForgetArguments = {
      code: "void airship.call('late'); return 'scheduled';",
      calls: [
        { id: "late", tool: "text_editor", arguments: { edits: [{ path: "/workspace/drained.txt", oldText: null, newText: "finished before receipt\n", expectedRevision: null }] } },
      ],
      timeoutMs: 5_000,
    };
    const fireAndForgetContext = { ...context, operationId: "approved-program-drain" };
    await registry.review("execute_workspace_program", fireAndForgetArguments, fireAndForgetContext, {
      async review() { return "allow"; },
    });
    const drainedResult = await registry.executeApproved(
      "execute_workspace_program",
      fireAndForgetArguments,
      fireAndForgetContext,
    );
    const deniedContext = { ...context, operationId: "undeclared-program" };
    const deniedArguments = {
      code: "await airship.call('not-declared');",
      calls: [],
      timeoutMs: 5_000,
    };
    await registry.review("execute_workspace_program", deniedArguments, deniedContext, {
      async review() { return "allow"; },
    });
    let undeclared = "unexpectedly completed";
    try {
      await registry.executeApproved("execute_workspace_program", deniedArguments, deniedContext);
    } catch (error) {
      undeclared = error instanceof Error ? error.message : String(error);
    }
    return {
      decision,
      reviewedEffect,
      result,
      drainedResult,
      undeclared,
      content: (await workspace.read("/workspace/generated.txt"))?.content,
      drainedContent: (await workspace.read("/workspace/drained.txt"))?.content,
    };
  });

  expect(observed).toMatchObject({
    decision: "allow",
    reviewedEffect: "write",
    content: "browser-owned\n",
    drainedContent: "finished before receipt\n",
  });
  expect(observed.undeclared).toContain("not uniquely predeclared");
  expect(JSON.parse(observed.result!.content)).toMatchObject({
    value: "browser-owned\n",
    calls: [
      { id: "edit", tool: "text_editor", status: "completed", isError: false },
      { id: "verify", tool: "read_file", status: "completed", isError: false },
    ],
  });
  expect(JSON.parse(observed.drainedResult.content)).toMatchObject({
    value: "scheduled",
    calls: [{ id: "late", tool: "text_editor", status: "completed", isError: false }],
  });
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
    expect.objectContaining({ id: "wasix", state: "unavailable", commandInterface: "unavailable" }),
  ]));
  expect(capabilities.find(({ id }) => id === "node-webcontainer")?.state).not.toBe("ready");
});

test("the pinned WASIX candidate records its live no-go verdict without normalizing SDK status", async ({ page }) => {
  test.skip(process.env.AIRSHIP_LIVE_WASIX !== "1", "requires the live Wasmer registry/CDN and records the current promotion verdict");
  test.setTimeout(120_000);
  await page.goto("/#chat");
  const observed = await page.evaluate(async () => {
    const [pack, workspaceModule] = await Promise.all([
      import("/src/execution/wasix-pack.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const signal = new AbortController().signal;
    const adapter = pack.createWasixAdapter();
    const successChunks: Array<{ stream: string; text: string }> = [];
    const success = await adapter.execute({
      runtime: "wasix",
      code: "printf 'child-stdout\\n'; printf 'child-stderr\\n' >&2",
      timeoutMs: 20_000,
      signal,
      onOutput: (chunk) => successChunks.push(chunk),
    });
    const failureChunks: Array<{ stream: string; text: string }> = [];
    const failure = await adapter.execute({
      runtime: "wasix",
      code: "printf 'before-failure\\n'; printf 'failure-detail\\n' >&2; exit 7",
      timeoutMs: 20_000,
      signal,
      onOutput: (chunk) => failureChunks.push(chunk),
    });
    const workspace = new workspaceModule.MemoryWorkspace();
    await workspace.write("/workspace/project/input.txt", "twenty-one\n");
    await workspace.write("/workspace/project/output.txt", "");
    const mounted = await adapter.execute({
      runtime: "wasix",
      code: "IFS= read -r value < input.txt; printf 'value:%s\\n' \"$value\"; printf 'warn\\n' >&2; printf '%s\\n' \"$value\" > output.txt",
      workspace,
      workspaceRoot: "/workspace/project",
      writeBack: true,
      timeoutMs: 20_000,
      signal,
      onOutput() {},
    });
    let activationError = "";
    try {
      await pack.activateWasixExecutionAdapter(signal, 45_000);
    } catch (error) {
      activationError = error instanceof Error ? error.message : String(error);
    }
    return {
      success,
      successChunks,
      failure,
      failureChunks,
      mounted,
      outputAfterMountedRun: (await workspace.read("/workspace/project/output.txt"))?.content,
      activationError,
    };
  });

  expect(observed.success).toMatchObject({
    exitCode: 0,
    stdout: "child-stdout\n",
    stderr: "child-stderr\n",
    value: { providerRuntimeExitCode: 45 },
  });
  expect(observed.successChunks).toEqual(expect.arrayContaining([
    { stream: "stdout", text: "child-stdout\n" },
    { stream: "stderr", text: "child-stderr\n" },
  ]));
  expect(observed.failure).toMatchObject({
    // This is intentionally the observed defect: the Bash-written wrapper
    // does not preserve the explicit `exit 7` through this pinned runtime.
    exitCode: 0,
    stdout: "before-failure\n",
    stderr: "failure-detail\n",
    value: { providerRuntimeExitCode: 45 },
  });
  expect(observed.failureChunks).toEqual(expect.arrayContaining([
    { stream: "stdout", text: "before-failure\n" },
    { stream: "stderr", text: "failure-detail\n" },
  ]));
  expect(observed.mounted).toMatchObject({
    exitCode: 0,
    stdout: "",
    stderr: "",
    value: { providerRuntimeExitCode: 45 },
    workspace: { adopted: false, writtenPaths: [] },
  });
  expect(observed.outputAfterMountedRun).toBe("");
  expect(observed.activationError).toContain("nonzero exit-status probe");
});

test("the explicit Pyodide pack runs real Python in a fresh bounded worker", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/#chat");
  const result = await page.evaluate(async () => {
    const [module, workspaceModule, codec] = await Promise.all([
      import("/src/tools/execution-tools.ts"),
      import("/src/workspace/memory.ts"),
      import("/src/workspace/content-codec.ts"),
    ]);
    const controller = new AbortController();
    const activation = await module.executeExecutionTool(
      "install_execution_runtime",
      { runtime: "python-pyodide", timeoutMs: 30_000 },
      {
        sessionId: "baseline-session",
        turnId: "activation-turn",
        operationId: "activate-python",
        capabilityTier: "web-baseline",
        signal: controller.signal,
      },
    );
    const before = module.getClientExecutionRuntime().capabilities()
      .find(({ id }) => id === "python-pyodide");
    let pinnedSessionError = "";
    try {
      await module.executeExecutionTool(
        "execute_code",
        { runtime: "python-pyodide", code: "40 + 2", timeoutMs: 10_000 },
        {
          sessionId: "baseline-session",
          turnId: "execution-turn",
          operationId: "execute-python",
          capabilityTier: "web-baseline",
          signal: controller.signal,
        },
      );
    } catch (error) {
      pinnedSessionError = error instanceof Error ? error.message : String(error);
    }
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
    await workspace.write("projects/python/main.py", "from pathlib import Path\nvalue = int(Path('input.txt').read_text())\nPath('result.txt').write_text(str(value * 2))\nblob = Path('blob.bin')\nblob.write_bytes(blob.read_bytes()[::-1])\nprint(value)");
    await workspace.write("projects/python/input.txt", "21");
    await workspace.write("projects/python/blob.bin", codec.encodeWorkspaceBytes(new Uint8Array([0, 255, 2, 128])));
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
      activation,
      pinnedSessionError,
      execution,
      boundedOutputChars: bounded.stdout.length,
      project,
      writtenResult: (await workspace.read("projects/python/result.txt"))?.content,
      writtenBlob: [...codec.decodeWorkspaceBytes((await workspace.read("projects/python/blob.bin"))!.content)],
    };
  });

  expect(result.before).toMatchObject({
    state: "ready",
    isolation: "disposable-worker",
    persistence: "ephemeral",
  });
  expect(result.activation.metadata).toMatchObject({
    requiresSessionFork: true,
    pinnedCapabilityTier: "web-baseline",
  });
  expect(JSON.parse(result.activation.content)).toMatchObject({ sessionCompatibility: "fork-required" });
  expect(result.pinnedSessionError).toContain("Create or fork a conversation after activation");
  expect(result.execution).toMatchObject({
    runtime: "python-pyodide",
    exitCode: 0,
    value: 42,
    provenance: { capabilityTier: "web-enhanced", authority: "browser", artifactKind: "source" },
  });
  expect(result.execution.stdout).toContain("browser-python");
  expect(result.execution.stdout).toContain("ephemeral");
  expect(result.boundedOutputChars).toBe(256 * 1_024);
  expect(result.project.workspace).toMatchObject({
    root: "/workspace/projects/python",
    mountedFiles: 3,
    changedPaths: ["/workspace/projects/python/blob.bin", "/workspace/projects/python/result.txt"],
    writtenPaths: ["/workspace/projects/python/blob.bin", "/workspace/projects/python/result.txt"],
    writeBack: true,
  });
  expect(result.writtenResult).toBe("42");
  expect(result.writtenBlob).toEqual([128, 2, 255, 0]);
});
