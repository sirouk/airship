import { expect, test, type Page } from "@playwright/test";

/**
 * The `chutes` embedding mode, from connecting to choosing it.
 *
 * `setConfidentialAuthority` had no caller anywhere in the tree, so
 * `hasConfidentialAuthority()` was permanently false: `readStoredEmbeddingMode`
 * could never restore the mode, `SwitchableEmbeddingProvider`'s confidential
 * branch was unreachable, and the Context screen offered two engines for a
 * three-member union. Every part of that is render and connection state, so it
 * is asserted in a browser rather than from source.
 *
 * The Chutes surface is fully mocked. No request in this spec leaves the
 * machine, and in particular the embedding chute itself is never contacted:
 * what is under test is that the *choice* becomes reachable and discloses
 * itself, not that a remote embedder returns vectors.
 */

const CHUTE = "chute-embed-0001";

/** 1,184 bytes, base64 — the ML-KEM-1024 encapsulation-key length the client validates. */
const E2E_PUBLIC_KEY = Buffer.from(Uint8Array.from({ length: 1184 }, (_, index) => index % 251)).toString("base64");

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

/**
 * Installs the Chutes mocks and returns the list of requests they did not
 * anticipate — which the caller asserts is empty. A silent 503 fallback would
 * let a future dependency turn this journey into a test of an error path.
 */
