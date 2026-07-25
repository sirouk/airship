import { expect, test } from "@playwright/test";

test("opt-in semantic pack embeds, indexes, and retrieves entirely in Chromium", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative browser runtime");
  test.skip(process.env.AIRSHIP_LIVE_SEMANTIC !== "1", "Set AIRSHIP_LIVE_SEMANTIC=1 after npm run semantic:prepare.");
  test.setTimeout(240_000);
  const baseUrl = process.env.AIRSHIP_LIVE_BASE_URL;
  await page.goto(baseUrl ? `${baseUrl}/#workspace` : "/#workspace");
  const appOrigin = new URL(page.url()).origin;
  const offOriginRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("mxbai-embed") && url.origin !== appOrigin) offOriginRequests.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const [{ createBrowserSemanticProvider }, { MemoryWorkspace }, { ClientContextEngine }, { getBrowserCapabilityRegistry }] = await Promise.all([
      import("/src/indexing/semantic-browser-provider.ts"),
      import("/src/workspace/memory.ts"),
      import("/src/indexing/client-context-engine.ts"),
      import("/src/capabilities/browser-runtime.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    const entries = await Promise.all([
      workspace.write("/workspace/engines.md", "A turbofan compressor raises air pressure before combustion. Turbine exhaust creates thrust.", { expectedRevision: null }),
      workspace.write("/workspace/gardening.md", "Tomatoes benefit from full sun, regular watering, and fertile well-drained soil.", { expectedRevision: null }),
    ]);
    // The production boot path completes this exact probe before session
    // capability pinning. The direct provider gate must do the same instead of
    // racing a cold registry snapshot and mistaking conservative WASM startup
    // for a failed WebGPU activation.
    const browserReport = await getBrowserCapabilityRegistry().refresh(true);
    const provider = createBrowserSemanticProvider();
    const states: string[] = [];
    const unsubscribe = provider.subscribe((state) => states.push(`${state.phase}:${state.backend ?? "none"}`));
    try {
      const gpu = (navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<unknown | null> };
      }).gpu;
      let webgpuAdapterAvailable = false;
      try {
        webgpuAdapterAvailable = Boolean(gpu && await gpu.requestAdapter());
      } catch {
        // Presence of navigator.gpu is not activation evidence. A rejected or
        // null adapter keeps the semantic runtime on its tested WASM fallback.
      }
      const vectors = await provider.embed(["aircraft propulsion", "vegetable garden"]);
      const engine = new ClientContextEngine({ workspace, embeddings: provider, maxChunkCharacters: 512 });
      const generation = await engine.updateWorkspace(entries);
      const search = await engine.search("How does a jet engine produce thrust?", { limit: 2 });
      engine.dispose();
      return {
        isolated: globalThis.crossOriginIsolated,
        webgpuAdapterAvailable,
        preferredSemanticBackend: browserReport.scheduling.preferredSemanticBackend,
        dimensions: vectors.map((vector) => vector.length),
        norms: vectors.map((vector) => Math.hypot(...vector)),
        states,
        provider: generation.lineage.embeddingProvider,
        posture: generation.lineage.embeddingPosture,
        firstPath: search.hits[0]?.path,
        firstScore: search.hits[0]?.score,
      };
    } finally {
      unsubscribe();
      provider.dispose();
    }
  });
  expect(result.isolated).toBe(true);
  if (process.env.AIRSHIP_REQUIRE_WEBGPU === "1") {
    expect(result.webgpuAdapterAvailable, "the hardware acceptance host must expose an activatable WebGPU adapter").toBe(true);
    expect(result.preferredSemanticBackend, "the adaptive policy must select the observed WebGPU adapter on this performance host").toBe("webgpu");
  }
  expect(result.dimensions).toEqual([384, 384]);
  for (const norm of result.norms) expect(norm).toBeCloseTo(1, 3);
  expect(result.states).toContain(`ready:${result.preferredSemanticBackend}`);
  expect(result.provider).toContain("mixedbread-ai/mxbai-embed-xsmall-v1");
  expect(result.posture).toBe("local-semantic");
  expect(result.firstPath).toContain("engines.md");
  expect(result.firstScore).toBeGreaterThan(0);
  expect(offOriginRequests).toEqual([]);
});

test("production UI activates the same-origin semantic worker and rebuilds the index", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative browser runtime");
  test.skip(process.env.AIRSHIP_LIVE_SEMANTIC_UI !== "1", "Set AIRSHIP_LIVE_SEMANTIC_UI=1 against a prepared production preview.");
  test.setTimeout(240_000);
  const baseUrl = process.env.AIRSHIP_LIVE_BASE_URL;
  await page.addInitScript(() => localStorage.removeItem("airship.context.embedding.v1"));
  await page.goto(baseUrl ? `${baseUrl}/#memory` : "/#memory");
  const appOrigin = new URL(page.url()).origin;
  const offOriginRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.pathname.includes("mxbai-embed") || url.pathname.includes("transformers.web")) && url.origin !== appOrigin) offOriginRequests.push(request.url());
  });
  await page.getByRole("tab", { name: "Index" }).click();
  await page.getByRole("button", { name: "Local semantic" }).click();
  const semanticStatus = page.locator(".embedding-engine-state");
  await expect(semanticStatus).toContainText(/semantic model ready|semantic unavailable/i, { timeout: 180_000 });
  await expect(semanticStatus).toContainText(/semantic model ready/i);
  await expect(page.getByText(/airship-transformersjs:4\.0\.0:mixedbread-ai\/mxbai-embed-xsmall-v1/)).toBeVisible({ timeout: 60_000 });
  expect(offOriginRequests).toEqual([]);
});
