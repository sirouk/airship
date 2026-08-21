import { expect, test } from "@playwright/test";
import { DISPOSABLE_WORKER_AMBIENT_GLOBALS } from "../src/execution/disposable-worker-isolation-source";
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

test("disposable JavaScript has no recoverable ambient or controller egress", async ({ page }) => {
  const requests: Array<{ url: string; body: string | null }> = [];
  await page.route("**/__airship_disposable_egress_probe__*", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "text/javascript", body: "export default 42;" });
  });
  await page.goto("/#chat");

  const observed = await page.evaluate(async (ambientNames) => {
    const { runDisposableWorker } = await import("/src/tools/execution-tools.ts");
    return runDisposableWorker(`
      const exposedAmbient = [];
      for (const name of ${JSON.stringify(ambientNames)}) {
        if (globalThis[name] !== undefined) exposedAmbient.push("global:" + name);
        let owner = Object.getPrototypeOf(globalThis);
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, name);
          if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
            exposedAmbient.push("prototype:" + name);
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      const exposedController = [];
      for (const name of ["postMessage", "onmessage", "onmessageerror", "close"]) {
        if (globalThis[name] !== undefined) exposedController.push("global:" + name);
        let owner = Object.getPrototypeOf(globalThis);
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, name);
          if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
            exposedController.push("prototype:" + name);
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      const attempts = {};
      try { await fetch("/__airship_disposable_egress_probe__fetch?secret=FETCH"); attempts.fetch = "allowed"; }
      catch (error) { attempts.fetch = error && error.name || typeof error; }
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/__airship_disposable_egress_probe__xhr");
        xhr.send("XHR-SECRET");
        attempts.xhr = "allowed";
      } catch (error) { attempts.xhr = error && error.name || typeof error; }
      try {
        const font = new FontFace("probe", "url(/__airship_disposable_egress_probe__font?secret=FONT)");
        await font.load();
        attempts.font = "allowed";
      } catch (error) { attempts.font = error && error.name || typeof error; }
      try {
        await import("/__airship_disposable_egress_probe__import.js?secret=IMPORT");
        attempts.dynamicImport = "allowed";
      } catch (error) { attempts.dynamicImport = error && error.name || typeof error; }
      try {
        EventTarget.prototype.addEventListener.call(globalThis, "message", () => {});
        attempts.controllerRegistration = "allowed";
      } catch (error) { attempts.controllerRegistration = error && error.name || typeof error; }
      try {
        EventTarget.prototype.dispatchEvent.call(globalThis, new MessageEvent("message", { data: { ok: true } }));
        attempts.controllerDispatch = "allowed";
      } catch (error) { attempts.controllerDispatch = error && error.name || typeof error; }
      let abortSignalEvents = 0;
      const localAbort = new AbortController();
      localAbort.signal.addEventListener("abort", () => { abortSignalEvents += 1; }, { once: true });
      localAbort.abort();
      const originalMapGet = Map.prototype.get;
      const originalMapSet = Map.prototype.set;
      let controllerMapTouches = 0;
      Map.prototype.get = function(...args) {
        controllerMapTouches += 1;
        return Reflect.apply(originalMapGet, this, args);
      };
      Map.prototype.set = function(...args) {
        controllerMapTouches += 1;
        return Reflect.apply(originalMapSet, this, args);
      };
      try { await pat.call("__prototype_poison_probe", {}); } catch {}
      Map.prototype.get = originalMapGet;
      Map.prototype.set = originalMapSet;
      return {
        exposedAmbient,
        exposedController,
        attempts,
        abortSignalEvents,
        controllerMapTouches,
        controllerLexicals: [typeof __post, typeof __listen, typeof __protocolToken],
      };
    `, 5_000, new AbortController().signal);
  }, [...DISPOSABLE_WORKER_AMBIENT_GLOBALS]);

  expect(observed.value).toEqual({
    exposedAmbient: [],
    exposedController: [],
    attempts: {
      fetch: "TypeError",
      xhr: "TypeError",
      font: "TypeError",
      dynamicImport: "TypeError",
      controllerRegistration: "TypeError",
      controllerDispatch: "TypeError",
    },
    abortSignalEvents: 1,
    controllerMapTouches: 0,
    controllerLexicals: ["undefined", "undefined", "undefined"],
  });
  expect(requests).toEqual([]);
});

