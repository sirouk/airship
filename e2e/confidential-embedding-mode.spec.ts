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
 * What the mode *does* changed underneath it. The provider used to open its own
 * plain HTTPS connection to a hardcoded chute hostname with a hardcoded model
 * name, carrying the bearer itself. It now asks the management catalog which
 * chutes carry `standard_template: "embedding"`, asks the chute which path
 * speaks the OpenAI shape, and seals the corpus to the serving instance through
 * the same `/e2e/invoke` a conversation uses. So the request this spec watches
 * for is on `api.chutes.ai`, not on any per-chute host — and there is no longer
 * a per-chute host in `connect-src` for one to be reachable on.
 *
 * The Chutes surface is fully mocked and no request leaves the machine. The one
 * thing a mock cannot do is answer `/e2e/invoke` with a frame the ML-KEM context
 * in this page will authenticate, so the encrypted leg is driven to a *named
 * refusal* rather than to a vector: it is asserted that the request is made,
 * sealed, to the right chute and path, and that when it fails the screen says so
 * instead of quietly falling back to hash vectors wearing a semantic label.
 */

const CHUTE = "chute-embed-0001";

/**
 * The embedding deployment this journey discovers. Deliberately named nothing
 * like Qwen3-Embedding-8B: if any assertion here passed because the product
 * still knew that name, the point of discovery would be lost.
 */
const EMBEDDING_CHUTE = "chute-embed-discovered-0002";
const EMBEDDING_MODEL = "Journey/Discovered-Embedding-TEE";

/**
 * A structurally valid ML-KEM-768 encapsulation key, 1,184 bytes, base64.
 *
 * It used to be 1,184 bytes of `index % 251`, which passes a length check and
 * nothing else — and the length check was all this spec ever reached, because
 * no journey got as far as sealing anything. `build_e2ee_request` calls
 * `EncapsulationKey768::new`, which rejects a byte string that does not decode
 * and re-encode to itself, so the counting pattern stopped the encrypted leg
 * before a single request left the page.
 *
 * FIPS 203 §7.2 says what "valid" means here: the key is 768 twelve-bit
 * coefficients, each below q = 3329, packed two per three bytes, followed by a
 * 32-byte seed. Nothing secret is needed to build one — encapsulation only ever
 * uses the public half — so the page can seal a real request to it and this
 * spec can watch the ciphertext go out. It cannot decrypt the answer, which is
 * why the answer is a refusal.
 */
const E2E_PUBLIC_KEY = mlKem768EncapsulationKey();

function mlKem768EncapsulationKey(): string {
  const bytes = new Uint8Array(1184);
  for (let pair = 0; pair < 384; pair += 1) {
    // Deterministic, and deliberately spread across the range rather than
    // constant: a packing bug that dropped high bits would still round-trip
    // zeros.
    const first = (pair * 7) % 3329;
    const second = (pair * 13 + 11) % 3329;
    const offset = pair * 3;
    bytes[offset] = first & 0xff;
    bytes[offset + 1] = ((first >> 8) & 0x0f) | ((second & 0x0f) << 4);
    bytes[offset + 2] = (second >> 4) & 0xff;
  }
  // The trailing 32-byte ρ seed is unconstrained.
  for (let index = 1152; index < 1184; index += 1) bytes[index] = index % 251;
  return Buffer.from(bytes).toString("base64");
}

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
  /*
   * One path, two questions. `?template=vllm` is the chat-model enrichment the
   * connect flow reads; `?template=embedding` is the embedding discovery the
   * Context screen performs, and it answers with the envelope the live
   * management API returns — `items[]` plus a `cord_refs` map whose entries say
   * which path inside the chute speaks which public API. `/v1/embeddings` is
   * read from there rather than written into the product.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/chutes/",
    (route) => {
      const template = new URL(route.request().url()).searchParams.get("template");
      if (template === "embedding") {
        return route.fulfill({
          json: {
            total: 1,
            items: [{
              chute_id: EMBEDDING_CHUTE,
              name: EMBEDDING_MODEL,
              slug: "an-embedding-chute",
              standard_template: "embedding",
              cord_ref_id: "cord-ref-1",
              public: true,
              tee: true,
              hot: true,
            }],
            cord_refs: {
              "cord-ref-1": [
                { path: "/embed", method: "POST", stream: false, function: "embed", public_api_path: "/v1/embeddings", public_api_method: "POST" },
                { path: "/get_models", method: "GET", stream: false, function: "get_models", public_api_path: "/v1/models", public_api_method: "GET" },
              ],
            },
          },
        });
      }
      return route.fulfill({
        json: {
          total: 1,
          items: [{ chute_id: CHUTE, name: "embed-journey", slug: "embed-journey", public: true, tee: true, hot: true, invocation_count: 7 }],
        },
      });
    },
  );
  /*
   * The endpoint-evidence surface the connected transport reaches on every
   * invocation. Answered rather than left to the 503 catch-all so that "nothing
   * unmocked" stays a meaningful assertion; the connection is built with
   * `attestationMode: "optional"`, so an unverifiable answer degrades the claim
   * without blocking the turn — which is the behaviour under test everywhere
   * else and is deliberately not re-tested here.
   */
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/servers/tee/measurements",
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && /^\/(?:instances|chutes)\/[^/]+\/evidence$/u.test(url.pathname),
    (route) => route.fulfill({ json: { evidence: [], failed_instance_ids: [] } }),
  );
  return unmocked;
}

