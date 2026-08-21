import { describe, expect, it } from "vitest";
import type { JsonValue } from "../core/contracts";
import { createSessionManifest } from "../core/agent";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { sha256 } from "../core/hash";
import { createSlashCommandRegistry } from "../commands/registry";
import { MemoryWorkspace } from "../workspace/memory";
import { createAirshipToolRegistry } from "./airship-tools";
import { MEMORY_PATH, parseMemoryDocument } from "./memory-tools";
import { allowAllForTests } from "./registry";

describe("profile-scoped explicit memory", () => {
  it("binds writes and reads to the accountable session profile, not model arguments", async () => {
    const harness = await setup();
    const engineer = await harness.session("engineer");
    const researcher = await harness.session("researcher");

    await run(harness, engineer, "update_memory", {
      action: "remember",
      content: "Engineer-only turbine decision",
      source: "turn:engineer",
    }, "remember-engineer");
    await run(harness, researcher, "update_memory", {
      action: "remember",
      content: "Researcher-only citation preference",
      source: "turn:researcher",
    }, "remember-researcher");

    const engineerRecall = await run(harness, engineer, "recall_memory", {}, "recall-engineer");
    const researcherRecall = await run(harness, researcher, "recall_memory", {}, "recall-researcher");
    expect(engineerRecall.content).toContain("Engineer-only turbine decision");
    expect(engineerRecall.content).not.toContain("Researcher-only citation preference");
    expect(researcherRecall.content).toContain("Researcher-only citation preference");
    expect(researcherRecall.content).not.toContain("Engineer-only turbine decision");
    expect(engineerRecall.metadata).toMatchObject({ scope: "profile", profileId: "engineer" });

    await expect(review(harness, engineer, "recall_memory", { profileId: "researcher" }, "spoof"))
      .rejects.toThrow();
  });

  it("prevents one pinned profile from forgetting another profile's record", async () => {
    const harness = await setup();
    const engineer = await harness.session("engineer");
    const researcher = await harness.session("researcher");
    await run(harness, engineer, "update_memory", {
      action: "remember", content: "Owned by engineer", source: "turn:1",
    }, "remember");
    const document = parseMemoryDocument((await harness.workspace.read(MEMORY_PATH))!.content);
    const id = document.records[0]!.id;
    await expect(run(harness, researcher, "update_memory", { action: "forget", id }, "cross-forget"))
      .rejects.toThrow("not found in pinned profile researcher");
    expect((await harness.workspace.read(MEMORY_PATH))?.content).toContain(id);
  });

  it("migrates version 1 records into an explicit quarantined scope", async () => {
    const harness = await setup();
    const engineer = await harness.session("engineer");
    await harness.workspace.write(MEMORY_PATH, JSON.stringify({
      version: 1,
      records: [{
        id: "legacy-1",
        content: "Prior globally visible memory",
        source: "legacy",
        createdAt: "2026-07-18T00:00:00.000Z",
      }],
    }));

    const before = await run(harness, engineer, "recall_memory", {}, "legacy-recall");
    expect(JSON.parse(before.content)).toEqual([]);
    expect(before.metadata).toMatchObject({ legacyQuarantined: 1 });
    await run(harness, engineer, "update_memory", {
      action: "remember", content: "New scoped memory", source: "turn:new",
    }, "migrate-write");

    const stored = JSON.parse((await harness.workspace.read(MEMORY_PATH))!.content);
    expect(stored.version).toBe(2);
    expect(stored.records[0].scope).toEqual({ kind: "legacy-unscoped" });
    expect(stored.records[1].scope).toMatchObject({
      kind: "profile",
      profileId: "engineer",
      createdInSessionId: engineer,
    });
  });

  it("fails closed for sessions without a pinned profile", async () => {
    const harness = await setup();
    const manifest = await createSessionManifest({
      systemPrompt: "unbound",
      providerId: "test",
      model: "test",
      tools: harness.registry.definitions(),
      workspaceId: "memory://test",
    });
    const session = await harness.journal.createSession("Unbound", manifest);
    await expect(run(harness, session.id, "recall_memory", {}, "unbound"))
      .rejects.toThrow("pinned profile");
  });

  it("honours a session-scoped pin in recall, its counts, and forget", async () => {
    const harness = await setup();
    const first = await harness.session("research", "session");
    const second = await harness.session("research", "session");
    await run(harness, first, "update_memory", {
      action: "remember", content: "First-session quartz note", source: "turn:first",
    }, "remember-first");
    await run(harness, second, "update_memory", {
      action: "remember", content: "Second-session quartz note", source: "turn:second",
    }, "remember-second");

    const recall = await run(harness, first, "recall_memory", {}, "recall-first");
    expect(recall.content).toContain("First-session quartz note");
    expect(recall.content).not.toContain("Second-session quartz note");
    expect(recall.metadata).toMatchObject({ scope: "session", count: 1, total: 1 });

    const document = parseMemoryDocument((await harness.workspace.read(MEMORY_PATH))!.content);
    const siblingId = document.records[1]!.id;
    await expect(run(harness, first, "update_memory", { action: "forget", id: siblingId }, "cross-session-forget"))
      .rejects.toThrow("not found in pinned profile research");
  });

  it("rejects duplicate IDs so forgetting cannot remove two scopes at once", () => {
    const record = {
      id: "duplicate",
      content: "content",
      source: "source",
      createdAt: "2026-07-18T00:00:00.000Z",
      scope: { kind: "legacy-unscoped" },
    };
    expect(() => parseMemoryDocument(JSON.stringify({ version: 2, records: [record, record] })))
      .toThrow("duplicate memory IDs");
  });
});

