/**
 * One absolute timestamp, and one sentence for a clock that will not parse.
 *
 * The same instant was drawn five ways as a person walked this product:
 * "Jul 30, 1:26 AM PDT" on Account's ledger, "Jul 30" on the chart axis three
 * rows above it — a different calendar day, because the axis formatted the same
 * bucket in UTC while the row formatted it locally — and "7/30/2026, 1:26:05 AM"
 * on Connection's catalog chip, the only numeric-slash date in the build, from a
 * bare `toLocaleString()` with no options at all. An unreadable timestamp had
 * eight answers across the product ("Unavailable", "unknown", "Unknown bucket",
 * "Unknown time", "an unreadable time", "time unavailable", "Time unavailable",
 * or the raw string), so a person auditing a receipt against a usage row could
 * not tell the two readings came from the same tool.
 *
 * This is a zero-import leaf on purpose. `deferred-capabilities.ts` packs
 * Account, Connection, Proof, Index and Sources into one chunk, so those routes
 * share this for free; a route in another chunk can still adopt it without
 * dragging a route boundary behind it, which is the constraint
 * capabilities-view.tsx documents about cross-route formatter imports.
 */

/**
 * The one thing Airship says when it cannot read a clock.
 *
 * Verbatim from `trust-language.ts`'s `relativeEvidenceAge`, which is the other
 * half of this vocabulary: the absolute reading and the relative age must fail
 * in the same words or the fallback becomes a fingerprint of which screen you
 * happen to be on.
 */
export const INSTANT_UNAVAILABLE = "Time unavailable";

/**
 * Two reads of one instant, one implementation.
 *
 * `minute` is an observation — when something was read, which is the claim
 * every "Observed …" and "Catalog read …" line is making. `day` is a calendar
 * label for a chart axis tick or a queried range, where a time neither fits in
 * the tick nor is part of the claim. This is the split `formatUsd` already
 * makes between a wallet and a ledger; it is a parameter rather than a second
 * function so the parse rule and the failure sentence cannot drift apart.
 */
export type InstantPrecision = "day" | "minute";

/**
 * `timeZone` names the zone a *calendar* value belongs to, and is left unset
 * for instants.
 *
 * Account's usage header labels the UTC range Chutes was actually queried for
 * (`start_date`/`end_date`, built from `Date.UTC(...)`), so rendering it in the
 * viewer's zone printed "Jun 30 → Jul 30" for a range the request spelled
 * "Jul 1 → Jul 30" anywhere west of UTC. Observed instants take no zone: they
 * belong in the reader's.
 */
export function formatInstant(value: string, precision: InstantPrecision, timeZone?: string): string {
  const parsed = parseInstant(value);
  if (!parsed) return INSTANT_UNAVAILABLE;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(precision === "minute" ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const : {}),
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(parsed);
}

/**
 * One parse rule for every surface that reads a Chutes timestamp.
 *
 * Chutes returns naive UTC (`2026-07-30T01:26:05`, no zone), and a bare
 * `new Date(value)` reads exactly that shape as *local* time — which is why the
 * Connection catalog chip moved every reading by the viewer's offset while
 * Account, which appended the `Z`, did not. Date-only values get an explicit
 * `T00:00:00Z` rather than a bare `Z` suffix, because `Date.parse("2026-07-01Z")`
 * is an implementation-defined fallback: it happens to work in V8 and is not
 * something the product may depend on.
 */
export function parseInstant(value: string): Date | undefined {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d\d-\d\d$/u.test(trimmed)
    ? `${trimmed}T00:00:00Z`
    : /(?:Z|[+-]\d\d:?\d\d)$/u.test(trimmed)
      ? trimmed
      : `${trimmed}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}
