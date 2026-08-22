import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES } from "./session-audit";
import { sessionAuditRefusesResume } from "./session-audit-admission";
import { PRIME_EVENT_TYPES } from "../prime/runtime/prime-events";

/**
 * `KNOWN_EVENT_TYPES` once listed only the Airship turn protocol. When Prime
 * became the default engine, its first runtime-selection record was unknown to
 * the audit and made each new conversation incomplete after its first turn.
 *
 * The event set is a literal in `session-audit.ts` because core may not import
 * `src/prime` back without closing a cycle. This file holds the current write
 * vocabulary and the audit list in agreement. Historical marker compatibility
 * is called out separately so it cannot re-enter the write vocabulary.
 */
describe("the audit knows the prime engine's vocabulary", () => {
  it("names every event type the prime runtime can journal", () => {
    const missing = Object.values(PRIME_EVENT_TYPES).filter((type) => !KNOWN_EVENT_TYPES.has(type));
    expect(missing, `prime event types the audit would report as unknown: ${missing.join(", ")}`).toEqual([]);
  });

  it("names the current runtime-selection marker", () => {
    expect(PRIME_EVENT_TYPES.sessionRuntimeSelected).toBe("prime.session.runtime.selected");
    expect(KNOWN_EVENT_TYPES.has(PRIME_EVENT_TYPES.sessionRuntimeSelected)).toBe(true);
  });

  it("keeps the historical marker read-only", () => {
    const historicalMarker = "prime.session.runtime.seal";
    expect(KNOWN_EVENT_TYPES.has(historicalMarker)).toBe(true);
    expect(Object.values(PRIME_EVENT_TYPES)).not.toContain(historicalMarker);
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
 *
 * The line moved once more: what refuses is an `error` finding, which now
 * means only "this record cannot be appended to". `status: "invalid"` is still
 * the wider claim and every path that *copies* a journal still reads it, but
 * reading a conversation is not copying it, and a manifest complaint is not a
 * reason to take a finished thread away from the person who wrote it.
 */
describe("what an audit is allowed to refuse a resume over", () => {
  it("refuses only a journal that cannot be appended to", () => {
    expect(sessionAuditRefusesResume({ appendable: false })).toBe(true);
  });

  it("admits a verified history", () => {
    expect(sessionAuditRefusesResume({ appendable: true })).toBe(false);
  });

  it("admits an incomplete history, which is what an unfinished turn looks like", () => {
    // `TURN_INCOMPLETE` is raised for a turn with no terminal — every cancelled
    // turn and every turn still in flight. Quarantining on it locked people out
    // of the conversation they had just been talking in.
    expect(sessionAuditRefusesResume({ appendable: true })).toBe(false);
  });
});