describe("memory duplicates (phase 1: the hunter at the tool seam)", () => {
  it("re-pinning the same wording is idempotent instead of growing the corpus", async () => {
    const harness = await setup();
    const session = await harness.session("general");

    await run(harness, session, "update_memory", {
      action: "remember",
      content: "The turbine pressure limit is 42 bar.",
      source: "turn:pressure-review",
    }, "remember-1");
    const again = await run(harness, session, "update_memory", {
      action: "remember",
      content: "the TURBINE pressure limit   is 42 bar!!",
      source: "turn:pressure-review",
    }, "remember-2");

    expect(again.content).toContain("Already remembered");
    expect(again.metadata).toMatchObject({ status: "already-remembered" });
    expect(JSON.parse((await harness.workspace.read(MEMORY_PATH))!.content).records).toHaveLength(1);
  });

  it("a rephrased re-pin writes but names its near-twins in metadata", async () => {
    const harness = await setup();
    const session = await harness.session("general");

    const first = await run(harness, session, "update_memory", {
      action: "remember",
      content: "The turbine pressure limit is 42 bar.",
      source: "turn:pressure-review",
    }, "remember-1");
    const second = await run(harness, session, "update_memory", {
      action: "remember",
      content: "The turbine pressure limit is 42 bar at the inlet manifold.",
      source: "turn:pressure-review",
    }, "remember-2");

    expect((second.metadata as Record<string, JsonValue> | undefined)?.status).toBeUndefined();
    const duplicates = ((second.metadata as Record<string, JsonValue> | undefined)?.duplicates) as { id: string; similarity: number }[] | undefined ?? [];
    expect(duplicates.length).toBe(1);
    expect(first).toBeDefined();
    expect(duplicates[0]!.similarity).toBeGreaterThan(0.87);
    expect(JSON.parse((await harness.workspace.read(MEMORY_PATH))!.content).records).toHaveLength(2);
  });

  it("recall duplicates: true reports the cluster, keep-first, and never couples Berlin with Paris", async () => {
    const harness = await setup();
    const session = await harness.session("general");

    await run(harness, session, "update_memory", {
      action: "remember", content: "The owner lives in Berlin.", source: "turn:profile",
    }, "remember-berlin");
    await run(harness, session, "update_memory", {
      action: "remember", content: "The owner lives in Paris.", source: "turn:profile",
    }, "remember-paris");
    await run(harness, session, "update_memory", {
      action: "remember", content: "The deployment key rotates every 90 days.", source: "turn:ops",
    }, "remember-key-1");
    await run(harness, session, "update_memory", {
      action: "remember", content: "the deployment key rotates every 90 DAYS now", source: "turn:ops",
    }, "remember-key-2");

    const review = await run(harness, session, "recall_memory", { duplicates: true }, "review-dupes");
    const clusters = JSON.parse(review.content) as { keep: string; members: { id: string }[] }[];
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
    expect(review.metadata).toMatchObject({ duplicatesClusterCount: 1 });
  });

  it("identical wording in two profiles is an intended duplicate: the silo wall wins over the hunter", async () => {
    const harness = await setup();
    const engineer = await harness.session("engineer");
    const researcher = await harness.session("researcher");

    await run(harness, engineer, "update_memory", {
      action: "remember", content: "The deployment key rotates every 90 days.", source: "turn:ops",
    }, "remember-eng");
    const again = await run(harness, researcher, "update_memory", {
      action: "remember", content: "The deployment key rotates every 90 days.", source: "turn:ops",
    }, "remember-res");

    expect(again.content).toContain("Remembered");
    expect(again.metadata).not.toMatchObject({ status: "already-remembered" });
    const engineerReview = await run(harness, engineer, "recall_memory", { duplicates: true }, "review-eng");
    expect(JSON.parse(engineerReview.content)).toHaveLength(0);
  });
});