async function mockChutes(page: Page): Promise<readonly string[]> {
  const unmocked: string[] = [];
  /*
   * Registered first, and deliberately: Playwright matches the *most recently*
   * added handler, so this catch-all is the fallback the specific mocks below
   * override. Anything on a Chutes host that this spec has not thought about is
   * refused here rather than reaching the real service from a test whose whole
   * point is that nothing leaves the machine.
   */
  await page.route(
    (url) => url.hostname.endsWith(".chutes.ai"),
    (route) => {
      unmocked.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "not mocked" }) });
    },
  );
  await page.route(
    (url) => url.hostname === "llm.chutes.ai" && url.pathname === "/v1/models",
    (route) => route.fulfill({ json: { object: "list", data: [inferenceModel("airship/embed-journey", CHUTE)] } }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/users/me",
    (route) => route.fulfill({ json: { username: "journey", user_id: "usr_journey" } }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/utilization",
    (route) => route.fulfill({ json: [] }),
  );
  /*
   * The E2EE endpoint discovery the connect flow performs before it will call
   * itself connected. `e2e_pubkey` is an ML-KEM-1024 encapsulation key, so it
   * has to be 1,184 bytes of *something* — the shape is validated, the bytes
   * are never used here because no turn is taken.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname.startsWith("/e2e/instances/"),
    (route) => route.fulfill({
      json: {
        instances: [{
          instance_id: "instance-embed-journey",
          e2e_pubkey: E2E_PUBLIC_KEY,
          nonces: ["one_time_nonce_value_0001", "one_time_nonce_value_0002"],
        }],
        nonce_expires_in: 60,
        nonce_expires_at: Math.floor(Date.now() / 1_000) + 60,
      },
    }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/",
    (route) => route.fulfill({
      json: {
        total: 1,
        items: [{ chute_id: CHUTE, name: "embed-journey", slug: "embed-journey", public: true, tee: true, hot: true, invocation_count: 7 }],
      },
    }),
  );
  return unmocked;
}

/**
 * The embedding chute itself, answering with correctly-shaped vectors.
 *
 * Returned separately from the connection mocks because the point of this one
 * is what it *records*: the bearer each request carried. That is the whole
 * writer contract — the page-memory Chutes credential reaching the embedding
 * provider — and it cannot be read from anywhere else.
 */
async function mockEmbeddingChute(page: Page): Promise<readonly string[]> {
  const bearers: string[] = [];
  await page.route(
    (url) => url.hostname === "chutes-qwen-qwen3-embedding-8b-tee.chutes.ai",
    async (route) => {
      bearers.push(route.request().headers()["authorization"] ?? "<none>");
      const body = route.request().postDataJSON() as { input: string[] };
      // Qwen3-Embedding-8B's declared width. A vector of any other length is
      // refused by the provider by design, so this has to be exact.
      const vector = Array.from({ length: 4096 }, (_, index) => (index % 7) / 7);
      await route.fulfill({
        json: { object: "list", data: body.input.map((_, index) => ({ object: "embedding", index, embedding: vector })) },
      });
    },
  );
  return bearers;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("a disconnected page offers two embedding engines and discloses no egress", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser is enough for a state check");
  await mockChutes(page);
  await page.goto("/#context");
  const engines = page.getByRole("group", { name: "Embedding engine" });
  await expect(engines.getByRole("button")).toHaveCount(2);
  await expect(page.locator(".context-confidential-preflight")).toHaveCount(0);

  // The group is never silent about which engine produced the index: exactly
  // one of the buttons it does render reports itself pressed.
  const pressed = await engines.getByRole("button").evaluateAll(
    (nodes) => nodes.filter((node) => node.getAttribute("aria-pressed") === "true").length,
  );
  expect(pressed).toBe(1);
});

test("connecting Chutes makes the confidential engine selectable and says what it costs", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one paid-shaped journey is enough");
  test.setTimeout(120_000);
  const unmockedChutesRequests = await mockChutes(page);
  const embeddingBearers = await mockEmbeddingChute(page);

  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  // The route header's ⓘ auto-opens on first visit and overlays the lead lane.
  await page.keyboard.press("Escape");

  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await chutes.getAttribute("data-open")) !== "true") {
    await chutes.locator("button.connect-lane__header").click();
  }
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await chutes.locator('input[name="chutes-api-key"]').fill("cpk_embedding-journey.key");
  await chutes.getByRole("button", { name: "Discover models with key" }).click();

  const candidate = page.locator(".candidate-model");
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  const picker = candidate.locator(".model-picker-trigger");
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await picker.click();
  const dialog = page.getByRole("dialog", { name: "Choose a Chutes model" });
  await dialog.getByRole("option").first().click();
  await page.getByRole("button", { name: "Finish: verify & connect" }).click();

  // Connecting navigates to Chat. The authority is installed with the
  // connection, not with the route, so Context is opened afterwards.
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 60_000 });

  await page.goto("/#context");
  const engines = page.getByRole("group", { name: "Embedding engine" });
  const confidential = engines.getByRole("button", { name: "Confidential" });
  await expect(confidential).toBeVisible({ timeout: 30_000 });
  await expect(confidential).toBeEnabled();
  await expect(confidential).toHaveAttribute("aria-pressed", "false");

  // The disclosure is on screen before the press, and names the host, the
  // credential, and the fact the discovery pre-flight is not allowed to imply.
  const preflight = page.locator(".context-confidential-preflight");
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText("chutes-qwen-qwen3-embedding-8b-tee.chutes.ai");
  await expect(preflight).toContainText("bearer token");
  await expect(preflight).toContainText("does leave this page");

  /*
   * And it is a real selection, not a decoration: pressing it reaches
   * `SwitchableEmbeddingProvider.setMode`, which is the branch that had no way
   * in. The group reports the new mode and the summary line names the engine
   * that produced the generation — the line that used to say "bootstrap
   * embeddings" for every mode outside `semantic`.
   */
  await confidential.click();
  await expect(confidential).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(engines.getByRole("button", { name: "Bootstrap" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".context-index-status__toggle")).toContainText("confidential remote embeddings");
  await expect(page.locator(".embedding-engine-state")).toContainText("Confidential embeddings active");

  /*
   * The writer's whole contract, read off the wire.
   *
   * `setConfidentialAuthority` had no caller, so this request had no bearer to
   * carry and could never be made. Every embed now carries the same page-memory
   * credential the connection holds — not a copy captured at install time, which
   * is why the supplier reads the ref rather than closing over its value.
   */
  await expect.poll(() => embeddingBearers.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(new Set(embeddingBearers)).toEqual(new Set(["Bearer cpk_embedding-journey.key"]));

  // And nothing in this journey reached a Chutes endpoint the spec did not mock.
  expect(unmockedChutesRequests).toEqual([]);

  /*
   * Releasing the connection withdraws the authority — and must not remove the
   * button that says which engine is in force. Hiding it would put the group
   * back into the exact state the third button was added to fix: three modes,
   * two buttons, `aria-pressed="false"` on both, a screen reader told nothing
   * is selected while an engine is demonstrably running.
   */
  await page.goto("/#connection");
  await page.keyboard.press("Escape");
  const connected = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await connected.getAttribute("data-open")) !== "true") {
    await connected.locator("button.connect-lane__header").click();
  }
  await connected.getByRole("button", { name: "Clear connection" }).click();

  await page.goto("/#context");
  const afterRelease = page.getByRole("group", { name: "Embedding engine" }).getByRole("button", { name: "Confidential" });
  await expect(afterRelease).toBeVisible({ timeout: 30_000 });
  await expect(afterRelease).toHaveAttribute("aria-pressed", "true");
  await expect(afterRelease).toBeDisabled();
  // Fail loudly: the mode is still in force and can no longer authorize.
  await expect(page.locator(".embedding-engine-state"))
    .toContainText("Confidential embeddings unavailable · Chutes is not connected");
});
