import { expect, test, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/**
 * The folder tier, end to end, against real browser machinery.
 *
 * `showDirectoryPicker` cannot be driven from Playwright — there is no protocol
 * for choosing a directory in the browser's own dialog — so the picker is the
 * one thing this journey substitutes. Everything it returns is real: an OPFS
 * `FileSystemDirectoryHandle`, the same class and the same interface the picker
 * hands back, stored in the real IndexedDB, read through the real permission
 * query, walked and written through the real `FileSystemFileHandle`. The
 * permission methods are shimmed only if this Chromium does not define them, so
 * a build where they exist exercises them.
 */
const FOLDER = "airship-e2e-folder";
const SEED = "# notes on this device\n";

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
      let seeded = true;
      try {
        await directory.getFileHandle("NOTES.md");
      } catch {
        seeded = false;
      }
      if (!seeded) {
        const file = await directory.getFileHandle("NOTES.md", { create: true });
        const writable = await file.createWritable();
        await writable.write(new TextEncoder().encode(seed));
        await writable.close();
      }
      return directory;
    };
  }, [FOLDER, SEED] as const);
}

/** The Explorer draws collapsed directories; the folder is two levels down. */
async function revealFolderFile(page: Page): Promise<void> {
  await page.getByRole("treeitem", { name: /^local\b/u }).click();
  await page.getByRole("treeitem", { name: new RegExp(`^${FOLDER}\\b`, "u") }).click();
}

async function readFolderFile(page: Page, name: string): Promise<string> {
  return page.evaluate(async ([folder, file]) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(folder);
    return (await (await directory.getFileHandle(file)).getFile()).text();
  }, [FOLDER, name] as const);
}

test("opens a folder on this device, reads it, has the agent edit it with approval, and reopens it after a reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one File System Access contract is sufficient");
  test.setTimeout(120_000);
  await installFolderPicker(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("airship-local-folder-seeded")) return;
    sessionStorage.setItem("airship-local-folder-seeded", "1");
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
  await expect(panel).toContainText("No folder is open.");
  await expect(panel).toContainText("it copies the folder nowhere");

  const open = panel.getByRole("button", { name: "Open a folder…" });
  const box = await open.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.height), "coarse-pointer floor on the tier's primary control")
    .toBeGreaterThanOrEqual(44);

  await open.click();
  await expect(panel).toContainText(`“${FOLDER}” is open at /workspace/local/${FOLDER}.`);
  await expect(panel).toContainText("Every agent write still goes through approvals");

  // The folder's own file, in the Explorer, read through the workspace port.
  await revealFolderFile(page);
  const notes = page.getByRole("treeitem", { name: /^NOTES\.md/u });
  await expect(notes).toBeVisible({ timeout: 20_000 });
  await notes.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit NOTES.md" })).toHaveValue(SEED);

  // The agent's own write path: the registered `write_file` tool, adjudicated
  // by the same approval broker a model's tool call goes through.
  await page.goto("/#chat");
  await waitForShellSettled(page, { composer: true });
  await page.getByRole("combobox", { name: "Message Airship" })
    .fill(`/write local/${FOLDER}/NOTES.md edited-through-approvals`);
  await page.getByRole("button", { name: "Send message" }).click();
  const decision = page.getByRole("dialog", { name: /Allow write_file once/u });
  await expect(decision).toBeVisible();
  await decision.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/edited-through-approvals/u).last()).toBeVisible({ timeout: 30_000 });

  // On disk, in the folder the person opened — and nowhere else.
  await expect.poll(async () => readFolderFile(page, "NOTES.md"), { timeout: 20_000 })
    .toBe("edited-through-approvals");

  await page.reload();
  await waitForShellSettled(page, { composer: true });
  await page.goto("/#workspace");
  await waitForShellSettled(page);
  await expect(page.getByRole("region", { name: "Folder on this device" }))
    .toContainText(`“${FOLDER}” is open at /workspace/local/${FOLDER}.`, { timeout: 20_000 });
  await revealFolderFile(page);
  const reopened = page.getByRole("treeitem", { name: /^NOTES\.md/u });
  await expect(reopened).toBeVisible({ timeout: 20_000 });
  await reopened.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit NOTES.md" })).toHaveValue("edited-through-approvals");

  // Forgetting is revocation, not deletion: Airship stops reading the folder
  // and the bytes stay exactly where they were.
  await page.getByRole("region", { name: "Folder on this device" })
    .getByRole("button", { name: "Forget folder" }).click();
  await expect(page.getByRole("region", { name: "Folder on this device" })).toContainText("No folder is open.");
  await expect(page.getByRole("treeitem", { name: /^NOTES\.md/u })).toHaveCount(0);
  expect(await readFolderFile(page, "NOTES.md")).toBe("edited-through-approvals");
});

test("tells a browser without the File System Access API the truth and keeps every other capability", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "the refusal is browser-independent; the picker is what is removed");
  await page.addInitScript(() => {
    delete (self as unknown as Record<string, unknown>).showDirectoryPicker;
  });
  await page.goto("/#workspace");
  await waitForShellSettled(page);

  const panel = page.getByRole("region", { name: "Folder on this device" });
  await expect(panel).toContainText("only Chromium browsers");
  await expect(panel).toContainText("Everything else in Airship works in this browser");
  await expect(panel.getByRole("button")).toHaveCount(0);
  // The rest of the route is untouched: the workspace it always had is there.
  await expect(page.getByRole("treeitem", { name: /^README\.md/u })).toBeVisible({ timeout: 20_000 });
});
