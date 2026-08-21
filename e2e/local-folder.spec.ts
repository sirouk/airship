import { expect, test, type Page } from "@playwright/test";
import { expectNothingHiddenFromView, expectRenderedText, renderedText } from "./support/rendered-text";
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
  /*
   * Rendered text, not `textContent`.
   *
   * Every assertion in this file used to be a `toContainText`, which reads
   * `textContent` — and the whole tier lived inside a `<details>` that was
   * closed on load and never opened. So these four promises were asserted, and
   * passed, against 995 characters the panel did not draw. `renderedText` is
   * `innerText`, which is the browser's own answer to what is on screen.
   */
  await expectRenderedText(panel, "No folder is open.");
  await expect(panel.locator("details")).toHaveCount(0);

  const ask = panel.getByRole("button", { name: "Open a folder…" });
  const box = await ask.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.height), "coarse-pointer floor on the tier's primary control")
    .toBeGreaterThanOrEqual(44);

  /*
   * Asking for a folder prints the terms; it does not open the picker. So the
   * assertions below are about what is on screen *before* a directory handle
   * exists, which is the only moment they can change a decision.
   */
  await ask.click();
  // Precise about what is not copied — the folder — and about the door the
  // three named fences do not cover: what the agent reads is in the
  // conversation, and a conversation travels in a bundle.
  await expectRenderedText(panel, "stores no copy of the folder");
  await expectRenderedText(panel, "becomes part of that conversation");
  // The listing bound this tier actually enforces.
  await expectRenderedText(panel, "refused rather than shown in part");
  // The six answers every storage tier gives, in the tier that gives them.
  await expectRenderedText(panel, "Revoking permission · moving the folder");
  // And the rule that keeps every one of them from ever being satisfiable by
  // text nobody can see again.
  await expectNothingHiddenFromView(panel);
  await expect(panel.locator("details")).toHaveCount(0);

  const open = panel.getByRole("button", { name: "Choose a folder…" });
  await open.click();
  await expectRenderedText(panel, `“${FOLDER}” is open at /workspace/local/${FOLDER} for this profile only.`, 20_000);
  await expectRenderedText(panel, "Every agent write still goes through approvals");
  await expectRenderedText(panel, "reviewed in every approval mode");
  // The two fences the old panel stated only in `textContent`.
  await expectRenderedText(panel, "The Terminal does not carry it at all.");
  await expectRenderedText(panel, "A file read from here becomes part of that conversation.");
  await expectNothingHiddenFromView(panel);
  /*
   * Attaching a folder is an event, and a screen reader has to hear it.
   *
   * The panel used to assign a `live` ref on attach and on forget and render it
   * nowhere, and its only `role="status"` was sealed inside the closed
   * disclosure. The status region is the visible sentence now, so what is
   * announced and what is on screen are the same words.
   */
  const announced = panel.locator("[role=status]");
  await expect(announced).toHaveCount(1);
  await expect(announced).toContainText(`is open at /workspace/local/${FOLDER}`);
  expect(await renderedText(announced)).toContain("The Terminal does not carry it at all.");

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
  await expectRenderedText(
    page.getByRole("region", { name: "Folder on this device" }),
    `“${FOLDER}” is open at /workspace/local/${FOLDER} for this profile only.`,
    20_000,
  );
  await revealFolderFile(page);
  const reopened = page.getByRole("treeitem", { name: /^NOTES\.md/u });
  await expect(reopened).toBeVisible({ timeout: 20_000 });
  await reopened.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit NOTES.md" })).toHaveValue("edited-through-approvals");

  // Forgetting is revocation, not deletion: Airship stops reading the folder
  // and the bytes stay exactly where they were.
  await page.getByRole("region", { name: "Folder on this device" })
    .getByRole("button", { name: "Forget folder" }).click();
  await expectRenderedText(page.getByRole("region", { name: "Folder on this device" }), "No folder is open.", 20_000);
  // Forgetting is the other event a screen reader has to hear.
  await expectRenderedText(
    page.getByRole("region", { name: "Folder on this device" }).locator("[role=status]"),
    "Nothing on this device is readable by Airship until you open one.",
  );
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
  await expectRenderedText(panel, "only Chromium browsers");
  await expectRenderedText(panel, "Everything else in Airship works in this browser");
  await expect(panel.getByRole("button")).toHaveCount(0);
  // The rest of the route is untouched: the workspace it always had is there.
  await expect(page.getByRole("treeitem", { name: /^README\.md/u })).toBeVisible({ timeout: 20_000 });
});

/**
 * The terms are rendered text on a phone too, and the workbench survives them.
 *
 * Both halves are measured because the first nearly cost the second. With every
 * sentence rendered at full height at 390×664 the workbench measured exactly
 * 0px — `.main` is `overflow: hidden` for this route, so a panel taller than the
 * frame does not scroll it, it subtracts from the surface below, and the
 * Explorer simply stopped existing. The band in `editor-view.css` is what bounds
 * the terms; this is what proves the bound is real and that bounding it did not
 * put any of the words back inside a fold.
 */
test("a phone shows the attached folder's terms and keeps a usable workbench", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "the geometry this measures is the phone's");
  test.setTimeout(120_000);
  await installFolderPicker(page);
  // The same 390×844 phone `responsive-breakpoints.spec.ts` measures the
  // folder-free workbench on, so the two readings are comparable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#workspace");
  await waitForShellSettled(page);

  const panel = page.getByRole("region", { name: "Folder on this device" });
  await expectRenderedText(panel, "No folder is open.");
  await panel.getByRole("button", { name: "Open a folder…" }).click();
  await expectRenderedText(panel, "stores no copy of the folder");
  await panel.getByRole("button", { name: "Choose a folder…" }).click();
  await expectRenderedText(panel, `is open at /workspace/local/${FOLDER}`, 20_000);

  // Every promise the attachment makes, in rendered text, on a 390px screen.
  await expectRenderedText(panel, "reviewed in every approval mode");
  await expectRenderedText(panel, "The Terminal does not carry it at all.");
  await expectRenderedText(panel, "Nothing on your device is deleted or moved");
  await expectRenderedText(panel, "Revoking permission · moving the folder");
  await expectNothingHiddenFromView(panel);
  await expect(panel.locator("details")).toHaveCount(0);

  // And the surface this route exists for is still a surface.
  // Measured 255px with the folder attached, against 374px with none. The floor
  // is that reading less its font-metric slack; what it refuses is the 0px this
  // panel produced before the band bounded it.
  const workbench = await page.locator(".workbench-shell").evaluate((shell) => shell.getBoundingClientRect().height);
  expect(Math.round(workbench), "workbench height with a folder attached").toBeGreaterThanOrEqual(240);
  await expect(page.getByRole("treeitem", { name: /^local\b/u })).toBeVisible({ timeout: 20_000 });
});
