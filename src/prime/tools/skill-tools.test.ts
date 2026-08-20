/**
 * prime_skills tool tests. The python-call flow runs through a REAL
 * PrimeKernelHost fronting a scripted in-process worker (the
 * kernel-host.test.ts pattern): the host owns dispatch, job
 * serialization, bridge routing, and cancellation; the worker scripts
 * the worker-side responses, including the ready handshake's engine
 * announcement.
 *
 * Engine honesty in tests: PrimeKernelHost.description() currently
 * hardcodes engine "javascript" and DROPS the engine the worker
 * announces at ready. The `pyodidePort` adapter below reports the engine
 * the scripted worker actually announced (a pyodide-simulating worker),
 * which is honest about its own world — the same message the production
 * host will stop dropping when a real pyodide engine lands. The
 * javascript-engine test passes the bare host as the port, proving both
 * the structural fit and the python_engine_unavailable gate under the
 * only engine that exists today.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolExecutionResult } from "../../core/contracts";
import type { KernelEngine, KernelJobResult } from "../kernel/kernel-contract";
import type { KernelWorkerLike } from "../kernel/kernel-host";
import { PrimeKernelHost } from "../kernel/kernel-host";
import { InMemoryHarnessStore } from "../harness/store";
import { FakeWorkspacePort, makeToolContext } from "./test-utils.test-support";
import {
  PRIME_SKILL_RESULT_BEGIN,
  PRIME_SKILL_RESULT_END,
  buildPrimeSkillInvokeJobCode,
  buildPrimeSkillMaterializeJobCode,
  canonicalPrimeSkillModuleSource,
  createPrimeSkillsTool,
  extractPrimeSkillResultEnvelope,
  planPrimeSkillInvocation,
  type PrimeSkillKernelPort,
} from "./skill-tools";
import { PRIME_SKILL_UNAVAILABLE_REMEDY, PrimeSkillRegistry } from "./skills";

const MAX_MODULE_SOURCE_BYTES = 96 * 1_024;

type ScriptedWorker = KernelWorkerLike & {
  listeners: { message: ((event: { data?: unknown }) => void)[]; error: ((event: { message?: string }) => void)[] };
  emit(message: unknown): void;
  posted: unknown[];
  terminated: boolean;
};

type InvokeScript = Readonly<{ stdout: string; stderr?: string; outcome?: "completed" | "failed"; error?: string }>;

type WorkerOptions = Readonly<{
  onInvoke?: (job: { jobId: string; code: string }) => InvokeScript;
  onMaterialize?: (job: { jobId: string; code: string }) => InvokeScript;
}>;

const DEFAULT_INVOKE: InvokeScript = {
  stdout: [
    "search ran for: x",
    `${PRIME_SKILL_RESULT_BEGIN}{"ok":true,"value":{"search_results":[],"query":"x"},"repr":"{'search_results': [], 'query': 'x'}"}${PRIME_SKILL_RESULT_END}`,
  ].join("\n"),
};

function makeSkillWorker(options: WorkerOptions = {}): ScriptedWorker {
  const listeners = {
    message: [] as ((event: { data?: unknown }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
  const posted: unknown[] = [];
  const finish = (jobId: string, script: InvokeScript): void => {
    if (script.stdout !== "") worker.emit({ type: "stdout", jobId, text: script.stdout });
    if (script.stderr !== undefined && script.stderr !== "") worker.emit({ type: "stderr", jobId, text: script.stderr });
    const outcome = script.outcome ?? "completed";
    worker.emit({
      type: "finished",
      jobId,
      result: {
        jobId,
        engine: "pyodide",
        outcome,
        ...(outcome === "completed" ? { valueJson: "null" } : {}),
        ...(script.error !== undefined ? { error: script.error } : {}),
        stdout: script.stdout,
        stderr: script.stderr ?? "",
        bridgeCalls: 0,
        wallMs: 3,
      } satisfies KernelJobResult,
    });
  };
  const worker: ScriptedWorker = {
    listeners,
    posted,
    terminated: false,
    emit(message: unknown) {
      for (const listener of listeners.message) listener({ data: message });
    },
    postMessage(message: unknown) {
      posted.push(message);
      const data = message as { type?: string; job?: { jobId: string; code: string } };
      if (data.type !== "exec" || data.job === undefined) return;
      const { jobId, code } = data.job;
      if (code.includes("_prime_skill_emit")) {
        finish(jobId, options.onInvoke === undefined ? DEFAULT_INVOKE : options.onInvoke({ jobId, code }));
        return;
      }
      if (code.includes("_prime_skill_os")) {
        finish(jobId, options.onMaterialize?.({ jobId, code }) ?? { stdout: "materialized 1 skill module file(s) under /prime-skills" });
        return;
      }
      finish(jobId, { stdout: "" });
    },
    terminate() {
      worker.terminated = true;
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") listeners.message.push(listener as (event: { data?: unknown }) => void);
      if (type === "error") listeners.error.push(listener as (event: { message?: string }) => void);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      const bucket = type === "message" ? listeners.message : listeners.error;
      const idx = bucket.indexOf(listener as never);
      if (idx >= 0) bucket.splice(idx, 1);
    },
  };
  return worker;
}

function makeHost(worker: ScriptedWorker): PrimeKernelHost {
  return new PrimeKernelHost({
    ports: {
      bridge: { call: async (request) => ({ seq: request.seq, ok: true, content: "{}" }) },
      workerFactory: () => worker,
      randomId: (() => {
        let n = 0;
        return (prefix: string) => `${prefix}-${++n}`;
      })(),
    },
  });
}

async function bootHost(host: PrimeKernelHost, worker: ScriptedWorker, engine: KernelEngine): Promise<void> {
  const boot = host.start();
  worker.emit({ type: "ready", engine });
  await boot;
}

/**
 * The engine-honest adapter: reports the engine the scripted worker
 * announced at ready, delegates everything else (exec, cancel) to the
 * real host unchanged.
 */
