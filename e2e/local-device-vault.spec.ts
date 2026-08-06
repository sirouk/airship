import { expect, test } from "@playwright/test";

test("device Vault persists encrypted state offline through OPFS and atomically restores a backup", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one real Chromium OPFS authority contract is sufficient");
  await page.goto("/e2e/fixtures/provider-fabric-harness.html");
  await expect(page).toHaveTitle("Airship provider fabric acceptance harness");

  const partition = `playwright-device-${crypto.randomUUID()}`;
  const first = await page.evaluate(async (partition) => {
    const [{ WorkspaceRootKey }, { openLocalDeviceVault }] = await Promise.all([
      import("/src/storage/encrypted-envelope.ts"),
      import("/src/vault/local-device.ts"),
    ]);
    const generated = await WorkspaceRootKey.generate();
    const handle = await openLocalDeviceVault({
      partition,
      workspaceKey: generated.key,
      disposition: "create-new",
      displayName: "Playwright device",
    });
    const contender = await openLocalDeviceVault({
      partition,
      workspaceKey: generated.key,
      disposition: "open-existing",
      displayName: "Second tab authority",
    });
    const createRace = await Promise.all([
      handle.runtime.store.putIfAbsent("races/head", new TextEncoder().encode("left")),
      contender.runtime.store.putIfAbsent("races/head", new TextEncoder().encode("right")),
    ]);
    const head = await handle.runtime.store.get("races/head");
    if (!head) throw new Error("OPFS create-race winner disappeared.");
    const casRace = await Promise.all([
      handle.runtime.store.compareAndSwap("races/head", head.etag, new TextEncoder().encode("one")),
      contender.runtime.store.compareAndSwap("races/head", head.etag, new TextEncoder().encode("two")),
    ]);
    await handle.runtime.workspace.write("/workspace/private.txt", "device-only secret");
    const backup = await handle.exportEncryptedBackup();
    const serialized = new TextDecoder().decode(backup);
    const status = handle.status;
    contender.close();
    handle.close();
    return {
      recovery: [...generated.recoveryBytes],
      backup: [...backup],
      status,
      runtimeKeys: Object.keys(handle.runtime).sort(),
      createWinners: createRace.filter((result) => result.created).length,
      casWinners: casRace.filter((result) => result.updated).length,
      leaksPath: serialized.includes("/workspace/private.txt"),
      leaksValue: serialized.includes("device-only secret"),
    };
  }, partition);

  expect(first.status).toMatchObject({
    phase: "ready",
    configuration: {
      provider: "local-device",
      authority: "this-browser-origin",
      offline: true,
      synchronization: "device-only",
    },
    readiness: {
      backend: "opfs",
      schema: { current: 2 },
    },
  });
  expect(first.leaksPath).toBe(false);
  expect(first.leaksValue).toBe(false);
  expect(first.createWinners).toBe(1);
  expect(first.casWinners).toBe(1);
  expect(first.runtimeKeys).toEqual([
    "acceleration",
    "contextFabric",
    "journal",
    "profiles",
    "store",
    "workspace",
  ]);

  await page.reload();
  const reopened = await page.evaluate(async ({ partition, recovery, backup }) => {
    const [{
      WorkspaceRootKey,
    }, {
      openLocalDeviceVault,
      restoreLocalDeviceVaultBackup,
    }] = await Promise.all([
      import("/src/storage/encrypted-envelope.ts"),
      import("/src/vault/local-device.ts"),
    ]);
    const key = await WorkspaceRootKey.import(Uint8Array.from(recovery));
    const handle = await openLocalDeviceVault({
      partition,
      workspaceKey: key,
      disposition: "open-existing",
    });
    const restoredBefore = await handle.runtime.workspace.read("/workspace/private.txt");
    handle.close();
    const transientHandle = await openLocalDeviceVault({
      partition,
      workspaceKey: key,
      disposition: "open-existing",
    });
    await transientHandle.runtime.store.putIfAbsent(
      "transient/after-backup",
      Uint8Array.from([9, 8, 7]),
    );
    transientHandle.close();
    const restored = await restoreLocalDeviceVaultBackup({
      partition,
      workspaceKey: key,
      disposition: "open-existing",
      backup: Uint8Array.from(backup),
    });
    const restoredHandle = await openLocalDeviceVault({
      partition,
      workspaceKey: key,
      disposition: "open-existing",
    });
    const transientAfterRestore = await restoredHandle.runtime.store.get("transient/after-backup");
    const restoredAfter = await restoredHandle.runtime.workspace.read("/workspace/private.txt");
    const backend = restoredHandle.runtime.acceleration.backend;
    restoredHandle.close();
    return {
      backend,
      restored,
      before: restoredBefore?.content,
      after: restoredAfter?.content,
      transientPresent: Boolean(transientAfterRestore),
    };
  }, { partition, recovery: first.recovery, backup: first.backup });

  expect(reopened).toEqual({
    backend: "opfs",
    restored: expect.objectContaining({ restored: expect.any(Number) }),
    before: "device-only secret",
    after: "device-only secret",
    transientPresent: false,
  });
});

