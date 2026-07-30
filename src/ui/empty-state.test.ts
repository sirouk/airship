import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
const emptyState = await readFile(new URL("./empty-state.tsx", import.meta.url), "utf8");
const routes = await readFile(new URL("./routes.css", import.meta.url), "utf8");

describe("the shared empty state is reachable", () => {
  it("is no longer a private helper inside app.tsx", () => {
    // It sat here, styled and unrendered, for as long as ten routes were each
    // drawing their own "nothing here yet" — at 180px, 260px, 330px and
    // flex-fill. A recipe no route can import is a recipe every route forks.
    expect(app).not.toMatch(/function EmptyState\(/u);
    expect(app).toContain("`EmptyState` moved to `./empty-state`");
  });

  it("stays a leaf, so a route need not pay for the shell to use it", () => {
    const imports = [...emptyState.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
    expect(imports).toEqual(["preact", "./icons"]);
  });

  it("draws the class routes.css already owns, and can hold the route's verb", () => {
    expect(emptyState).toContain('class="empty-state"');
    expect(routes).toMatch(/\.empty-state\s*\{/u);
    // Four of the routes that hand-rolled this needed a button under the
    // sentence; a recipe that cannot hold one is a recipe they fork again.
    expect(emptyState).toContain("action?: ComponentChildren;");
  });
});
