import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

async function openClaimStack(page: Page, projectName: string): Promise<Locator> {
  await page.goto("/#chat");
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("combobox", { name: "Message Airship" }).fill("Create a local proof-layout fixture.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".transcript .message.assistant").getByText("Airship is running this turn entirely on your device", { exact: false })).toBeVisible({ timeout: 15_000 });
  if (projectName !== "desktop-chromium") await page.goto("/#proof");
  const inspector = page.locator(projectName === "desktop-chromium"
    ? ".inspector .proof-inspector"
    : ".work-view .proof-inspector");
  await expect(inspector.getByRole("heading", { name: "Verification" })).toBeVisible();
  await expect(inspector.locator(".evidence-join")).toBeVisible();
  await expect(inspector.locator(".claim-row").first()).toBeVisible();
  await expect(inspector.locator(".claim-absence")).toBeVisible();
  return inspector;
}

test("proof names every unavailable claim before the first completed turn", async ({ page }, testInfo) => {
  await page.goto("/#proof");
  const inspector = page.getByRole("main").locator(".proof-inspector");
  await expect(inspector.getByRole("heading", { name: "Verification" })).toBeVisible();
  const unavailable = inspector.locator(".claim-absence");
  await expect(unavailable).toHaveAttribute("open", "");
  await expect(unavailable.locator(".claim-absence__list > div")).toHaveCount(8);
  for (const label of ["Encrypted transport", "Fresh evidence", "Protected CPU runtime", "Protected accelerator", "Endpoint identity", "Model artifact", "Conversation integrity", "Payment standing"] as const) {
    await expect(unavailable.getByText(label, { exact: true })).toBeVisible();
  }
  await inspector.screenshot({ path: testInfo.outputPath(`empty-claim-stack-${testInfo.project.name}.png`), animations: "disabled" });
  await unavailable.locator(":scope > summary").click();
  await expect(unavailable).not.toHaveAttribute("open", "");
});

test("claim stack keeps labels, state, technical names, and Details contained", async ({ page }, testInfo) => {
  const inspector = await openClaimStack(page, testInfo.project.name);
  const geometry = await inspector.locator(".claim-row > summary").evaluateAll((summaries) => summaries.map((summary) => {
    const box = summary.getBoundingClientRect();
    const title = summary.querySelector<HTMLElement>(".claim-title")!.getBoundingClientRect();
    const disclosure = summary.querySelector<HTMLElement>(".claim-disclosure")!.getBoundingClientRect();
    const meta = summary.querySelector<HTMLElement>(".claim-meta")!.getBoundingClientRect();
    const technical = summary.querySelector<HTMLElement>(".claim-source")!;
    const seal = summary.querySelector<HTMLElement>(".claim-seal")!;
    const state = summary.querySelector<HTMLElement>(".seal__label")!;
    const contained = [title, disclosure, meta].every((child) =>
      child.left >= box.left - 1 && child.right <= box.right + 1 &&
      child.top >= box.top - 1 && child.bottom <= box.bottom + 1);
    const titleOverlapsDetails = !(
      title.right <= disclosure.left || disclosure.right <= title.left ||
      title.bottom <= disclosure.top || disclosure.bottom <= title.top
    );
    return {
      contained,
      titleOverlapsDetails,
      metaBelowHeading: meta.top >= Math.min(title.bottom, disclosure.bottom) - 1,
      summaryOverflow: summary.scrollWidth - summary.clientWidth,
      technicalOverflow: technical.scrollWidth - technical.clientWidth,
      stateOverflow: state.scrollWidth - state.clientWidth,
      stateVisible: seal.getBoundingClientRect().width > 0,
      stateName: state.textContent?.trim(),
      technicalName: technical.textContent?.trim(),
      title: summary.querySelector<HTMLElement>(".claim-title")?.textContent?.trim(),
      details: summary.querySelector<HTMLElement>(".claim-disclosure")?.textContent?.trim(),
    };
  }));

  expect(geometry.length).toBeGreaterThan(0);
  for (const row of geometry) {
    expect(row.contained, `${row.title}: summary contents must remain contained`).toBe(true);
    expect(row.titleOverlapsDetails, `${row.title}: label must not overlap Details`).toBe(false);
    expect(row.metaBelowHeading, `${row.title}: state and technical name need their own tier`).toBe(true);
    expect(row.summaryOverflow, `${row.title}: summary must not overflow horizontally`).toBeLessThanOrEqual(1);
    expect(row.technicalOverflow, `${row.title}: technical claim must wrap inside its tier`).toBeLessThanOrEqual(1);
    expect(row.stateOverflow, `${row.title}: state label must remain legible`).toBeLessThanOrEqual(1);
    expect(row.stateVisible, `${row.title}: claim state must remain visible`).toBe(true);
    expect(row.stateName).not.toBe("");
    expect(row.technicalName).not.toBe("");
  }

  const firstClaim = inspector.locator(".claim-row").first();
  const firstSummary = firstClaim.locator(":scope > summary");
  await firstSummary.focus();
  await page.keyboard.press("Enter");
  await expect(firstClaim).toHaveAttribute("open", "");
  const detailGeometry = await firstClaim.locator(".claim-detail").evaluate((detail) => ({
    overflow: detail.scrollWidth - detail.clientWidth,
    fieldsContained: [...detail.querySelectorAll("dl")].every((field) => {
      const parent = detail.getBoundingClientRect();
      const child = field.getBoundingClientRect();
      return child.left >= parent.left - 1 && child.right <= parent.right + 1;
    }),
  }));
  expect(detailGeometry.overflow, "expanded claim details must stay inside the inspector").toBeLessThanOrEqual(1);
  expect(detailGeometry.fieldsContained, "expanded claim fields must stay contained").toBe(true);
  await page.keyboard.press("Enter");
  await expect(firstClaim).not.toHaveAttribute("open", "");
  await firstSummary.evaluate((element) => element.blur());

  const absent = inspector.locator(".claim-absence");
  await expect(absent).not.toHaveAttribute("open", "");
  await absent.locator(":scope > summary").click();
  await expect(absent).toHaveAttribute("open", "");
  await expect(absent.locator(".claim-absence__list > div").first()).toBeVisible();
  await absent.locator(":scope > summary").click();
  await expect(absent).not.toHaveAttribute("open", "");

  const screenshotPath = testInfo.outputPath(`claim-stack-${testInfo.project.name}.png`);
  if (testInfo.project.name === "mobile-chromium") {
    // Keep the device width while giving the component enough vertical room
    // to capture all eight rows without a fixed mobile navigation overlay.
    await page.setViewportSize({ width: 390, height: 2_200 });
    await inspector.screenshot({ path: screenshotPath, animations: "disabled" });
  } else {
    await inspector.screenshot({ path: screenshotPath, animations: "disabled" });
  }
});
