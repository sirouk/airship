import { describe, expect, it } from "vitest";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { createSessionManifest } from "../core/session-manifest";
import { MemoryWorkspace } from "../workspace/memory";
import { migrateJournalState } from "../vault/runtime-adoption";
import { auditSessionHistory } from "../core/session-audit";
import {
  WORK_BUNDLE_SEAL_NAMESPACE,
  applyWorkBundleImport,
  collectWorkBundle,
  isSealedWorkBundle,
  openSealedWorkBundle,
  parseWorkBundle,
  planWorkBundleImport,
  sealWorkBundle,
  serializeWorkBundle,
  verifyWorkBundleChain,
  workBundleFileName,
  type WorkBundle,
} from "./work-bundle";
import {
  WorkspaceRootKey,
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from "../storage/encrypted-envelope";
import type { PortableSealPort } from "../workspace/contracts";

const MEMORY_PATH = "/workspace/.airship/memory.json";

async function device(): Promise<Readonly<{ backend: MemoryJournalBackend; journal: EventJournal }>> {
  const backend = new MemoryJournalBackend();
  return { backend, journal: new EventJournal(backend) };
}

async function conversation(journal: EventJournal, title: string): Promise<string> {
  const manifest = await createSessionManifest({
    systemPrompt: "test",
    providerId: "local",
    model: "demo",
    tools: [],
    workspaceId: "workspace",
  });
  const session = await journal.createSession(title, manifest);
  // A real journal verb rather than a synthetic event: `session.renamed` is
  // one the product writes and the audit knows, so the chain this bundle
  // carries is the chain a person's conversation actually has.
  await journal.renameSession(session.id, `${title} · noted`);
  return session.id;
}

/** The real envelope, keyed by a real root key — the Vault's own encryption. */
async function sealPort(key: WorkspaceRootKey): Promise<PortableSealPort> {
  let revision = 0;
  return {
    async sealPortable(namespace, plaintext) {
      revision += 1;
      return encodeEnvelope(await sealEnvelope({
        key,
        namespace,
        logicalId: "portable",
        revision: String(revision),
        contentType: "application/json",
        plaintext,
      }));
    },
    async openPortable(namespace, sealed) {
      return openEnvelope({
        key,
        envelope: decodeEnvelope(sealed),
        expectedNamespace: namespace,
        expectedLogicalId: "portable",
      });
    },
  };
}

async function bundleOf(journal: EventJournal, ids: readonly string[]): Promise<WorkBundle> {
  return collectWorkBundle({ journal, sessionIds: ids, exportedAt: "2026-08-21T09:00:00.000Z" });
}

async function importInto(
  target: Readonly<{ backend: MemoryJournalBackend; journal: EventJournal }>,
  bundle: WorkBundle,
  workspace?: MemoryWorkspace,
) {
  const chain = await verifyWorkBundleChain(bundle);
  const plan = await planWorkBundleImport({ bundle, journal: target.journal, chain, workspace });
  const result = await applyWorkBundleImport({
    bundle,
    plan,
    target: target.backend,
    migrate: migrateJournalState,
    workspace,
    includeMemory: Boolean(workspace),
  });
  return { plan, result };
}

describe("work bundle", () => {
  it("is one JSON object other software can read, and survives a round trip byte for byte", async () => {
    const laptop = await device();
    const first = await conversation(laptop.journal, "Roof survey");
    const second = await conversation(laptop.journal, "Landing gear");
    const bundle = await bundleOf(laptop.journal, [first, second]);

    const text = serializeWorkBundle(bundle);
    // The readability claim, checked as a claim: no framing, no Airship codec.
    const plain = JSON.parse(text) as { conversations: { session: { id: string }; events: unknown[] }[] };
    expect(plain.conversations.map((entry) => entry.session.id)).toEqual([first, second]);
    expect(plain.conversations[0]!.events).toHaveLength(2);

    const phone = await device();
    const { plan, result } = await importInto(phone, parseWorkBundle(text));
    expect(plan.conversations.map((entry) => entry.state)).toEqual(["new", "new"]);
    expect(result.imported).toBe(2);

    // Ids, event bytes, sequences and digest heads, all of them.
    const returned = await bundleOf(phone.journal, [first, second]);
    expect(serializeWorkBundle(returned)).toBe(text);
  });

  it("lands in an empty authority with the same ids, digests and a verified audit", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "Audited");
    const before = await laptop.journal.getSession(id);
    const beforeEvents = await laptop.journal.readEvents(id);

    // An empty browser authority: a fresh journal that has never seen this id.
    const empty = await device();
    expect(await empty.journal.listSessions()).toEqual([]);
    const { result } = await importInto(empty, parseWorkBundle(serializeWorkBundle(await bundleOf(laptop.journal, [id]))));
    expect(result.imported).toBe(1);

    const after = await empty.journal.getSession(id);
    const afterEvents = await empty.journal.readEvents(id);
    expect(after!.id).toBe(before!.id);
    expect(after!.headSequence).toBe(before!.headSequence);
    expect(after!.headDigest).toBe(before!.headDigest);
    expect(afterEvents.map((event) => event.eventId)).toEqual(beforeEvents.map((event) => event.eventId));
    expect(afterEvents.map((event) => event.digest)).toEqual(beforeEvents.map((event) => event.digest));
    expect(afterEvents.map((event) => event.previousDigest)).toEqual(beforeEvents.map((event) => event.previousDigest));
    expect(afterEvents.map((event) => event.recordedAt)).toEqual(beforeEvents.map((event) => event.recordedAt));

    // And the product's own audit, on the imported copy, in the empty authority.
    const report = await auditSessionHistory({ session: after!, events: afterEvents });
    expect(report.status).toBe("verified");
    expect(report.checks.chain).toBe(true);
    expect(report.commitment).toEqual({ sequence: before!.headSequence, digest: before!.headDigest });
  });

  it("recomputes every digest from the file rather than trusting it", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "Ballast");
    const bundle = await bundleOf(laptop.journal, [id]);
    expect(await verifyWorkBundleChain(bundle)).toEqual([{ sessionId: id, verified: true }]);

    const tampered = JSON.parse(serializeWorkBundle(bundle)) as {
      conversations: { events: { payload: { text: string } }[] }[];
    };
    tampered.conversations[0]!.events[1]!.payload.text = "something else entirely";
    const reparsed = parseWorkBundle(JSON.stringify(tampered));
    const chain = await verifyWorkBundleChain(reparsed);
    expect(chain[0]!.verified).toBe(false);

    const phone = await device();
    const { plan, result } = await importInto(phone, reparsed);
    expect(plan.conversations[0]!.state).toBe("unreadable");
    expect(result.refused).toBe(1);
    expect(await phone.journal.listSessions()).toEqual([]);
  });

  it("merges rather than replaces, in both directions, without losing newer work", async () => {
    const laptop = await device();
    const shared = await conversation(laptop.journal, "Shared thread");
    const laptopOnly = await conversation(laptop.journal, "Laptop only");

    // Laptop -> phone.
    const phone = await device();
    await importInto(phone, await bundleOf(laptop.journal, [shared, laptopOnly]));
    // Work made on the phone afterwards.
    const phoneOnly = await conversation(phone.journal, "Phone only");

    // Phone -> laptop. The laptop keeps everything it had.
    const back = await bundleOf(phone.journal, [shared, laptopOnly, phoneOnly]);
    const { plan, result } = await importInto(laptop, back);
    expect(plan.conversations.map((entry) => entry.state)).toEqual(["present", "present", "new"]);
    expect(plan.untouchedConversations).toBe(0);
    expect(result).toMatchObject({ imported: 1, skipped: 2, refused: 0 });
    const titles = (await laptop.journal.listSessions()).map((session) => session.title).sort();
    expect(titles).toEqual(["Laptop only · noted", "Phone only · noted", "Shared thread · noted"]);
  });

  it("refuses a conflicting session instead of merging it silently", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "Hangar");
    const bundle = await bundleOf(laptop.journal, [id]);

    // A different journal that reuses the same id for different work.
    const phone = await device();
    const divergent = structuredClone(bundle.conversations[0]!.session);
    await phone.backend.createSession({ ...divergent, title: "Hangar, elsewhere", headSequence: 0, headDigest: "genesis" });

    const { plan, result } = await importInto(phone, bundle);
    expect(plan.conversations[0]!.state).toBe("conflict");
    expect(plan.conversations[0]!.reason).toContain("different conversation under that id");
    expect(result.refused).toBe(1);
    expect((await phone.journal.getSession(id))!.title).toBe("Hangar, elsewhere");
  });

  it("names what it will not touch", async () => {
    const laptop = await device();
    const carried = await conversation(laptop.journal, "Carried");
    const bundle = await bundleOf(laptop.journal, [carried]);
    const phone = await device();
    await conversation(phone.journal, "Untouched one");
    await conversation(phone.journal, "Untouched two");
    const chain = await verifyWorkBundleChain(bundle);
    const plan = await planWorkBundleImport({ bundle, journal: phone.journal, chain });
    expect(plan.untouchedConversations).toBe(2);
  });

  it("carries memory records only when asked, and joins them by id", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "With memory");
    const source = new MemoryWorkspace();
    await source.write(MEMORY_PATH, memoryDocument([
      memory("m-1", "the hangar door sticks", "general"),
      memory("m-2", "ballast is measured in litres", "general"),
      memory("m-3", "belongs to another profile", "research"),
    ]));

    const without = await collectWorkBundle({
      journal: laptop.journal,
      sessionIds: [id],
      exportedAt: "2026-08-21T09:00:00.000Z",
    });
    expect(without.memory).toBeNull();

    const bundle = await collectWorkBundle({
      journal: laptop.journal,
      sessionIds: [id],
      exportedAt: "2026-08-21T09:00:00.000Z",
      memory: { workspace: source, profileId: "general" },
    });
    expect(bundle.memory!.records.map((entry) => entry.id)).toEqual(["m-1", "m-2"]);

    const phone = await device();
    const target = new MemoryWorkspace();
    await target.write(MEMORY_PATH, memoryDocument([
      memory("m-1", "the hangar door sticks", "general"),
      memory("m-9", "phone wrote this", "general"),
    ]));
    const { plan, result } = await importInto(phone, parseWorkBundle(serializeWorkBundle(bundle)), target);
    expect(plan.memory).toEqual({ offered: 2, add: 1, present: 1, conflict: 0, overflow: 0 });
    expect(result.memory).toEqual({ added: 1, present: 1, conflict: 0, overflow: 0 });
    const merged = JSON.parse((await target.read(MEMORY_PATH))!.content) as { records: { id: string }[] };
    expect(merged.records.map((entry) => entry.id)).toEqual(["m-1", "m-9", "m-2"]);
  });

  it("refuses a memory record that would overwrite a different one under the same id", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "Memory clash");
    const source = new MemoryWorkspace();
    await source.write(MEMORY_PATH, memoryDocument([memory("m-1", "the hangar door sticks", "general")]));
    const bundle = await collectWorkBundle({
      journal: laptop.journal,
      sessionIds: [id],
      exportedAt: "2026-08-21T09:00:00.000Z",
      memory: { workspace: source, profileId: "general" },
    });

    const phone = await device();
    const target = new MemoryWorkspace();
    await target.write(MEMORY_PATH, memoryDocument([memory("m-1", "something entirely different", "general")]));
    const { plan, result } = await importInto(phone, bundle, target);
    expect(plan.memory).toEqual({ offered: 1, add: 0, present: 0, conflict: 1, overflow: 0 });
    expect(result.memory!.conflict).toBe(1);
    const kept = JSON.parse((await target.read(MEMORY_PATH))!.content) as { records: { content: string }[] };
    expect(kept.records[0]!.content).toBe("something entirely different");
  });

  it("seals with the Vault's own envelope, and only that Vault opens it", async () => {
    const laptop = await device();
    const id = await conversation(laptop.journal, "Sealed run");
    const bundle = await bundleOf(laptop.journal, [id]);

    const mine = await sealPort((await WorkspaceRootKey.generate()).key);
    const sealed = await sealWorkBundle(mine, bundle);
    const text = new TextDecoder().decode(sealed);
    expect(isSealedWorkBundle(text)).toBe(true);
    expect(isSealedWorkBundle(serializeWorkBundle(bundle))).toBe(false);
    // The cost of sealing: the messages are not in the file in readable form.
    expect(text).not.toContain("Sealed run");
    expect(JSON.parse(text)).toMatchObject({ suite: "AES-256-GCM/HKDF-SHA-256" });

    const reopened = await openSealedWorkBundle(mine, sealed);
    expect(serializeWorkBundle(reopened)).toBe(serializeWorkBundle(bundle));

    const someoneElse = await sealPort((await WorkspaceRootKey.generate()).key);
    await expect(openSealedWorkBundle(someoneElse, sealed)).rejects.toThrow(/not sealed by the Vault that is open here/u);
    expect(WORK_BUNDLE_SEAL_NAMESPACE).toBe("airship/work-bundle/v1");
  });

  it("names the file for the moment it was written, and marks a sealed one", () => {
    expect(workBundleFileName("2026-08-21T09:04:12.512Z", false)).toBe("airship-work-2026-08-21-09-04.json");
    expect(workBundleFileName("2026-08-21T09:04:12.512Z", true)).toBe("airship-work-2026-08-21-09-04.sealed.json");
  });

  it("refuses a file that is not an Airship bundle, and one that carries a storage fence", async () => {
    expect(() => parseWorkBundle("not json at all")).toThrow(/not JSON/u);
    expect(() => parseWorkBundle('{"format":"something.else"}')).toThrow(/not an Airship work bundle/u);
    const laptop = await device();
    const id = await conversation(laptop.journal, "Fenced");
    const bundle = JSON.parse(serializeWorkBundle(await bundleOf(laptop.journal, [id]))) as {
      conversations: { session: Record<string, unknown> }[];
    };
    bundle.conversations[0]!.session.headIncarnation = "device-local-fence";
    expect(() => parseWorkBundle(JSON.stringify(bundle))).toThrow(/storage fence/u);
  });
});

function memory(id: string, content: string, profileId: string): Record<string, unknown> {
  return {
    id,
    content,
    source: "test",
    createdAt: "2026-08-01T00:00:00.000Z",
    scope: {
      kind: "profile",
      profileId,
      profileRevision: "r1",
      createdInSessionId: "s1",
    },
  };
}

function memoryDocument(records: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ version: 2, records }, undefined, 2)}\n`;
}
