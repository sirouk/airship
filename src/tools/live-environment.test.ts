import { describe, expect, it } from "vitest";
import { probeBrowserRuntimeCapabilities } from "../capabilities/browser-runtime";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { createAirshipToolRegistry } from "./airship-tools";
import { createToolLiveEnvironmentProvider } from "./live-environment";

describe("tool live environment provider", () => {
  it("composes browser, execution, index, and freshly evaluated App status", async () => {
    const browser = await probeBrowserRuntimeCapabilities({
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    const generationDigest = await sha256("generation");
    const workspaceSnapshotDigest = await sha256("workspace");
    let supplementCapture = 0;
    const provider = createToolLiveEnvironmentProvider({
      contextRuntime: contextRuntime(generationDigest, workspaceSnapshotDigest) as never,
      browser: async () => browser,
      execution: () => [],
      supplement: async () => {
        supplementCapture += 1;
        const generation = supplementCapture === 1 ? "A" : "B";
        return {
          providers: [{
            id: "provider-directory",
            label: "Provider directory",
            state: supplementCapture === 1 ? "ready" : "degraded",
            evidence: "runtime-reported",
            detail: `provider-generation-${generation}`,
            facets: [`generation=${generation}`],
          }],
          storage: [],
        };
      },
      now: () => new Date("2026-07-28T12:01:00.000Z"),
    });
    const request = { sessionId: "session-live", signal: new AbortController().signal };

    const first = await provider.capture(request);
    const second = await provider.capture(request);

    expect(first.browser.map(({ id }) => id)).toContain("webgpu");
    expect(first.browser.every((entry) => entry.facets.includes("observed-at=2026-07-28T12:00:00.000Z"))).toBe(true);
    expect(first.workspaceIndex).toMatchObject({
      state: "ready",
      generationDigest,
      workspaceSnapshotDigest,
      indexedFiles: 2,
      chunks: 4,
    });
    expect(first.providers[0]?.detail).toBe("provider-generation-A");
    expect(second.providers[0]?.detail).toBe("provider-generation-B");
    expect(second.extension[0]).toMatchObject({ state: "not-observed" });
    expect(second.limitations.join(" ")).toContain("extension bridge");
    expect(supplementCapture).toBe(2);
  });

  it("reports App observation failures explicitly instead of reusing stale state", async () => {
    const browser = await probeBrowserRuntimeCapabilities();
    const generationDigest = await sha256("generation-failed-source");
    const workspaceSnapshotDigest = await sha256("workspace-failed-source");
    const provider = createToolLiveEnvironmentProvider({
      contextRuntime: contextRuntime(generationDigest, workspaceSnapshotDigest) as never,
      browser: async () => browser,
      execution: () => [],
      supplement: async () => {
        throw new Error("directory unavailable");
      },
    });

    const snapshot = await provider.capture({
      sessionId: "session-live",
      signal: new AbortController().signal,
    });

    expect(snapshot.providers[0]).toMatchObject({ state: "failed", evidence: "probe-failed" });
    expect(snapshot.storage[0]).toMatchObject({ state: "failed", evidence: "probe-failed" });
    expect(snapshot.extension[0]).toMatchObject({ state: "failed", evidence: "probe-failed" });
    expect(snapshot.limitations.join(" ")).toContain("could not be observed");
  });

  it("is attached automatically by the standard Airship tool bundle", async () => {
    const tools = await createAirshipToolRegistry({
      workspace: new MemoryWorkspace(),
      journal: new EventJournal(new MemoryJournalBackend()),
    });
    const provider = tools.getLiveEnvironmentProvider();

    expect(provider).toBeDefined();
    const observation = await provider!.capture({
      sessionId: "session-standard-bundle",
      signal: new AbortController().signal,
    });
    expect(observation.browser.length).toBeGreaterThan(0);
    expect(observation.workspaceIndex.state).toBe("ready");
    expect(observation.providers[0]).toMatchObject({ state: "not-observed" });
  });
});

function contextRuntime(generationDigest: string, workspaceSnapshotDigest: string) {
  const generation = {
    lineage: {
      generationDigest,
      embeddingProvider: "airship/hash-embedding-v1",
      embeddingPosture: "deterministic-bootstrap",
    },
    workspaceSnapshotDigest,
    candidateStats: { byStatus: { indexed: 2 } },
    chunkStats: { total: 4 },
  };
  return {
    async refreshNow() {
      return generation;
    },
    getState() {
      return { generation };
    },
  };
}
