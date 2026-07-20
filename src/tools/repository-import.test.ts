import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { importGithubRepository } from "./repository-import";

describe("direct GitHub repository snapshot import", () => {
  it("uses CORS-safe pinned tree and raw-file reads before writing the workspace", async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
      if (url.includes("/commits/main")) return Response.json({ sha: "0123456789abcdef" });
      if (url.includes("/git/trees/0123456789abcdef")) {
        return Response.json({
          sha: "0123456789abcdef",
          truncated: false,
          tree: [
            { type: "blob", path: "README.md", size: 10 },
            { type: "blob", path: "src/index.ts", size: 26 },
            { type: "blob", path: "assets/raw.bin", size: 3 },
          ],
        });
      }
      if (url.endsWith("/README.md")) return new Response("# Imported");
      if (url.endsWith("/src/index.ts")) return new Response("export const edge = true;\n");
      if (url.endsWith("/assets/raw.bin")) return new Response(new Uint8Array([1, 0, 2]));
      return new Response("missing", { status: 404 });
    }) as typeof globalThis.fetch;
    const workspace = new MemoryWorkspace();
    const result = await importGithubRepository({
      repository: "owner/repo",
      workspace,
      fetch,
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(`${event.phase}:${event.completed}/${event.total ?? "?"}`),
    });

    expect(result).toMatchObject({
      repository: "owner/repo",
      ref: "main",
      commit: "0123456789abcdef",
      destination: "/workspace/sources/repo",
      filesWritten: 2,
      skippedBinary: 1,
    });
    expect((await workspace.read("sources/repo/src/index.ts"))?.content).toContain("edge = true");
    expect((await workspace.read("sources/repo/.airship-import.json"))?.content).toContain("github-tree+raw-cors-v1");
    expect(result.committed.map((entry) => entry.path)).toEqual([
      "/workspace/sources/repo/README.md",
      "/workspace/sources/repo/src/index.ts",
      "/workspace/sources/repo/.airship-import.json",
    ]);
    expect(calls).toHaveLength(6);
    expect(calls).not.toEqual(expect.arrayContaining([expect.stringContaining("codeload.github.com")]));
    expect(progress[0]).toBe("resolving:0/?");
    expect(progress).toContain("fetching:3/3");
    expect(progress.at(-1)).toBe("complete:3/3");
  });

  it("does not mutate the destination when any pinned raw read fails", async () => {
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
      if (url.includes("/commits/main")) return Response.json({ sha: "abc" });
      if (url.includes("/git/trees/abc")) {
        return Response.json({
          truncated: false,
          tree: [
            { type: "blob", path: "README.md", size: 5 },
            { type: "blob", path: "missing.ts", size: 5 },
          ],
        });
      }
      if (url.endsWith("README.md")) return new Response("hello");
      return new Response("missing", { status: 404 });
    }) as typeof globalThis.fetch;
    const workspace = new MemoryWorkspace();

    await expect(importGithubRepository({
      repository: "owner/repo",
      workspace,
      fetch,
      signal: new AbortController().signal,
    })).rejects.toThrow("missing.ts");
    expect(await workspace.list("sources/repo")).toEqual([]);
  });

  it("rejects a non-empty destination before any provider read", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("sources/repo/README.md", "existing");
    let fetched = false;
    await expect(importGithubRepository({
      repository: "owner/repo",
      destination: "sources/repo",
      workspace,
      fetch: (async () => {
        fetched = true;
        return new Response();
      }) as typeof globalThis.fetch,
      signal: new AbortController().signal,
    })).rejects.toThrow("not empty");
    expect(fetched).toBe(false);
  });
});
