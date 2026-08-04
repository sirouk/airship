import { expect, test, type Page } from "@playwright/test";
import { mlKem768EncapsulationKey } from "./support/chutes-e2ee-key";

/**
 * The chat header on a phone, with a provider actually connected.
 *
 * Every other phone assertion in this suite runs against the disconnected
 * build, where the header carries `DemoModelChip` — a single static button. The
 * owner's review was not of that build. He was connected to Chutes, and what he
 * described was "the model dropdown renders as a card floating inside a
 * circular outline, the two overlapping" with `CHUTES · SESSI…` clipped
 * mid-word above it.
 *
 * That state has a different component tree, and until this spec existed
 * nothing reached it: a lane that verified the phone header measured the
 * disconnected one, reported the numbers, and the artifact he was complaining
 * about was never once rendered. Connecting is the whole point of this file.
 *
 * `ModelControl` has two branches and they are styled differently. Without a
 * picker it renders `<label><small>…</small><MenuSelect/></label>`; with one —
 * which is the Chutes path, and only the Chutes path — it renders
 * `<div class="session-runtime-picker"><small>…</small>{trigger}</div>`. The
 * phone rule that hides that eyebrow was written for the first shape only, so
 * the second shape rendered it and ellipsised it. Mocking a different provider
 * would not have found this; it is specifically the branch a Chutes catalogue
 * unlocks.
 *
 * Fully mocked. No request leaves the machine.
 */

const CHUTE = "chute-header-0001";
const MODEL = "zai-org/GLM-5.2-TEE";
const E2E_PUBLIC_KEY = mlKem768EncapsulationKey();
const PHONE = { width: 430, height: 932 };

function inferenceModel(id: string, chuteId: string) {
  return {
    id,
    chute_id: chuteId,
    object: "model",
    owned_by: "vllm",
    created: 1_800_000_000,
    context_length: 131_072,
    max_model_len: 131_072,
    max_output_length: 32_768,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_features: ["tools"],
    supported_sampling_parameters: ["temperature", "top_p"],
    confidential_compute: true,
    pricing: { prompt: 0.5, completion: 1 },
  };
}

async function mockChutes(page: Page): Promise<readonly string[]> {
  const unmocked: string[] = [];
  // Catch-all first: Playwright matches the most recently added handler, so
  // anything this spec did not anticipate is refused here rather than reaching
  // the real service.
  await page.route(
    (url) => url.hostname.endsWith(".chutes.ai"),
    (route) => {
      unmocked.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "not mocked" }) });
    },
  );
  await page.route(
    (url) => url.hostname === "llm.chutes.ai" && url.pathname === "/v1/models",
    (route) => route.fulfill({
      json: {
        object: "list",
        // More than one, or the picker is disabled and the branch under test
        // never opens.
        data: [inferenceModel(MODEL, CHUTE), inferenceModel("moonshotai/Kimi-K2-Instruct-TEE", "chute-header-0002")],
      },
    }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/users/me",
    (route) => route.fulfill({ json: { username: "owner", user_id: "usr_owner" } }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/utilization",
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/",
    (route) => route.fulfill({ json: { items: [], total: 0, page: 0, limit: 50 } }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && /^\/e2e\/instances\//u.test(url.pathname),
    (route) => route.fulfill({
      json: {
        nonce_expires_in: 55,
        instances: [{ instance_id: "instance-header", e2e_pubkey: E2E_PUBLIC_KEY, nonces: ["nonce-header"] }],
      },
    }),
  );
  return unmocked;
}

async function connectChutes(page: Page): Promise<void> {
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  // The route header's ⓘ auto-opens on first visit and overlays the lead lane.
  await page.keyboard.press("Escape");

  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await chutes.getAttribute("data-open")) !== "true") {
    await chutes.locator("button.connect-lane__header").click();
  }
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await chutes.locator('input[name="chutes-api-key"]').fill("cpk_header-journey.key");
  await chutes.getByRole("button", { name: "Discover models with key" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 60_000 });
}

test.describe("connected chat header on a phone", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test("renders the real connected control, not the demo chip", async ({ page }) => {
    const unmocked = await mockChutes(page);
    await connectChutes(page);

    // The premise of this whole file. If this fails, every other assertion here
    // is measuring the disconnected header again.
    await expect(page.locator(".session-bar .session-runtime")).toBeVisible();
    expect(unmocked).toEqual([]);
  });

  test("does not print a clipped CHUTES · SESSI… eyebrow above the picker", async ({ page }) => {
    await mockChutes(page);
    await connectChutes(page);

    const eyebrow = page.locator(".session-bar .session-runtime-picker > small");
    await expect(eyebrow).toHaveCount(1);

    // Present for assistive technology, absent from the layout — the same
    // treatment the `<label>` branch has had all along. Asserting "not visible"
    // alone would also pass for `display: none`, which would take it out of the
    // accessibility tree and lose the provider context entirely.
    const box = await eyebrow.boundingBox();
    expect(box === null || box.width <= 1 || box.height <= 1).toBe(true);
    await expect(eyebrow).toHaveText(/session model/iu);
  });

  test("keeps the header inside the viewport with nothing overlapping", async ({ page }) => {
    await mockChutes(page);
    await connectChutes(page);

    const bar = page.locator(".session-bar");
    const overflow = await bar.evaluate((node) => ({
      scroll: node.scrollWidth - node.clientWidth,
      right: node.getBoundingClientRect().right,
    }));
    expect(overflow.scroll).toBe(0);
    expect(overflow.right).toBeLessThanOrEqual(PHONE.width);

    // The document itself must not scroll sideways either.
    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(documentOverflow).toBe(0);

    // The circular runtime glyph and the picker trigger are the two the owner
    // saw overlapping. They are siblings in one grid row and must not intersect.
    const rects = await page.locator(".session-bar .session-runtime").evaluate((node) => {
      const icon = node.querySelector(".session-runtime-icon")?.getBoundingClientRect();
      const trigger = node.querySelector(".model-picker-trigger")?.getBoundingClientRect();
      return icon && trigger
        ? { iconRight: icon.right, triggerLeft: trigger.left }
        : undefined;
    });
    if (rects) expect(rects.triggerLeft).toBeGreaterThanOrEqual(rects.iconRight - 0.5);
  });
});
