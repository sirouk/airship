import { describe, expect, it } from "vitest";
import type { JsonValue } from "../core/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { decodeWorkspaceBytes } from "../workspace/content-codec";
import type { ClientNodeEgressPort, NodeEgressResult } from "./egress/client-node-egress";
import { allowAllForTests, ToolRegistry } from "./registry";
import { registerNetworkTools } from "./network-tools";

describe("browser network tools", () => {
  it("returns one actionable CORS boundary result rather than throwing a cascade", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    const context = {
      sessionId: "s",
      turnId: "t",
      operationId: "o",
      signal: new AbortController().signal,
    };
    const args = { url: "https://example.invalid/page" } as const;
    await registry.review("fetch_url", args, context, allowAllForTests);
    const result = await registry.executeApproved("fetch_url", args, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cors-or-network");
    expect(result.content).toContain("import_github_repository");
  });

  it("returns bounded direct browser text with provenance", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, (async () => new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch);
    const context = {
      sessionId: "s",
      turnId: "t",
      operationId: "o",
      signal: new AbortController().signal,
    };
    const args = { url: "https://example.com/readme" } as const;
    await registry.review("fetch_url", args, context, allowAllForTests);
    const result = await registry.executeApproved("fetch_url", args, context);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("hello");
  });
});



