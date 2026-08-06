import { expect, test, type Page, type Route } from "@playwright/test";

const FIRST_MODEL = "gpt-return-alpha";
const SECOND_MODEL = "gpt-return-beta";
const ANTHROPIC_MODEL = "claude-return-current";
const USER_MARKER = "Keep this return marker: copper-orbit-17";
const ASSISTANT_MARKER = "Return marker copper-orbit-17 is held in this conversation.";

function responsesSse(includeTranscript: boolean): string {
  const records = includeTranscript ? [
    ["response.output_text.delta", { type: "response.output_text.delta", delta: ASSISTANT_MARKER }],
    ["response.completed", { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 9 } } }],
  ] : [
    ["response.completed", { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 1 } } }],
  ];
  return records.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

type OpenAiMock = Readonly<{
  unmocked: string[];
  failNextResponse(): void;
  holdNextResponse(): Promise<void>;
  releaseHeldResponse(): Promise<void>;
}>;

async function mockOpenAi(page: Page): Promise<OpenAiMock> {
  const unmocked: string[] = [];
  let holdNextResponse = false;
  let failNextResponse = false;
  let responseReached: (() => void) | undefined;
  let releaseResponse: (() => void) | undefined;
  let responseReleaseCompleted: (() => void) | undefined;
  await page.route("https://api.openai.com/**", (route) => {
    unmocked.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 503, json: { error: "not mocked" } });
  });
  await page.route("https://api.openai.com/v1/models", (route) => route.fulfill({
    json: {
      object: "list",
      data: [
        { id: FIRST_MODEL, object: "model", owned_by: "openai" },
        { id: SECOND_MODEL, object: "model", owned_by: "openai" },
      ],
    },
  }));
  await page.route("https://api.openai.com/v1/responses", async (route: Route) => {
    if (failNextResponse) {
      failNextResponse = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Reconnect verification unavailable." } }),
      });
      return;
    }
    let heldResponse = false;
    if (holdNextResponse) {
      heldResponse = true;
      holdNextResponse = false;
      const released = new Promise<void>((resolve) => { releaseResponse = resolve; });
      responseReached?.();
      responseReached = undefined;
      await released;
      releaseResponse = undefined;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as { input?: unknown };
    const includeTranscript = JSON.stringify(body.input).includes(USER_MARKER);
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: responsesSse(includeTranscript),
      });
    } finally {
      if (heldResponse) {
        responseReleaseCompleted?.();
        responseReleaseCompleted = undefined;
      }
    }
  });
  return Object.freeze({
    unmocked,
    failNextResponse() {
      if (failNextResponse || holdNextResponse || releaseResponse) throw new Error("A response outcome is already staged.");
      failNextResponse = true;
    },
    holdNextResponse() {
      if (holdNextResponse || releaseResponse) throw new Error("A response is already held.");
      holdNextResponse = true;
      return new Promise<void>((resolve) => { responseReached = resolve; });
    },
    releaseHeldResponse() {
      if (!releaseResponse) throw new Error("No response has reached the hold point.");
      const completed = new Promise<void>((resolve) => { responseReleaseCompleted = resolve; });
      releaseResponse();
      return completed;
    },
  });
}

async function mockAnthropic(page: Page): Promise<void> {
  await page.route("https://api.anthropic.com/v1/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: [{ id: ANTHROPIC_MODEL, type: "model", display_name: "Claude Return Current" }],
      has_more: false,
      first_id: ANTHROPIC_MODEL,
      last_id: ANTHROPIC_MODEL,
    }),
  }));
  await page.route("https://api.anthropic.com/v1/messages", (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""),
  }));
}

async function connectOpenAiCredential(page: Page, apiKey: string): Promise<void> {
  const setup = page.locator("#provider-setup-openai");
  await setup.scrollIntoViewIfNeeded();
  await setup.locator('input[type="password"]').fill(apiKey);
  const acknowledgement = setup.locator('input[type="checkbox"]');
  if (!await acknowledgement.isChecked()) await acknowledgement.check();
  await setup.getByRole("button", { name: /^Connect OpenAI$/u }).click();

  await expect(page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  })).toBeVisible();
}

async function connectOpenAi(page: Page): Promise<void> {
  await page.goto("/#connection");
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press("Escape");
  await connectOpenAiCredential(page, "sk-return-journey-page-memory");

  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  await expect(connection).toBeVisible();
  await chooseProviderModel(page, connection, "OpenAI", FIRST_MODEL);
  await connection.getByRole("button", { name: "Use in new conversation" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });
}

