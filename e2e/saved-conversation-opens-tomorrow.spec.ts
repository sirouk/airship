import { chromium, expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { completeLocalDeviceCeremony } from "./support/vault-ceremony";
import { setProfilePresentationDensity } from "./support/density";

/**
 * A conversation you saved yesterday opens tomorrow.
 *
 * Driven on a persistent browser profile across a real browser restart, which
 * is the only way to reach the defect: the conversation's inference pin records
 * `connection.id`, and a connection ID is minted with `randomUuid()` once per
 * page lifetime. Nothing a person can do the next day reproduces it — not
 * reconnecting the identical endpoint, not re-entering the identical key.
 *
 * Measured on the build before this spec existed, after one encrypted Local
 * Device Vault, one custom OpenAI-compatible endpoint and one real turn:
 *
 *   - navigating to the conversation's own address showed a DIFFERENT, empty
 *     conversation for eight seconds while the address bar named the right one;
 *   - the live region read "Encrypted Local Device vault active · audited
 *     session resumed", which was untrue of the conversation being addressed;
 *   - at eight seconds — a deferred describer chunk arriving — the composer
 *     finally read "This conversation link is not available in the current
 *     runtime: Fork required". It never opened;
 *   - "Open" from All conversations did not open it either.
 *
 * What this proves instead: the addressed conversation opens, with its own
 * transcript and its own receipts; the refusal is on screen in the same commit
 * as that transcript, in words that name the pin that moved; the address is
 * never used to display some other conversation; reconnecting the identical
 * endpoint does not weaken the pin; and Fork is one button that works.
 */

const ENDPOINT = Object.freeze({
  label: "Overnight Endpoint",
  baseUrl: "https://overnight.endpoint.example/v1/",
  apiKey: "sk-overnight-endpoint-e2e",
  model: "overnight-chat-1",
});
const PROMPT = "Draft the Q3 pricing memo intro paragraph.";
const ANSWER = "Q3 pricing memo intro: three tiers, one page, priced against renewal risk.";
const FORK_PROMPT = "Now add a second paragraph about packaging.";

const PREFERENCES = JSON.stringify({
  mode: "dark",
  typeScale: "default",
  density: "comfortable",
  corners: "subtle",
  bodyFont: "system-sans",
  vaultBackend: "local-device",
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

async function cors(route: Route, status: number, body: string, contentType = "text/plain"): Promise<void> {
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

/** The same endpoint, byte for byte, on both days. */
async function mockEndpoint(context: BrowserContext, answer: string): Promise<void> {
  await context.route(`${ENDPOINT.baseUrl}**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await cors(route, 204, "");
      return;
    }
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/models")) {
      await cors(route, 200, JSON.stringify({
        object: "list",
        data: [{ id: ENDPOINT.model, object: "model", supported_features: ["tools"] }],
      }), "application/json");
      return;
    }
    if (path.endsWith("/chat/completions")) {
      await cors(route, 200, chatCompletionsSse(answer), "text/event-stream");
      return;
    }
    await cors(route, 404, "not mocked");
  });
}

/**
 * Every sentence the one live runtime region has ever displayed in this page.
 *
 * The measured defect is a claim, not a layout: "audited session resumed" was
 * true of a conversation nobody had asked for and was announced under the
 * address of one that had not opened. A single end-state assertion cannot see
 * a sentence that was shown and replaced, so the region is recorded.
 */
async function recordRuntimeSentences(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __runtimeSentences: string[] }).__runtimeSentences = seen;
    const read = () => {
      for (const node of document.querySelectorAll(".runtime-line__text")) {
        const text = (node.textContent ?? "").trim();
        if (text && seen[seen.length - 1] !== text && !seen.includes(text)) seen.push(text);
      }
    };
    const start = () => {
      read();
      new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
}

async function runtimeSentences(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (globalThis as unknown as { __runtimeSentences?: string[] }).__runtimeSentences ?? []);
}

async function openProfile(
  userDataDir: string,
  baseURL: string,
  answer: string,
): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript((preferences) => {
    localStorage.setItem("airship.display-preferences.v1", preferences);
  }, PREFERENCES);
  await recordRuntimeSentences(context);
  await mockEndpoint(context, answer);
  return context;
}

function composer(page: Page) {
  return page.getByRole("combobox", { name: "Message Airship" });
}

/** The refusal, where the composer is: one paragraph, one remedy. */
function refusal(page: Page) {
  return page.locator("p.composer-notice").filter({ hasText: "You are reading a saved conversation" });
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

async function sendOneTurn(page: Page, prompt: string, answer: string): Promise<void> {
  await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
  await composer(page).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message.user").filter({ hasText: prompt })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".message.assistant").last()).toContainText(answer, { timeout: 40_000 });
  /* The turn is over when its finalized local run record exists, not when the
     first token lands. Closing the browser on anything earlier would strand a
     turn with no durable terminal event and test a different defect. */
  const run = page.locator('[data-transcript-card][data-message-role="assistant"]').last()
    .getByRole("button", { name: /^Run details\./u });
  await expect(run).toBeVisible({ timeout: 40_000 });
}

test("a saved conversation opens at its own address the next day, and says why it cannot continue", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One persistent-profile restart journey is sufficient.");
  test.setTimeout(360_000);
  const userDataDir = testInfo.outputPath("overnight-profile");
  /* The origin this project was configured with, so the persistent context and
     the rest of the matrix are provably the same server. */
  const baseURL = (testInfo.project.use.baseURL ?? "http://127.0.0.1:4173").replace(/\/$/u, "");

  // ── Day 1 ──────────────────────────────────────────────────────────────
  const dayOne = await openProfile(userDataDir, baseURL, ANSWER);
  let saved: string;
  try {
    const page = dayOne.pages()[0] ?? await dayOne.newPage();
    await page.goto("/#vault");
    await completeLocalDeviceCeremony(page);
    await page.goto("/#chat");
    await expect(composer(page)).toBeVisible({ timeout: 40_000 });
    /* Finalized Run details retire at the house density; this journey fences on
       that local completion record, so it runs one rung up. */
    await setProfilePresentationDensity(page, "Balanced");

    await connectEndpointAndPin(page);
    saved = new URL(page.url()).hash.replace("#chat/", "");
    expect(saved).toMatch(/^[0-9a-f-]{16,}$/u);
    await sendOneTurn(page, PROMPT, ANSWER);
  } finally {
    await dayOne.close();
  }

  // ── Day 2: the same profile, a new browser, no page-lifetime connection ──
  const dayTwo = await openProfile(userDataDir, baseURL, ANSWER);
  try {
    const page = dayTwo.pages()[0] ?? await dayTwo.newPage();
    await page.goto(`/#chat/${saved}`);

    // It opens. The transcript is the transcript of the conversation asked for.
    await expect(page.locator(".message.user").filter({ hasText: PROMPT }))
      .toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".message.assistant").filter({ hasText: ANSWER })).toBeVisible();
    // And the address it opened at is the address that was requested.
    await expect(page).toHaveURL(new RegExp(`#chat/${saved}$`, "u"));
    // No empty conversation was minted into this address in its place: the
    // opening line of an app-minted vault conversation is not on screen.
    await expect(page.locator(".transcript")).not.toContainText("The encrypted Local Device Vault is active");

    // The refusal is already on screen in the same commit as that transcript,
    // not eight seconds later behind a chunk fetch.
    await expect(refusal(page)).toBeVisible({ timeout: 1_000 });
    await expect(refusal(page)).toContainText("It cannot continue on this route.");
    await expect(refusal(page)).toContainText("inference binding");
    const firstWords = (await refusal(page).innerText()).trim();

    // Its receipts and provenance came back with it: the finalized local run
    // record for yesterday's turn is on the answer that was read from the vault.
    const run = page.locator('[data-transcript-card][data-message-role="assistant"]').last()
      .getByRole("button", { name: /^Run details\./u });
    await expect(run).toBeVisible();
    await run.click();
    const panel = page.locator('[data-transcript-card][data-message-role="assistant"]').last()
      .getByRole("group", { name: "Run details" });
    await expect(panel.locator('[data-field="model"] code')).toHaveText(ENDPOINT.model);
    await panel.getByRole("button", { name: "Done" }).click();

    // The composer refuses in its own words rather than looking armed.
    await composer(page).fill("this must not be sendable");
    const send = page.getByRole("button", { name: /^Send/u });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleName("Send unavailable: this conversation cannot continue here");
    await composer(page).fill("");

    // Nothing rewrote the sentence eight seconds later, and no conversation
    // other than the one addressed was ever announced as resumed.
    await page.waitForTimeout(9_000);
    expect((await refusal(page).innerText()).trim()).toBe(firstWords);
    const sentences = await runtimeSentences(page);
    expect(sentences.join(" | ")).not.toMatch(/audited session resumed/iu);
    // The one live region says exactly what the composer band says.
    expect(sentences.join(" | ")).toMatch(/reading a saved conversation/iu);

    // "Open" from All conversations reaches the same conversation, at the same
    // address, with the same answer. Step off it first, so the row really is
    // offering Open rather than Return to what is already on screen.
    await page.getByRole("region", { name: "Agent session" })
      .getByRole("button", { name: "New conversation" }).click();
    await expect(page).not.toHaveURL(new RegExp(`#chat/${saved}$`, "u"), { timeout: 30_000 });
    await page.goto("/#sessions");
    await expect(page.getByRole("heading", { name: "All conversations", level: 1 })).toBeVisible({ timeout: 30_000 });
    const row = page.locator(`.session-library-row[data-session-id="${saved}"]`);
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Open / }).click();
    await expect(page).toHaveURL(new RegExp(`#chat/${saved}$`, "u"), { timeout: 60_000 });
    await expect(page.locator(".message.user").filter({ hasText: PROMPT })).toBeVisible({ timeout: 60_000 });
    await expect(refusal(page)).toBeVisible();

    // Reconnecting the identical endpoint with the identical key does not make
    // it continuable, and the product does not pretend otherwise: the pin
    // records a connection generation this page cannot mint again.
    await connectEndpointAndPin(page);
    await page.goto(`/#chat/${saved}`);
    await expect(page.locator(".message.user").filter({ hasText: PROMPT })).toBeVisible({ timeout: 60_000 });
    await expect(refusal(page)).toContainText("What no longer matches: inference binding.");

    // Fork is one button, and it works.
    await refusal(page).getByRole("button", { name: "Fork to continue" }).click();
    await expect(page).not.toHaveURL(new RegExp(`#chat/${saved}$`, "u"), { timeout: 60_000 });
    await expect(page).toHaveURL(/#chat\/[^/?#]+$/u);
    await expect(refusal(page)).toHaveCount(0);
    await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
    await sendOneTurn(page, FORK_PROMPT, ANSWER);

    // The conversation that was read is untouched and still reachable.
    await page.goto("/#sessions");
    await expect(page.locator(`.session-library-row[data-session-id="${saved}"]`)).toHaveCount(1);
  } finally {
    await dayTwo.close();
  }
});
