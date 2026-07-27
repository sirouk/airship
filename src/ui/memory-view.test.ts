import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [source, contextSource, styles] = await Promise.all([
  readFile(new URL("./memory-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./context-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./memory-view.css", import.meta.url), "utf8"),
]);

describe("unified Memory surface", () => {
  it("uses one query for recall, graph matching, and the embedded index", () => {
    expect(source).toContain("const memorySearch = useFederatedMemorySearch(query, searchMemory, memoryAuthority, !indexMounted || Boolean(contextGeneration))");
    expect(source).toContain("<FederatedMemorySearch state={memorySearch} />");
    expect(source).toContain("graph.search(normalizedQuery, { limit: 12 })");
    expect(source).toContain("searchQuery={query} sharedSearch={memorySearch}");
    expect(contextSource).toContain("sharedContextResult(sharedSearch, query, generationDigest)");
    expect(contextSource).toContain("workspace.generationDigest !== generationDigest");
    expect(source).toContain("[activeProfile, catalog, messages, sessionId, workspaceAuthority]");
    expect(contextSource).not.toContain("The shared Memory query changed.");
    expect(source.match(/type="search"/gu)).toHaveLength(1);
    expect(source).not.toContain('role="tablist"');
  });

  it("keeps relationship and index potency behind native progressive disclosure", () => {
    expect(source.match(/<details/gu)).toHaveLength(2);
    expect(source).toContain('id="memory-relationships"');
    expect(source).toContain('id="memory-index"');
    expect(source).toContain("graph.stats.componentCount");
    expect(source).toContain("groupMemoryRelationships(selectedEdges, relationshipLimit)");
    expect(source).toContain("<ContextView workspace={workspace} entries={files} embedded searchQuery={query} sharedSearch={memorySearch}");
    expect(source).toContain("if (open) setIndexMounted(true)");
    expect(source).toContain('indexRef.current?.scrollIntoView({ block: "start" })');
    expect(source).toContain('onReady={initialTab === "index" ? alignIndex : undefined}');
  });

  it("labels the shared control and every destination it updates", () => {
    expect(source).toContain('aria-labelledby="memory-title"');
    expect(source).toContain('aria-controls="memory-results memory-relationships memory-index"');
    expect(source).toContain('aria-label="Memory page sections"');
    expect(source).toContain('scrollToMemorySection("memory-index")');
    expect(source).not.toContain('href="#memory-');
    expect(contextSource).toContain('aria-label={embedded ? "Workspace context index" : undefined}');
  });

  it("describes remote, local-device, and ephemeral storage without inventing a Vault posture", () => {
    expect(source).toContain("Recall follows the selected storage mode");
    expect(source).toContain("Remote Vaults can serve encrypted ranges; Local Device and Ephemeral keep recall on-device.");
    expect(source).not.toContain("The selected Vault is the encrypted backbone");
  });

  it("provides stable desktop and touch layouts without a second route gutter", () => {
    expect(cssRule(styles, ".memory-view")).toContain("display: grid");
    expect(cssRule(styles, ".memory-view")).not.toMatch(/(?:^|;)\s*padding(?:-|:)/u);
    expect(cssRule(styles, ".memory-disclosure > summary")).toContain("min-height: 68px");
    expect(cssRule(styles, ".memory-view .memory-result-lane > div")).toContain("min-height: 150px");
    expect(styles).toContain("@media (max-width: 620px)");
    expect(styles).toContain("overflow-x: auto");
    expect(styles).toContain("font-size: 16px");
  });
});

function cssRule(sourceText: string, selector: string): string {
  const start = sourceText.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = sourceText.indexOf("{", start) + 1;
  return sourceText.slice(bodyStart, sourceText.indexOf("}", bodyStart));
}
