import { expect, test, type Page } from "@playwright/test";

const THROWAWAY_KEY = "sk-airship-playwright-provider-secret";

test.describe("inference provider fabric browser contract", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "One Chromium page-memory authority is sufficient for this browser contract.",
    );
    await page.goto("/e2e/fixtures/provider-fabric-harness.html");
    await expect(page).toHaveTitle("Airship provider fabric acceptance harness");
  });

  test("consumes a compatibility key without leaving it in the DOM or browser persistence", async ({ page }) => {
    await mountProviderPanel(page, { mode: "empty" });

    const openAi = page.locator("#provider-fabric-acceptance details.provider-entry").filter({
      has: page.locator("strong").filter({ hasText: /^OpenAI$/u }),
    });
    await openAi.locator("summary").click();
    const keyInput = openAi.getByLabel("OpenAI API key");
    await keyInput.fill(THROWAWAY_KEY);
    await openAi.getByRole("checkbox").check();
    await openAi.getByRole("button", { name: "Probe and connect" }).click();

    await expect(page.locator("#provider-fabric-acceptance .provider-fabric__count")).toHaveText("1 connection");
    await expect(keyInput).toHaveValue("");
    await expect(page.locator("#provider-fabric-acceptance")).not.toContainText(THROWAWAY_KEY);

    const audit = await page.evaluate((secret) => {
      const persisted = {
        localStorage: Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
        sessionStorage: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
      };
      const host = document.querySelector("#provider-fabric-acceptance");
      const inputValues = [...(host?.querySelectorAll("input") ?? [])]
        .map((input) => (input as HTMLInputElement).value);
      const snapshot = (
        globalThis as typeof globalThis & {
          __airshipProviderAcceptance?: { snapshot?: unknown };
        }
      ).__airshipProviderAcceptance?.snapshot;
      return {
        secretInMarkup: host?.innerHTML.includes(secret) ?? false,
        secretInInputs: inputValues.includes(secret),
        secretInPersistence: JSON.stringify(persisted).includes(secret),
        secretInSnapshot: JSON.stringify(snapshot).includes(secret),
        snapshot,
      };
    }, THROWAWAY_KEY);

    expect(audit).toMatchObject({
      secretInMarkup: false,
      secretInInputs: false,
      secretInPersistence: false,
      secretInSnapshot: false,
      snapshot: {
        version: 1,
        connections: [{
          providerId: "openai",
          authKind: "api-key",
          health: "ready",
          canInvoke: true,
        }],
      },
    });
  });

  test("sends an exact connection/model pair only after an explicit user choice", async ({ page }) => {
    await mountProviderPanel(page, { mode: "ready-models" });

    const host = page.locator("#provider-fabric-acceptance");
    const openAiCard = host.locator("article.provider-connection").filter({
      has: page.locator("strong").filter({ hasText: /^OpenAI$/u }),
    });
    const openAiModel = openAiCard.getByRole("button", { name: "OpenAI discovered model" });
    /*
     * Before a choice, the picker must not name a model. `selectedModelId` is
     * `stagedModelId ?? activeModel?.id ?? ""` — nothing is staged here — and
     * this test's own title is the reason that matters: a pair is sent only
     * after an explicit choice. The trigger used to read "GPT Alpha" anyway,
     * because `MenuSelect` clamped a no-match to index 0 and rendered the first
     * option as chosen. That put a model's name under the reader's eyes beside
     * an activation button the same empty value keeps disabled, which is the
     * surface disagreeing with itself rather than a default.
     */
    await expect(openAiModel).toContainText("Choose");
    await expect(openAiModel).not.toContainText("GPT Alpha");
    await expect(openAiCard.getByRole("button", { name: "Use in new thread" })).toBeDisabled();
    await openAiModel.click();
    await page.getByRole("listbox", { name: "OpenAI discovered model" })
      .getByRole("option", { name: /GPT Beta/u })
      .click();
    await openAiCard.getByRole("button", { name: "Use in new thread" }).click();

    await expect.poll(() => page.evaluate(() => (
      globalThis as typeof globalThis & {
        __airshipProviderAcceptance?: { activations?: unknown[] };
      }
    ).__airshipProviderAcceptance?.activations ?? [])).toEqual([{
      connectionId: "openai-main",
      modelId: "gpt-beta",
    }]);

    // The neighbouring connection was never touched, so it still names no
    // model — and staging one on OpenAI did not stage one here.
    const anthropicModel = host.getByRole("button", { name: "Anthropic discovered model" });
    await expect(anthropicModel).toContainText("Choose");
    await expect.poll(() => page.evaluate(() => (
      globalThis as typeof globalThis & {
        __airshipProviderAcceptance?: { activations?: unknown[] };
      }
    ).__airshipProviderAcceptance?.activations ?? [])).toHaveLength(1);
  });
});

async function mountProviderPanel(
  page: Page,
  options: Readonly<{ mode: "empty" | "ready-models" }>,
): Promise<void> {
  await page.evaluate(async ({ mode }) => {
    const harness = await import("/e2e/fixtures/provider-fabric-harness.tsx");
    harness.mountProviderFabricAcceptance(mode);
  }, options);
}