async function connectAndActivateAnthropic(page: Page): Promise<void> {
  await page.evaluate(() => { window.location.hash = "#connection"; });
  await expect(page.getByRole("heading", { name: "Connection", exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press("Escape");
  const setup = page.locator("#provider-setup-anthropic");
  await setup.scrollIntoViewIfNeeded();
  await setup.locator('input[type="password"]').fill("sk-ant-return-current-page-memory");
  await setup.locator('input[type="checkbox"]').check();
  await setup.getByRole("button", { name: /^Connect Anthropic$/u }).click();
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "Anthropic", exact: true }),
  });
  await expect(connection).toBeVisible();
  await chooseProviderModel(page, connection, "Anthropic", ANTHROPIC_MODEL);
  await connection.getByRole("button", { name: "Use in new conversation" }).click();
  await expect(page).toHaveURL(/#chat\/[^/?#]+$/u, { timeout: 30_000 });
}

async function chooseProviderModel(
  page: Page,
  connection: ReturnType<Page["locator"]>,
  provider: string,
  modelId: string,
): Promise<void> {
  const modelSelect = connection.getByRole("button", { name: `${provider} model for a new pinned conversation` });
  await modelSelect.click();
  const options = page.getByRole("listbox", { name: `${provider} model for a new pinned conversation` }).getByRole("option");
  const matching = options.filter({ hasText: new RegExp(modelId, "u") });
  // Some providers publish a human display name while keeping the opaque id
  // only in the connection record. Prefer the returned id when it is visible;
  // otherwise choose the sole option the provider actually advertised.
  await (await matching.count() ? matching.first() : options.first()).click();
}

type ReconnectJourney = Readonly<{
  activeSessionId: string;
  countBeforeReconnect: number;
  sourceSessionId: string;
}>;

async function requestReturnToSourceConversation(page: Page): Promise<ReconnectJourney> {
  await connectOpenAi(page);

  const sourceSessionId = page.url().match(/#chat\/([^/?#]+)$/u)?.[1];
  expect(sourceSessionId).toBeTruthy();
  await page.getByRole("combobox", { name: "Message Airship" }).fill(USER_MARKER);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("article", { name: "Your message" }).filter({ hasText: USER_MARKER })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Airship message" }).filter({ hasText: ASSISTANT_MARKER })).toHaveCount(1);

  const modelMenu = page.getByRole("button", { name: /OpenAI session model/u });
  const activeModel = (await modelMenu.innerText()).includes(FIRST_MODEL) ? FIRST_MODEL : SECOND_MODEL;
  const otherModel = activeModel === FIRST_MODEL ? SECOND_MODEL : FIRST_MODEL;
  await modelMenu.click();
  await page.getByRole("listbox", { name: /OpenAI session model/u })
    .getByRole("option", { name: new RegExp(otherModel, "u") })
    .click();
  await expect(modelMenu).toContainText(otherModel, { timeout: 30_000 });

  await page.evaluate(() => { window.location.hash = "#sessions"; });
  await expect(page.getByRole("heading", { name: "All conversations", exact: true })).toBeVisible();
  const rows = page.locator(".session-library-row");
  await expect(rows).toHaveCount(3);
  const countBeforeReconnect = await rows.count();
  const activeRow = rows.filter({ has: page.locator(".session-library-card-active") });
  await expect(activeRow).toHaveCount(1);
  const activeSessionId = await activeRow.getAttribute("data-session-id");
  expect(activeSessionId).toBeTruthy();
  expect(activeSessionId).not.toBe(sourceSessionId);
  await page.locator(`.session-library-row[data-session-id="${sourceSessionId!}"] button.session-library-card`).click();

  const reconnect = page.locator("a.session-library-reconnect__primary");
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toHaveText(`Check exact OpenAI · ${activeModel} connection`);
  const reconnectHref = await reconnect.getAttribute("href");
  const reconnectQuery = new URLSearchParams(reconnectHref!.slice(reconnectHref!.indexOf("?") + 1));
  expect(reconnectHref).toMatch(/^#connection\?/u);
  expect(reconnectQuery.get("return")).toBe(sourceSessionId);
  expect(reconnectQuery.get("model")).toBe(activeModel);
  expect(reconnectQuery.get("connection")).toMatch(/^[a-z0-9][a-z0-9._:/-]{0,127}$/u);
  expect(reconnectQuery.get("generation")).toMatch(/^[1-9]\d*$/u);
  await reconnect.click();
  await expect(page).toHaveURL(/#connection\?lane=codex/u);

  return {
    activeSessionId: activeSessionId!,
    countBeforeReconnect,
    sourceSessionId: sourceSessionId!,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: "default", density: "comfortable", corners: "subtle", bodyFont: "system-sans",
    vaultBackend: "ephemeral", approvalMode: "ask-first",
  })));
});

