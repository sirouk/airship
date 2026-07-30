import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatCompactCount, formatCount, formatUsd } from "./number-format";

describe("one number grammar", () => {
  it("groups a count the way the reader's locale groups it", () => {
    // Not `en-US`, which is what Account pinned: a reader whose own numbers are
    // `12.345` was shown `12,345` there and `12.345` on Index and All
    // conversations, which both take the runtime default.
    expect(formatCount(12_345)).toBe(new Intl.NumberFormat().format(12_345));
    expect(formatCount(24)).toBe("24");
    // A count is never rounded: a figure a reader is asked to reconcile with
    // the table beside it has to be the figure in the table.
    expect(formatCount(1_234.6)).toBe(formatCount(1_235));
  });

  it("keeps the exact figure until it stops fitting", () => {
    expect(formatCompactCount(9_999)).toBe(formatCount(9_999));
    expect(formatCompactCount(10_000)).toBe("10K");
    expect(formatCompactCount(1_250_000)).toBe("1.3M");
  });

  it("reads a wallet and a ledger as two different figures", () => {
    // One formatter at four digits printed the *balance* as `$46.2054`. The
    // exact figure is not lost: the balance metric prints it in its caption,
    // which is the `ledger` read.
    expect(formatUsd(46.205_4, "headline")).toBe("$46.21");
    expect(formatUsd(46.205_4, "ledger")).toBe("$46.2054");
    expect(formatUsd(0.08, "ledger")).toBe("$0.0800");
  });

  it("is a leaf, so a route in another chunk can adopt it without dragging one", () => {
    // The same constraint `instant-format.ts` documents about itself: a
    // formatter with imports merges the chunks the release gate keeps apart.
    const source = readFileSync(new URL("./number-format.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/mu);
  });

  it("leaves Account with no locale decision of its own", () => {
    /*
     * Three grammars on one route: `Intl.NumberFormat("en-US", …)` for money,
     * a second `Intl.NumberFormat("en-US", …)` for counts, and raw
     * interpolation in the usage chart's bar label and the bounded-list
     * sentence — so `12345 requests` sat above a grouped `12,345` in the table.
     */
    const source = readFileSync(new URL("./billing-view.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("Intl.NumberFormat");
    expect(source).not.toContain("en-US");
    expect(source).toContain('from "./number-format"');
    expect(source).toContain("${formatCount(entry.requests)} requests");
  });
});
