import { describe, expect, it } from "vitest";
import { runObjectStoreConformance } from "./conformance";
import { WorkspaceRootKey } from "./encrypted-envelope";
import {
  LocalDeviceObjectStore,
  LocalDeviceVaultCorruptionError,
  LocalDeviceVaultNotFoundError,
  MemoryLocalDeviceRecordBackend,
} from "./local-device-object-store";

const encoder = new TextEncoder();

describe("LocalDeviceObjectStore", () => {
  it("is a real offline authority with exact ranges and atomic conditional writes", async () => {
    const { store } = await fixture("object-contract");

    const conformance = await runObjectStoreConformance({
      store,
      prefix: "probe",
      nonce: "localdevice01",
    });

    expect(conformance.capabilities.adapter).toMatchObject({
      adapter: "local-device",
      conditionalWrite: {
        createIfAbsent: "atomic-or-fail",
        compareAndSwap: "atomic-or-fail",
        providerEvidence: "in-process",
      },
    });
    expect(store.localCapability).toMatchObject({
      provider: "local-device",
      persistence: "page-memory",
      offline: true,
      cloudSynchronization: "none",
      encryptionAtRest: "AES-256-GCM/HKDF-SHA-256",
    });
  });

  it("encrypts both logical keys and values and reopens with the same non-extractable key", async () => {
    const generated = await WorkspaceRootKey.generate();
    const backend = new MemoryLocalDeviceRecordBackend();
    const first = new LocalDeviceObjectStore({
      partition: "personal",
      key: generated.key,
      backend,
      revision: sequence(),
    });
    await expect(first.verifyOrInitialize("create-new")).resolves.toBe("initialized");
    const logicalKey = "state/workspace/private-notes.txt";
    const secret = encoder.encode("the launch phrase is private");

    await expect(first.putIfAbsent(logicalKey, secret)).resolves.toMatchObject({ created: true });
    const persistedText = [...backend.records.values()]
      .map((raw) => `${JSON.stringify({ ...raw, ciphertext: undefined })}\n${new TextDecoder().decode(raw.ciphertext)}`)
      .join("\n");
    expect(persistedText).not.toContain(logicalKey);
    expect(persistedText).not.toContain("launch phrase");

    const reopened = new LocalDeviceObjectStore({
      partition: "personal",
      key: generated.key,
      backend,
      revision: sequence(),
    });
    await expect(reopened.verifyOrInitialize("open-existing")).resolves.toBe("verified");
    await expect(reopened.get(logicalKey)).resolves.toMatchObject({ bytes: secret });
    await expect(reopened.list("state/")).resolves.toEqual([
      expect.objectContaining({ key: logicalKey, size: secret.byteLength }),
    ]);
  });

  it("fails closed on ciphertext corruption and with the wrong recovery key", async () => {
    const generated = await WorkspaceRootKey.generate();
    const backend = new MemoryLocalDeviceRecordBackend();
    const store = new LocalDeviceObjectStore({
      partition: "corruption",
      key: generated.key,
      backend,
      revision: sequence(),
    });
    await store.verifyOrInitialize("create-new");
    await store.putIfAbsent("workspace/a.txt", encoder.encode("authentic"));

    const raw = [...backend.records.values()].at(-1)!;
    raw.ciphertext[raw.ciphertext.byteLength - 1] ^= 0xff;
    await expect(store.get("workspace/a.txt")).rejects.toBeInstanceOf(LocalDeviceVaultCorruptionError);
    await expect(store.list("")).rejects.toBeInstanceOf(LocalDeviceVaultCorruptionError);

    const cleanBackend = new MemoryLocalDeviceRecordBackend();
    const clean = new LocalDeviceObjectStore({
      partition: "wrong-key",
      key: generated.key,
      backend: cleanBackend,
      revision: sequence(),
    });
    await clean.verifyOrInitialize("create-new");
    await clean.putIfAbsent("workspace/b.txt", encoder.encode("belongs to another key"));
    const other = await WorkspaceRootKey.generate();
    const wrongKeyStore = new LocalDeviceObjectStore({
      partition: "wrong-key",
      key: other.key,
      backend: cleanBackend,
      revision: sequence(),
    });
    await expect(wrongKeyStore.verifyOrInitialize("open-existing")).rejects.toBeInstanceOf(LocalDeviceVaultCorruptionError);
  });

  it("exports ciphertext-only backups and atomically restores only after full authentication", async () => {
    const generated = await WorkspaceRootKey.generate();
    const sourceBackend = new MemoryLocalDeviceRecordBackend();
    const source = new LocalDeviceObjectStore({
      partition: "portable",
      key: generated.key,
      backend: sourceBackend,
      revision: sequence(),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    await source.verifyOrInitialize("create-new");
    await source.putIfAbsent("workspace/secret.txt", encoder.encode("portable private payload"));
    await source.putIfAbsent("state/index.bin", Uint8Array.from([1, 2, 3, 4]));

    const backup = await source.exportEncryptedBackup();
    const serialized = new TextDecoder().decode(backup);
    expect(serialized).toContain("airship-local-device-vault-backup");
    expect(serialized).not.toContain('"partition":"portable"');
    expect(serialized).not.toContain("workspace/secret.txt");
    expect(serialized).not.toContain("portable private payload");

    const targetBackend = new MemoryLocalDeviceRecordBackend();
    const target = new LocalDeviceObjectStore({
      partition: "portable",
      key: generated.key,
      backend: targetBackend,
      revision: sequence(),
    });
    await target.verifyOrInitialize("create-new");
    await target.putIfAbsent("old.txt", encoder.encode("replace me"));
    await expect(target.restoreEncryptedBackup(backup)).resolves.toEqual({ restored: 2 });
    await expect(target.get("old.txt")).resolves.toBeUndefined();
    await expect(target.get("workspace/secret.txt")).resolves.toMatchObject({
      bytes: encoder.encode("portable private payload"),
    });

    const stableInventory = await target.list("");
    const damaged = backup.slice();
    damaged[damaged.byteLength - 3] ^= 1;
    await expect(target.restoreEncryptedBackup(damaged)).rejects.toBeInstanceOf(LocalDeviceVaultCorruptionError);
    await expect(target.list("")).resolves.toEqual(stableInventory);

    const wrongKey = await WorkspaceRootKey.generate();
    const wrongTarget = new LocalDeviceObjectStore({
      partition: "portable",
      key: wrongKey.key,
      backend: new MemoryLocalDeviceRecordBackend(),
      revision: sequence(),
    });
    await expect(wrongTarget.restoreEncryptedBackup(backup)).rejects.toBeInstanceOf(LocalDeviceVaultCorruptionError);
  });

  it("serializes concurrent create and compare-and-swap races", async () => {
    const { store } = await fixture("races");
    const [left, right] = await Promise.all([
      store.putIfAbsent("head", encoder.encode("left")),
      store.putIfAbsent("head", encoder.encode("right")),
    ]);
    expect([left, right].filter((result) => result.created)).toHaveLength(1);
    const head = (await store.get("head"))!;

    const [first, second] = await Promise.all([
      store.compareAndSwap("head", head.etag, encoder.encode("one")),
      store.compareAndSwap("head", head.etag, encoder.encode("two")),
    ]);
    expect([first, second].filter((result) => result.updated)).toHaveLength(1);
  });

  it("never legitimizes an anchor-less inventory and distinguishes missing from corrupt", async () => {
    const generated = await WorkspaceRootKey.generate();
    const empty = new LocalDeviceObjectStore({
      partition: "missing",
      key: generated.key,
      backend: new MemoryLocalDeviceRecordBackend(),
      revision: sequence(),
    });
    await expect(empty.verifyOrInitialize("open-existing")).rejects.toBeInstanceOf(
      LocalDeviceVaultNotFoundError,
    );

    const backend = new MemoryLocalDeviceRecordBackend();
    const anchorless = new LocalDeviceObjectStore({
      partition: "anchorless",
      key: generated.key,
      backend,
      revision: sequence(),
    });
    await anchorless.putIfAbsent("orphan/object", encoder.encode("must not become legitimate"));
    await expect(anchorless.verifyOrInitialize("create-new")).rejects.toThrow(
      "no authenticated identity anchor",
    );
    await expect(anchorless.verifyOrInitialize("open-existing")).rejects.toThrow(
      "identity anchor is missing",
    );
  });

  it("authenticates the exact winning identity payload in a creation race", async () => {
    const backend = new MemoryLocalDeviceRecordBackend();
    const leftKey = await WorkspaceRootKey.generate();
    const rightKey = await WorkspaceRootKey.generate();
    const left = new LocalDeviceObjectStore({
      partition: "identity-race",
      key: leftKey.key,
      backend,
      revision: sequence(),
    });
    const right = new LocalDeviceObjectStore({
      partition: "identity-race",
      key: rightKey.key,
      backend,
      revision: sequence(),
    });

    const outcomes = await Promise.allSettled([
      left.verifyOrInitialize("create-new"),
      right.verifyOrInitialize("create-new"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(LocalDeviceVaultCorruptionError),
    });
  });

  it("binds encrypted backups to the exact local partition", async () => {
    const generated = await WorkspaceRootKey.generate();
    const source = new LocalDeviceObjectStore({
      partition: "profile-a",
      key: generated.key,
      backend: new MemoryLocalDeviceRecordBackend(),
      revision: sequence(),
    });
    await source.verifyOrInitialize("create-new");
    await source.putIfAbsent("a", encoder.encode("one"));
    const backup = await source.exportEncryptedBackup();
    const other = new LocalDeviceObjectStore({
      partition: "profile-b",
      key: generated.key,
      backend: new MemoryLocalDeviceRecordBackend(),
      revision: sequence(),
    });
    await expect(other.restoreEncryptedBackup(backup)).rejects.toThrow("targets another vault");
  });

  it("keeps the authenticated identity key outside the public object namespace", async () => {
    const { store } = await fixture("reserved-identity");
    const reserved = ".airship/local-device-vault-identity-v1";

    await expect(store.get(reserved)).rejects.toThrow("reserved");
    await expect(store.putIfAbsent(reserved, encoder.encode("forged"))).rejects.toThrow("reserved");
    await expect(store.compareAndSwap(reserved, "etag", encoder.encode("forged"))).rejects.toThrow(
      "reserved",
    );
  });
});

async function fixture(partition: string): Promise<{ store: LocalDeviceObjectStore }> {
  const generated = await WorkspaceRootKey.generate();
  const store = new LocalDeviceObjectStore({
    partition,
    key: generated.key,
    backend: new MemoryLocalDeviceRecordBackend(),
    revision: sequence(),
  });
  await store.verifyOrInitialize("create-new");
  return { store };
}

function sequence(): () => string {
  let value = 0;
  return () => `revision_${String(++value).padStart(8, "0")}`;
}