function announcedEnginePort(host: PrimeKernelHost, engine: KernelEngine): PrimeSkillKernelPort {
  return {
    description: () => ({ state: host.description().state, engine }),
    exec: (spec, listener) => host.exec(spec, listener),
    cancel: (jobId: string, reason?: string) => host.cancel(jobId, reason),
  } as PrimeSkillKernelPort;
}

const WEB_SEARCH_MD = [
  "---",
  "name: web-search",
  "description: Search the web. Use when the task needs current facts.",
  "---",
  "",
  "# Web Search",
  "",
  "Run the search and read the snippets.",
].join("\n");

const MODULE_CODE = "def run(query: str = \"\"):\n    return {\"search_results\": [], \"query\": query}\n";

function makeRegistry(): PrimeSkillRegistry {
  const registry = new PrimeSkillRegistry();
  registry.register({
    type: "skill-md",
    skillMd: WEB_SEARCH_MD,
    baseDir: "skills/web-search",
    source: "test",
    python: { codeOrigin: { type: "workspace-file", path: "/workspace/skills/web_search.py" } },
  });
  registry.register({
    type: "skill-md",
    skillMd: "---\nname: style-guide\ndescription: Enforce the house style.\n---\n\n# Style\n\nBe brief.",
    source: "test",
  });
  return registry;
}

function makeWorkspace(): FakeWorkspacePort {
  return new FakeWorkspacePort({ "/workspace/skills/web_search.py": MODULE_CODE });
}

async function resultOf(tool: Tool, args: Record<string, JsonValue>, operationId = "op-1"): Promise<ToolExecutionResult> {
  return tool.execute(args as JsonValue, makeToolContext({ operationId }));
}

