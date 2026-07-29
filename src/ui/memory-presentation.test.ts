import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { ProfileScopedMemoryPageStore } from "./memory-view";

describe("profile-scoped Memory presentation", () => {
  it("restores A after B without sharing query or Index disclosure state", () => {
    const workspace = new MemoryWorkspace();
    const store = new ProfileScopedMemoryPageStore();
    store.write(workspace, "profile-alpha", "session-alpha", {
      query: "alpha private query",
      relationshipsExpanded: false,
      indexExpanded: true,
      indexMounted: true,
    });
    store.write(workspace, "profile-beta", "session-beta", {
      query: "beta private query",
      relationshipsExpanded: true,
      indexExpanded: false,
      indexMounted: false,
    });

    expect(store.read(workspace, "profile-beta", "session-beta"))
      .toMatchObject({ query: "beta private query", indexExpanded: false });
    expect(store.read(workspace, "profile-alpha", "session-alpha"))
      .toMatchObject({ query: "alpha private query", indexExpanded: true });
  });

  it("also fences conversations and workspace authorities inside one Profile", () => {
    const firstWorkspace = new MemoryWorkspace();
    const secondWorkspace = new MemoryWorkspace();
    const store = new ProfileScopedMemoryPageStore();
    store.write(firstWorkspace, "profile-alpha", "session-one", {
      query: "one",
      relationshipsExpanded: true,
      indexExpanded: false,
      indexMounted: false,
    });

    expect(store.read(firstWorkspace, "profile-alpha", "session-two")).toBeUndefined();
    expect(store.read(secondWorkspace, "profile-alpha", "session-one")).toBeUndefined();
  });
});