test("an exact held route check offers continuation without creating another conversation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one desktop journey pins the reconnect transaction");
  test.setTimeout(90_000);
  const mock = await mockOpenAi(page);
  const journey = await requestReturnToSourceConversation(page);
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  await expect(connection.getByRole("button", { name: "OpenAI model for the requested conversation" })).toBeDisabled();
  const responseHeld = mock.holdNextResponse();
  await connection.getByRole("button", { name: "Continue requested conversation" }).click();
  await responseHeld;
  const returnNotice = page.locator(".provider-fabric__return--exact");
  await expect(returnNotice).toBeVisible();
  const pending = page.getByText("Connection change in progress", { exact: true });
  await expect(pending).toBeVisible();
  const markerGeometry = await returnNotice.evaluate((notice) => {
    const marker = notice.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
    const progress = notice.querySelector<HTMLElement>(".provider-fabric__return-pending");
    return {
      markerWidth: marker?.getBoundingClientRect().width,
      progressWidth: progress?.getBoundingClientRect().width,
      progressFlexBasis: progress ? getComputedStyle(progress).flexBasis : undefined,
    };
  });
  expect(markerGeometry.markerWidth).toBeCloseTo(7, 0);
  expect(markerGeometry.progressWidth ?? 0).toBeGreaterThan(80);
  expect(markerGeometry.progressFlexBasis).not.toBe("7px");
  await expect(page.getByRole("button", { name: "Abandon return request" })).toHaveCount(0);
  await mock.releaseHeldResponse();

  await expect(page).toHaveURL(new RegExp(`#chat/${journey.sourceSessionId}$`, "u"), { timeout: 30_000 });
  await expect(page.getByRole("article", { name: "Your message" }).filter({ hasText: USER_MARKER })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Airship message" }).filter({ hasText: ASSISTANT_MARKER })).toHaveCount(1);

  await page.evaluate(() => { window.location.hash = "#sessions"; });
  await expect(page.locator(".session-library-row")).toHaveCount(journey.countBeforeReconnect);
  await expect(page.locator(`.session-library-row[data-session-id="${journey.sourceSessionId}"] .session-library-card-active`)).toHaveText("Active");
  expect(mock.unmocked).toEqual([]);
});

test("a failed exact route check answers beside the continuation control", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one desktop journey pins reconnect recovery placement");
  test.setTimeout(90_000);
  const mock = await mockOpenAi(page);
  await requestReturnToSourceConversation(page);
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  const continueButton = connection.getByRole("button", { name: "Continue requested conversation" });
  mock.failNextResponse();
  await continueButton.click();

  const failure = connection.locator(".provider-connection__activation-error");
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute("role", "alert");
  await expect(failure).toContainText(/\S/u);
  await expect(continueButton).toBeEnabled();
  expect(await continueButton.getAttribute("aria-describedby")).toBe(await failure.getAttribute("id"));
  await expect(page.locator(".provider-fabric > .provider-fabric__error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Abandon return request" })).toBeVisible();
  expect(mock.unmocked).toEqual([]);
});