describe("prime_skills list / read", () => {
  it("lists the registry overview with engine posture and recorded unavailability", async () => {
    const registry = makeRegistry();
    registry.recordImportError("web_search", "ModuleNotFoundError: No module named 'httpx'");
    const tool = createPrimeSkillsTool(registry, {});
    const result = await resultOf(tool, { action: "list" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("2 skill(s) registered (1 python, 1 markdown).");
    expect(result.content).toContain("python engine: not attached");
    expect(result.content).toContain("- web-search (python, import web_search, test)");
    expect(result.content).toContain("UNAVAILABLE: ModuleNotFoundError: No module named 'httpx'");
    expect(result.content).toContain(`Remedy: ${PRIME_SKILL_UNAVAILABLE_REMEDY}`);
    expect(result.metadata).toMatchObject({ count: 2, shown: 2, pythonEngine: null });
  });

  it("reads one skill with its frontmatter facts and body, bounded with a leading notice", async () => {
    const registry = makeRegistry();
    const tool = createPrimeSkillsTool(registry, {});
    const result = await resultOf(tool, { action: "read", name: "web-search" });
    expect(result.content).toContain("# Skill: web-search");
    expect(result.content).toContain("kind: python (import web_search, origin workspace file /workspace/skills/web_search.py");
    expect(result.content).toContain("description: Search the web.");
    expect(result.content).toContain("location: skills/web-search/SKILL.md");
    expect(result.content).toContain("# Web Search");
    expect(result.metadata).toMatchObject({ skill: "web-search", kind: "python", truncated: false });
  });

  it("read bounds oversized bodies with the notice leading and kept/total named", async () => {
    const registry = new PrimeSkillRegistry();
    const body = `# Big\n\n${"instruction line\n".repeat(4_096)}`; // 7 + 4096*17 = 69639, and the parsed body drops the trailing newline
    registry.register({
      type: "skill-md",
      skillMd: `---\nname: big-skill\ndescription: A large instruction set.\n---\n\n${body}`,
    });
    const tool = createPrimeSkillsTool(registry, {});
    const result = await resultOf(tool, { action: "read", name: "big-skill" });
    expect(result.metadata).toMatchObject({ truncated: true, bodyChars: body.trimEnd().length });
    const noticeAt = result.content.indexOf("skill instructions truncated: kept first 65536");
    const bodyStart = result.content.indexOf("# Big");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(noticeAt);
  });

  it("read/list refuse unknown skills with the registered names", async () => {
    const registry = makeRegistry();
    const tool = createPrimeSkillsTool(registry, {});
    const result = await resultOf(tool, { action: "read", name: "missing" });
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ error: { code: "skill_not_found" } });
    expect(result.content).toContain("web-search");
  });

  it("call refuses markdown skills with the read remedy, and unknown skills", async () => {
    const registry = makeRegistry();
    const tool = createPrimeSkillsTool(registry, {});
    const markdown = await resultOf(tool, { action: "call", name: "style-guide" });
    expect(markdown.metadata).toMatchObject({ error: { code: "skill_not_callable", kind: "markdown" } });
    expect(markdown.content).toContain('prime_skills {"action":"read","name":"style-guide"}');
    const missing = await resultOf(tool, { action: "call", name: "nope" });
    expect(missing.metadata).toMatchObject({ error: { code: "skill_not_found" } });
  });
});

describe("prime_skills call — engine and kernel gating", () => {
  it("refuses without any kernel attached", async () => {
    const registry = makeRegistry();
    const tool = createPrimeSkillsTool(registry, { workspace: makeWorkspace() });
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ error: { code: "kernel_not_attached" } });
  });

  it("names python_engine_unavailable under the javascript engine and posts no job", async () => {
    const registry = makeRegistry();
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "javascript");
    // The bare host IS the port: the only engine that exists today, honestly reported.
    const tool = createPrimeSkillsTool(registry, { kernel: host, workspace: makeWorkspace() });
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({
      error: { code: "python_engine_unavailable", engine: "javascript", capability: "python-skill-call", capabilityAvailable: false },
    });
    expect(result.content).toContain("pyodide kernel engine");
    expect(result.content).toContain("Remedy: start the session kernel with the pyodide engine");
    const execPosts = worker.posted.filter((message) => (message as { type?: string }).type === "exec");
    expect(execPosts).toHaveLength(0);
  });

  it("names kernel_not_ready on a stopped kernel", async () => {
    const registry = makeRegistry();
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    await host.terminate("test shutdown");
    const tool = createPrimeSkillsTool(registry, { kernel: announcedEnginePort(host, "pyodide"), workspace: makeWorkspace() });
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.metadata).toMatchObject({ error: { code: "kernel_not_ready", kernelState: "stopped" } });
    expect(result.content).toContain("Remedy: restart the kernel");
  });
});

