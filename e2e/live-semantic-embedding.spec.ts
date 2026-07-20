import { expect, test } from "@playwright/test";

test("opt-in semantic pack embeds, indexes, and retrieves entirely in Chromium", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one authoritative browser runtime");
  test.skip(process.env.AIRSHIP_LIVE_SEMANTIC !== "1", "Set AIRSHIP_LIVE_SEMANTIC=1 after npm run semantic:prepare.");
  test.setTimeout(240_000);
  const baseUrl = process.env.AIRSHIP_LIVE_BASE_URL ?? "http://127.0.0.1:4173";
  const offOriginRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("mxbai-embed") && url.origin !== new URL(baseUrl).origin) offOriginRequests.push(request.url());
  });
  await page.goto(`${baseUrl}/#workspace`);
  const result = await page.evaluate(async () => {
    const [{ createBrowserSemanticProvider }, { MemoryWorkspace }, { ClientContextEngine }] = await Promise.all([
      import("/src/indexing/semantic-browser-provider.ts"),
      import("/src/workspace/memory.ts"),
      import("/src/indexing/client-context-engine.ts"),
    ]);
    const workspace = new MemoryWorkspace();
    const entries = await Promise.all([
      workspace.write("/workspace/engines.md", "A turbofan compressor raises air pressure before combustion. Turbine exhaust creates thrust.", { expectedRevision: null }),
      workspace.write("/workspace/gardening.md", "Tomatoes benefit from full sun, regular watering, and fertile well-drained soil.", { expectedRevision: null }),
    ]);
    const provider = createBrowserSemanticProvider();
    const states: string[] = [];
    const unsubscribe = provider.subscribe((state) => states.push(`${state.phase}:${state.backend ?? "none"}`));
    try {
      const vectors = await provider.embed(["aircraft propulsion", "vegetable garden"]);
      const engine = new ClientContextEngine({ workspace, embeddings: provider, maxChunkCharacters: 512 });
      const generation = await engine.updateWorkspace(entries);
      const search = await engine.search("How does a jet engine produce thrust?", { limit: 2 });
      engine.dispose();
      return {
        isolated: globalThis.crossOriginIsolated,
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
  expect(result.dimensions).toEqual([384, 384]);
  for (const norm of result.norms) expect(norm).toBeCloseTo(1, 3);
  expect(result.states).toContain("ready:wasm");
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
  const baseUrl = process.env.AIRSHIP_LIVE_BASE_URL ?? "http://127.0.0.1:4173";
  const offOriginRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.pathname.includes("mxbai-embed") || url.pathname.includes("transformers.web")) && url.origin !== new URL(baseUrl).origin) offOriginRequests.push(request.url());
  });
  await page.addInitScript(() => localStorage.removeItem("airship.context.embedding.v1"));
  await page.goto(`${baseUrl}/#memory`);
  await page.getByRole("tab", { name: "Index" }).click();
  await page.getByRole("button", { name: "Local semantic" }).click();
  const semanticStatus = page.locator(".embedding-engine-state");
  await expect(semanticStatus).toContainText(/semantic model ready|semantic unavailable/i, { timeout: 180_000 });
  await expect(semanticStatus).toContainText(/semantic model ready/i);
  await expect(page.getByText(/airship-transformersjs:4\.0\.0:mixedbread-ai\/mxbai-embed-xsmall-v1/)).toBeVisible({ timeout: 60_000 });
  expect(offOriginRequests).toEqual([]);
});
