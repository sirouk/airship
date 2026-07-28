import { expect, test } from "@playwright/test";

test("Local Device enrollment commits only after recovery acknowledgement and reopens offline", async ({ page, context }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One Chromium CryptoKey + OPFS/IndexedDB authority is sufficient for this browser contract.",
  );
  const partition = `playwright-enrollment-${crypto.randomUUID()}`;
  const plaintext = `offline-workspace-${crypto.randomUUID()}`;

  await page.goto("/e2e/fixtures/provider-fabric-harness.html");
  const enrolled = await page.evaluate(async ({ partition, plaintext }) => {
    const [
      {
        openLocalDeviceWorkspaceKey,
        prepareLocalDeviceWorkspaceKeyEnrollment,
      },
      { openLocalDeviceVault },
    ] = await Promise.all([
      import("/src/storage/local-device-keyring.ts"),
      import("/src/vault/local-device.ts"),
    ]);

    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({ partition });
    const recoveryKey = enrollment.recoveryKey;
    const beforeCommit = await openLocalDeviceWorkspaceKey({ partition });
    const serializedEnrollment = JSON.stringify(enrollment);
    const committed = await enrollment.commit({
      recoveryKeySavedAcknowledged: true,
    });
    const handle = await openLocalDeviceVault({
      partition,
      workspaceKey: committed.key,
      disposition: "open-existing",
    });
    await handle.runtime.workspace.write("/workspace/offline.txt", plaintext);
    const backup = await handle.exportEncryptedBackup();
    const backend = handle.runtime.acceleration.backend;
    handle.close();

    const persistence = {
      localStorage: Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
      sessionStorage: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    };
    return {
      recoveryKey,
      beforeCommitWasMissing: beforeCommit === undefined,
      created: committed.created,
      extractable: committed.key.persistedHandle().extractable,
      backend,
      recoveryInEnrollmentJson: serializedEnrollment.includes(recoveryKey),
      recoveryInPersistence: JSON.stringify(persistence).includes(recoveryKey),
      plaintextInPersistence: JSON.stringify(persistence).includes(plaintext),
      plaintextInBackup: new TextDecoder().decode(backup).includes(plaintext),
    };
  }, { partition, plaintext });

  expect(enrolled).toMatchObject({
    beforeCommitWasMissing: true,
    created: true,
    extractable: false,
    backend: expect.stringMatching(/^(opfs|indexeddb)$/u),
    recoveryInEnrollmentJson: false,
    recoveryInPersistence: false,
    plaintextInPersistence: false,
    plaintextInBackup: false,
  });
  expect(enrolled.recoveryKey).toMatch(/^airship-wrk-v1\.[A-Za-z0-9_-]{43}$/u);

  await page.reload();
  await page.evaluate(async () => {
    const [keyring, vault] = await Promise.all([
      import("/src/storage/local-device-keyring.ts"),
      import("/src/vault/local-device.ts"),
    ]);
    Object.defineProperty(globalThis, "__airshipOfflineReopen", {
      configurable: true,
      value: async (partition: string) => {
        const reopened = await keyring.openLocalDeviceWorkspaceKey({ partition });
        if (!reopened) throw new Error("The enrolled browser-profile key disappeared.");
        const handle = await vault.openLocalDeviceVault({
          partition,
          workspaceKey: reopened.key,
          disposition: "open-existing",
        });
        const file = await handle.runtime.workspace.read("/workspace/offline.txt");
        const result = {
          created: reopened.created,
          extractable: reopened.key.persistedHandle().extractable,
          content: file?.content,
          backend: handle.runtime.acceleration.backend,
          online: navigator.onLine,
        };
        handle.close();
        return result;
      },
    });
  });

  await context.setOffline(true);
  try {
    const reopened = await page.evaluate(async (partition) => {
      const reopen = (
        globalThis as typeof globalThis & {
          __airshipOfflineReopen?: (partition: string) => Promise<unknown>;
        }
      ).__airshipOfflineReopen;
      if (!reopen) throw new Error("Offline reopen harness was not installed.");
      return await reopen(partition);
    }, partition);

    expect(reopened).toEqual({
      created: false,
      extractable: false,
      content: plaintext,
      backend: enrolled.backend,
      online: false,
    });
  } finally {
    await context.setOffline(false);
  }
});
