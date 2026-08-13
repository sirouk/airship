import { describe, expect, it } from "vitest";
import { sha256 } from "../../core/hash";
import type { ExecutionRequest, ExecutionResult } from "../../execution/runtime-registry";
import { MemoryWorkspace } from "../../workspace/memory";
import { createClientNodeEgress, type ClientNodeEgressOptions } from "./client-node-egress";
import { EGRESS_ENVELOPE_MARKER, NODE_EGRESS_RESULT_NAME } from "./node-egress-script";

/**
 * The engine itself is tested with a scripted adapter: no WebContainer boots.
 * What is proven: envelope parsing, digest verification of the staged body,
 * workspace scrubbing, and the value semantics the tool ladder consumes.
 */

const RESULT_PATH = `/workspace/${NODE_EGRESS_RESULT_NAME}`;

function fakeRuntime(envelope: Record<string, unknown> | null, options: { stagedBody?: string; exitCode?: number } = {}) {
  const requests: ExecutionRequest[] = [];
  const stagedBody = options.stagedBody;
  const adapter = {
    capability: {
      id: "node-webcontainer" as const,
      label: "Node.js · WebContainer",
      languages: ["javascript"],
      state: "ready" as const,
      tier: "web-enhanced" as const,
      isolation: "webcontainer" as const,
      persistence: "workspace-checkpoint" as const,
      commandInterface: "direct-process" as const,
      shell: "webcontainer-jsh" as const,
      workspaceAccess: "bounded-snapshot-writeback" as const,
      output: "bounded-stream" as const,
      cancellation: "kill-process" as const,
      detail: "test double",
    },
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      requests.push(request);
      if (stagedBody !== undefined && request.workspace) {
        await request.workspace.write(RESULT_PATH, stagedBody);
      }
      return {
        runtime: "node-webcontainer",
        exitCode: options.exitCode ?? 0,
        stdout: envelope === null ? "node: internal error" : `\n${EGRESS_ENVELOPE_MARKER}${JSON.stringify(envelope)}\n`,
        stderr: "",
        provenance: { capabilityTier: "web-enhanced", authority: "browser", engine: "test", artifactKind: "workspace-project" },
      };
    },
  };
  return { adapter, requests };
}

function engineWith(envelope: Record<string, unknown> | null, options: { stagedBody?: string; exitCode?: number } & Partial<ClientNodeEgressOptions> = {}) {
  const { adapter, requests } = fakeRuntime(envelope, options);
  const engine = createClientNodeEgress({
    workspace: new MemoryWorkspace(),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    activate: async () => adapter,
  });
  return { engine, requests };
}

async function okEnvelope(body: string) {
  return {
    ok: true,
    status: 200,
    finalUrl: "https://example.com/page",
    contentType: "text/plain",
    bytes: new TextEncoder().encode(body).byteLength,
    truncated: false,
    redirects: 0,
    transportAttempts: 1,
    elapsedMs: 12,
    resultFile: NODE_EGRESS_RESULT_NAME,
    resultBytes: new TextEncoder().encode(body).byteLength,
    resultSha256: await sha256(body),
    preview: body.slice(0, 32),
  };
}

const signal = () => new AbortController().signal;

