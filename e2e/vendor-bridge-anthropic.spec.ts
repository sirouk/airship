import { expect, test, type Page } from "@playwright/test";

/*
 * Directive: every connected vendor runs the same Airship turn — tool calls,
 * approval dock, journaling. Anthropic Messages dialect: the vendor streams
 * a native tool_use block, the dock asks before the memory write, Allow once
 * commits exactly one record, and the follow-up text lands in the same
 * transcript. Mirrors e2e/vendor-bridge-openai.spec.ts for the SSE dialect
 * that is not OpenAI Responses.
 */

const MODEL = "claude-e2e-bridge";
const FINAL_TEXT = "Noted — mint tea rides in the default cup from now on.";
const TOOL_ARGS = { action: "remember", content: "Likes mint tea", source: "The user asked to be reminded of it in conversation." };

function frame(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function mockAnthropicBridge(page: Page): Promise<void> {
  await page.route("https://api.anthropic.com/**", (route) => route.fulfill({ status: 503, json: { error: { message: "not mocked" } } }));
  await page.route("https://api.anthropic.com/v1/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{ id: MODEL, type: "model", display_name: "Claude Bridge E2E" }], has_more: false, first_id: MODEL, last_id: MODEL }),
  }));
  let call = 0;
  await page.route("https://api.anthropic.com/v1/messages", (route) => {
    call += 1;
    // 1 activation probe; 2 conversation naming; 3 the tool-offering turn;
    // 4 the continuation after the approved write.
    const frames = call <= 2
      ? [
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Mint Tea Memory" } }),
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }),
        frame("message_stop", { type: "message_stop" }),
      ]
      : call === 3
      ? [
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_bridge_1", name: "update_memory", input: {} } }),
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL_ARGS) } }),
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }),
        frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        frame("message_stop", { type: "message_stop" }),
      ]
      : [
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FINAL_TEXT } }),
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }),
        frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
        frame("message_stop", { type: "message_stop" }),
      ];
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: frames.join("") });
  });
}

test("anthropic messages lane: tool call docks for approval before the memory write", async ({ page }) => {
  await mockAnthropicBridge(page);
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  const setup = page.locator("#provider-setup-anthropic");
  await setup.scrollIntoViewIfNeeded();
  await setup.locator('input[type="password"]').fill("sk-ant-e2e-bridge-lane");
  const acknowledgement = setup.locator('input[type="checkbox"]');
  if (!await acknowledgement.isChecked()) await acknowledgement.check();
  await setup.getByRole("button", { name: /^Connect Anthropic$/u }).click();
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "Anthropic", exact: true }),
  });
  await expect(connection).toBeVisible();
  const modelSelect = connection.getByRole("button", { name: "Anthropic model for a new pinned conversation" });
  await modelSelect.click();
  await page.getByRole("listbox", { name: "Anthropic model for a new pinned conversation" }).getByRole("option").first().click();
  await expect(modelSelect).toContainText("Claude Bridge E2E", { timeout: 10_000 });
  await connection.getByRole("button", { name: "Use in new conversation" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });

  const composer = page.getByRole("combobox", { name: "Message Airship" });
  await composer.fill("please remember that I like mint tea");
  await page.keyboard.press("Enter");

  const dock = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await dock.click();
  await expect(page.getByText(FINAL_TEXT).first()).toBeVisible({ timeout: 30_000 });

  await page.goto("/#memory");
  const record = page.getByRole("main").locator("text=Likes mint tea").first();
  await expect(record).toBeVisible({ timeout: 15_000 });
});