test("workspace-program plaintext stays behind its exact manifest bridge", async ({ page }) => {
  const requests: Array<{ url: string; body: string | null }> = [];
  await page.route("**/__airship_workspace_egress_probe__*", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: "text/javascript", body: "export default 42;" });
  });
  await page.goto("/#chat");

  const observed = await page.evaluate(async (ambientNames) => {
    const [{ createWorkspaceToolRegistry }, { registerLazyExecutionTools }, { MemoryWorkspace }] = await Promise.all([
      import("/src/tools/workspace-tools.ts"),
      import("/src/tools/execution-tool-proxies.ts"),
      import("/src/workspace/memory.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/secret.txt", "WORKSPACE-PLAINTEXT-SECRET");
    const registry = createWorkspaceToolRegistry(workspace);
    registerLazyExecutionTools(registry, workspace);
    const argumentsValue = {
      code: `
        const mapTouches = [];
        const mapOriginals = {};
        for (const name of ["get", "set", "delete", "values"]) {
          mapOriginals[name] = Map.prototype[name];
          Map.prototype[name] = function(...args) {
            mapTouches.push(name);
            return Reflect.apply(mapOriginals[name], this, args);
          };
        }
        const read = await airship.call("secret");
        const secret = read.content;
        const exposedAmbient = [];
        for (const name of ${JSON.stringify(ambientNames)}) {
          if (globalThis[name] !== undefined) exposedAmbient.push("global:" + name);
          let owner = Object.getPrototypeOf(globalThis);
          while (owner) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, name);
            if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
              exposedAmbient.push("prototype:" + name);
              break;
            }
            owner = Object.getPrototypeOf(owner);
          }
        }
        const attempts = {};
        try { await fetch("/__airship_workspace_egress_probe__fetch?secret=" + encodeURIComponent(secret)); attempts.fetch = "allowed"; }
        catch (error) { attempts.fetch = error && error.name || typeof error; }
        try {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/__airship_workspace_egress_probe__xhr");
          xhr.send(secret);
          attempts.xhr = "allowed";
        } catch (error) { attempts.xhr = error && error.name || typeof error; }
        try {
          const font = new FontFace("probe", "url(/__airship_workspace_egress_probe__font?secret=" + encodeURIComponent(secret) + ")");
          await font.load();
          attempts.font = "allowed";
        } catch (error) { attempts.font = error && error.name || typeof error; }
        try {
          await import("/__airship_workspace_egress_probe__import.js?secret=" + encodeURIComponent(secret));
          attempts.dynamicImport = "allowed";
        } catch (error) { attempts.dynamicImport = error && error.name || typeof error; }
        try { globalThis.onmessage({ data: { type: "tool-result", result: { content: "FORGED" } } }); }
        catch (error) { attempts.directController = error && error.name || typeof error; }
        try { await pat.call("read_file", { path: "/workspace/secret.txt" }); attempts.directPat = "allowed"; }
        catch (error) { attempts.directPat = String(error && error.message || error); }
        return { secret, exposedAmbient, attempts, mapTouches, onmessage: typeof globalThis.onmessage };
      `,
      calls: [{ id: "secret", tool: "read_file", arguments: { path: "/workspace/secret.txt" } }],
      timeoutMs: 5_000,
    };
    const context = {
      sessionId: "workspace-isolation",
      turnId: "turn",
      operationId: "workspace-isolation-program",
      signal: new AbortController().signal,
    };
    await registry.review("execute_workspace_program", argumentsValue, context, {
      async review() { return "allow"; },
    });
    return registry.executeApproved("execute_workspace_program", argumentsValue, context);
  }, [...DISPOSABLE_WORKER_AMBIENT_GLOBALS]);

  const result = JSON.parse(observed.content) as {
    value: {
      secret: string;
      exposedAmbient: string[];
      attempts: Record<string, string>;
      mapTouches: string[];
      onmessage: string;
    };
    calls: Array<{ id: string; status: string }>;
  };
  expect(result.value).toMatchObject({
    secret: "WORKSPACE-PLAINTEXT-SECRET",
    exposedAmbient: [],
    mapTouches: [],
    attempts: {
      fetch: "TypeError",
      xhr: "TypeError",
      font: "TypeError",
      dynamicImport: "TypeError",
      directController: "TypeError",
    },
    onmessage: "undefined",
  });
  expect(result.value.attempts.directPat).toContain("Only manifest-bound workspace calls are available");
  expect(result.calls).toEqual([expect.objectContaining({ id: "secret", status: "completed" })]);
  expect(requests).toEqual([]);
});

