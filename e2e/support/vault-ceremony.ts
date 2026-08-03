import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The Local Device Vault ceremony, in the order a person actually meets it.
 *
 * The ceremony gained a step: the acknowledgement checkbox — "I saved this
 * recovery key outside Airship" — is now disabled until the key has genuinely
 * been saved, by copying it, downloading it, or pressing "I wrote it down by
 * hand". Before that, a person could tick a box claiming they had kept a key
 * they had never looked at, and the whole point of a one-time recovery key is
 * that the claim is true.
 *
 * Three specs drove the old order and each timed out on a disabled checkbox,
 * which reads in CI as a Vault failure rather than as a ceremony that grew a
 * step. The order lives here once so the next step it grows is one edit, and so
 * a spec that fails here is telling you about the Vault rather than about its
 * own staleness.
 */
export async function completeLocalDeviceCeremony(
  page: Page,
  options: Readonly<{ setup?: Locator; acknowledgement?: "hand" | "copy" | "download" }> = {},
): Promise<void> {
  const setup = options.setup ?? page.locator(".local-device-vault");
  await expect(setup).toBeVisible({ timeout: 20_000 });
  await setup.getByRole("button", { name: "Create new" }).click();

  // Saving the key is what unlocks the claim about having saved it. "By hand"
  // is the one that needs no clipboard permission and no download directory,
  // which is why it is the default here.
  const save = {
    hand: "I wrote it down by hand",
    copy: "Copy key",
    download: "Download recovery key",
  }[options.acknowledgement ?? "hand"];
  await setup.getByRole("button", { name: save }).click();

  // Clicked by its text rather than as a checkbox: acknowledgement removes the
  // control and the secret in the same event, so waiting for a checked state
  // waits for something the product deliberately never renders.
  await setup.getByText("I saved this recovery key outside Airship").click();
  await setup.getByRole("button", { name: "Create encrypted Vault" }).click();
  await expect(setup.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** The runtime line, once the adopted Vault is the authority being written through. */
export async function expectLocalDeviceVaultActive(page: Page, timeout = 40_000): Promise<void> {
  await expect(
    page.locator("header .runtime-line__text").filter({ hasText: /Encrypted Local Device vault active/u }),
  ).toBeVisible({ timeout });
}
