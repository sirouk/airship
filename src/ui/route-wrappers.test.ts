import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A recovery affordance nobody can reach is not a recovery affordance.
 *
 * Measured defect: `access-route.tsx` and `billing-route.tsx` each implemented
 * a chunk-failure Retry for the two routes that most need one, and neither had
 * a single importer — `deferred-capabilities.ts` publishes `AccessView` and
 * `BillingView` straight from their views, so the shell's own loaders in
 * `app.tsx` were always the render path. Two more spellings of "this did not
 * load" sat in the tree looking like the answer while the product shipped a
 * different one. They are gone; this keeps the next one from accumulating.
 */
const uiRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(uiRoot, "..");

async function readSourceTree(directory: string): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of await readSourceTree(path)) found.set(key, value);
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      found.set(relative(sourceRoot, path), await readFile(path, "utf8"));
    }
  }
  return found;
}

const sources = await readSourceTree(sourceRoot);
const routeWrappers = [...sources.keys()].filter((path) => /(?:^|\/)[a-z-]+-route\.tsx?$/u.test(path));

describe("route wrappers", () => {
  it("finds the wrappers it is meant to police", () => {
    // Without this the reachability assertion below passes on an empty list.
    expect(routeWrappers.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps no wrapper that nothing renders", () => {
    for (const wrapper of routeWrappers) {
      const base = wrapper.replace(/^.*\//u, "").replace(/\.tsx?$/u, "");
      // Static `from "./x"` and deferred `import("./x")` both count; a wrapper
      // imported only by its own test is still code the product cannot reach.
      const specifier = new RegExp(`["'][^"']*${base}["']`, "u");
      const importers = [...sources].filter(([path, source]) => path !== wrapper && specifier.test(source));
      expect(importers.map(([path]) => path), `${wrapper} is reachable`).not.toHaveLength(0);
    }
  });

  it("answers a failed chunk with the shared panel, never its own retry verb", () => {
    for (const wrapper of routeWrappers) {
      expect(sources.get(wrapper), `${wrapper} defers to routeRetryLabel`).not.toContain("Retry loading");
    }
    const context = sources.get("ui/context-route.tsx") as string;
    // Both arms: a whole route gets the <h1>, a slot inside a rendered Memory
    // route gets the slot's name so it does not re-title the page.
    expect(context).toContain('<RouteFailure title="Context" message={loadError} onRetry={retry} />');
    expect(context).toContain('<RouteFailure inline title="the workspace context index" message={loadError} onRetry={retry} />');
  });
});
