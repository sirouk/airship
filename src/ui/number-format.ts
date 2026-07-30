/**
 * One locale decision for every number Airship prints.
 *
 * The same count was grouped three different ways as a person walked one
 * route. Account pinned `en-US` twice — once for money, once for counts — so
 * `12345` read `12,345` there and `12.345` on Index and All conversations,
 * which both take the reader's own locale (`Intl.NumberFormat()` and a bare
 * `toLocaleString()`). Account's third way was no formatter at all: the usage
 * chart's bar label and the bounded-list sentence interpolated raw, printing
 * `12345 requests` beside a grouped `12,345` in the table under it.
 *
 * The decision is the reader's locale, because that is what every surface
 * outside this one already does and because a pinned `en-US` renders a German
 * reader's own numbers wrong. Currency is USD by *value* — Chutes bills in
 * dollars — and by presentation it is the reader's: `Intl` keeps the amount
 * identified as USD in every locale.
 *
 * This is a zero-import leaf, for the reason `instant-format.ts` states about
 * itself: `deferred-capabilities.ts` packs Account, Connection, Proof, Index
 * and Sources into one chunk, and a route in another chunk must be able to
 * adopt this without dragging a route boundary behind it.
 */

/**
 * Every formatter, constructed once.
 *
 * `Intl.NumberFormat` construction is the expensive half of formatting, and
 * the usage chart calls this 64 times per render for its bar labels.
 */
const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const held = FORMATTERS.get(key);
  if (held) return held;
  // `undefined` is the locale decision, not an oversight: it resolves to the
  // reader's, which is the whole point of this module.
  const built = new Intl.NumberFormat(undefined, options);
  FORMATTERS.set(key, built);
  return built;
}

/**
 * A count, grouped the way the reader groups numbers.
 *
 * For anything a person may be asked to reconcile against another figure on
 * the same screen — "10 of 24 buckets", "12,345 requests". Never rounded: a
 * count that has been made approximate cannot be reconciled with anything.
 */
export function formatCount(value: number): string {
  return formatter("count", { maximumFractionDigits: 0 }).format(value);
}

/**
 * A count that has to fit in a metric tile.
 *
 * Compact only above 10,000, where the exact digits stop being readable at a
 * glance and the tile stops fitting them; below that the grouped figure is
 * both, so there is no reason to lose it.
 */
export function formatCompactCount(value: number): string {
  return value >= 10_000
    ? formatter("compact", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : formatCount(value);
}

/**
 * Two money formats, because a wallet and a ledger are two different reads.
 *
 * One formatter with `maximumFractionDigits: 4` rendered the balance as
 * `$46.2054` — a token price, not a balance — and produced `$0.2871`, `$0.08`,
 * `$0.0823` in adjacent ledger rows, so nothing aligned on the decimal point.
 * `headline` rounds for reading; `ledger` pads to a fixed width for scanning.
 * The exact figure is never lost: the balance metric prints it in its caption.
 */
export function formatUsd(value: number, mode: "headline" | "ledger"): string {
  return formatter(`usd:${mode}`, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: mode === "ledger" ? 4 : 2,
    maximumFractionDigits: mode === "ledger" ? 4 : 2,
  }).format(value);
}
