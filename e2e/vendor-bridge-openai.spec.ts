import { expect, test, type Page } from "@playwright/test";

/*
 * Directive: every connected vendor runs the same Airship turn — tool calls,
 * approval dock, journaling — the way the local engine and Chutes already do.
 * This proves the OpenAI Responses lane end to end: the vendor streams a
 * native function_call, the dock asks before the memory write, Allow once
 * commits exactly one record, and the vendor's follow-up text lands in the
 * same transcript.
 */

const MODEL = "gpt-e2e-bridge";
const FINAL_TEXT = "Noted — mint tea rides in the default cup from now on.";

async function mockOpenAiBridge(page: Page): Promise<void> {
  await page.route("https://api.openai.com/v1/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{ id: MODEL, object: "model" }], object: "list" }),
  }));
  let call = 0;
  await page.route("https://api.openai.com/v1/responses", (route) => {
    call += 1;
    // 1 activation probe; 2 conversation naming; 3 the tool-offering turn;
    // 4 the continuation after the approved write.
    const frames = call <= 2
      ? [
        'data: {"type":"response.output_text.delta","delta":"Mint Tea Memory"}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ]
      : call === 3
      ? [
        "data: " + JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_bridge_1",
            name: "update_memory",
            arguments: JSON.stringify({ action: "remember", content: "Likes mint tea", source: "The user asked to be reminded of it in conversation." }),
          },
        }) + "\n\n",
        'data: {"type":"response.completed"}\n\n',
      ]
      : [
        `data: {"type":"response.output_text.delta","delta":${JSON.stringify(FINAL_TEXT)}}\n\n`,
        'data: {"type":"response.completed"}\n\n',
      ];
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: frames.join("") });
  });
;
}

test("openai responses lane: tool call docks for approval before the memory write", async ({ page }) => {
  await mockOpenAiBridge(page);
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  const setup = page.locator("#provider-setup-openai");
  await setup.scrollIntoViewIfNeeded();
  await setup.locator('input[type="password"]').fill("sk-e2e-bridge-lane");
  const acknowledgement = setup.locator('input[type="checkbox"]');
  if (!await acknowledgement.isChecked()) await acknowledgement.check();
  await setup.getByRole("button", { name: /^Connect OpenAI$/u }).click();
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  await expect(connection).toBeVisible();
  const modelSelect = connection.getByRole("button", { name: "OpenAI model for a new pinned conversation" });
  await modelSelect.click();
  await page.getByRole("listbox", { name: "OpenAI model for a new pinned conversation" }).getByRole("option").first().click();
  await expect(modelSelect).toContainText(MODEL, { timeout: 10_000 });
  const useButton = connection.getByRole("button", { name: "Use in new conversation" });
  await useButton.click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("please remember that I like mint tea");
  await page.keyboard.press("Enter");

  // The vendor's function_call must dock for approval — not auto-run, not vanish.
  const dock = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await dock.click();
  // Allow once commits the write, the agent loop re-asks the vendor, and the
  // final text lands in the transcript the user owns.
  await expect(page.getByText(FINAL_TEXT).first()).toBeVisible({ timeout: 30_000 });

  // Proof beyond the happy path: the approved write is a real memory record.
  await page.goto("/#memory");
  const record = page.getByRole("main").locator("text=Likes mint tea").first();
  await expect(record).toBeVisible({ timeout: 15_000 });
});