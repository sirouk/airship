import { expect, test, type Page } from "@playwright/test";

/*
 * The Type scale preference, measured on a real page.
 *
 * `type-floor.test.ts` and `density-contract.test.ts` hold the static half of
 * this — no px or rem size literal outside `tokens.css`, every declared size
 * naming a ramp token. Neither can see the *cascade*, and the cascade is where
 * this failed: 60 px literals and 45 rem literals across 19 sheets meant
 * `data-type-scale="x-large"` moved 39 of 48 elements on `#chat` and froze the
 * rest — the wordmark, the runtime status line, both disclosure chevrons, both
 * skip links and the largest heading in the product. Every relationship tuned
 * at 1x was therefore wrong at 1.25x, which is the guideline `tokens.css` cites
 * by number (WCAG 1.4.4).
 *
 * So this drives the real preference and compares computed sizes element by
 * element. It is deliberately not a screenshot: a frozen element is invisible
 * in a picture and obvious in a number.
 */

const SCALES = Object.freeze({ default: 1, large: 1.125, "x-large": 1.25 } as const);

type Sample = Readonly<{ path: string; size: number; text: string }>;

test.describe("the Type scale preference governs the whole product", () => {
  test("every text-bearing element on #chat grows with the preference", async ({ page }) => {
    await preferences(page, "default");
    await page.goto("/#chat");
    await page.waitForSelector(".chat-stage", { timeout: 30_000 });
    const before = await sampleText(page);
    expect(before.length, "there is text on #chat to measure").toBeGreaterThan(20);

    await setScale(page, "x-large");
    const after = await sampleText(page);

    const beforeByPath = new Map(before.map((sample) => [sample.path, sample]));
    const frozen: string[] = [];
    for (const sample of after) {
      const baseline = beforeByPath.get(sample.path);
      if (!baseline) continue;
      // 1.25x, less a rounding allowance: a 0.01px difference is a subpixel
      // artefact, a 0.00x difference is a literal nobody re-homed.
      if (sample.size < baseline.size * 1.2) {
        frozen.push(`${sample.path} ${baseline.size}px -> ${sample.size}px ${JSON.stringify(sample.text)}`);
      }
    }
    expect(frozen, `frozen at x-large:\n${frozen.join("\n")}`).toEqual([]);
  });

  test("the route title is one ramp step and moves with the preference", async ({ page }) => {
    await preferences(page, "default");
    // `#profiles` on purpose: it is one of the six routes that carried the
    // legacy slab, and it is rendered by the entry chunk's own `RouteBar`
    // rather than by `<RouteHeader>` — so this also proves the second renderer
    // spends the same recipe rather than growing a third one.
    await page.goto("/#profiles");
    await page.waitForSelector("main.main h1.route-title", { timeout: 30_000 });
    const sizes: Record<string, number> = {};
    for (const scale of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
      await setScale(page, scale);
      sizes[scale] = await page.evaluate(() => {
        const title = document.querySelector<HTMLElement>("main.main h1");
        return title ? Number.parseFloat(getComputedStyle(title).fontSize) : Number.NaN;
      });
    }
    // The legacy slab was `clamp(30px, 4vw, 47px)`: three identical numbers
    // here is exactly what that produced, and is what this test exists to
    // catch. The ratios are the ramp's, not a hard-coded pixel count, so a
    // density change does not make this test lie.
    expect(sizes["large"]! / sizes["default"]!).toBeCloseTo(SCALES.large, 2);
    expect(sizes["x-large"]! / sizes["default"]!).toBeCloseTo(SCALES["x-large"], 2);
  });

  test("a field never drops under the mobile zoom guard at any scale", async ({ page }) => {
    // Mobile Safari zooms the whole page when a focused field computes below
    // 16px, and a page that zooms on focus loses its own composer. `--fs-field`
    // is a floor rather than a fixed size, so this asserts both halves: never
    // below 16, and genuinely larger once the preference asks for more.
    await preferences(page, "default");
    await page.goto("/#chat");
    await page.waitForSelector(".composer textarea", { timeout: 30_000 });
    const measured: Record<string, number> = {};
    for (const scale of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
      await setScale(page, scale);
      // `max()` does not resolve through `getPropertyValue`, so the token is
      // read off a real element that spends it.
      measured[scale] = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.fontSize = "var(--fs-field)";
        document.body.append(probe);
        const size = Number.parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return size;
      });
    }
    for (const [scale, size] of Object.entries(measured)) {
      expect(size, `${scale} clears the zoom guard`).toBeGreaterThanOrEqual(16);
    }
    expect(measured["x-large"]!, "the preference can still raise it").toBeGreaterThan(measured["default"]!);
  });
});

async function preferences(page: Page, typeScale: keyof typeof SCALES): Promise<void> {
  await page.addInitScript((scale) => localStorage.setItem("airship.display-preferences.v1", JSON.stringify({
    mode: "dark", typeScale: scale, density: "comfortable", corners: "subtle",
    bodyFont: "system-sans", vaultBackend: "page", approvalMode: "ask-first",
  })), typeScale);
}

async function setScale(page: Page, scale: keyof typeof SCALES): Promise<void> {
  await page.evaluate((value) => { document.documentElement.dataset.typeScale = value; }, scale);
  // One frame for style recalculation; `getComputedStyle` is synchronous but
  // the attribute write is not yet in a resolved style when it returns.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/**
 * Every visible element that directly owns rendered text, keyed by a stable
 * structural path so the same element can be found again after a reflow.
 */
async function sampleText(page: Page): Promise<readonly Sample[]> {
  return page.evaluate(() => {
    const samples: { path: string; size: number; text: string }[] = [];
    const stage = document.querySelector("main.main");
    if (!stage) return samples;
    const walk = (node: Element, path: string): void => {
      const ownsText = [...node.childNodes].some((child) =>
        child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim().length > 0);
      const box = node.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0;
      if (ownsText && visible) {
        samples.push({
          path,
          size: Number.parseFloat(getComputedStyle(node).fontSize),
          text: (node.textContent ?? "").trim().slice(0, 40),
        });
      }
      [...node.children].forEach((child, index) => walk(child, `${path}>${child.tagName.toLowerCase()}:${index}`));
    };
    walk(stage, "main");
    return samples;
  });
}
