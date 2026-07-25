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