describe("fetch_url egress ladder", () => {
  const context = {
    sessionId: "s",
    turnId: "t",
    operationId: "o",
    signal: new AbortController().signal,
  };

  const corsBlockedDirectFetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;

  // The relay answers in bytes, because a body is bytes until something decides
  // otherwise. Tests are written in text or in bytes, whichever the case is
  // actually about, and this encodes the text ones on the way in.
  type ScriptedResult =
    | Extract<NodeEgressResult, { ok: false }>
    | (Omit<Extract<NodeEgressResult, { ok: true }>, "bytes"> & { text?: string; bytes?: Uint8Array });

  function asEgressResult(result: ScriptedResult): NodeEgressResult {
    if (!result.ok) return result;
    const { text, bytes, ...rest } = result;
    return { ...rest, bytes: bytes ?? new TextEncoder().encode(text ?? "") };
  }

  function fakeEngine(result: ScriptedResult | ((target: URL) => ScriptedResult)) {
    const seen: string[] = [];
    const engine: ClientNodeEgressPort = {
      async fetch(target) {
        seen.push(target.toString());
        return asEgressResult(typeof result === "function" ? result(target) : result);
      },
    };
    return { engine, seen };
  }

  async function run(registry: ToolRegistry, args: JsonValue) {
    await registry.review("fetch_url", args, context, allowAllForTests);
    return registry.executeApproved("fetch_url", args, context);
  }

  it("uses the client Node http/https relay first by default", async () => {
    const registry = new ToolRegistry();
    const { engine, seen } = fakeEngine({
      ok: true,
      status: 200,
      finalUrl: "https://www.etymonline.com/word/mandate",
      contentType: "text/html",
      bytes: new TextEncoder().encode("mandate (n.) ... mandatum"),
      byteLength: 32,
      truncated: false,
      redirects: 0,
      transportAttempts: 2,
      preview: "mandate (n.) ...",
    });
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://www.etymonline.com/word/mandate" });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.via).toBe("node-webcontainer");
    expect(parsed.transportAttempts).toBe(2);
    expect(parsed.text).toContain("mandatum");
    expect(seen).toEqual(["https://www.etymonline.com/word/mandate"]);
  });

  it("reports every egress route honestly when none answers", async () => {
    const registry = new ToolRegistry();
    const { engine } = fakeEngine({
      ok: false,
      code: "econnreset",
      message: "socket hang up (after 3 transport attempts).",
      transportAttempts: 3,
    });
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://example.invalid/page" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.attempts).toEqual([
      expect.objectContaining({ route: "node-webcontainer", code: "econnreset", transportAttempts: 3 }),
      expect.objectContaining({ route: "browser", code: "cors-or-network", retryable: true }),
    ]);
    expect(parsed.message).toContain("already used core Node http/https");
    expect(parsed.message).toContain("do not install the runtime");
    expect(parsed.message).toContain("Retry fetch_url once");
    expect(parsed.message).toContain("import_github_repository");
  });

  it("forces the engine when via is node-webcontainer, skipping the browser read", async () => {
    const registry = new ToolRegistry();
    let directCalls = 0;
    const countingFetch = (async () => {
      directCalls += 1;
      return new Response("browser text", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const { engine, seen } = fakeEngine({
      ok: true,
      status: 200,
      finalUrl: "https://example.com/",
      contentType: "text/html",
      bytes: new TextEncoder().encode("engine text"),
      byteLength: 11,
      truncated: false,
      redirects: 0,
      preview: "engine text",
    });
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, countingFetch, engine);
    const result = await run(registry, { url: "https://example.com/", via: "node-webcontainer" });
    expect(JSON.parse(result.content).via).toBe("node-webcontainer");
    expect(directCalls).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("uses the full reviewed 8 MiB return channel by default", async () => {
    const registry = new ToolRegistry();
    let observedMaxBytes = 0;
    const engine: ClientNodeEgressPort = {
      async fetch(target, init) {
        observedMaxBytes = init.maxBytes;
        return {
          ok: true,
          status: 200,
          finalUrl: target.toString(),
          contentType: "text/plain",
          bytes: new TextEncoder().encode("full-channel default"),
          byteLength: 20,
          truncated: false,
          redirects: 0,
          preview: "full-channel default",
        };
      },
    };
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://example.com/large", via: "node-webcontainer" });
    expect(result.isError).not.toBe(true);
    expect(observedMaxBytes).toBe(8 * 1_024 * 1_024);
  });

  it("lets an Agent Profile opt out to browser-only egress", async () => {
    const registry = new ToolRegistry();
    let engineCalls = 0;
    const engine: ClientNodeEgressPort = {
      async fetch() {
        engineCalls += 1;
        return { ok: false, code: "must-not-run", message: "profile opted out" };
      },
    };
    const direct = (async () => new Response("browser-only answer", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, direct, engine, "browser-only");
    const definition = registry.definitions().find(({ name }) => name === "fetch_url")!;
    expect(definition.description).toContain("opted out of client-side Node egress");
    expect(definition.inputSchema).toMatchObject({
      properties: { via: { type: "string", enum: ["auto", "browser"] } },
    });
    const result = await run(registry, { url: "https://example.com/" });
    expect(JSON.parse(result.content)).toMatchObject({ via: "browser-direct", text: "browser-only answer" });
    expect(engineCalls).toBe(0);
  });

  it("keeps the browser boundary absolute when via is browser", async () => {
    const registry = new ToolRegistry();
    let engineCalls = 0;
    const engine: ClientNodeEgressPort = {
      async fetch() {
        engineCalls += 1;
        return { ok: false, code: "node-egress-unavailable", message: "must not run" };
      },
    };
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://example.invalid/", via: "browser" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).attempts).toHaveLength(1);
    expect(engineCalls).toBe(0);
  });


  it("lets the Node route recover a browser response whose content type is untextual", async () => {
    const registry = new ToolRegistry();
    const binaryDirect = (async () => new Response(new Uint8Array([0, 1, 2]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;
    const { engine } = fakeEngine({
      ok: true,
      status: 200,
      finalUrl: "https://example.com/resource",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("the Node route negotiated readable text"),
      byteLength: 39,
      truncated: false,
      redirects: 0,
      preview: "the Node route",
    });
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, binaryDirect, engine);
    const result = await run(registry, { url: "https://example.com/resource" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ via: "node-webcontainer", text: "the Node route negotiated readable text" });
  });

  it("stages a successful binary Node response in the workspace", async () => {
    const registry = new ToolRegistry();
    const workspace = new MemoryWorkspace();
    const { engine } = fakeEngine({
      ok: true,
      status: 200,
      finalUrl: "https://example.com/archive.zip",
      contentType: "application/zip",
      bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      byteLength: 4,
      truncated: false,
      redirects: 0,
      preview: "",
    });
    registerNetworkTools(registry, workspace, undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://example.com/archive.zip" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual(expect.objectContaining({
      via: "node-webcontainer",
      encoding: "binary",
      saved: true,
      path: expect.stringContaining("archive.zip"),
    }));
  });

  it("passes HTTP error statuses from the engine through as failures", async () => {
    const registry = new ToolRegistry();
    const { engine } = fakeEngine({
      ok: true,
      status: 404,
      finalUrl: "https://example.com/missing",
      contentType: "text/html",
      bytes: new TextEncoder().encode("not here"),
      byteLength: 8,
      truncated: false,
      redirects: 0,
      preview: "not here",
    });
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch, engine);
    const result = await run(registry, { url: "https://example.com/missing" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.attempts[0]).toEqual(expect.objectContaining({ route: "node-webcontainer", code: "http", status: 404 }));
  });

  it("declares the engine unavailable honestly when no client runtime exists", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, corsBlockedDirectFetch);
    const result = await run(registry, { url: "https://example.invalid/" });
    const parsed = JSON.parse(result.content);
    expect(parsed.attempts[0]).toEqual(expect.objectContaining({ route: "node-webcontainer", code: "node-egress-unavailable" }));
  });
});

describe("fetch_url takes whatever the origin answers with", () => {
  const context = { sessionId: "s", turnId: "t", operationId: "o", signal: new AbortController().signal };
  const ZIP_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);

  async function run(registry: ToolRegistry, args: JsonValue) {
    await registry.review("fetch_url", args, context, allowAllForTests);
    return registry.executeApproved("fetch_url", args, context);
  }

  function origin(contentType: string, body: string | Uint8Array): typeof fetch {
    return (async () => new Response(body as BodyInit, { status: 200, headers: { "content-type": contentType } })) as typeof fetch;
  }

  // This is the DuckDuckGo case exactly: their instant-answer API returns JSON
  // under the legacy `application/x-javascript` label. The connection was fine
  // and the payload was fine; the reader discarded a paid-for 200 on the header
  // alone. Adding that one type to an allowlist would have fixed this call and
  // not the next one, so the bytes decide instead.
  it("reads a body the origin mislabelled", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined,
      origin("application/x-javascript", '{"AbstractText":"a powered aerostat"}'));
    const parsed = JSON.parse((await run(registry, { url: "https://api.duckduckgo.com/?q=airship", via: "browser" })).content);
    expect(parsed.encoding).toBe("text");
    expect(parsed.text).toContain("powered aerostat");
  });

  it("keeps a binary body by writing it to the workspace and naming the path", async () => {
    const registry = new ToolRegistry();
    const workspace = new MemoryWorkspace();
    registerNetworkTools(registry, workspace, undefined, origin("application/zip", ZIP_BYTES));
    const parsed = JSON.parse((await run(registry, { url: "https://example.com/a/archive.zip", via: "browser" })).content);

    expect(parsed).toMatchObject({ encoding: "binary", saved: true, byteLength: ZIP_BYTES.byteLength });
    expect(parsed.path).toBe("/workspace/.airship/downloads/archive.zip");
    expect(parsed.text).toBeUndefined();
    const stored = await workspace.read(parsed.path);
    expect(Array.from(decodeWorkspaceBytes(stored!.content))).toEqual(Array.from(ZIP_BYTES));
  });

  it("inlines as base64 only when the caller asks, because that is charged to the context", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, origin("application/zip", ZIP_BYTES));
    const parsed = JSON.parse((await run(registry, { url: "https://example.com/a/archive.zip", via: "browser", as: "base64" })).content);
    expect(parsed.encoding).toBe("base64");
    expect(Array.from(Uint8Array.from(atob(parsed.base64), (c) => c.charCodeAt(0)))).toEqual(Array.from(ZIP_BYTES));
  });

  it("forces a lossy text read when the caller says it knows the payload", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, origin("application/zip", ZIP_BYTES));
    const parsed = JSON.parse((await run(registry, { url: "https://example.com/a/archive.zip", via: "browser", as: "text" })).content);
    expect(parsed.encoding).toBe("text");
    expect(typeof parsed.text).toBe("string");
  });

  it("never calls a body unsupported, because by default none is", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, origin("application/x-shockwave-flash", ZIP_BYTES));
    const result = await run(registry, { url: "https://example.com/thing", via: "browser" });
    expect(result.isError).not.toBe(true);
    expect(result.content).not.toContain("unsupported-content");
  });

  it("still reports the body when the workspace refuses to hold it", async () => {
    const registry = new ToolRegistry();
    const refusing = new MemoryWorkspace();
    refusing.write = async () => { throw new Error("quota exhausted"); };
    registerNetworkTools(registry, refusing, undefined, origin("application/zip", ZIP_BYTES));
    const result = await run(registry, { url: "https://example.com/a/archive.zip", via: "browser" });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({ encoding: "binary", saved: false });
    expect(parsed.message).toContain("quota exhausted");
    expect(parsed.message).toContain('as:"base64"');
  });
});

