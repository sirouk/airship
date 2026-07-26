import { expect, test } from "@playwright/test";

test("Chromium activates a persistent OPFS ciphertext cache through a dedicated worker", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one real Chromium OPFS contract is sufficient");
  await page.goto("/#vault");
  await expect(page.locator(".app-shell")).toBeVisible();

  const result = await page.evaluate(async () => {
    const module = await import("/src/storage/client-ciphertext-cache.ts");
    const partition = `playwright-opfs-${crypto.randomUUID()}`;
    const address = {
      objectKey: "context/segments/playwright-opaque-page",
      kind: "index-page" as const,
      range: { start: 32, endExclusive: 40 },
    };
    const expected = Uint8Array.from([170, 187, 204, 221, 1, 2, 3, 4]);
    const first = await module.createClientCiphertextCache({ partition });
    await first.put(address, { bytes: expected, etag: "playwright-etag", totalSize: 256 });
    const firstCapability = first.capability;
    first.close();

    const reopened = await module.createClientCiphertextCache({ partition });
    const restored = await reopened.get(address);
    await reopened.remove(address);
    const secondCapability = reopened.capability;
    reopened.close();
    return {
      firstCapability,
      secondCapability,
      bytes: restored ? [...restored.bytes] : undefined,
      etag: restored?.etag,
      totalSize: restored?.totalSize,
    };
  });

  expect(result.firstCapability.backend).toBe("opfs-sync-worker");
  expect(result.secondCapability.backend).toBe(result.firstCapability.backend);
  expect(result.firstCapability).toMatchObject({
    active: true,
    durability: "origin-private-persistent",
    persistenceBoundary: "ciphertext-only",
    authority: "vault-provider-remains-authoritative",
  });
  expect(result.firstCapability.syncAccessHandle).toBe("active");
  expect(result.bytes).toEqual([170, 187, 204, 221, 1, 2, 3, 4]);
  expect(result).toMatchObject({ etag: "playwright-etag", totalSize: 256 });
});

test("the OPFS worker never reclaims a partition another context still holds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one real Chromium OPFS contract is sufficient");
  await page.goto("/#vault");
  await expect(page.locator(".app-shell")).toBeVisible();

  const result = await page.evaluate(async () => {
    const cacheModule = await import("/src/storage/client-ciphertext-cache.ts");
    const { sha256 } = await import("/src/core/hash.ts");
    const directoryName = async (partition: string) => (await sha256(partition)).slice("sha256:".length);
    const listPartitions = async (): Promise<string[]> => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle("airship-ciphertext-cache-v1", { create: true });
      const names: string[] = [];
      for await (const [name] of (base as unknown as { entries(): AsyncIterable<readonly [string, FileSystemHandle]> }).entries()) {
        names.push(name);
      }
      return names;
    };
    const address = { objectKey: "context/segments/playwright-sibling-page", kind: "index-page" as const };
    const bytes = Uint8Array.from([9, 8, 7, 6]);
    const heldPartition = `playwright-opfs-held-${crypto.randomUUID()}`;
    const heldDirectory = await directoryName(heldPartition);

    const held = await cacheModule.createClientCiphertextCache({ partition: heldPartition });
    await held.put(address, { bytes, etag: "held-etag" });
    // A second vault partition opens in the same tab while the first is still
    // live. Its worker sweeps siblings, and must skip this one.
    const sibling = await cacheModule.createClientCiphertextCache({ partition: `playwright-opfs-sibling-${crypto.randomUUID()}` });
    await sibling.put(address, { bytes, etag: "sibling-etag" });
    const survivedOpenSibling = (await listPartitions()).includes(heldDirectory);
    const stillReadable = (await held.get(address))?.etag;

    // Closing releases the partition lock with the worker context, so the same
    // directory becomes reclaimable. Bounded polling: release is not synchronous.
    held.close();
    let reclaimed = false;
    for (let attempt = 0; attempt < 10 && !reclaimed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sweeper = await cacheModule.createClientCiphertextCache({ partition: `playwright-opfs-sweeper-${crypto.randomUUID()}` });
      reclaimed = !(await listPartitions()).includes(heldDirectory);
      sweeper.close();
    }
    sibling.close();
    return { survivedOpenSibling, stillReadable, reclaimed };
  });

  expect(result.survivedOpenSibling).toBe(true);
  expect(result.stillReadable).toBe("held-etag");
  // Reclamation is still real; it is only withheld while the lock proves the
  // partition is in use.
  expect(result.reclaimed).toBe(true);
});

test("the real OPFS cache enforces its residency ceiling and survives a reopen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one real Chromium OPFS contract is sufficient");
  await page.goto("/#vault");
  await expect(page.locator(".app-shell")).toBeVisible();

  const result = await page.evaluate(async () => {
    const module = await import("/src/storage/client-ciphertext-cache.ts");
    const partition = `playwright-opfs-lru-${crypto.randomUUID()}`;
    let clock = 1_700_000_000_000;
    // A monotonic clock makes least-recently-used deterministic; wall-clock
    // puts inside one millisecond would tie.
    const budget = { maxEntries: 3, maxBytes: 1024 * 1024, now: () => (clock += 1_000), estimateStorage: async () => ({}) };
    const address = (index: number) => ({ objectKey: `context/segments/lru-${index}`, kind: "index-page" as const });

    const cache = await module.createClientCiphertextCache({ partition, budget });
    const backend = cache.capability.backend;
    for (let index = 0; index < 3; index += 1) {
      await cache.put(address(index), { bytes: new Uint8Array(512).fill(index + 1), etag: `etag-${index}` });
    }
    // Re-reading 0 makes 1 the least recently used before the fourth arrives.
    const touched = Boolean(await cache.get(address(0)));
    await cache.put(address(3), { bytes: new Uint8Array(512).fill(4), etag: "etag-3" });
    const live = await Promise.all([0, 1, 2, 3].map(async (index) => Boolean(await cache.get(address(index)))));
    cache.close();

    // Reopening must reconcile against the real directory listing, not invent
    // an inventory, so the survivors are still readable and the evicted one is
    // still gone.
    const reopened = await module.createClientCiphertextCache({ partition, budget });
    const afterReopen = await Promise.all([0, 1, 2, 3].map(async (index) => Boolean(await reopened.get(address(index)))));
    const etag = (await reopened.get(address(3)))?.etag;
    reopened.close();
    return { backend, touched, live, afterReopen, etag };
  });

  expect(result.backend).toBe("opfs-sync-worker");
  expect(result.touched).toBe(true);
  expect(result.live).toEqual([true, false, true, true]);
  expect(result.afterReopen).toEqual([true, false, true, true]);
  expect(result.etag).toBe("etag-3");
});
