import { describe, expect, it } from "vitest";
import { CONTEXT_ROUTING_MIRROR_PATH } from "./contracts";
import { MemoryWorkspace } from "./memory";
import {
  ProfileWorkspacePort,
  adoptLegacyRootWorkspace,
  isProfileWorkspacePath,
  profileWorkspaceIdentity,
} from "./profile-scope";

describe("ProfileWorkspacePort", () => {
  it("maps identical virtual paths into disjoint Profile namespaces", async () => {
    const backing = new MemoryWorkspace();
    const alpha = new ProfileWorkspacePort(backing, "profile-alpha");
    const beta = new ProfileWorkspacePort(backing, "profile-beta");

    await alpha.write("README.md", "alpha");
    await alpha.write(".airship/memory.json", "alpha-memory");
    await beta.write("README.md", "beta");
    await beta.write(".airship/memory.json", "beta-memory");

    expect((await alpha.read("README.md"))?.content).toBe("alpha");
    expect((await beta.read("README.md"))?.content).toBe("beta");
    expect((await alpha.read(".airship/memory.json"))?.content).toBe("alpha-memory");
    expect((await beta.read(".airship/memory.json"))?.content).toBe("beta-memory");
    expect((await alpha.list()).map(({ path }) => path)).toEqual([
      "/workspace/.airship/memory.json",
      "/workspace/README.md",
    ]);
    expect((await beta.list()).map(({ path }) => path)).toEqual([
      "/workspace/.airship/memory.json",
      "/workspace/README.md",
    ]);

    const backingEntries = await backing.list("/workspace/.airship/profile-workspaces/v1");
    expect(backingEntries).toHaveLength(4);
    expect(new Set(backingEntries.map(({ path }) => path.split("/")[5]))).toEqual(
      new Set(["p-profile-alpha", "p-profile-beta"]),
    );
  });

  it("preserves revision checks, bounded reads, and encrypted-boundary identity", async () => {
    class EncryptedMemoryWorkspace extends MemoryWorkspace {
      readonly encryptionBoundary = "airship-client-envelope-v1" as const;
    }
    const backing = new EncryptedMemoryWorkspace();
    const scoped = new ProfileWorkspacePort(backing, "developer/profile");
    const first = await scoped.write("notes.txt", "abcdefghij", { expectedRevision: null });
    expect(scoped.encryptionBoundary).toBe("airship-client-envelope-v1");
    expect((await scoped.readBounded("notes.txt", 4))?.content).toBe("abcd");
    await scoped.remove("notes.txt", { expectedRevision: first.revision });
    expect(await scoped.read("notes.txt")).toBeUndefined();
    expect(profileWorkspaceIdentity("vault+s3://bucket/root", "developer/profile")).toBe(
      "vault+s3://bucket/root::airship-profile=developer%2Fprofile",
    );
  });

  it("rejects backing-path confusion", async () => {
    class ConfusedWorkspace extends MemoryWorkspace {
      override async list() {
        return [{ path: "/workspace/outside.txt", revision: "r", updatedAt: new Date(0).toISOString(), size: 1 }];
      }
    }
    const scoped = new ProfileWorkspacePort(new ConfusedWorkspace(), "alpha");
    await expect(scoped.list()).rejects.toThrow(/outside the active Profile namespace/u);
  });
});