/**
 * The encrypted invoke endpoint, recording what each sealed request was aimed at.
 *
 * This used to mock the chute's own hostname and record the bearer it carried,
 * because the bearer arriving at a remote embedding host *was* the contract. It
 * is not any more: the credential stays with the connection, and what travels is
 * a ciphertext addressed by `X-Chute-Id` and `X-E2E-Path`. Those two headers are
 * the whole of what this journey has to prove about routing, and neither of them
 * is a string that appears anywhere in the product — both were discovered from
 * the catalog moments earlier.
 *
 * It answers 429 rather than a frame. A mock cannot produce a response the
 * page's ML-KEM context will authenticate, and a made-up "success" here would
 * test nothing; a refusal exercises the path the owner actually hit and lets the
 * screen be checked for saying so.
 */
async function mockEncryptedInvoke(page: Page): Promise<ReadonlyArray<Record<string, string>>> {
  const invocations: Array<Record<string, string>> = [];
  await page.route(
    (url) => url.hostname === "api.chutes.ai" && url.pathname === "/e2e/invoke",
    async (route) => {
      const headers = route.request().headers();
      invocations.push({
        chute: headers["x-chute-id"] ?? "<none>",
        path: headers["x-e2e-path"] ?? "<none>",
        streamed: headers["x-e2e-stream"] ?? "<none>",
        instance: headers["x-instance-id"] ?? "<none>",
        authorized: headers["authorization"] ? "yes" : "no",
        // Whatever else is true, the body must not be readable text.
        body: route.request().postData() ?? "",
      });
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ detail: "too many requests" }) });
    },
  );
  return invocations;
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

test("connecting Chutes discovers an embedding model and seals the corpus to it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one paid-shaped journey is enough");
  test.setTimeout(120_000);
  const unmockedChutesRequests = await mockChutes(page);
  const invocations = await mockEncryptedInvoke(page);
  const catalogReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "api.chutes.ai" && url.pathname === "/chutes/") {
      catalogReads.push(url.searchParams.get("template") ?? "<none>");
    }
  });

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

  /*
   * The disclosure is on screen before the press. It names the host the request
   * actually reaches, says the request is encrypted here, and still says the
   * text leaves — and it names no model, because the model is discovered a
   * moment from now and this sentence is written before anyone knows it.
   */
  const preflight = page.locator(".context-confidential-preflight");
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText("api.chutes.ai");
  await expect(preflight).toContainText("encrypted on this device");
  await expect(preflight).toContainText("does leave this page");
  await expect(preflight).not.toContainText("Qwen");

  await confidential.click();

  /*
   * Two questions were asked before a byte of corpus moved: which chutes embed,
   * and how wide this one's vectors are. The first is the catalog read below;
   * the second is the sealed probe.
   */
  await expect.poll(() => catalogReads, { timeout: 30_000 }).toContain("embedding");

  /*
   * And the corpus went out sealed, to the chute and the path the catalog named
   * — neither of which appears anywhere in the product. `X-E2E-Stream` is
   * `false`, which is the header that used to be the literal string `"true"`
   * written into the invoke request because chat was the only caller.
   */
  /*
   * And the corpus went out sealed, to the chute and the path the catalog named
   * — neither of which appears anywhere in the product. `X-E2E-Stream` is
   * `false`, which is the header that was the literal string `"true"` written
   * into the invoke request back when chat was its only caller.
   */
  await expect.poll(() => invocations.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(invocations[0]).toMatchObject({
    chute: EMBEDDING_CHUTE,
    path: "/v1/embeddings",
    streamed: "false",
    instance: "instance-embed-journey",
    authorized: "yes",
  });
  /*
   * The body is a real ML-KEM sealed frame, so none of the request is legible:
   * not the probe text, not the model name the payload addresses, not even the
   * OpenAI field names. This is the assertion the old journey could not make,
   * because the old provider posted `{"model":…,"input":[…]}` as plaintext JSON.
   */
  const sealed = invocations[0]!.body;
  expect(sealed.length).toBeGreaterThan(1_000);
  expect(sealed).not.toContain("input");
  expect(sealed).not.toContain("model");
  expect(sealed).not.toContain(EMBEDDING_MODEL);
  // And no per-chute host was contacted at all — there is no longer one in the
  // content security policy for a request to be allowed to reach.
  expect(unmockedChutesRequests).toEqual([]);

  /*
   * The mock answered 429, which is the failure the owner saw on this route
   * while the same key and model answered 200 on the shared gateway. Nothing
   * silently becomes hash vectors wearing a semantic label: the mode stays where
   * it was, and the screen says why — beside the control that was pressed, not
   * in the retrieval panel's search slot, where this refusal used to be written
   * and where it rendered for nobody.
   */
  const failure = page.locator(".context-engine-failure");
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText("429");
  await expect(failure).toContainText("pinned to instance instance-embed-journey");
  // Named, so a reader can tell a rate limit from a bad key: the sentence
  // carries the discovered model it was talking to.
  await expect(failure).toContainText(EMBEDDING_MODEL);
  await expect(confidential).toHaveAttribute("aria-pressed", "false");
  await expect(engines.getByRole("button", { name: "Bootstrap" })).toHaveAttribute("aria-pressed", "true");
});

