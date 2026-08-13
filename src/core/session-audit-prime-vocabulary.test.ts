import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES } from "./session-audit";
import { sessionAuditRefusesResume } from "./session-audit-admission";
import { PRIME_EVENT_TYPES } from "../prime/runtime/prime-events";

/**
 * How a conversation became unopenable by its own first turn.
 *
 * `KNOWN_EVENT_TYPES` listed only the airship turn protocol. Prime then became
 * the default engine, and the first prime turn of every session journals
 * `prime.session.runtime.seal` — so the audit met a type it did not name,
 * raised `EVENT_TYPE_UNKNOWN` (category `completeness`), the report came back
 * `incomplete`, and five separate resume paths demanded `verified`. Every new
 * conversation was quarantined from resume, while the detail panel beside the
 * button said "Ready to resume · Fork not required" because
 * `decideSessionResume` never consults the audit.
 *
 * The event set is a literal in `session-audit.ts` because core may not import
 * `src/prime` back without closing a cycle. This file is what holds the two in
 * agreement instead, so the next prime record cannot be added without the
 * audit learning it.
 */
describe("the audit knows the prime engine's vocabulary", () => {
  it("names every event type the prime runtime can journal", () => {
    const missing = Object.values(PRIME_EVENT_TYPES).filter((type) => !KNOWN_EVENT_TYPES.has(type));
    expect(missing, `prime event types the audit would report as unknown: ${missing.join(", ")}`).toEqual([]);
  });

  it("names the seal the first prime turn always writes", () => {
    // Called out separately because it is the one prime record *every* prime
    // session carries, so it alone decided whether the default engine shipped
    // resumable conversations.
    expect(PRIME_EVENT_TYPES.sessionRuntimeSeal).toBe("prime.session.runtime.seal");
    expect(KNOWN_EVENT_TYPES.has("prime.session.runtime.seal")).toBe(true);
  });

  it("carries no airship turn-protocol type into the prime namespace", () => {
    // The reverse drift: a prime type that shadows a turn event would be
    // audited under turn-protocol rules it does not obey.
    for (const type of Object.values(PRIME_EVENT_TYPES)) {
      expect(type.startsWith("prime."), `${type} is not in the prime namespace`).toBe(true);
    }
  });
});

/**
 * Integrity refuses; incompleteness observes. The distinction the five resume
 * paths were missing.
 */
describe("what an audit is allowed to refuse a resume over", () => {
  it("refuses only a journal that contradicts itself", () => {
    expect(sessionAuditRefusesResume({ status: "invalid" })).toBe(true);
  });

  it("admits a verified history", () => {
    expect(sessionAuditRefusesResume({ status: "verified" })).toBe(false);
  });

  it("admits an incomplete history, which is what an unfinished turn looks like", () => {
    // `TURN_INCOMPLETE` is raised for a turn with no terminal — every cancelled
    // turn and every turn still in flight. Quarantining on it locked people out
    // of the conversation they had just been talking in.
    expect(sessionAuditRefusesResume({ status: "incomplete" })).toBe(false);
  });
});
