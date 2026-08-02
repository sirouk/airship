import { expect, test } from "@playwright/test";

/*
 * "Delete conversation" on a Local Device vault.
 *
 * This spec exists because a real user could not make it work: pass 2 had
 * given the tier its one sanctioned verb (`trash` under `ObjectStore`), and
 * the facade the deleted path crosses at `src/vault/local-device.ts` was
 * written before that verb and never learned it — so every Local Device
 * delete answered "This Vault cannot delete objects, so the conversation was
 * not removed." A silent reconciliation renders the dead verb invisible to
 * unit tests and inert to live journeys; the user found it first.
 *
 * The whole journey is deliberately the real app: a real OPFS enrollment in
 * Chromium, a real conversation through the mounted session route, the
 * ConfirmDialog, and the list shrinking. If any of those steps goes hollow
 * the Vault is lying about what it holds, and silence was the finding.
 */

const PARTITION = "airship-workspace-v1";

async function enrollLocalDevice(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e/fixtures/provider-fabric-harness.html");
  await page.waitForLoadState("networkidle");
  await page.evaluate(async ({ partition }) => {
    const [{ prepareLocalDeviceWorkspaceKeyEnrollment }] = await Promise.all([
      import("/src/storage/local-device-keyring.ts"),
    ]);
    const enrollment = await prepareLocalDeviceWorkspaceKeyEnrollment({ partition });
    await enrollment.commit({ recoveryKeySavedAcknowledged: true });
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "local-device",
      approvalMode: "ask-first",
    }));
  }, { partition: PARTITION });
}

test("a Local Device conversation actually leaves when its delete is confirmed", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One Chromium origin covers the real OPFS enrollment journal path.",
  );
  /*
   * Its own journal, because "0 conversations" is a claim about the whole list.
   *
   * This spec carried no `airshipLabNamespace`, so it shared the default
   * journal with every other spec that does the same. Run alone it was right;
   * run in parallel, another worker's conversation was in the list and the
   * count it asserts could never reach zero. Diagnosed rather than retried:
   * probed directly, the delete empties the list within 500ms and the header
   * reads "0 conversations", so what was shared was the journal, not a defect.
   */
  const namespace = `deletion-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
  await enrollLocalDevice(page);

  await page.goto(`/?airshipLabNamespace=${namespace}#chat`);
  await expect(page.getByText("encrypted Local Device Vault is active")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("combobox", { name: "Message Airship" }).fill("delete this line");
  await page.getByRole("button", { name: "Send message" }).click();
  // Scoped to the transcript, not to the page: the conversation now takes its
  // title from the first message, so this text is legitimately on screen twice
  // — once as the session-bar title and once as the message. A bare text lookup
  // resolved to both and failed strict mode, which reads as a missing message
  // when what actually happened is that titling got better.
  await expect(page.locator(".message.user").filter({ hasText: "delete this line" })).toBeVisible();

  await page.goto(`/?airshipLabNamespace=${namespace}#sessions`);
  const row = page.getByRole("button", { name: /delete this line|General · encrypted/u }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Delete conversation" });
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect(page.getByText("Deleted", { exact: false })).toBeVisible({ timeout: 15_000 });
  // The ledger lists zero remaining conversations rather than lying about the
  // pointer it just cleared.
  await expect(page.getByText(/0 conversations/u)).toBeVisible({ timeout: 15_000 });
});