/**
 * The engine control when the connection is released.
 *
 * A `toggle` group whose selected member has been removed reports
 * `aria-pressed="false"` on every remaining button, which is a screen reader
 * being told nothing is selected while an engine is demonstrably in force. The
 * group must therefore always report exactly one pressed member, in every
 * connection state, and that is what is asserted here.
 *
 * What is deliberately *not* asserted is the confidential engine surviving a
 * release as the mode in force. Reaching that state means completing a
 * confidential index generation, which means a real chute answering a sealed
 * `/e2e/invoke` with a frame this page's ML-KEM context authenticates — a
 * mocked Chutes cannot produce one, and a spec that faked it would be testing
 * its own fake. `src/ui/context-embedding-modes.test.ts` holds that arm.
 */
test("the engine group always reports exactly one pressed member", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser is enough for a state check");
  await mockChutes(page);
  await mockEncryptedInvoke(page);

  const engines = () => page.getByRole("group", { name: "Embedding engine" });
  const pressedCount = () => engines().getByRole("button").evaluateAll(
    (nodes) => nodes.filter((node) => node.getAttribute("aria-pressed") === "true").length,
  );

  await page.goto("/#connection");
  await page.keyboard.press("Escape");
  const chutes = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await chutes.getAttribute("data-open")) !== "true") {
    await chutes.locator("button.connect-lane__header").click();
  }
  await chutes.getByRole("tab", { name: /^API key/u }).click();
  await chutes.locator('input[name="chutes-api-key"]').fill("cpk_embedding-journey.key");
  await chutes.getByRole("button", { name: "Discover models with key" }).click();
  const picker = page.locator(".candidate-model .model-picker-trigger");
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await picker.click();
  await page.getByRole("dialog", { name: "Choose a Chutes model" }).getByRole("option").first().click();
  await page.getByRole("button", { name: "Finish: verify & connect" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 60_000 });

  await page.goto("/#context");
  await expect(engines().getByRole("button", { name: "Confidential" })).toBeEnabled({ timeout: 30_000 });
  await expect(engines().getByRole("button")).toHaveCount(3);
  expect(await pressedCount()).toBe(1);

  await page.goto("/#connection");
  await page.keyboard.press("Escape");
  const connected = page.locator('.connect-lane[data-lane="chutes"]');
  if ((await connected.getAttribute("data-open")) !== "true") {
    await connected.locator("button.connect-lane__header").click();
  }
  await connected.getByRole("button", { name: "Clear connection" }).click();

  await page.goto("/#context");
  // The choice withdraws with the credential that made it possible, and so does
  // the egress sentence that only ever described it.
  await expect(engines().getByRole("button")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(".context-confidential-preflight")).toHaveCount(0);
  expect(await pressedCount()).toBe(1);
});
