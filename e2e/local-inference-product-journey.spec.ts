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

  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Ollama · gemma3:latest/u })).toBeVisible();

  // AMENDED: the composer placeholder reads "Message Airship — / for commands"
  // now; it stopped being "Ask Airship…" when the composer started advertising
  // the slash-command entry point. Addressing the field by its accessible name
  // rather than its placeholder is stronger: the name is the contract screen
  // readers depend on, and a placeholder is free to be re-worded again without
  // this spec silently losing its grip on the control.
  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("Reply with a short local greeting.");
  await composer.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("OK", { timeout: 20_000 });

  await page.goto("/#connection");
  const activeCard = page.locator(".provider-fabric article.provider-connection", { hasText: "Ollama" });
  await activeCard.getByRole("button", { name: "Disconnect" }).click();
  await expect(activeCard.getByText(/conversation stays readable/u)).toBeVisible();
  await activeCard.getByRole("button", { name: "Confirm disconnect" }).click();
  await expectConversationTrustAxis(page, /^Ollama · disconnected/u);
});

/**
 * AMENDED: the four trust axes stopped rendering as four topbar pills.
 *
 * The topbar carries one chip that states the weakest claim true of this
 * browser tab and counts every axis behind it; the inference axis is scoped to
 * the conversation, so its verbatim label is stated at rest in the session bar
 * and in full in the sheet the chip opens (`topbar.tsx:30`,
 * `platform-shell.tsx:454`). This route has no session bar, which is exactly
 * why the sheet is the right place to read it from here — the claim was
 * re-presented, not deleted.
 *
 * Stronger than the button check it replaces: it additionally proves the chip
 * is honest about how many claims it hides, that the sheet opens and closes,
 * and that a released pin is still filed as a claim about *this conversation*
 * rather than quietly promoted to a property of the tab.
 */
async function expectConversationTrustAxis(page: Page, label: RegExp): Promise<void> {
  const chip = page.getByRole("button", { name: /^Runtime trust for this browser tab\./u });
  await expect(chip).toHaveAccessibleName(/\s\d+ axes\./u);
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Runtime trust" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("region", { name: "This conversation" }).getByRole("button", { name: label }))
    .toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
}

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