describe("the Agent Profile opt-out, which is never the default", () => {
  const context = { sessionId: "s", turnId: "t", operationId: "o", signal: new AbortController().signal };
  const ZIP_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);

  async function run(registry: ToolRegistry, args: JsonValue) {
    await registry.review("fetch_url", args, context, allowAllForTests);
    return registry.executeApproved("fetch_url", args, context);
  }

  const zipOrigin = (async () => new Response(ZIP_BYTES as BodyInit, {
    status: 200,
    headers: { "content-type": "application/zip" },
  })) as typeof fetch;

  it("refuses a binary body when a profile asked for text only, and says whose refusal it is", async () => {
    const registry = new ToolRegistry();
    const workspace = new MemoryWorkspace();
    registerNetworkTools(registry, workspace, undefined, zipOrigin, undefined, "browser-only", "text-only");
    const result = await run(registry, { url: "https://example.com/a/archive.zip" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.attempts[0]).toEqual(expect.objectContaining({ route: "browser", code: "unsupported-content" }));
    // The wording matters: this used to read as a broken website.
    expect(parsed.message).toContain("this Agent Profile restricted fetch_url");
    expect(parsed.message).toContain("The response was not the problem");
    expect(await workspace.list("/workspace/.airship/downloads")).toHaveLength(0);
  });

  it("still reads text under the opt-out, and does not offer to inline anything", async () => {
    const registry = new ToolRegistry();
    const textual = (async () => new Response("plain enough", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, textual, undefined, "browser-only", "text-only");
    const parsed = JSON.parse((await run(registry, { url: "https://example.com/notes" })).content);
    expect(parsed.text).toBe("plain enough");

    const schema = registry.definitions().find((definition) => definition.name === "fetch_url")!.inputSchema;
    expect(Object.keys((schema as { properties: Record<string, unknown> }).properties)).not.toContain("as");
  });

  it("does not let a turn argue its way past the profile: as: is gone, not ignored", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, zipOrigin, undefined, "browser-only", "text-only");
    await expect(run(registry, { url: "https://example.com/a/archive.zip", as: "base64" }))
      .rejects.toThrow(/not declared by the tool schema/i);
  });

  it("is wide open when no profile says otherwise", async () => {
    const registry = new ToolRegistry();
    registerNetworkTools(registry, new MemoryWorkspace(), undefined, zipOrigin, undefined, "browser-only");
    const result = await run(registry, { url: "https://example.com/a/archive.zip" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content).encoding).toBe("binary");
  });
});