describe("prime_skills call — module origin resolution", () => {
  it("named errors cover the whole origin-resolution table", async () => {
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const kernel = announcedEnginePort(host, "pyodide");

    // module file absent
    {
      const tool = createPrimeSkillsTool(makeRegistry(), { kernel, workspace: new FakeWorkspacePort({}) });
      const result = await resultOf(tool, { action: "call", name: "web-search" });
      expect(result.metadata).toMatchObject({ error: { code: "module_source_missing", origin: "workspace-file" } });
    }
    // module file over the materialization bound
    {
      const big = new FakeWorkspacePort({ "/workspace/skills/web_search.py": `# ${"x".repeat(MAX_MODULE_SOURCE_BYTES)}` });
      const tool = createPrimeSkillsTool(makeRegistry(), { kernel, workspace: big });
      const result = await resultOf(tool, { action: "call", name: "web-search" });
      expect(result.metadata).toMatchObject({ error: { code: "module_source_too_large" } });
      expect(result.content).toContain("98304-byte materialization bound");
    }
    // control-plane paths are refused, never read
    {
      const registry = new PrimeSkillRegistry();
      registry.register({
        type: "skill-md",
        skillMd: WEB_SEARCH_MD,
        python: { codeOrigin: { type: "workspace-file", path: "/workspace/.airship/private/module.py" } },
      });
      const ws = new FakeWorkspacePort({ "/workspace/.airship/private/module.py": "def run():\n    return 1\n" });
      const tool = createPrimeSkillsTool(registry, { kernel, workspace: ws });
      const result = await resultOf(tool, { action: "call", name: "web-search" });
      expect(result.metadata).toMatchObject({ error: { code: "control_plane_refusal" } });
      expect(result.content).toContain("control-plane");
    }
    // pack not found (provider absent, then provider returning undefined)
    {
      const registry = new PrimeSkillRegistry();
      registry.register({
        type: "skill-md",
        skillMd: WEB_SEARCH_MD,
        python: { codeOrigin: { type: "pack", pack: "missing-pack" } },
      });
      const noProvider = createPrimeSkillsTool(registry, { kernel });
      expect((await resultOf(noProvider, { action: "call", name: "web-search" })).metadata).toMatchObject({ error: { code: "pack_not_found" } });
      const withProvider = createPrimeSkillsTool(registry, { kernel, packs: () => undefined });
      expect((await resultOf(withProvider, { action: "call", name: "web-search" })).metadata).toMatchObject({ error: { code: "pack_not_found" } });
    }
  });

  it("argument guards are named and fire before any job", async () => {
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(makeRegistry(), { kernel: announcedEnginePort(host, "pyodide"), workspace: makeWorkspace() });
    const badKey = await resultOf(tool, { action: "call", name: "web-search", arguments: { "bad key": 1 } });
    expect(badKey.metadata).toMatchObject({ error: { code: "arguments_invalid" } });
    const tooLarge = await resultOf(tool, { action: "call", name: "web-search", arguments: { blob: "x".repeat(70 * 1_024) } });
    expect(tooLarge.metadata).toMatchObject({ error: { code: "arguments_too_large" } });
    expect(worker.posted.filter((message) => (message as { type?: string }).type === "exec")).toHaveLength(0);
  });
});

