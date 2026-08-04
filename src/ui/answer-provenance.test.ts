import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/*
 * An answer has to say which model produced it.
 *
 * The receipt carried `model` all along and exactly one surface rendered it —
 * the Proof inspector, one navigation away. On the transcript every answer said
 * only "Airship", so a reader comparing two turns could not tell that a
 * different model wrote them.
 *
 * These read the source rather than rendering, because the state that shows the
 * chip needs a real receipt and the demo transport mints none. Rendered
 * behaviour is therefore pinned by structure here and confirmed on a
 * Chutes-connected session.
 */

const APP = new URL("./app.tsx", import.meta.url);
const CHAT_CSS = new URL("./chat.css", import.meta.url);

async function source(url: URL): Promise<string> {
  return await readFile(url, "utf8");
}

/** The body of one CSS rule, located by selector without parsing the sheet. */
function cssRule(sourceText: string, selector: string): string {
  const start = sourceText.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = sourceText.indexOf("{", start) + 1;
  return sourceText.slice(bodyStart, sourceText.indexOf("}", bodyStart));
}

describe("the answer names its model", () => {
  it("renders the model from the receipt", async () => {
    expect(await source(APP)).toContain('<span class="message-model"');
  });

  it("reads the receipt and never the currently active binding", async () => {
    const app = await source(APP);
    const start = app.indexOf('<span class="message-model"');
    const chip = app.slice(app.lastIndexOf("{", start) - 200, app.indexOf("</span>", start));

    expect(chip).toContain("message.receipt.model");
    /*
     * The active binding is whatever is pinned now. Rendering it here would
     * relabel every historical answer the moment someone switched models, which
     * is worse than saying nothing: it would be confidently wrong about the past.
     */
    expect(chip).not.toContain("activeInferenceBinding");
    expect(chip).not.toContain("selectedModel");
  });

  it("shows nothing rather than a placeholder when the receipt carries no model", async () => {
    const app = await source(APP);
    const start = app.indexOf('<span class="message-model"');
    const guarded = app.slice(start - 400, start);

    expect(guarded, "the chip is conditional on receipt.model").toContain("message.receipt.model ?");
    expect(app.slice(start - 400, start + 400)).not.toMatch(/unknown model/iu);
  });

  it("sits in the receipt-gated chip row, not beside the role word", async () => {
    const app = await source(APP);
    const chips = app.indexOf('<div class="message-evidence-chips">');
    const model = app.indexOf('<span class="message-model"');
    const label = app.indexOf('<div class="message-label">');

    expect(chips).toBeGreaterThanOrEqual(0);
    expect(model).toBeGreaterThan(chips);
    /*
     * `.message-label` already overflows its column by 30px at 320px from
     * `.message-capability-tier`. Adding a chip there would be loading weight
     * onto something already broken; this row is receipt-gated, which is exactly
     * the condition the model id needs anyway.
     */
    expect(model, "the chip must not live in .message-label").toBeGreaterThan(label);
  });
});

describe("the model chip cannot hold a phone open", () => {
  it("can shrink and can break a long unbroken model id", async () => {
    const rule = cssRule(await source(CHAT_CSS), ".message-model");

    // `Qwen/Qwen3.5-397B-A17B-TEE` has no break opportunity. Without both of
    // these the chip becomes this row's min-content floor and pushes the receipt
    // chip beside it off the screen — the same mechanism that held the Memory
    // route open at 320px.
    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("overflow-wrap: anywhere");
    expect(rule).toContain("max-width: 100%");
  });
});