test("device Vault upgrades schema v1 and uses IndexedDB when atomic OPFS is unavailable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one real Chromium IndexedDB fallback contract is sufficient");
  await page.addInitScript(() => {
    if (typeof StorageManager !== "undefined") {
      Object.defineProperty(StorageManager.prototype, "getDirectory", {
        configurable: true,
        value: undefined,
      });
    }
  });
  await page.goto("/e2e/fixtures/provider-fabric-harness.html");
  await expect(page).toHaveTitle("Airship provider fabric acceptance harness");

  const partition = `playwright-idb-${crypto.randomUUID()}`;
  const result = await page.evaluate(async (partition) => {
    const [{ sha256 }, { WorkspaceRootKey }, { openLocalDeviceVault }] = await Promise.all([
      import("/src/core/hash.ts"),
      import("/src/storage/encrypted-envelope.ts"),
      import("/src/vault/local-device.ts"),
    ]);
    const databaseId = (await sha256(`airship-local-device-vault/v1\0${partition}`)).slice("sha256:".length);
    const databaseName = `airship-local-device-vault-v1-${databaseId}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore("encrypted-objects", { keyPath: "id" });
      }, { once: true });
      request.addEventListener("success", () => {
        request.result.close();
        resolve();
      }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });

    const generated = await WorkspaceRootKey.generate();
    const first = await openLocalDeviceVault({
      partition,
      workspaceKey: generated.key,
      disposition: "create-new",
    });
    const contender = await openLocalDeviceVault({
      partition,
      workspaceKey: generated.key,
      disposition: "open-existing",
    });
    const createRace = await Promise.all([
      first.runtime.store.putIfAbsent("races/idb", new TextEncoder().encode("left")),
      contender.runtime.store.putIfAbsent("races/idb", new TextEncoder().encode("right")),
    ]);
    const head = await first.runtime.store.get("races/idb");
    if (!head) throw new Error("IndexedDB create-race winner disappeared.");
    const casRace = await Promise.all([
      first.runtime.store.compareAndSwap("races/idb", head.etag, new TextEncoder().encode("one")),
      contender.runtime.store.compareAndSwap("races/idb", head.etag, new TextEncoder().encode("two")),
    ]);
    contender.close();
    await first.runtime.workspace.write("/workspace/fallback.txt", "indexed persistence");
    const status = first.status;
    first.close();
    const reopened = await openLocalDeviceVault({
      partition,
      workspaceKey: generated.key,
      disposition: "open-existing",
    });
    const restored = await reopened.runtime.workspace.read("/workspace/fallback.txt");
    const backend = reopened.runtime.acceleration.backend;
    reopened.close();
    return {
      backend,
      restored: restored?.content,
      status,
      recovery: [...generated.recoveryBytes],
      createWinners: createRace.filter((entry) => entry.created).length,
      casWinners: casRace.filter((entry) => entry.updated).length,
    };
  }, partition);

  expect(result).toMatchObject({
    backend: "indexeddb",
    restored: "indexed persistence",
    createWinners: 1,
    casWinners: 1,
    status: {
      readiness: {
        backend: "indexeddb",
        schema: { current: 2, migratedFrom: 1 },
      },
    },
  });

  const upgradedBrowser = await page.context().newPage();
  await upgradedBrowser.goto("/e2e/fixtures/provider-fabric-harness.html");
  const selected = await upgradedBrowser.evaluate(async ({ partition, recovery }) => {
    const [{ WorkspaceRootKey }, { openLocalDeviceVault }] = await Promise.all([
      import("/src/storage/encrypted-envelope.ts"),
      import("/src/vault/local-device.ts"),
    ]);
    const key = await WorkspaceRootKey.import(Uint8Array.from(recovery));
    const handle = await openLocalDeviceVault({
      partition,
      workspaceKey: key,
      disposition: "open-existing",
    });
    const restored = await handle.runtime.workspace.read("/workspace/fallback.txt");
    const backend = handle.runtime.acceleration.backend;
    handle.close();
    return { backend, restored: restored?.content };
  }, { partition, recovery: result.recovery });
  await upgradedBrowser.close();

  expect(selected).toEqual({
    backend: "indexeddb",
    restored: "indexed persistence",
  });
});


test("a lost enrolled key copy gets an honest destruction path instead of an impossible backup demand", async ({ page, baseURL }) => {
  await page.goto("/#vault", { waitUntil: "domcontentloaded" });
  const provider = page.getByRole("button", { name: "Vault storage provider" });
  await provider.click();
  await page.getByRole("listbox", { name: "Vault storage provider" })
    .getByRole("option", { name: /^Local Device\b/u }).click();
  const setup = page.locator(".local-device-vault");
  await expect(setup).toBeVisible({ timeout: 20_000 });
  await setup.getByRole("button", { name: "Create new" }).click();
  const saveButton = setup.getByRole("button", { name: "I wrote it down by hand" });
  await saveButton.click();
  await setup.getByText("I saved this recovery key outside Airship").click();
  await setup.getByRole("button", { name: "Create encrypted Vault" }).click();
  await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });

  // The enrolled key record dies; the encrypted authority survives. This is
  // the state the old flow dead-ended on: an existing Vault whose backup the
  // browser can never encrypt.
  await page.evaluate(async () => {
    const req = indexedDB.open("airship-local-device-keyring-v1");
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("workspace-keys", "readwrite");
        tx.objectStore("workspace-keys").clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(setup).toBeVisible({ timeout: 20_000 });
  await setup.getByRole("button", { name: "Create new" }).click();
  await expect(setup.getByText("This browser already has a Local Device Vault")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to backup warning" }).click();

  // No pretense of a backup: the stage names the lost key copy and its exits —
  // recover with the saved recovery key, or destroy the unreadable authority.
  await expect(setup.getByText("This browser no longer holds this Vault’s key copy")).toBeVisible();
  const destroyButton = setup.getByRole("button", { name: "Destroy the unreadable Vault" });
  await expect(destroyButton).toBeDisabled();
  await setup.getByText("I understand every encrypted record in this Vault will be permanently destroyed").click();
  await expect(destroyButton).toBeEnabled();

  // Destruction ends in a reload (the storage authority was replaced
  // underneath the page); assertions belong to the reloaded page.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    destroyButton.click(),
  ]);
  await expect(setup.getByRole("button", { name: "Create new" })).toBeVisible({ timeout: 30_000 });
  const authority = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((db) => db.name?.startsWith("airship-local-device-vault-v1-"));
  });
  expect(authority).toBe(false);
});