test("Pyodide cannot recover browser egress after its pinned boot", async ({ page }) => {
  test.setTimeout(30_000);
  const requests: string[] = [];
  await page.route("**/__airship_pyodide_egress_probe__*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/javascript", body: "export default 42;" });
  });
  await page.goto("/#chat");

  const observed = await page.evaluate(async (ambientNames) => {
    const { runDisposablePyodide } = await import("/src/tools/execution-tools.ts");
    const code = `
from pathlib import Path
import js
all_names = ${JSON.stringify(ambientNames)}
secret = Path("secret.txt").read_text()
absent = []
for name in all_names:
    if getattr(js.globalThis, name, None) is None:
        absent.append(name)
owners = []
cursor = js.Object.getPrototypeOf(js.globalThis)
# Bound the walk and stop on Pyodide's falsey JsNull proxy.
for _ in range(16):
    if not cursor:
        break
    owners.append(cursor)
    cursor = js.Object.getPrototypeOf(cursor)
recovered = []
for name in ["fetch", "XMLHttpRequest", "FontFace", "fonts", "postMessage", "onmessage", "close"]:
    for owner in owners:
        descriptor = js.Object.getOwnPropertyDescriptor(owner, name)
        if descriptor and (
            getattr(descriptor, "value", None) is not None
            or getattr(descriptor, "get", None) is not None
            or getattr(descriptor, "set", None) is not None
        ):
            recovered.append(name)
            break
attempts = {}
origin = str(js.location.origin)
try:
    from pyodide.http import pyfetch
    await pyfetch(origin + "/__airship_pyodide_egress_probe__fetch?secret=" + secret)
    attempts["pyfetch"] = "allowed"
except Exception as error:
    attempts["pyfetch"] = type(error).__name__
try:
    from pyodide.code import run_js
    await run_js("import(" + repr(origin + "/__airship_pyodide_egress_probe__import.js?secret=" + secret) + ")")
    attempts["dynamicImport"] = "allowed"
except Exception as error:
    attempts["dynamicImport"] = type(error).__name__
try:
    import pyodide_js
    await pyodide_js.loadPackage(origin + "/__airship_pyodide_egress_probe__/probe-" + secret + "-py3-none-any.whl")
    attempts["loadPackage"] = "resolved"
except Exception as error:
    attempts["loadPackage"] = type(error).__name__
{"secret": secret, "absent": absent, "recovered": recovered, "attempts": attempts}
`;
    return runDisposablePyodide(
      code,
      [],
      {},
      20_000,
      new AbortController().signal,
      {
        workspace: {
          root: "/workspace",
          files: [{ path: "/workspace/secret.txt", content: "PYODIDE-PLAINTEXT-SECRET" }],
        },
      },
    );
  }, [...DISPOSABLE_WORKER_AMBIENT_GLOBALS]);

  expect(observed).toMatchObject({
    exitCode: 0,
    value: {
      secret: "PYODIDE-PLAINTEXT-SECRET",
      absent: [...DISPOSABLE_WORKER_AMBIENT_GLOBALS],
      recovered: [],
      attempts: { pyfetch: "TypeError", dynamicImport: "JsException", loadPackage: "resolved" },
    },
    workspaceFiles: [{ path: "/workspace/secret.txt", content: "PYODIDE-PLAINTEXT-SECRET" }],
  });
  expect(observed.stderr).toContain("fetch is not a function");
  expect(requests).toEqual([]);
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