describe("prime_skills call — scripted workerFactory flow", () => {
  it("materializes then invokes the module through the kernel, returning the envelope value", async () => {
    const registry = makeRegistry();
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const context = makeToolContext({ operationId: "op-call-1" });
    const tool = createPrimeSkillsTool(registry, { kernel: announcedEnginePort(host, "pyodide"), workspace: makeWorkspace() });
    const result = await tool.execute({ action: "call", name: "web-search", arguments: { query: "x" } }, context);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('Skill "web-search" call completed');
    expect(result.content).toContain("[result]");
    expect(result.content).toContain('"query": "x"');
    expect(result.metadata).toMatchObject({
      skill: "web-search",
      importName: "web_search",
      engine: "pyodide",
      materializeJobId: "prime-skill-op-call-1-materialize",
      invokeJobId: "prime-skill-op-call-1-invoke",
    });

    const execPosts = worker.posted
      .map((message) => message as { type?: string; job?: { jobId: string; code: string } })
      .filter((message) => message.type === "exec");
    expect(execPosts).toHaveLength(2);
    const [materialize, invoke] = execPosts.map((message) => message.job!);
    expect(materialize.jobId).toBe("prime-skill-op-call-1-materialize");
    expect(materialize.code).toContain("_prime_skill_os.makedirs");
    expect(materialize.code).toContain("web_search.py");
    expect(materialize.code).toContain("b64decode");
    expect(materialize.code).toContain("/prime-skills");
    expect(invoke.jobId).toBe("prime-skill-op-call-1-invoke");
    expect(invoke.code).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS");
    expect(invoke.code).toContain('_prime_skill_name = "web_search"');
    // The default reference is callable "run", resolved through the dotted-attribute chain.
    expect(invoke.code).toContain('for _prime_skill_attr in ["run"]:');
    expect(invoke.code).toContain("_prime_skill_target = getattr(_prime_skill_target, _prime_skill_attr)");
    // live stdout frames were forwarded to the presentation observer
    expect(context.output.some((chunk) => chunk.text.includes("search ran for: x"))).toBe(true);
  });

  it("call_pattern references materialize the documented call form", async () => {
    const registry = new PrimeSkillRegistry();
    registry.register({
      type: "skill-md",
      skillMd: "---\nname: adder\ndescription: Adds two numbers.\n---\nusage",
      python: {
        codeOrigin: { type: "pack", pack: "adder-pack" },
        reference: { type: "python", import: "adder", call_pattern: "await {callable}(**{args})" },
      },
    });
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(registry, {
      kernel: announcedEnginePort(host, "pyodide"),
      packs: (name) => (name === "adder-pack" ? { importName: "adder", files: [{ path: "adder.py", content: "def run(a=0, b=0):\n    return a + b\n" }] } : undefined),
    });
    const result = await resultOf(tool, { action: "call", name: "adder", arguments: { a: 2, b: 3 } });
    expect(result.isError).not.toBe(true);
    const invokePosts = worker.posted
      .map((message) => message as { type?: string; job?: { jobId: string; code: string } })
      .filter((message) => message.type === "exec" && message.job!.code.includes("_prime_skill_emit"));
    expect(invokePosts).toHaveLength(1);
    expect(invokePosts[0].job!.code).toContain("_prime_skill_result = await (getattr(_prime_skill_module, \"run\", None) or _prime_skill_module)(**_prime_skill_args)");
  });

  it("call_pattern without placeholders is named unavailable before any job", async () => {
    const registry = new PrimeSkillRegistry();
    registry.register({
      type: "skill-md",
      skillMd: "---\nname: adder\ndescription: Adds two numbers.\n---\nusage",
      python: {
        codeOrigin: { type: "pack", pack: "adder-pack" },
        reference: { type: "python", import: "adder", call_pattern: "await adder.run(1, 2)" },
      },
    });
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(registry, {
      kernel: announcedEnginePort(host, "pyodide"),
      packs: () => ({ importName: "adder", files: [{ path: "adder.py", content: "def run():\n    return 0\n" }] }),
    });
    const result = await resultOf(tool, { action: "call", name: "adder", arguments: {} });
    expect(result.metadata).toMatchObject({ error: { code: "call_pattern_without_placeholders" } });
    expect(result.content).toContain("Remedy: add a callable");
    expect(worker.posted.filter((message) => (message as { type?: string }).type === "exec")).toHaveLength(0);
  });

  it("harness-entry origins resolve module code from the harness store", async () => {
    const store = new InMemoryHarnessStore({ now: Date.now });
    const created = await store.create("local", {
      id: "sys-stats",
      title: "System statistics",
      content: "def run():\n    return 42\n",
      kind: "skill",
      reference: { type: "python", import: "sys_stats", callable: "run" },
      arguments: {},
    });
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({ type: "harness-entry", entry: created });
    expect(skill?.kind).toBe("python");
    const worker = makeSkillWorker();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(registry, { kernel: announcedEnginePort(host, "pyodide"), harnessStore: store });
    const ok = await resultOf(tool, { action: "call", name: "sys-stats" });
    expect(ok.isError).not.toBe(true);
    await store.delete("local", "skill", created.id);
    const missing = await resultOf(tool, { action: "call", name: "sys-stats" });
    expect(missing.metadata).toMatchObject({ error: { code: "harness_entry_missing" } });
  });

  it("materialize failure is named with the job outcome", async () => {
    const worker = makeSkillWorker({
      onMaterialize: () => ({ stdout: "", outcome: "failed", error: "Read-only file system" }),
    });
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(makeRegistry(), { kernel: announcedEnginePort(host, "pyodide"), workspace: makeWorkspace() });
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.metadata).toMatchObject({ error: { code: "skill_materialize_failed", outcome: "failed" } });
    expect(result.content).toContain("Read-only file system");
  });
});

