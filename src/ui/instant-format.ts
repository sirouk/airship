/**
 * One timestamp format for local run and session details.
 *
 * This stays a zero-import leaf so deferred routes can share it without
 * crossing route chunk boundaries.
 */

/** The one thing Airship says when it cannot read a clock. */
export const INSTANT_UNAVAILABLE = "Time unavailable";

/**
 * Two reads of one instant, one implementation.
 *
 * `minute` is an observation — when something was read, which is the claim
 * every "Observed …" and "Catalog read …" line is making. `day` is a calendar
 * label for a chart axis tick or a queried range, where a time neither fits in
 * the tick nor is part of the observation. It is a parameter rather than a
 * second function so the parse rule and failure sentence cannot drift apart.
 */
export type InstantPrecision = "day" | "minute";

/**
 * `timeZone` names the zone a *calendar* value belongs to, and is left unset
 * for instants.
 *
 * Calendar values can name an explicit zone. Observed instants use the reader's
 * zone so local session history stays legible.
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
 * One parse rule for provider timestamps. Some provider catalogs return naive
 * UTC (`2026-07-30T01:26:05`, no zone), while a bare `new Date(value)` reads
 * that shape as local time. Date-only values get an explicit
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