test("a workspace-resident Rust artifact runs through the wasmPath channel and stays out of its own mount", async ({ page }) => {
  await page.goto("/#chat");
  const observed = await page.evaluate(async ({ wasmBase64 }) => {
    const [execution, workspaceModule, codec] = await Promise.all([
      import("/src/tools/execution-tools.ts"),
      import("/src/workspace/memory.ts"),
      import("/src/workspace/content-codec.ts"),
    ]);
    const binary = atob(wasmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

    const workspace = new workspaceModule.MemoryWorkspace();
    await workspace.write("/workspace/rust/tool.wasm", codec.encodeWorkspaceBytes(bytes));
    await workspace.write("/workspace/rust/input.txt", "browser workspace input\n");

    const result = await execution.getClientExecutionRuntime().execute({
      runtime: "wasi-preview1",
      wasmPath: "/workspace/rust/tool.wasm",
      args: ["workspace"],
      env: {},
      workspace,
      workspaceRoot: "/workspace/rust",
      writeBack: true,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });

    let missingArtifact = "unexpectedly completed";
    try {
      await execution.getClientExecutionRuntime().execute({
        runtime: "wasi-preview1",
        wasmPath: "/workspace/rust/absent.wasm",
        workspace,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
    } catch (error) {
      missingArtifact = error instanceof Error ? error.message : String(error);
    }

    return {
      result,
      output: (await workspace.read("/workspace/rust/output.txt"))?.content,
      artifactStillIntact: (await workspace.read("/workspace/rust/tool.wasm"))?.content.length,
      missingArtifact,
    };
  }, { wasmBase64: RUST_WASI_PREVIEW1_BASE64 });

  expect(observed.result).toMatchObject({
    runtime: "wasi-preview1",
    exitCode: 0,
    stdout: "rust-stdout:workspace\n",
    provenance: { artifactKind: "wasi-command" },
    workspace: {
      // The artifact itself is loaded through the separate 4 MiB artifact
      // budget and is deliberately not part of the mounted snapshot.
      mountedFiles: 1,
      changedPaths: ["/workspace/rust/output.txt"],
      writtenPaths: ["/workspace/rust/output.txt"],
      adopted: true,
    },
  });
  expect(observed.output).toBe("browser workspace input\n");
  expect(observed.artifactStillIntact).toBeGreaterThan(0);
  expect(observed.missingArtifact).toContain("not in the workspace");
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
      code: "void airship.call('late'); pat = { call: async () => ({ content: '{}'}) }; return 'scheduled';",
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
  ]));
  expect(capabilities.find(({ id }) => id === "node-webcontainer")?.state).not.toBe("ready");
});

