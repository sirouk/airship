import { expect, test, type Route } from "@playwright/test";

/**
 * Capability names now belong to each discovered model. The old Chutes
 * sign-in/key eligibility matrix no longer exists, so this browser contract
 * checks the words exposed by the current provider catalog and selected-model
 * group instead of assigning names to decorative matrix glyphs.
 */
test("every discovered capability is exposed by name in the model option and selected-model group", async ({ page }) => {
  const catalogUrl = "https://capabilities.e2e.example/v1/models";
  await page.route(catalogUrl, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    await cors(route, 200, JSON.stringify({
      object: "list",
      data: [{
        id: "named-capabilities-e2e",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supported_features: ["tools", "reasoning", "structured_outputs"],
      }],
    }), "application/json");
  });

  await page.goto("/#connection");
  await expect(page.locator(".topbar-destination")).toHaveText("Providers");
  await expect(page.getByRole("heading", { name: "Cloud and local models", level: 2 })).toBeVisible();

  const form = page.locator("form.provider-setup-card--custom");
  await form.getByLabel("Provider name", { exact: true }).fill("Capability Names");
  await form.getByLabel("API base URL · HTTPS", { exact: true }).fill("https://capabilities.e2e.example/v1/");
  await form.getByLabel("API key · page memory only", { exact: true }).fill("sk-capability-names-e2e");
  await form.getByRole("checkbox", { name: /I understand this tab sends the key directly/u }).check();
  await form.getByRole("button", { name: "Connect custom endpoint" }).click();

  const connection = page.getByRole("group", { name: "Connected inference providers" })
    .locator("article.provider-connection")
    .filter({ hasText: "Capability Names" });
  await expect(connection.getByRole("heading", { name: "Capability Names", level: 3 })).toBeVisible();

  const modelControl = connection.getByRole("button", {
    name: "Capability Names model for a new pinned conversation",
  });
  await modelControl.click();
  const option = page.getByRole("listbox", {
    name: "Capability Names model for a new pinned conversation",
  }).getByRole("option", { name: "named-capabilities-e2e", exact: true });
  await expect(option).toHaveAccessibleDescription(
    "Provider catalog · availability unknown · Text input · Vision · Text output · Tools · Reasoning · Structured output",
  );
  await option.click();

  const capabilities = connection.getByRole("group", {
    name: "Capabilities reported for the selected model",
  });
  const expectedNames = ["Text input", "Vision", "Text output", "Tools", "Reasoning", "Structured output"];
  await expect(capabilities.locator(":scope > span")).toHaveCount(expectedNames.length);
  for (const name of expectedNames) {
    await expect(capabilities.getByText(name, { exact: true })).toBeVisible();
  }

  await expect(capabilities.getByRole("img")).toHaveCount(0);
  await expect(capabilities).not.toContainText(/✓|—/u);
  await expect(page.locator(".capability-table-wrap")).toHaveCount(0);
});

async function cors(route: Route, status: number, body: string, contentType = "text/plain"): Promise<void> {
  await route.fulfill({
    status,
    body,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Content-Type": contentType,
    },
  });
}
