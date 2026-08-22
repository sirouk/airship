import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { waitForShellSettled } from "./support/settled";

/**
 * You can come back to a conversation while its own turn is still running.
 *
 * Measured on the build before this spec existed, with a real endpoint held
 * open in conversation A and a finished turn in conversation B: clicking A in
 * the rail did nothing a person could see. The address, the rail selection,
 * the session-bar title and the transcript all stayed on B, and B's composer
 * grew "You are reading a saved conversation. It cannot continue on this
 * route. Fork it to continue." with Send disabled — a refusal that names
 * nothing, attached to a conversation nobody navigated away from, and it did
 * not clear when either turn finished.
 */

const ENDPOINT = Object.freeze({
  label: "Held Endpoint",
  baseUrl: "https://held.endpoint.example/v1/",
  apiKey: "sk-held-endpoint-e2e",
  model: "held-chat-1",
});
const SLOW_PROMPT = "Take your time with the long answer.";
const SLOW_ANSWER = "Long answer, finally delivered.";
const FAST_PROMPT = "Answer this one immediately.";
const FAST_ANSWER = "Immediate answer.";

const PREFERENCES = JSON.stringify({
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "ephemeral",
  approvalMode: "ask-first",
});

function chatCompletionsSse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

type Held = { release: () => void };

async function mockEndpoint(context: BrowserContext): Promise<Held> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await context.route(`${ENDPOINT.baseUrl}**`, async (route) => {
    const request = route.request();
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, body: "", headers: { ...headers, "Content-Type": "text/plain" } });
      return;
    }
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/models")) {
      await route.fulfill({
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ object: "list", data: [{ id: ENDPOINT.model, object: "model", supported_features: ["tools"] }] }),
      });
      return;
    }
    if (path.endsWith("/chat/completions")) {
      const body = request.postDataJSON() as {
        messages?: readonly { role?: unknown; content?: unknown }[];
      };
      const latest = body.messages?.at(-1);
      // Selected context can repeat Alpha's prompt earlier in Bravo's message.
      // Only the terminal current prompt controls this endpoint.
      const prompt = latest?.role === "user" && typeof latest.content === "string"
        ? latest.content.trimEnd()
        : "";
      const slow = prompt.endsWith(SLOW_PROMPT);
      const fast = prompt.endsWith(FAST_PROMPT);
      if (slow === fast) throw new Error("The held endpoint received an unexpected current prompt.");
      if (slow) await held;
      await route.fulfill({
        status: 200,
        headers: { ...headers, "Content-Type": "text/event-stream" },
        body: chatCompletionsSse(slow ? SLOW_ANSWER : FAST_ANSWER),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not mocked", headers: { ...headers, "Content-Type": "text/plain" } });
  });
  return { release: () => release() };
}

function composer(page: Page) {
  return page.getByRole("combobox", { name: "Message Airship" });
}

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Primary" });
}

function railRow(page: Page, title: string) {
  return rail(page).locator(".recent-conversation-row").filter({ hasText: title });
}

async function openRailRecents(page: Page): Promise<void> {
  const expand = rail(page).getByRole("button", { name: "Expand recent conversations" });
  if (await expand.count()) await expand.click();
}

async function rename(page: Page, title: string): Promise<void> {
  await page.locator(".session-bar__identity-button").dblclick();
  const input = page.getByRole("textbox", { name: "Conversation title" });
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(page.locator(".session-bar__title")).toHaveText(title);
}

async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function connectEndpointAndPin(page: Page): Promise<void> {
  await page.goto("/#connection");
  const form = page.locator("form.provider-setup-card--custom");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Provider name", { exact: true }).fill(ENDPOINT.label);
  await form.getByLabel("API base URL · HTTPS", { exact: true }).fill(ENDPOINT.baseUrl);
  await form.getByLabel("API key · page memory only", { exact: true }).fill(ENDPOINT.apiKey);
  await form.getByRole("checkbox", { name: /I understand this tab sends the key directly/u }).check();
  await form.getByRole("button", { name: "Connect custom endpoint" }).click();
  const connection = page.locator("article.provider-connection").filter({ hasText: ENDPOINT.label });
  await expect(connection).toBeVisible({ timeout: 30_000 });
  await connection.getByRole("button", { name: `${ENDPOINT.label} model for a new pinned conversation` }).click();
  await page.getByRole("listbox", { name: `${ENDPOINT.label} model for a new pinned conversation` })
    .getByRole("option").first().click();
  await connection.getByRole("button", { name: "Use in new conversation" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });
}

test("returning to a conversation whose turn is still running opens that conversation", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one browser proves the switch");
  test.setTimeout(180_000);
  await page.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", preferences);
  }, PREFERENCES);
  const endpoint = await mockEndpoint(context);

  await page.goto("/#chat");
  await waitForShellSettled(page);
  await connectEndpointAndPin(page);
  const alphaUrl = page.url();
  await rename(page, "Alpha");

  // Alpha opens a turn that the endpoint holds open.
  await send(page, SLOW_PROMPT);
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeVisible({ timeout: 30_000 });

  // Bravo runs and finishes beside it.
  await rail(page).locator('button[aria-label="New conversation"]').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(alphaUrl);
  await rename(page, "Bravo");
  await send(page, FAST_PROMPT);
  await expect(page.locator(".message.assistant").last()).toContainText(FAST_ANSWER, { timeout: 40_000 });

  // Alpha is still working.
  await openRailRecents(page);
  await expect(railRow(page, "Alpha")).toContainText("Working…");

  // Click it. This is the whole finding.
  await railRow(page, "Alpha").locator("button.recent-conversation").click();

  await expect(page.locator(".session-bar__title")).toHaveText("Alpha", { timeout: 30_000 });
  await expect.poll(() => page.url(), { timeout: 30_000 }).toBe(alphaUrl);
  await expect(page.locator(".transcript")).toContainText(SLOW_PROMPT);
  // Its turn is still on screen as a running turn, in this conversation.
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeVisible();
  // And nothing calls a live conversation a saved one.
  await expect(page.locator("p.composer-notice")).toHaveCount(0);

  // The answer lands in the conversation that asked for it.
  endpoint.release();
  await expect(page.locator(".message.assistant").last()).toContainText(SLOW_ANSWER, { timeout: 40_000 });
  await expect(page.locator(".transcript")).not.toContainText(FAST_PROMPT);

  // And the conversation that was never left carries no refusal about it. The
  // measured failure attached "You are reading a saved conversation" to Bravo —
  // the thread the person had not navigated away from — and left it there.
  await openRailRecents(page);
  await railRow(page, "Bravo").locator("button.recent-conversation").click();
  await expect(page.locator(".session-bar__title")).toHaveText("Bravo", { timeout: 30_000 });
  await expect(page.locator("p.composer-notice")).toHaveCount(0);
  await composer(page).fill("Bravo can still be sent to");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});
