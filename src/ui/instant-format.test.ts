import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatInstant, INSTANT_UNAVAILABLE, parseInstant } from "./instant-format";
import { relativeEvidenceAge } from "./trust-language";

describe("one absolute timestamp shape", () => {
  it("answers an unreadable clock with the same sentence the relative age uses", () => {
    /*
     * Eight sentences answered this one state across the product — "Unavailable",
     * "unknown", "Unknown bucket", "Unknown time", "an unreadable time",
     * "time unavailable", "Time unavailable", or the raw string — so which
     * words a person saw was a fingerprint of which screen they were on. The
     * relative age is asserted here as the *reference*, not as a copy of the
     * literal: the absolute and relative readings are two halves of one
     * vocabulary and have to fail in one voice.
     */
    expect(formatInstant("not a time", "minute")).toBe(INSTANT_UNAVAILABLE);
    expect(formatInstant("not a time", "day")).toBe(INSTANT_UNAVAILABLE);
    expect(relativeEvidenceAge("not a time")).toBe(INSTANT_UNAVAILABLE);
  });

  it("reads a zoneless Chutes timestamp as UTC rather than as local time", () => {
    // `new Date("2026-07-30T01:26:05")` is *local* per spec, which is why the
    // Connection catalog chip moved every reading by the viewer's offset while
    // Account, which appended the Z, did not.
    expect(parseInstant("2026-07-30T01:26:05")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    expect(parseInstant("2026-07-30T01:26:05Z")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    expect(parseInstant("2026-07-30T01:26:05+00:00")?.toISOString()).toBe("2026-07-30T01:26:05.000Z");
    // A bare "2026-07-01Z" is an implementation-defined parse; the explicit
    // midnight is what makes the range header the same date in every engine.
    expect(parseInstant("2026-07-01")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parseInstant("")).toBeUndefined();
  });

  it("gives a calendar value the zone it was queried in, and an instant the reader's", () => {
    // Account's usage header labels the UTC range Chutes was asked for, so a
    // reader west of UTC was shown "Jun 30 → Jul 30" for a request that said
    // "Jul 1". The instant beside it carries a zone name so the two readings
    // can be told apart at a glance.
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

describe("the routes that adopted it keep no formatter of their own", () => {
  const ADOPTED = Object.freeze(["billing-view.tsx", "access-view.tsx"] as const);

  it("leaves no bare toLocaleString and no second fallback sentence behind", async () => {
    const offenders: string[] = [];
    for (const name of ADOPTED) {
      const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
      // `toLocaleString()` with no options is the bare locale default: it is
      // what produced "7/30/2026, 1:26:05 AM", the only numeric-slash date in
      // the build, on a route whose neighbours all printed "Jul 30".
      if (/toLocale(?:Date|Time)?String\(\s*\)/u.test(source)) offenders.push(`${name}: bare locale default`);
      for (const dead of ["Unknown bucket", "time unavailable", 'return "unknown"']) {
        if (source.includes(dead)) offenders.push(`${name}: ${dead}`);
      }
      expect(source, name).toContain('from "./instant-format"');
    }
    expect(offenders).toEqual([]);
  });

  it("is a leaf, so a route in another chunk can adopt it without dragging one", async () => {
    /*
     * capabilities-view.tsx documents why it kept its own copy: importing a
     * formatter across a route boundary merges two chunks the release gate
     * keeps apart. That is only true of a module with imports. This one has
     * none, and it must stay that way for the remaining routes to adopt it.
     */
    const source = await readFile(new URL("./instant-format.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/mu);
  });
});