test("the Prime JavaScript kernel runs only behind its exact worker response policy", async ({ page }) => {
  const probeRequests: string[] = [];
  const workerResponses: Promise<{ url: string; headers: Record<string, string> }>[] = [];
  await page.route("**/__airship_kernel_*", async (route) => {
    probeRequests.push(route.request().url());
    const isModule = new URL(route.request().url()).pathname.endsWith(".js");
    await route.fulfill({
      body: isModule ? "export default 99;" : "network unexpectedly reached",
      contentType: isModule ? "text/javascript" : "text/plain",
      status: 200,
    });
  });
  await page.route("**/__airship_page_function_probe__.js", async (route) => {
    await route.fulfill({
      body: `
        let result;
        try {
          result = { blocked: false, value: Function("return 6 * 7")(), error: "" };
        } catch (error) {
          result = {
            blocked: true,
            value: null,
            error: error instanceof Error ? error.name + ": " + error.message : String(error)
          };
        }
        export default result;
      `,
      contentType: "text/javascript",
      status: 200,
    });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.endsWith(".prime-kernel-worker.js")
      || url.searchParams.has("worker_file")
    ) {
      workerResponses.push(response.allHeaders().then((headers) => ({ url: response.url(), headers })));
    }
  });

  await page.goto("/#chat");
  const pageEvaluation = await page.evaluate(async () => (
    await import("/__airship_page_function_probe__.js")
  ).default);

  const observed = await page.evaluate(async () => {
    const { PrimeKernelHost } = await import("/src/prime/kernel/kernel-host.ts");
    const host = new PrimeKernelHost({
      ports: {
        bridge: {
          async call() {
            throw new Error("This isolation check declares no tool call.");
          },
        },
      },
    });
    try {
      const answer = await host.exec({
        code: "pat.ns.auditSentinel = 'must-not-persist'; return 6 * 7;",
        jobId: "browser-kernel-answer",
      });
      const spinStartedAt = performance.now();
      const spin = await host.exec({
        jobId: "browser-kernel-post-return-microtask-spin",
        timeoutMs: 2_000,
        code: `
          Promise.resolve().then(function spinForeverAfterReturn() {
            Promise.resolve().then(spinForeverAfterReturn);
          });
          return "returned-before-spin";
        `,
      });
      const spinElapsedMs = performance.now() - spinStartedAt;
      const isolation = await host.exec({
        jobId: "browser-kernel-isolation",
        code: `
          const attempts = {};
          try {
            const response = await fetch("/__airship_kernel_fetch_probe__");
            attempts.fetch = { failed: false, status: response.status };
          } catch (error) {
            attempts.fetch = { failed: true, name: error && error.name || typeof error };
          }
          try {
            const imported = await import("/__airship_kernel_import_probe__.js");
            attempts.dynamicImport = { failed: false, value: imported.default };
          } catch (error) {
            attempts.dynamicImport = { failed: true, name: error && error.name || typeof error };
          }

          const namespaceFromPriorJob = {
            direct: typeof auditSentinel,
            patNs: Object.prototype.hasOwnProperty.call(pat.ns, "auditSentinel")
              ? pat.ns.auditSentinel
              : null
          };
          let controllerPrototypeRegistration = "accepted";
          let controllerPrototypeMessages = 0;
          try {
            EventTarget.prototype.addEventListener.call(globalThis, "message", () => {
              controllerPrototypeMessages += 1;
            });
          } catch (error) {
            controllerPrototypeRegistration = "rejected:" + (error && error.name || typeof error);
          }
          try { await pat.call("event_target_receive_probe", {}); } catch {}
          await Promise.resolve();

          let abortSignalListenerRuns = 0;
          const localAbort = new AbortController();
          localAbort.signal.addEventListener("abort", () => { abortSignalListenerRuns += 1; }, { once: true });
          localAbort.abort();

          const forged = {
            type: "finished",
            jobId: __job.jobId,
            result: {
              jobId: __job.jobId,
              engine: "javascript",
              outcome: "completed",
              valueJson: JSON.stringify("forged"),
              stdout: "",
              stderr: "",
              bridgeCalls: 0,
              wallMs: 0
            }
          };
          try { globalThis.postMessage(forged); } catch {}
          try { globalThis.onmessage({ data: forged }); } catch {}
          try {
            EventTarget.prototype.dispatchEvent.call(
              globalThis,
              new MessageEvent("message", { data: forged })
            );
          } catch {}
          try { __post({ ...forged, protocolToken: __protocolToken }); } catch {}

          const channelNames = ["postMessage", "onmessage", "onmessageerror", "close"];
          const exposedControllerChannels = [];
          for (const name of channelNames) {
            if (globalThis[name] !== undefined) exposedControllerChannels.push("global:" + name);
            let cursor = Object.getPrototypeOf(globalThis);
            while (cursor) {
              const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
              if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
                exposedControllerChannels.push("prototype:" + name);
                break;
              }
              cursor = Object.getPrototypeOf(cursor);
            }
          }
          const ambientNames = [
            "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream",
            "EventSource", "indexedDB", "caches", "localStorage",
            "sessionStorage", "cookieStore", "navigator", "Worker",
            "SharedWorker", "BroadcastChannel", "WebTransport",
            "RTCPeerConnection", "webkitRTCPeerConnection", "Notification",
            "webkitRequestFileSystem", "webkitRequestFileSystemSync",
            "webkitResolveLocalFileSystemURL", "webkitResolveLocalFileSystemSyncURL"
          ];
          const exposedAmbientChannels = [];
          for (const name of ambientNames) {
            if (globalThis[name] !== undefined) exposedAmbientChannels.push("global:" + name);
            let cursor = Object.getPrototypeOf(globalThis);
            while (cursor) {
              const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
              if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) {
                exposedAmbientChannels.push("prototype:" + name);
                break;
              }
              cursor = Object.getPrototypeOf(cursor);
            }
          }
          const legacyFilesystemNames = [
            "webkitRequestFileSystem", "webkitRequestFileSystemSync",
            "webkitResolveLocalFileSystemURL", "webkitResolveLocalFileSystemSyncURL"
          ];
          const legacyFilesystemPersistentAbsent = [];
          for (const name of legacyFilesystemNames) {
            try { globalThis[name] = () => "restored"; } catch {}
            try { Object.defineProperty(globalThis, name, { value: () => "restored" }); } catch {}
            let exposed = globalThis[name] !== undefined;
            let cursor = Object.getPrototypeOf(globalThis);
            while (cursor) {
              const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
              if (descriptor && (descriptor.value !== undefined || descriptor.get || descriptor.set)) exposed = true;
              cursor = Object.getPrototypeOf(cursor);
            }
            if (!exposed) legacyFilesystemPersistentAbsent.push(name);
          }
          return {
            attempts,
            namespaceFromPriorJob,
            controllerPrototypeRegistration,
            controllerPrototypeMessages,
            abortSignalListenerRuns,
            exposedAmbientChannels,
            legacyFilesystemPersistentAbsent,
            exposedControllerChannels,
            genericControllerGlobals: [
              typeof globalThis.addEventListener,
              typeof globalThis.removeEventListener,
              typeof globalThis.dispatchEvent
            ],
            syntheticMessageTrusted: new MessageEvent("message").isTrusted,
            controllerLexicals: {
              direct: [typeof __post, typeof __protocolToken],
              indirect: (0, eval)("[typeof __post, typeof __protocolToken]"),
              constructed: Function("return [typeof __post, typeof __protocolToken]")()
            }
          };
        `,
      });
      const cancelHost = new PrimeKernelHost({
        ports: {
          bridge: {
            async call() { throw new Error("The cold-cancel probe declares no tool call."); },
          },
        },
      });
      const cancelEvents = [];
      cancelHost.onEvent((event) => { cancelEvents.push(event.type); });
      let coldCancellation;
      try {
        const pending = cancelHost.exec({
          code: "return 'RAN_AFTER_CANCEL';",
          jobId: "browser-kernel-cancel-during-boot",
          timeoutMs: 1_000,
        });
        const accepted = cancelHost.cancel("browser-kernel-cancel-during-boot", "cancelled during worker boot");
        const result = await pending;
        await new Promise((resolve) => setTimeout(resolve, 100));
        coldCancellation = {
          accepted,
          outcome: result.outcome,
          value: result.valueJson ? JSON.parse(result.valueJson) : null,
          started: cancelEvents.includes("started"),
        };
      } finally {
        await cancelHost.terminate("Cold cancellation probe complete.");
      }
      const activeCancelHost = new PrimeKernelHost({
        ports: {
          bridge: {
            async call() { throw new Error("The active-cancel probe declares no tool call."); },
          },
        },
      });
      const runCancellationProbe = async (jobId, code) => {
        let markStarted;
        const started = new Promise((resolve) => { markStarted = resolve; });
        const pending = activeCancelHost.exec(
          { code, jobId, timeoutMs: 2_000 },
          (event) => { if (event.type === "started") markStarted(); },
        );
        await started;
        const startedAt = performance.now();
        const accepted = activeCancelHost.cancel(jobId, "browser caller cancelled");
        const result = await pending;
        return {
          accepted,
          outcome: result.outcome,
          value: result.valueJson ? JSON.parse(result.valueJson) : null,
          error: result.error || "",
          elapsedMs: performance.now() - startedAt,
        };
      };
      let activeCancellation;
      try {
        const caught = await runCancellationProbe(
          "browser-kernel-caught-cancel",
          "try { await pat.sleep(1000); } catch {} return 'CAUGHT_CANCEL';",
        );
        const spinning = await runCancellationProbe(
          "browser-kernel-spinning-cancel",
          "while (true) {}",
        );
        activeCancellation = { caught, spinning };
      } finally {
        await activeCancelHost.terminate("Active cancellation probes complete.");
      }
      const raceHost = new PrimeKernelHost({
        budgets: { maxSourceChars: 32, maxJobWallMs: 100 },
        ports: {
          bridge: {
            async call() { throw new Error("The caller-snapshot probe declares no tool call."); },
          },
        },
      });
      let callerSnapshot;
      try {
        const mutableSpec = {
          code: "return 'SAFE_SNAPSHOT';",
          jobId: "browser-kernel-caller-snapshot",
          timeoutMs: 50,
        };
        const admitted = raceHost.exec(mutableSpec);
        mutableSpec.code = "await pat.sleep(250); return 'MUTATED_AFTER_ADMISSION';";
        mutableSpec.jobId = "browser-kernel-mutated-job";
        mutableSpec.timeoutMs = 1_000;
        const result = await admitted;
        callerSnapshot = {
          jobId: result.jobId,
          outcome: result.outcome,
          value: result.valueJson ? JSON.parse(result.valueJson) : null,
          wallMs: result.wallMs,
        };
      } finally {
        await raceHost.terminate("Caller snapshot probe complete.");
      }
      return {
        coldCancellation,
        activeCancellation,
        callerSnapshot,
        answer: {
          outcome: answer.outcome,
          value: answer.valueJson ? JSON.parse(answer.valueJson) : null,
        },
        spin: {
          outcome: spin.outcome,
          value: spin.valueJson ? JSON.parse(spin.valueJson) : null,
          elapsedMs: spinElapsedMs,
        },
        description: host.describe(),
        isolation: {
          outcome: isolation.outcome,
          value: isolation.valueJson ? JSON.parse(isolation.valueJson) : null,
          error: isolation.error ?? null,
        },
      };
    } finally {
      await host.terminate("Browser kernel policy check complete.");
    }
  });

  expect(pageEvaluation.blocked).toBe(true);
  expect(pageEvaluation.value).toBeNull();
  expect(pageEvaluation.error).toMatch(/EvalError|Content Security Policy/iu);
  expect(observed.coldCancellation).toEqual({
    accepted: true,
    outcome: "cancelled",
    value: null,
    started: false,
  });
  expect(observed.activeCancellation.caught).toMatchObject({
    accepted: true,
    outcome: "cancelled",
    value: null,
  });
  expect(observed.activeCancellation.caught.elapsedMs).toBeLessThan(500);
  expect(observed.activeCancellation.spinning).toMatchObject({
    accepted: true,
    outcome: "cancelled",
    value: null,
  });
  expect(observed.activeCancellation.spinning.error).toContain("hard-terminated");
  expect(observed.activeCancellation.spinning.elapsedMs).toBeLessThan(500);
  expect(observed.callerSnapshot).toMatchObject({
    jobId: "browser-kernel-caller-snapshot",
    outcome: "completed",
    value: "SAFE_SNAPSHOT",
  });
  expect(observed.callerSnapshot.wallMs).toBeLessThan(100);
  expect(observed.answer).toEqual({ outcome: "completed", value: 42 });
  expect(observed.spin.outcome).toBe("completed");
  expect(observed.spin.value).toBe("returned-before-spin");
  expect(observed.spin.elapsedMs).toBeLessThan(2_000);
  expect(observed.description).toMatchObject({
    state: "ready",
    engine: "javascript",
    generation: 3,
    persistence: "job",
  });
  expect(observed.isolation).toEqual({
    outcome: "completed",
    value: {
      attempts: {
        fetch: { failed: true, name: "TypeError" },
        dynamicImport: { failed: true, name: "TypeError" },
      },
      namespaceFromPriorJob: { direct: "undefined", patNs: null },
      controllerPrototypeRegistration: "rejected:TypeError",
      controllerPrototypeMessages: 0,
      abortSignalListenerRuns: 1,
      exposedAmbientChannels: [],
      legacyFilesystemPersistentAbsent: [
        "webkitRequestFileSystem",
        "webkitRequestFileSystemSync",
        "webkitResolveLocalFileSystemURL",
        "webkitResolveLocalFileSystemSyncURL",
      ],
      exposedControllerChannels: [],
      genericControllerGlobals: ["undefined", "undefined", "undefined"],
      syntheticMessageTrusted: false,
      controllerLexicals: {
        direct: ["undefined", "undefined"],
        indirect: ["undefined", "undefined"],
        constructed: ["undefined", "undefined"],
      },
    },
    error: null,
  });
  expect(probeRequests).toEqual([]);

  const responseEvidence = await Promise.all(workerResponses);
  expect(responseEvidence.length).toBeGreaterThanOrEqual(2);
  for (const { url, headers } of responseEvidence) {
    expect(headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
    );
    expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(new URL(url).hash).toBe("");
    expect(new URL(url).searchParams.has("protocolToken")).toBe(false);
    expect(new URL(url).searchParams.has("token")).toBe(false);
  }
});