describe("client node egress engine", () => {
  it("verifies the staged body digest and returns the text", async () => {
    const body = "fetched without CORS cooperation, inside the client's own Node";
    const { engine, requests } = engineWith(await okEnvelope(body), { stagedBody: body });
    const result = await engine.fetch(new URL("https://example.com/page"), { maxBytes: 512 * 1_024, signal: signal() });
    // The relay hands back bytes, not text: decoding here would corrupt every
    // non-UTF-8 answer before `fetch_url` ever got to classify it.
    expect(result).toMatchObject({ ok: true, status: 200, truncated: false, transportAttempts: 1 });
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe(body);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.env?.AIRSHIP_EGRESS_TARGET).toBe("https://example.com/page");
    expect(requests[0]!.writeBack).toBe(true);
  });

  it("discards a staged body whose digest does not match the envelope", async () => {
    const { engine, requests } = engineWith(await okEnvelope("honest answer"), { stagedBody: "tampered answer" });
    const result = await engine.fetch(new URL("https://example.com/page"), { maxBytes: 512 * 1_024, signal: signal() });
    expect(result).toMatchObject({ ok: false, code: "node-egress-integrity" });
    expect(requests).toHaveLength(1);
  });

  it("passes relay transport failures through without inventing content", async () => {
    const { engine } = engineWith({
      ok: false,
      code: "econnreset",
      message: "socket hang up (after 3 transport attempts).",
      transportAttempts: 3,
    });
    const result = await engine.fetch(new URL("https://example.com/page"), { maxBytes: 512 * 1_024, signal: signal() });
    expect(result).toEqual({
      ok: false,
      code: "econnreset",
      message: "socket hang up (after 3 transport attempts).",
      transportAttempts: 3,
    });
  });

  it("reports a run that produced no envelope", async () => {
    const { engine } = engineWith(null, { exitCode: 1 });
    const result = await engine.fetch(new URL("https://example.com/page"), { maxBytes: 512 * 1_024, signal: signal() });
    expect(result).toMatchObject({ ok: false, code: "node-egress-runtime" });
  });

  it("scrubs the staged result even on success so the next run starts clean", async () => {
    const body = "leave nothing behind";
    const workspace = new MemoryWorkspace();
    const { engine } = engineWith(await okEnvelope(body), { stagedBody: body, workspace });
    const first = await engine.fetch(new URL("https://example.com/a"), { maxBytes: 512 * 1_024, signal: signal() });
    expect(first.ok).toBe(true);
    expect(await workspace.read(RESULT_PATH)).toBeUndefined();
  });



  it("serializes the complete scratch lifecycle for parallel calls", async () => {
    const bodies = new Map([
      ["https://example.com/one", "first body"],
      ["https://example.com/two", "second body"],
    ]);
    let active = 0;
    let peak = 0;
    const adapter = fakeRuntime(null).adapter;
    adapter.execute = async (request: ExecutionRequest): Promise<ExecutionResult> => {
      active += 1;
      peak = Math.max(peak, active);
      const target = request.env?.AIRSHIP_EGRESS_TARGET ?? "";
      const body = bodies.get(target) ?? "";
      await new Promise((resolve) => setTimeout(resolve, target.endsWith("/one") ? 20 : 0));
      await request.workspace!.write(RESULT_PATH, body);
      active -= 1;
      return {
        runtime: "node-webcontainer",
        exitCode: 0,
        stdout: `\n${EGRESS_ENVELOPE_MARKER}${JSON.stringify(await okEnvelope(body))}\n`,
        stderr: "",
        provenance: { capabilityTier: "web-enhanced", authority: "browser", engine: "test", artifactKind: "workspace-project" },
      };
    };
    const engine = createClientNodeEgress({ workspace: new MemoryWorkspace(), activate: async () => adapter });
    const [one, two] = await Promise.all([
      engine.fetch(new URL("https://example.com/one"), { maxBytes: 4_096, signal: signal() }),
      engine.fetch(new URL("https://example.com/two"), { maxBytes: 4_096, signal: signal() }),
    ]);
    expect(one.ok && new TextDecoder().decode(one.bytes)).toBe("first body");
    expect(two.ok && new TextDecoder().decode(two.bytes)).toBe("second body");
    expect(peak).toBe(1);
  });

  it("rejects an aborted run before touching the runtime", async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, requests } = engineWith(await okEnvelope("x"));
    await expect(engine.fetch(new URL("https://example.com/"), { maxBytes: 4_096, signal: controller.signal })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("client node egress engine on a non-browser realm", () => {
  it("declares the engine unavailable rather than guessing", async () => {
    let activated = 0;
    const engine = createClientNodeEgress({
      requireBrowserHost: true,
      activate: async () => { activated += 1; throw new Error("must not activate"); },
    });
    const result = await engine.fetch(new URL("https://example.com/"), { maxBytes: 4_096, signal: signal() });
    expect(result).toMatchObject({ ok: false, code: "node-egress-unavailable" });
    expect(activated).toBe(0);
  });
});
