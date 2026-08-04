import { expect, test, type Page } from "@playwright/test";
import { mlKem768EncapsulationKey } from "./support/chutes-e2ee-key";

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
 *
 * AMENDED for a route that no longer interviews people. Entering a key used to
 * park on a chat-model chooser, which is where this journey stood while it
 * pressed the retry; a key now carries itself through to a conversation. The
 * one thing that still holds the connect stage open is a genuine choice — two
 * published embedding deployments — so that is the state this journey runs in,
 * and the availability facts it is about are read from the model picker where
 * they now live: the connected summary, after the connection exists.
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

async function hotFacetText(page: Page, scope: string): Promise<string> {
  const picker = page.locator(`${scope} .model-picker`);
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
  /*
   * The key check the product now performs before it draws a priced picker.
   *
   * Airship asks `api.chutes.ai/users/me` whether Chutes accepts the key before
   * it renders a model list with prices against it — a key nobody has checked
   * must not produce a picker that looks authoritative. This test predates that
   * and mocked only the catalog reads, so the check reached the real network,
   * failed, and no candidate model was ever drawn. Answering it here restores
   * what the test is actually about: the management read's refusal and recovery.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/users/me",
    async (route) => { await route.fulfill({ json: { username: "journey", user_id: "usr_journey" } }); },
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
  /*
   * Two published embedding deployments, which is the only state in which the
   * connect stage waits for a person at all. It waits because that *is* a
   * choice: with one, or none, the route adopts and carries on to chat.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/"
      && new URL(url.href).searchParams.get("template") === "embedding",
    async (route) => {
      const deployment = (chuteId: string, name: string, hot: boolean) => ({
        chute_id: chuteId,
        name,
        slug: name,
        standard_template: "embedding",
        cord_ref_id: "cord-ref-1",
        public: true,
        tee: true,
        hot,
      });
      await route.fulfill({
        json: {
          total: 2,
          items: [deployment("chute-embed-a", "Journey/Embedding-A-TEE", true), deployment("chute-embed-b", "Journey/Embedding-B-TEE", false)],
          cord_refs: {
            "cord-ref-1": [
              { path: "/embed", method: "POST", stream: false, function: "embed", public_api_path: "/v1/embeddings", public_api_method: "POST" },
            ],
          },
        },
      });
    },
  );

  /*
   * The E2EE endpoint discovery `verifyModelAccess` performs before the route
   * will call a connection made. This journey now finishes the connection, so
   * the facts it is about can be read from the picker they ended up in.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname.startsWith("/e2e/instances/"),
    async (route) => {
      await route.fulfill({
        json: {
          instances: [{
            instance_id: "instance-enrichment-journey",
            e2e_pubkey: mlKem768EncapsulationKey(),
            nonces: ["one_time_nonce_value_0001", "one_time_nonce_value_0002"],
          }],
          nonce_expires_in: 60,
          nonce_expires_at: Math.floor(Date.now() / 1_000) + 60,
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
  await expect(page.locator(".candidate-embedding")).toBeVisible({ timeout: 30_000 });
  const readsBeforeRetry = managementReads;
  expect(readsBeforeRetry).toBeGreaterThanOrEqual(1);

  const provenance = await openProvenance(page);
  await expect(provenance.getByText("Partial provider metadata")).toBeVisible();
  const retry = provenance.getByRole("button", { name: "Load live availability metadata" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();

  await (await openProvenance(page)).getByRole("button", { name: "Load live availability metadata" }).click();

  await expect(page.getByText("Live availability and TEE deployment claims loaded. These remain metadata, not attestation proof."))
    .toBeVisible({ timeout: 30_000 });
  expect(managementReads).toBe(readsBeforeRetry + 1);

  // The control retires itself once the state it recovers from is gone.
  const settled = await openProvenance(page);
  await expect(settled.getByText("Inference + management metadata loaded")).toBeVisible();
  await expect(settled.getByRole("button", { name: "Load live availability metadata" })).toHaveCount(0);

  // And the fact the failed read had deleted is back. The picker that can say
  // so is the connected summary's, so the connection is finished first — which
  // also proves the enriched list is the one the connection carries.
  await page.getByRole("button", { name: "Finish: verify & connect" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 60_000 });
  await page.goto("/#connection");
  await page.keyboard.press("Escape");
  const connected = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await connected.getAttribute("data-open")) !== "true") {
    await connected.locator("button.connect-lane__header").click();
  }
  await expect(page.locator(".active-connection-summary")).toBeVisible({ timeout: 30_000 });
  expect(await hotFacetText(page, ".active-connection-summary")).toBe("Hot1");
});