test("the explicit Pyodide pack runs real Python in a fresh bounded worker", async ({ page }) => {
  // Every job in this gate boots its own interpreter on purpose; the pack is
  // disposable per job, so the wall clock is several cold starts, not one.
  test.setTimeout(150_000);
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
    const sameSessionExecution = await module.executeExecutionTool(
      "execute_code",
      { runtime: "python-pyodide", code: "40 + 2", timeoutMs: 10_000 },
      {
        sessionId: "baseline-session",
        turnId: "activation-turn",
        operationId: "execute-python",
        capabilityTier: "web-baseline",
        signal: controller.signal,
      },
    );
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
    const overflowWorkspace = new workspaceModule.MemoryWorkspace();
    await overflowWorkspace.write("projects/overflow/input.txt", "keep\n");
    const overflow = await module.executeExecutionTool(
      "execute_code",
      {
        runtime: "python-pyodide",
        code: "from pathlib import Path\nPath('big.bin').write_bytes(b'x' * 600_000)\nprint('ok')",
        workspaceRoot: "/workspace/projects/overflow",
        writeBack: true,
        timeoutMs: 10_000,
      },
      {
        sessionId: "enhanced-session",
        turnId: "overflow-turn",
        operationId: "overflow-python",
        capabilityTier: "web-enhanced",
        signal: controller.signal,
      },
      overflowWorkspace,
    );

    const guardWorkspace = new workspaceModule.MemoryWorkspace();
    await guardWorkspace.write("projects/guard/input.txt", "keep\n");
    const guarded = await module.getClientExecutionRuntime().execute({
      runtime: "python-pyodide",
      code: "import os\nos.makedirs('.git', exist_ok=True)\nopen('.git/config', 'w').write('[core]\\n')\nprint('guarded')",
      workspace: guardWorkspace,
      workspaceRoot: "/workspace/projects/guard",
      writeBack: true,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    return {
      before,
      activation,
      sameSessionExecution,
      execution,
      executionBootMs: execution.bootMs,
      boundedOutputChars: bounded.stdout.length,
      project,
      writtenResult: (await workspace.read("projects/python/result.txt"))?.content,
      writtenBlob: [...codec.decodeWorkspaceBytes((await workspace.read("projects/python/blob.bin"))!.content)],
      overflow,
      overflowResult: JSON.parse(overflow.content) as Record<string, unknown>,
      overflowInput: (await overflowWorkspace.read("projects/overflow/input.txt"))?.content,
      overflowAdoptedBigFile: Boolean(await overflowWorkspace.read("projects/overflow/big.bin")),
      guarded,
      adoptedGitConfig: Boolean(await guardWorkspace.read("projects/guard/.git/config")),
    };
  });

  expect(result.before).toMatchObject({
    state: "ready",
    isolation: "disposable-worker",
    persistence: "ephemeral",
  });
  expect(result.activation.metadata).toMatchObject({
    usableNow: true,
    requiresNewConversation: false,
    initialCapabilityTier: "web-baseline",
    liveCapabilityTier: "web-enhanced",
  });
  expect(JSON.parse(result.activation.content)).toMatchObject({
    usableNow: true,
    sessionCompatibility: "ready-in-current-session",
  });
  expect(JSON.parse(result.sameSessionExecution.content)).toMatchObject({
    runtime: "python-pyodide",
    exitCode: 0,
    value: 42,
    provenance: { capabilityTier: "web-enhanced", authority: "browser" },
  });
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
  // The interpreter cold start is real and is budgeted outside the job's own
  // timeoutMs, so it is reported rather than charged silently.
  expect(result.executionBootMs).toBeGreaterThan(0);
  // A job that ran correctly but generated an over-budget file keeps its exit
  // code and output, adopts nothing, and is still reported as an error.
  expect(result.overflow.isError).toBe(true);
  expect(result.overflowResult).toMatchObject({
    exitCode: 0,
    stdout: "ok\n",
    workspace: { changedPaths: [], writtenPaths: [], adopted: false },
  });
  expect(String((result.overflowResult.workspace as Record<string, unknown>).workspaceError)).toContain("512 KiB");
  expect(result.overflowInput).toBe("keep\n");
  expect(result.overflowAdoptedBigFile).toBe(false);
  // Python writeback cannot adopt the browser Git or Airship control plane —
  // and refusing that one path does not destroy the completed run.
  expect(result.guarded).toMatchObject({ exitCode: 0, stdout: "guarded\n" });
  expect(result.guarded.workspace?.refusedPaths).toEqual(["/workspace/projects/guard/.git/config"]);
  expect(String(result.guarded.workspace?.refusalReason)).toContain("control-plane");
  expect(result.adoptedGitConfig).toBe(false);
});