describe("prime_skills call — failure and import-error ledger", () => {
  async function pyodideTool(worker: ScriptedWorker) {
    const registry = makeRegistry();
    const host = makeHost(worker);
    await bootHost(host, worker, "pyodide");
    const tool = createPrimeSkillsTool(registry, { kernel: announcedEnginePort(host, "pyodide"), workspace: makeWorkspace() });
    return { registry, tool, worker };
  }

  it("import errors record per-name reasons; later calls refuse with remedy and post nothing", async () => {
    const { registry, tool, worker } = await pyodideTool(makeSkillWorker({
      onInvoke: () => ({
        stdout: `${PRIME_SKILL_RESULT_BEGIN}{"ok":false,"stage":"import","importName":"web_search","error":"ModuleNotFoundError: No module named 'httpx'"}${PRIME_SKILL_RESULT_END}`,
      }),
    }));
    const first = await resultOf(tool, { action: "call", name: "web-search" });
    expect(first.isError).toBe(true);
    expect(first.metadata).toMatchObject({ error: { code: "skill_import_failed", importName: "web_search", recorded: true } });
    expect(first.content).toContain("httpx");
    expect(first.content).toContain(`Remedy: ${PRIME_SKILL_UNAVAILABLE_REMEDY}`);
    expect(registry.importErrors().web_search.reason).toContain("httpx");
    expect(registry.importErrors().web_search.skillName).toBe("web-search");

    const before = worker.posted.length;
    const second = await resultOf(tool, { action: "call", name: "web-search" });
    expect(second.metadata).toMatchObject({ error: { code: "python_skill_unavailable", importName: "web_search" } });
    expect(second.content).toContain("Import error recorded");
    expect(worker.posted.length).toBe(before);

    const list = await resultOf(tool, { action: "list" });
    expect(list.content).toContain("UNAVAILABLE: ModuleNotFoundError: No module named 'httpx'");
    const read = await resultOf(tool, { action: "read", name: "web-search" });
    expect(read.content).toContain("unavailable: ModuleNotFoundError: No module named 'httpx'");
    expect(read.content).toContain(`remedy: ${PRIME_SKILL_UNAVAILABLE_REMEDY}`);
    expect(read.metadata).toMatchObject({ unavailable: "ModuleNotFoundError: No module named 'httpx'" });
  });

  it("invoke failures surface the exception with the sectioned output", async () => {
    const { tool } = await pyodideTool(makeSkillWorker({
      onInvoke: () => ({
        stdout: `${PRIME_SKILL_RESULT_BEGIN}{"ok":false,"stage":"invoke","error":"boom","ename":"ValueError"}${PRIME_SKILL_RESULT_END}`,
      }),
    }));
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ error: { code: "skill_invoke_failed", ename: "ValueError" } });
    expect(result.content).toContain("Skill \"web-search\" call raised inside its invoke job");
    expect(result.content).toContain("[error]\nValueError: boom");
  });

  it("a completed job without an envelope is named, with bounded output attached", async () => {
    const { tool } = await pyodideTool(makeSkillWorker({
      onInvoke: () => ({ stdout: "garbage output without the sentinel" }),
    }));
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ error: { code: "result_envelope_missing" } });
    expect(result.content).toContain("garbage output without the sentinel");
  });

  it("a crashed invoke job is named with the job outcome", async () => {
    const { tool } = await pyodideTool(makeSkillWorker({
      onInvoke: () => ({ stdout: "", outcome: "failed", error: "killed by budget" }),
    }));
    const result = await resultOf(tool, { action: "call", name: "web-search" });
    expect(result.metadata).toMatchObject({ error: { code: "skill_call_failed", outcome: "failed" } });
    expect(result.content).toContain("killed by budget");
  });
});

