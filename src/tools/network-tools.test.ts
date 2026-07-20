import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
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
