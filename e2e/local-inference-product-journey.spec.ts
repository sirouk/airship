import { expect, test, type Page, type Route } from "@playwright/test";

const PREFERENCES_KEY = "airship.display-preferences.v1";

test("connects, pins, invokes, and disconnects an Ollama model through the mounted app", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One real Chromium transport journey is sufficient; responsive layout is covered separately.",
  );
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      mode: "dark",
      typeScale: "default",
      density: "comfortable",
      corners: "subtle",
      bodyFont: "system-sans",
      vaultBackend: "ephemeral",
      approvalMode: "ask-first",
    }));
  }, { key: PREFERENCES_KEY });
  await mockOllama(page);
  await page.goto("/#connection");

  const fabric = page.locator(".provider-fabric");
  await expect(fabric.getByRole("heading", { name: "Cloud and local models" })).toBeVisible();
  await fabric.getByRole("button", { name: "Check Ollama" }).click();

  const connected = fabric.locator("article.provider-connection", { hasText: "Ollama" });
  await expect(connected).toContainText("This machine · loopback");
  await connected.getByRole("button", { name: "Use in new conversation" }).click();

  await expect(page).toHaveURL(/#chat$/u, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Ollama · gemma3:latest/u })).toBeVisible();

  const composer = page.getByPlaceholder(/Ask Airship/u);
  await composer.fill("Reply with a short local greeting.");
  await composer.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("OK", { timeout: 20_000 });

  await page.goto("/#connection");
  const activeCard = page.locator(".provider-fabric article.provider-connection", { hasText: "Ollama" });
  await activeCard.getByRole("button", { name: "Disconnect" }).click();
  await expect(activeCard.getByText(/conversation stays readable/u)).toBeVisible();
  await activeCard.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByRole("button", { name: /Ollama · disconnected/u })).toBeVisible();
});

async function mockOllama(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:11434/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    if (url.pathname === "/api/version") {
      await json(route, { version: "0.12.3" });
      return;
    }
    if (url.pathname === "/api/tags") {
      await json(route, {
        models: [{
          name: "gemma3:latest",
          size: 3_338_801_804,
          digest: "sha256:browser-acceptance",
          modified_at: "2026-07-20T00:00:00Z",
          details: {
            format: "gguf",
            family: "gemma3",
            parameter_size: "4.3B",
            quantization_level: "Q4_K_M",
          },
        }],
      });
      return;
    }
    if (url.pathname === "/api/show") {
      await json(route, {
        capabilities: ["completion", "vision", "tools"],
        model_info: { "gemma3.context_length": 131_072 },
      });
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      await cors(route, 200, body, "text/event-stream");
      return;
    }
    await cors(route, 404, "not found", "text/plain");
  });
}

async function json(route: Route, value: unknown): Promise<void> {
  await cors(route, 200, JSON.stringify(value), "application/json");
}

async function cors(
  route: Route,
  status: number,
  body: string,
  contentType = "text/plain",
): Promise<void> {
  await route.fulfill({
    status,
    body,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": contentType,
    },
  });
}
