import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The startup budget in scripts/release-gate.mjs is a first-paint promise on a
 * phone, and a bundler will happily break it without warning: one ordinary
 * static import anywhere in the shell's graph is enough to drag a module that
 * only a deferred surface needs into the baseline chunk.
 *
 * This walks the real static module graph from the application entry — the same
 * edges Rollup follows when it decides chunk membership — and asserts that the
 * modules deliberately pushed behind a dynamic boundary are still unreachable.
 * Dynamic `import(...)` calls are deliberately not followed: they are the
 * boundary under test.
 */
const sourceRoot = dirname(fileURLToPath(import.meta.url));

/** Every export/import form that survives to runtime; `import type` is erased. */
const STATIC_EDGE = /(?:^|[\s;}])(?:import|export)\s+(?!type\s)(?:[^'"();]*?\sfrom\s+)?["']([^"']+)["']/gmu;
const RESOLUTION_SUFFIXES = Object.freeze(["", ".ts", ".tsx", "/index.ts", "/index.tsx"]);

function resolveSourceModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try {
      if (readFileSync(candidate).byteLength >= 0) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Files reachable from `entry` by static edges only, as repository paths. */
function staticallyReachable(entry: string): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [resolve(sourceRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    const key = relative(sourceRoot, file);
    if (reached.has(key)) continue;
    reached.add(key);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_EDGE)) {
      const target = resolveSourceModule(file, match[1]);
      if (target && !target.endsWith(".css")) pending.push(target);
    }
  }
  return reached;
}

describe("application startup module boundary", () => {
  const reachable = staticallyReachable("main.tsx");

  it("reaches the shell it is supposed to reach", () => {
    // Without this the assertions below could pass on a graph walk that simply
    // found nothing, which would make the boundary checks unfalsifiable.
    expect(reachable.has("main.tsx")).toBe(true);
    expect(reachable.has("ui/app.tsx")).toBe(true);
    expect(reachable.size).toBeGreaterThan(50);
  });

  it("keeps the fixture-only in-memory Git backend out of the startup graph", () => {
    // src/git/index.ts re-exports it, so importing the barrel anywhere in the
    // shell restores the edge even when nothing in the shell names the class.
    expect(reachable.has("git/memory-adapter.test-support.ts")).toBe(false);
    expect(reachable.has("git/index.ts")).toBe(false);
  });

  it("keeps the Chutes account-telemetry client with the Billing surface", () => {
    // The Account route already awaits the deferred capability pack before it
    // can request a snapshot, so this costs the user nothing at the point of use.
    expect(reachable.has("billing/client.ts")).toBe(false);
  });

  it("does not statically reach the packs its own loaders defer", () => {
    expect(reachable.has("deferred-capabilities.ts")).toBe(false);
    expect(reachable.has("core/agent.ts")).toBe(false);
    expect(reachable.has("git/workspace-adapter.ts")).toBe(false);
    expect(reachable.has("execution/execution-runtime-pack.ts")).toBe(false);
    expect(reachable.has("ui/skills-manager-view.tsx")).toBe(false);
  });
});
