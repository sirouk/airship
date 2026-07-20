import { describe, expect, it, vi } from "vitest";
import { VaultCoordinator } from "./coordinator";
import {
  LocalLabRecoveryMaterial,
  MemoryOnlyLocalLabCredentialProvider,
  createLocalLabConfigureRequest,
  importLocalLabRecoveryKey,
  type CreateLocalLabRequest,
} from "./local-lab";

describe("local S3 vault lab", () => {
  it("keeps credentials in native private fields, returns them only while active, and resets", async () => {
    const provider = new MemoryOnlyLocalLabCredentialProvider("minio-user", "minio-secret");

    await expect(provider.getCredentials()).resolves.toEqual({
      accessKeyId: "minio-user",
      secretAccessKey: "minio-secret",
    });
    expect(JSON.stringify(provider)).toBe('{"kind":"local-development","active":true,"persistence":"memory-only"}');
    expect(Object.keys(provider)).toEqual([]);

    provider.reset();
    expect(provider.active).toBe(false);
    expect(JSON.stringify(provider)).not.toContain("minio");
    await expect(provider.getCredentials()).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("honors cancellation before disclosing the local credential pair", async () => {
    const provider = new MemoryOnlyLocalLabCredentialProvider("minio-user", "minio-secret");
    const controller = new AbortController();
    controller.abort(new DOMException("account changed", "AbortError"));

    await expect(provider.getCredentials(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("creates a frozen loopback-only coordinator request without network or probe effects", async () => {
    const recovery = await LocalLabRecoveryMaterial.generate();
    const network = vi.fn<typeof fetch>();
    const request = createLocalLabConfigureRequest({
      ...validInput(recovery),
      fetchImplementation: network,
    });

    expect(request.configuration).toMatchObject({
      mode: "local-development",
      endpoint: "http://127.0.0.1:9000",
      region: "auto",
      bucket: "airship-dev",
      namespace: "users/local-test",
      forcePathStyle: true,
      credentialSource: { kind: "local-development", authorityOrigins: [] },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.configuration)).toBe(true);
    expect(JSON.stringify(request)).not.toContain("minio-secret");
    expect(network).not.toHaveBeenCalled();

    const coordinator = new VaultCoordinator();
    expect(coordinator.configure(request)).toMatchObject({ phase: "configured", config: { mode: "local-development" } });
    expect(network).not.toHaveBeenCalled();
    coordinator.disconnect();
    recovery.clear();
  });

  it("rejects non-loopback endpoints and both missing acknowledgements before handoff", async () => {
    const recovery = await LocalLabRecoveryMaterial.generate();
    expect(() => createLocalLabConfigureRequest({
      ...validInput(recovery),
      endpoint: "https://s3.example.com",
    })).toThrow("loopback");
    expect(() => createLocalLabConfigureRequest({
      ...validInput(recovery),
      ownLoopbackServiceAcknowledged: false as true,
    })).toThrow("own loopback");
    expect(() => createLocalLabConfigureRequest({
      ...validInput(recovery),
      recoveryKeySavedAcknowledged: false as true,
    })).toThrow("recovery key was saved");
    recovery.clear();
  });

  it("validates local credential bounds without reflecting the supplied value", () => {
    for (const [access, secret] of [
      ["ab", "long-enough"],
      ["valid", "short"],
      [" leading", "long-enough"],
      ["valid", "line\nbreak-secret"],
    ]) {
      expect(() => new MemoryOnlyLocalLabCredentialProvider(access, secret)).toThrow(/Local S3 (?:access|secret) key is invalid/u);
    }
  });

  it("generates a one-time versioned recovery display that reconstructs the same workspace key", async () => {
    const material = await LocalLabRecoveryMaterial.generate();
    const display = material.displayValue;
    expect(display).toMatch(/^airship-wrk-v1\.[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(material)).not.toContain(display);
    const imported = await importLocalLabRecoveryKey(`  ${display}\n`);
    const logicalId = "workspace:recovery-equivalence";
    await expect(imported.opaqueObjectId(logicalId)).resolves.toBe(await material.workspaceKey.opaqueObjectId(logicalId));

    material.clear();
    expect(material.cleared).toBe(true);
    expect(() => material.displayValue).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
    expect(() => material.workspaceKey).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
    expect(JSON.stringify(material)).toBe('{"kind":"workspace-recovery","available":false,"persistence":"memory-only"}');
  });

  it.each([
    "",
    "airship-wrk-v0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "airship-wrk-v1.short",
    "airship-wrk-v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])("rejects malformed recovery material without importing it: %s", async (value) => {
    await expect(importLocalLabRecoveryKey(value)).rejects.toThrow("recovery key");
  });
});

function validInput(recovery: LocalLabRecoveryMaterial): CreateLocalLabRequest {
  return {
    endpoint: "http://127.0.0.1:9000",
    region: "auto",
    bucket: "airship-dev",
    namespace: "users/local-test",
    accessKeyId: "minio-user",
    secretAccessKey: "minio-secret",
    workspaceKey: recovery.workspaceKey,
    recoveryKeySavedAcknowledged: true,
    ownLoopbackServiceAcknowledged: true,
  };
}
