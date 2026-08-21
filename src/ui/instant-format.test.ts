import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatInstant, INSTANT_UNAVAILABLE, parseInstant } from "./instant-format";

describe("one absolute timestamp shape", () => {
  it("uses one bounded fallback for an unreadable clock", () => {
    /*
     * Eight sentences answered this one state across the product — "Unavailable",
     * "unknown", "Unknown bucket", "Unknown time", "an unreadable time",
     * "time unavailable", "Time unavailable", or the raw string — so which
     * words a person saw was a fingerprint of which screen they were on. The
     * both timestamp precisions have to fail in one voice.
     */
    expect(formatInstant("not a time", "minute")).toBe(INSTANT_UNAVAILABLE);
    expect(formatInstant("not a time", "day")).toBe(INSTANT_UNAVAILABLE);
  });

  it("reads a zoneless provider timestamp as UTC rather than as local time", () => {
    // `new Date("2026-07-30T01:26:05")` is *local* per spec, which is why the
    // A local-time parse would move this reading by the viewer's offset.
    expect(parseInstant("2026-07-30T01:26:05")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    expect(parseInstant("2026-07-30T01:26:05Z")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    expect(parseInstant("2026-07-30T01:26:05+00:00")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    // A bare "2026-07-01Z" is an implementation-defined parse; the explicit
    // midnight is what makes the range header the same date in every engine.
    expect(parseInstant("2026-07-01")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parseInstant("")).toBeUndefined();
  });

  it("gives a calendar value the zone it was queried in, and an instant the reader's", () => {
    // An explicit UTC calendar range must not shift to the prior local day.
    expect(formatInstant("2026-07-01T00:00:00", "day", "UTC")).toBe("Jul 1");
    expect(formatInstant("2026-07-01T00:00:00Z", "minute", "UTC")).toBe("Jul 1, 12:00 AM UTC");
  });

  it("carries one precision per read, and no third shape", () => {
    const day = formatInstant("2026-07-30T13:26:05Z", "day", "UTC");
    const minute = formatInstant("2026-07-30T13:26:05Z", "minute", "UTC");
    expect(day).toBe("Jul 30");
    expect(minute).toBe("Jul 30, 1:26 PM UTC");
    // The numeric-slash date the Connection chip used to print is the shape
    // this module exists to remove; neither precision may reintroduce it.
    expect(day).not.toMatch(/\d+\/\d+/u);
    expect(minute).not.toMatch(/\d+\/\d+/u);
  });
});

describe("timestamp formatter module boundary", () => {
  it("is a leaf, so a deferred route can adopt it without dragging another chunk", async () => {
    const source = await readFile(new URL("./instant-format.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/mu);
  });
});