describe("adoptLegacyRootWorkspace", () => {
  /*
   * This runs once against every existing install, so its failure mode is
   * silent data loss rather than a broken feature: content written before
   * Profiles owned namespaces sits at the storage root, and no Profile's view
   * can address it. If this does not move it, the user's files are simply gone
   * from the product while still occupying their Vault.
   */
  it("moves pre-namespace content into the adopting Profile and leaves the root empty", async () => {
    const storage = new MemoryWorkspace();
    await storage.write("/workspace/README.md", "legacy readme");
    await storage.write("/workspace/src/index.ts", "legacy source");
    await storage.write("/workspace/.airship/browser-git-repositories.v1.json", "{}");

    const adopted = await adoptLegacyRootWorkspace(storage, "general");
    expect([...adopted].sort()).toEqual([
      "/workspace/.airship/browser-git-repositories.v1.json",
      "/workspace/README.md",
      "/workspace/src/index.ts",
    ]);

    const general = new ProfileWorkspacePort(storage, "general");
    expect((await general.read("README.md"))?.content).toBe("legacy readme");
    expect((await general.read("src/index.ts"))?.content).toBe("legacy source");
    // The Git registry travels too: it describes that Profile's repositories.
    expect((await general.read(".airship/browser-git-repositories.v1.json"))?.content).toBe("{}");
    expect((await storage.list("/workspace")).every(({ path }) => isProfileWorkspacePath(path))).toBe(true);
  });

  it("is idempotent, and a second Profile inherits nothing", async () => {
    const storage = new MemoryWorkspace();
    await storage.write("/workspace/README.md", "legacy readme");

    expect(await adoptLegacyRootWorkspace(storage, "general")).toHaveLength(1);
    expect(await adoptLegacyRootWorkspace(storage, "general")).toHaveLength(0);
    // The point of the change: Research does not receive General's files.
    expect(await adoptLegacyRootWorkspace(storage, "research")).toHaveLength(0);
    expect(await new ProfileWorkspacePort(storage, "research").read("README.md")).toBeUndefined();
    expect((await new ProfileWorkspacePort(storage, "general").read("README.md"))?.content).toBe("legacy readme");
  });

  it("keeps namespace content when a previous adoption was interrupted part-way", async () => {
    const storage = new MemoryWorkspace();
    const general = new ProfileWorkspacePort(storage, "general");
    // The shape an interruption leaves: copied into the namespace, not yet
    // removed from the root, and edited since. The root copy is now the stale
    // one, so re-running must not write it back over the newer content.
    await general.write("README.md", "adopted and then edited");
    await storage.write("/workspace/README.md", "stale legacy copy");

    await adoptLegacyRootWorkspace(storage, "general");
    expect((await general.read("README.md"))?.content).toBe("adopted and then edited");
    expect(await storage.read("/workspace/README.md")).toBeUndefined();
  });
});

describe("global-authority records are not adoptable", () => {
  /*
   * The encrypted-context routing mirror is a pointer written by the *global*
   * storage authority, at the storage root, on every publish. Legacy adoption
   * classifies by one question — "is this inside a Profile namespace" — so it
   * read the mirror as stray pre-namespace user content and carried it into
   * whichever Profile booted first. The published generation survived; the
   * pointer to it did not, so the next reload found nothing to adopt and the
   * user was told their encrypted index had to be rebuilt.
   */
  it("leaves the encrypted-context routing mirror at the storage root", async () => {
    const storage = new MemoryWorkspace();
    await storage.write(CONTEXT_ROUTING_MIRROR_PATH, '{"generation":"g1"}');
    await storage.write("/workspace/README.md", "legacy readme");

    const adopted = await adoptLegacyRootWorkspace(storage, "general");

    expect(adopted).toEqual(["/workspace/README.md"]);
    expect((await storage.read(CONTEXT_ROUTING_MIRROR_PATH))?.content).toBe('{"generation":"g1"}');
    expect(await new ProfileWorkspacePort(storage, "general").read(CONTEXT_ROUTING_MIRROR_PATH)).toBeUndefined();
  });

  it("reports nothing to adopt when the mirror is the only file at the root", async () => {
    const storage = new MemoryWorkspace();
    await storage.write(CONTEXT_ROUTING_MIRROR_PATH, '{"generation":"g1"}');
    expect(await adoptLegacyRootWorkspace(storage, "general")).toEqual([]);
    expect(await storage.read(CONTEXT_ROUTING_MIRROR_PATH)).toBeDefined();
  });

  it("gives each Profile its own mirror once the fabric is scoped to the namespace", async () => {
    // Two Profiles publishing through one global fabric overwrote each other's
    // pointer. Scoped ports keep them disjoint.
    const storage = new MemoryWorkspace();
    const alpha = new ProfileWorkspacePort(storage, "alpha");
    const beta = new ProfileWorkspacePort(storage, "beta");
    await alpha.write(CONTEXT_ROUTING_MIRROR_PATH, '{"generation":"alpha-gen"}');
    await beta.write(CONTEXT_ROUTING_MIRROR_PATH, '{"generation":"beta-gen"}');

    expect((await alpha.read(CONTEXT_ROUTING_MIRROR_PATH))?.content).toBe('{"generation":"alpha-gen"}');
    expect((await beta.read(CONTEXT_ROUTING_MIRROR_PATH))?.content).toBe('{"generation":"beta-gen"}');
    expect(await storage.read(CONTEXT_ROUTING_MIRROR_PATH)).toBeUndefined();
  });
});
