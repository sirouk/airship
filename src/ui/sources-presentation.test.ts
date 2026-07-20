import { describe, expect, it } from "vitest";
import { upstreamStatus } from "./sources-view";

describe("Sources upstream status", () => {
  it("states unavailable comparison instead of inventing ahead/behind", () => {
    const repository = { remotes: [] } as unknown as Parameters<typeof upstreamStatus>[0];
    const worktree = { branch: "main" } as Parameters<typeof upstreamStatus>[1];
    expect(upstreamStatus(repository, worktree)).toBe("No upstream configured. Ahead/behind unavailable.");
  });
});