describe("what /help update-memory tells a person to type", () => {
  it("names the option each verb needs, because the usage line binds positionals in schema order", async () => {
    const harness = await setup();
    const descriptor = createSlashCommandRegistry({ tools: harness.registry }).resolve("update-memory")!;

    // The usage line is derived from declaration order and can only mark
    // `action` required, so someone following it with
    // `/update-memory remember "Chris prefers dark mode" "chat"` binds the fact
    // to `id`, the source to `content`, and is then told that `source` — the
    // argument they typed last — must be a non-empty string. The description is
    // printed directly beneath that line, which is where the per-verb
    // requirement has to be stated for it to reach the person in time.
    expect(descriptor.usage).toContain("<action> [id] [content] [source]");
    expect(descriptor.summary).toContain("--content");
    expect(descriptor.summary).toContain("--source");
    expect(descriptor.summary).toContain("--id");
  });
});

async function setup() {
  const workspace = new MemoryWorkspace();
  const journal = new EventJournal(new MemoryJournalBackend());
  const registry = await createAirshipToolRegistry({ workspace, journal });
  return {
    workspace,
    journal,
    registry,
    async session(profileId: string, memoryScope?: "session" | "profile" | "workspace"): Promise<string> {
      const digest = await sha256(`profile:${profileId}`);
      const base = {
        profileId,
        profileRevision: digest,
        themeId: "test",
        themeDigest: digest,
        resolvedSkills: [],
        skillSetDigest: digest,
        resolutionDigest: digest,
      };
      const manifest = await createSessionManifest({
        systemPrompt: profileId,
        providerId: "test",
        model: "test",
        tools: registry.definitions(),
        workspaceId: "memory://test",
        // A v1 pin has no silo fields, so it exercises the legacy default; a
        // memoryScope argument forces the current shape that carries one.
        profile: memoryScope
          ? {
            ...base,
            version: 2,
            workspaceBinding: { kind: "active-workspace" },
            memoryScope,
            approvalMode: "ask-first",
          }
          : { ...base, version: 1 },
      });
      return (await journal.createSession(profileId, manifest)).id;
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function review(harness: Harness, sessionId: string, name: string, args: Record<string, unknown>, operationId: string) {
  const context = { sessionId, turnId: operationId, operationId, signal: new AbortController().signal };
  return harness.registry.review(name, args as never, context, allowAllForTests);
}

async function run(harness: Harness, sessionId: string, name: string, args: Record<string, unknown>, operationId: string) {
  const context = { sessionId, turnId: operationId, operationId, signal: new AbortController().signal };
  expect(await harness.registry.review(name, args as never, context, allowAllForTests)).toBe("allow");
  return harness.registry.executeApproved(name, args as never, context);
}
