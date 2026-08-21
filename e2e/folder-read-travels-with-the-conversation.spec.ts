import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectNothingHiddenFromView, expectRenderedText, renderedText } from "./support/rendered-text";
import { waitForShellSettled } from "./support/settled";

/**
 * The fourth door, and the sentence that has to admit it.
 *
 * The folder tier named three fences — not into the Vault, not into Airship's
 * Git, not off this device — and all three are real. The conversation journal is
 * a fourth: it keeps tool results, so a token sitting in a folder file, never
 * typed, read once by the agent, comes back out in the clear inside an exported
 * readable bundle.
 *
 * The tool payload is deliberately not fenced. It is the provenance that makes a
 * transcript checkable, and hiding it would turn every transcript into a claim
 * nobody can verify. What was wrong was the promise, so this spec holds the
 * wording and the behaviour against each other: the panel must say precisely
 * what is not copied — the folder — and must say that what the agent reads is in
 * the conversation, which a bundle carries.
 *
 * `showDirectoryPicker` cannot be driven from Playwright, so the picker is the
 * one substitution; everything it returns is a real OPFS directory handle read
 * through the real workspace port.
 */

const FOLDER = "airship-bundle-folder";
const TOKEN = "AIRSHIP-FOLDER-TOKEN-9f3c2a";
const SEED = `# api notes\napi key: ${TOKEN}\n`;

async function installFolderPicker(page: Page): Promise<void> {
  await page.addInitScript(([folder, seed]) => {
    const handlePrototype = (self as unknown as { FileSystemHandle?: { prototype: Record<string, unknown> } }).FileSystemHandle?.prototype;
    if (handlePrototype && typeof handlePrototype.queryPermission !== "function") {
      handlePrototype.queryPermission = async () => "granted";
      handlePrototype.requestPermission = async () => "granted";
    }
    (self as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(folder, { create: true });
      const file = await directory.getFileHandle("SECRETS.md", { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode(seed));
      await writable.close();
      return directory;
    };
  }, [FOLDER, SEED] as const);
}

test("says the folder is not copied, and admits that what the agent reads is in the conversation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one File System Access contract is sufficient");
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), "airship-folder-bundle-"));
  await installFolderPicker(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("airship-folder-bundle-seeded")) return;
    sessionStorage.setItem("airship-folder-bundle-seeded", "1");
    localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  });

  await page.goto("/#workspace");
  await waitForShellSettled(page);
  const panel = page.getByRole("region", { name: "Folder on this device" });

  /*
   * The promise, before anything is opened, in rendered text.
   *
   * Every line below was a `toContainText` — which reads `textContent` — while
   * the whole tier sat inside a `<details>` that is closed on load. So this
   * spec asserted the corrected wording against characters nobody saw, which is
   * the same defect one layer up from the one it was written for. Asking for a
   * folder is what prints the terms now, and the picker opens on the press
   * after them.
   */
  await panel.getByRole("button", { name: "Open a folder…" }).click();
  await expectRenderedText(panel, "stores no copy of the folder");
  await expectRenderedText(panel, "not in the Vault");
  await expectRenderedText(panel, "not off this device");
  // And about the door those three do not cover.
  await expectRenderedText(panel, "becomes part of that conversation");
  await expectRenderedText(panel, "readable bundle carries in the clear");
  // The claim that could not be kept is gone from every surface that made it.
  const drawn = await renderedText(panel);
  expect(drawn).not.toContain("copies the folder nowhere");
  expect(drawn).not.toContain("Airship keeps no copy");
  await expectNothingHiddenFromView(panel);

  await panel.getByRole("button", { name: "Choose a folder…" }).click();
  await expectRenderedText(panel, `“${FOLDER}” is open at /workspace/local/${FOLDER}`, 20_000);
  await expectRenderedText(panel, "A file read from here becomes part of that conversation.");
  await expectNothingHiddenFromView(panel);

  // The agent reads the file once. Nobody types the token.
  await page.goto("/#chat");
  await waitForShellSettled(page, { composer: true });
  await page.getByRole("combobox", { name: "Message Airship" }).fill(`/read local/${FOLDER}/SECRETS.md`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(new RegExp(TOKEN, "u")).last()).toBeVisible({ timeout: 40_000 });

  // A readable bundle carries the conversation, and the conversation carries
  // the read. This is what the wording above now says out loud.
  await page.goto("/#sessions");
  const toggle = page.getByRole("button", { name: "Move work" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("heading", { name: "Move work in or out" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Select all" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Write bundle file" }).click();
  const bundlePath = join(directory, "bundle.json");
  await (await download).saveAs(bundlePath);
  expect(await readFile(bundlePath, "utf8")).toContain(TOKEN);
});
