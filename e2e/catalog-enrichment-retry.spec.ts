import { expect, test, type Page } from "@playwright/test";

/**
 * The recovery journey for a failed management read, end to end in a browser.
 *
 * The gate on "Load live availability metadata" used to name `disabled` — the
 * state this route never produces, because it always constructs the catalog
 * client with `includeManagement: true`. A management read that a person could
 * actually retry lands as `failed`, so the control was unreachable and the
 * consequence was silent: with no management catalog every model's `hot` is
 * undefined, availability collapses to `unknown`, and the picker's Hot facet
 * counts zero for a chute Chutes is reporting as hot.
 *
 * That is a browser fact — the button's presence, the press, and the facet
 * count are all render, so it is asserted here rather than in a source test.
 * The management endpoint refuses once and succeeds on the retry, which is
 * exactly the sequence the old gate made unrecoverable.
 */

const HOT_CHUTE = "chute-hot-0001";
const COLD_CHUTE = "chute-cold-0002";

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
    // Asserted confidential compute is what makes a model an encrypted-
    // inference candidate at all; without it the connect lane refuses the
    // catalog before this journey can start.
    confidential_compute: true,
    pricing: { prompt: 0.5, completion: 1 },
  };
}

async function openProvenance(page: Page) {
  const popover = page.locator(".catalog-provenance-popover");
  await expect(popover).toHaveCount(1);
  // Hover intent can have opened it already; the trigger is a toggle, so the
  // state is read before it is pressed.
  if ((await popover.getAttribute("data-open")) !== "true") {
    await popover.locator("button.popover__trigger").click();
  }
  await expect(popover).toHaveAttribute("data-open", "true");
  return popover;
}

async function hotFacetText(page: Page): Promise<string> {
  const picker = page.locator(".candidate-model .model-picker");
  if ((await picker.getAttribute("data-open")) !== "true") {
    await picker.locator("button.model-picker-trigger").click();
  }
  await expect(picker).toHaveAttribute("data-open", "true");
  const hot = picker.locator(".model-picker-facets button").filter({ hasText: /^Hot/u });
  await expect(hot).toHaveCount(1);
  const text = (await hot.innerText()).replace(/\s+/gu, "");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveAttribute("data-open", "false");
  return text;
}

test("a refused management read is recoverable, and the recovery restores the availability facts", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));

  let managementReads = 0;
  await page.route(
    (url) => url.hostname === "llm.chutes.ai" && url.pathname === "/v1/models",
    async (route) => {
      await route.fulfill({
        json: { object: "list", data: [inferenceModel("airship/warm", HOT_CHUTE), inferenceModel("airship/spare", COLD_CHUTE)] },
      });
    },
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/utilization",
    async (route) => { await route.fulfill({ json: [] }); },
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/",
    async (route) => {
      managementReads += 1;
      if (managementReads === 1) {
        // A transient provider fault, which is what `failed` means and what a
        // retry is for.
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "temporarily unavailable" }) });
        return;
      }
      await route.fulfill({
        json: {
          total: 2,
          items: [
            { chute_id: HOT_CHUTE, name: "warm", slug: "warm", public: true, tee: true, hot: true, invocation_count: 12 },
            { chute_id: COLD_CHUTE, name: "spare", slug: "spare", public: true, tee: true, hot: false, invocation_count: 3 },
          ],
        },
      });
    },
  );

  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  // The route header's ⓘ auto-opens on first visit and overlays the lead lane,
  // swallowing the first click aimed beneath it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".route-header__about")).toHaveAttribute("data-open", "false");

  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  await expect(chutes).toHaveCount(1);
  if ((await chutes.getAttribute("data-open")) !== "true") {
    await chutes.locator("button.connect-lane__header").click();
  }
  await expect(chutes).toHaveAttribute("data-open", "true");

  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await chutes.locator('input[name="chutes-api-key"]').fill("cpk_browser-journey.key");
  await chutes.getByRole("button", { name: "Discover models with key" }).click();

  // Discovery completed on the inference catalog alone; the management read was
  // refused, which is the state the retry exists for. The count is read rather
  // than pinned to 1 — the guarantee is that pressing the control issues one
  // more read, and the state it recovers from is asserted from the rendered
  // provenance, not from the counter.
  await expect(page.locator(".candidate-model")).toBeVisible({ timeout: 30_000 });
  const readsBeforeRetry = managementReads;
  expect(readsBeforeRetry).toBeGreaterThanOrEqual(1);

  const provenance = await openProvenance(page);
  await expect(provenance.getByText("Partial provider metadata")).toBeVisible();
  const retry = provenance.getByRole("button", { name: "Load live availability metadata" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();

  // Nothing was read about availability, so nothing claims it: the Hot facet is
  // the count that used to be permanently zero.
  expect(await hotFacetText(page)).toBe("Hot0");

  await (await openProvenance(page)).getByRole("button", { name: "Load live availability metadata" }).click();

  await expect(page.getByText("Live availability and TEE deployment claims loaded. These remain metadata, not attestation proof."))
    .toBeVisible({ timeout: 30_000 });
  expect(managementReads).toBe(readsBeforeRetry + 1);

  // The control retires itself once the state it recovers from is gone.
  const settled = await openProvenance(page);
  await expect(settled.getByText("Inference + management metadata loaded")).toBeVisible();
  await expect(settled.getByRole("button", { name: "Load live availability metadata" })).toHaveCount(0);

  // And the fact the failed read had deleted is back: one of the two chutes is
  // hot, and the picker can now say so.
  expect(await hotFacetText(page)).toBe("Hot1");
});