test("Back cancels a held exact return before preparation or selection can publish", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one desktop journey proves return cancellation");
  test.setTimeout(90_000);
  const mock = await mockOpenAi(page);
  const journey = await requestReturnToSourceConversation(page);
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  const responseHeld = mock.holdNextResponse();
  await connection.getByRole("button", { name: "Continue requested conversation" }).click();
  await responseHeld;
  await expect(page.getByText("Connection change in progress", { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/#connection\?/u);
  await mock.releaseHeldResponse();
  await page.evaluate(() => { window.location.hash = "#sessions"; });
  await expect(page.getByRole("heading", { name: "All conversations", exact: true })).toBeVisible();
  await expect(page.locator(".session-library-row")).toHaveCount(journey.countBeforeReconnect);
  await expect(page.locator(`.session-library-row[data-session-id="${journey.activeSessionId}"] .session-library-card-active`)).toHaveText("Active");
  await expect(page.locator(`.session-library-row[data-session-id="${journey.sourceSessionId}"] .session-library-card-active`)).toHaveCount(0);
  expect(mock.unmocked).toEqual([]);
});

test("in-app navigation cancels a held exact return before selection can publish", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one desktop journey proves pushState navigation cancellation");
  test.setTimeout(90_000);
  const mock = await mockOpenAi(page);
  const journey = await requestReturnToSourceConversation(page);
  const connection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  const runtimeLine = page.locator(".runtime-line__text");
  const runtimeBeforeReconnect = await runtimeLine.innerText();
  const responseHeld = mock.holdNextResponse();
  await connection.getByRole("button", { name: "Continue requested conversation" }).click();
  await responseHeld;
  await expect(page.getByText("Connection change in progress", { exact: true })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#chat/${journey.activeSessionId}$`, "u"));
  await mock.releaseHeldResponse();
  await expect(page).toHaveURL(new RegExp(`#chat/${journey.activeSessionId}$`, "u"));
  await expect(runtimeLine).toHaveText(runtimeBeforeReconnect);

  await page.evaluate(() => { window.location.hash = "#sessions"; });
  await expect(page.getByRole("heading", { name: "All conversations", exact: true })).toBeVisible();
  await expect(page.locator(".session-library-row")).toHaveCount(journey.countBeforeReconnect);
  await expect(page.locator(`.session-library-row[data-session-id="${journey.activeSessionId}"] .session-library-card-active`)).toHaveText("Active");
  await expect(page.locator(`.session-library-row[data-session-id="${journey.sourceSessionId}"] .session-library-card-active`)).toHaveCount(0);
  expect(mock.unmocked).toEqual([]);
});

test("an exact return protects its inactive pinned connection until the request is abandoned", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one desktop journey proves inactive-pin disconnect protection");
  test.setTimeout(90_000);
  const mock = await mockOpenAi(page);
  await mockAnthropic(page);
  await connectOpenAi(page);
  const sourceSessionId = page.url().match(/#chat\/([^/?#]+)$/u)?.[1];
  expect(sourceSessionId).toBeTruthy();

  // Source A remains pinned to OpenAI/X while current B moves to an entirely
  // different connection. The OpenAI card therefore has no `activeModel`; the
  // return intent itself, not active-conversation styling, must protect it.
  await connectAndActivateAnthropic(page);
  const currentSessionId = page.url().match(/#chat\/([^/?#]+)$/u)?.[1];
  expect(currentSessionId).toBeTruthy();
  expect(currentSessionId).not.toBe(sourceSessionId);

  await page.evaluate(() => { window.location.hash = "#sessions"; });
  await expect(page.getByRole("heading", { name: "All conversations", exact: true })).toBeVisible();
  await page.locator(`.session-library-row[data-session-id="${sourceSessionId!}"] button.session-library-card`).click();
  const reconnect = page.locator("a.session-library-reconnect__primary");
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(page).toHaveURL(/#connection\?lane=codex/u);

  const sourceConnection = page.locator("article.provider-connection").filter({
    has: page.getByRole("heading", { name: "OpenAI", exact: true }),
  });
  const currentConnection = page.locator("article.provider-connection.active").filter({
    has: page.getByRole("heading", { name: "Anthropic", exact: true }),
  });
  await expect(currentConnection).toBeVisible();
  const protectedDisconnect = sourceConnection.getByRole("button", { name: "Connection held for requested return" });
  await expect(protectedDisconnect).toBeDisabled();
  const protection = sourceConnection.getByText("This exact connection is held for the requested conversation.", { exact: false });
  await expect(protection).toBeVisible();
  expect(await protectedDisconnect.getAttribute("aria-describedby")).toBe(await protection.getAttribute("id"));

  const abandon = page.getByRole("button", { name: "Abandon return request", exact: true });
  await abandon.click();
  await expect(page).toHaveURL(/#connection$/u);
  const disconnect = sourceConnection.getByRole("button", { name: "Disconnect" });
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  await expect(sourceConnection).toHaveCount(0);
  await expect(currentConnection).toBeVisible();
  expect(mock.unmocked).toEqual([]);
});
