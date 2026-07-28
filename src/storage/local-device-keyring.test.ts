import { describe, expect, it, vi } from "vitest";
import {
  MemoryLocalDeviceKeyHandleStore,
  importLocalDeviceWorkspaceRecoveryKey,
  openLocalDeviceWorkspaceKey,
  prepareLocalDeviceWorkspaceKeyEnrollment,
} from "./local-device-keyring";

describe("local device keyring", () => {
  it("persists nothing before recovery acknowledgement, then reopens the non-extractable handle", async () => {
    const store = new MemoryLocalDeviceKeyHandleStore();
    const initializeAuthority = vi.fn(async () => undefined);
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "personal",
      store,
      initializeAuthority,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(enrollment.recoveryKey).toMatch(/^airship-wrk-v1\.[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(enrollment)).not.toContain(enrollment.recoveryKey);
    await expect(openLocalDeviceWorkspaceKey({ partition: "personal", store })).resolves.toBeUndefined();
    expect(initializeAuthority).not.toHaveBeenCalled();

    await expect(enrollment.commit({
      recoveryKeySavedAcknowledged: false,
    } as unknown as { recoveryKeySavedAcknowledged: true })).rejects.toThrow("recovery key was saved");
    await expect(openLocalDeviceWorkspaceKey({ partition: "personal", store })).resolves.toBeUndefined();

    const committed = await enrollment.commit({ recoveryKeySavedAcknowledged: true });
    const reopened = await openLocalDeviceWorkspaceKey({ partition: "personal", store });
    expect(initializeAuthority).toHaveBeenCalledTimes(1);
    expect(committed.created).toBe(true);
    expect(reopened).toMatchObject({
      created: false,
      custody: "origin-private-non-extractable",
    });
    expect(reopened!.key.persistedHandle()).toBe(committed.key.persistedHandle());
    expect(reopened!.key.persistedHandle().extractable).toBe(false);
    expect(enrollment.toJSON()).toMatchObject({ state: "cleared" });
    expect(() => enrollment.recoveryKey).toThrow("cleared");
    await expect(enrollment.commit({ recoveryKeySavedAcknowledged: true })).resolves.toBe(committed);
  });

  it("cancellation leaves no durable key or authority", async () => {
    const store = new MemoryLocalDeviceKeyHandleStore();
    const initializeAuthority = vi.fn(async () => undefined);
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "cancelled",
      store,
      initializeAuthority,
    });

    enrollment.cancel();

    await expect(openLocalDeviceWorkspaceKey({ partition: "cancelled", store })).resolves.toBeUndefined();
    await expect(enrollment.commit({ recoveryKeySavedAcknowledged: true })).rejects.toThrow("cleared");
    expect(initializeAuthority).not.toHaveBeenCalled();
  });

  it("authenticates recovery against the existing authority before installing a handle", async () => {
    const store = new MemoryLocalDeviceKeyHandleStore();
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "recoverable",
      store,
      initializeAuthority: async () => undefined,
    });
    const recoveryKey = enrollment.recoveryKey;
    enrollment.cancel();
    const authenticateAuthority = vi.fn(async () => undefined);

    const recovered = await importLocalDeviceWorkspaceRecoveryKey({
      partition: "recoverable",
      recoveryKey,
      store,
      authenticateAuthority,
    });

    expect(authenticateAuthority).toHaveBeenCalledTimes(1);
    expect(recovered.created).toBe(true);
    await expect(openLocalDeviceWorkspaceKey({ partition: "recoverable", store })).resolves.toMatchObject({
      created: false,
    });
  });

  it("never installs a recovery key when authority authentication fails", async () => {
    const store = new MemoryLocalDeviceKeyHandleStore();
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "wrong-recovery",
      store,
      initializeAuthority: async () => undefined,
    });
    const recoveryKey = enrollment.recoveryKey;
    enrollment.cancel();

    await expect(importLocalDeviceWorkspaceRecoveryKey({
      partition: "wrong-recovery",
      recoveryKey,
      store,
      authenticateAuthority: async () => {
        throw new Error("identity authentication failed");
      },
    })).rejects.toThrow("identity authentication failed");
    await expect(openLocalDeviceWorkspaceKey({ partition: "wrong-recovery", store })).resolves.toBeUndefined();
  });

  it("rejects concurrent enrollment under a different key", async () => {
    const store = new MemoryLocalDeviceKeyHandleStore();
    const first = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "race",
      store,
      initializeAuthority: async () => undefined,
    });
    const second = await prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "race",
      store,
      initializeAuthority: async () => undefined,
    });

    await first.commit({ recoveryKeySavedAcknowledged: true });
    await expect(second.commit({ recoveryKeySavedAcknowledged: true })).rejects.toThrow(
      "Another workspace key",
    );
  });

  it("rejects unsafe partition identifiers", async () => {
    await expect(prepareLocalDeviceWorkspaceKeyEnrollment({
      partition: "../ escape",
      store: new MemoryLocalDeviceKeyHandleStore(),
    })).rejects.toThrow("partition");
  });
});