describe("invocation planning and builders", () => {
  it("planPrimeSkillInvocation: callable wins, bare references get the module-wrap plan", () => {
    expect(planPrimeSkillInvocation({ type: "python", import: "x", callable: "search.run" })).toEqual({ ok: true, plan: { kind: "callable", callable: "search.run" } });
    expect(planPrimeSkillInvocation({ type: "python", import: "x" })).toEqual({ ok: true, plan: { kind: "callable" } });
    expect(planPrimeSkillInvocation({ type: "python", import: "x", callPattern: "await {callable}(**{args})" })).toEqual({ ok: true, plan: { kind: "pattern", pattern: "await {callable}(**{args})" } });
    const docsOnly = planPrimeSkillInvocation({ type: "python", import: "x", callPattern: "await x.run(1)" });
    expect(docsOnly.ok).toBe(false);
    if (!docsOnly.ok) expect(docsOnly.code).toBe("call_pattern_without_placeholders");
  });

  it("buildPrimeSkillInvokeJobCode mirrors module-wrap resolution and the import-error registry", () => {
    const withCallable = buildPrimeSkillInvokeJobCode({
      importName: "web_search",
      plan: { kind: "callable", callable: "search.run" },
      argumentsJson: "{\"query\":\"x\"}",
    });
    expect(withCallable).toContain('for _prime_skill_attr in ["search","run"]:');
    expect(withCallable).toContain('_prime_skill_args = _prime_skill_json.loads("{\\"query\\":\\"x\\"}")');
    expect(withCallable).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_skill_name] = str(_prime_skill_error)");
    expect(withCallable).toContain(PRIME_SKILL_RESULT_BEGIN);
    const wrap = buildPrimeSkillInvokeJobCode({ importName: "web_search", plan: { kind: "callable" }, argumentsJson: "{}" });
    expect(wrap).toContain('getattr(_prime_skill_module, "run", None) or _prime_skill_module');
  });

  it("buildPrimeSkillMaterializeJobCode embeds base64 files under the skill root", () => {
    const code = buildPrimeSkillMaterializeJobCode({ importName: "web_search", files: [{ path: "web_search.py", content: "x = 1\n" }] });
    expect(code).toContain('"web_search.py"');
    expect(code).toContain(btoa("x = 1\n"));
    expect(code).toContain("/prime-skills");
    expect(code).toContain("materialized 1 skill module file(s)");
  });

  it("canonicalPrimeSkillModuleSource refuses hostile paths and oversized sources", () => {
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: [] })).toMatchObject({ ok: false, code: "module_source_missing" });
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: [{ path: "../escape.py", content: "" }] })).toMatchObject({ ok: false, code: "module_file_path_invalid" });
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: [{ path: "/abs.py", content: "" }] })).toMatchObject({ ok: false, code: "module_file_path_invalid" });
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: [{ path: "a\u0000b.py", content: "" }] })).toMatchObject({ ok: false, code: "module_file_path_invalid" });
    expect(canonicalPrimeSkillModuleSource({ importName: "not a name!", files: [{ path: "x.py", content: "" }] })).toMatchObject({ ok: false, code: "module_file_path_invalid" });
    const many = Array.from({ length: 65 }, (_, i) => ({ path: `f${i}.py`, content: "" }));
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: many })).toMatchObject({ ok: false, code: "module_source_too_large" });
    const big = [{ path: "big.py", content: "x".repeat(MAX_MODULE_SOURCE_BYTES + 1) }];
    expect(canonicalPrimeSkillModuleSource({ importName: "x", files: big })).toMatchObject({ ok: false, code: "module_source_too_large" });
    const ok = canonicalPrimeSkillModuleSource({ importName: "pkg.mod", files: [{ path: "pkg/mod.py", content: "x = 1" }] });
    expect(ok.ok).toBe(true);
  });

  it("extractPrimeSkillResultEnvelope parses envelopes and rejects noise", () => {
    const okEnv = extractPrimeSkillResultEnvelope(`noise\n${PRIME_SKILL_RESULT_BEGIN}{"ok":true,"value":{"a":1}}${PRIME_SKILL_RESULT_END}\nmore`);
    expect(okEnv).toEqual({ ok: true, value: { a: 1 } });
    const failEnv = extractPrimeSkillResultEnvelope(`${PRIME_SKILL_RESULT_BEGIN}{"ok":false,"stage":"invoke","error":"boom","ename":"E"}${PRIME_SKILL_RESULT_END}`);
    expect(failEnv).toEqual({ ok: false, stage: "invoke", error: "boom", ename: "E" });
    expect(extractPrimeSkillResultEnvelope("no envelope here")).toBeUndefined();
    expect(extractPrimeSkillResultEnvelope(`${PRIME_SKILL_RESULT_BEGIN}not-json${PRIME_SKILL_RESULT_END}`)).toBeUndefined();
    expect(extractPrimeSkillResultEnvelope(`${PRIME_SKILL_RESULT_BEGIN}{"ok":true}${PRIME_SKILL_RESULT_END}`, )).toEqual({ ok: true, value: undefined });
  });
});
