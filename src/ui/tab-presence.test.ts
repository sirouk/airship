import { describe, expect, it } from "vitest";
import {
  PRESENCE_EXPIRY_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_SWEEP_MS,
  TabPresenceRoster,
} from "./tab-presence";

/*
 * The note used to have no transition out of "occupied": one `hello`, one
 * `present`, `setPeer(true)`, and the warning stayed on the shell for the rest
 * of the session no matter what happened to the tab it was warning about.
 * Every assertion here is a way back to false.
 */
describe("tab presence roster", () => {
  const now = 1_000_000;

  it("says nothing about a tab that is alone", () => {
    const roster = new TabPresenceRoster("self");
    expect(roster.occupied(now)).toBe(false);
  });

  it("ignores its own broadcast", () => {
    const roster = new TabPresenceRoster("self");
    expect(roster.receive({ type: "hello", id: "self" }, now)).toBeUndefined();
    expect(roster.occupied(now)).toBe(false);
  });

  it("answers an arrival exactly once, so two tabs cannot ping-pong", () => {
    const roster = new TabPresenceRoster("self");
    expect(roster.receive({ type: "hello", id: "peer" }, now)).toEqual({ type: "present", id: "self" });
    // A `present` is already the answer to a `hello`; answering it again is the
    // loop that made a heartbeat unaffordable in the first place.
    expect(roster.receive({ type: "present", id: "peer" }, now)).toBeUndefined();
    expect(roster.occupied(now)).toBe(true);
  });

  it("takes the warning down the moment a peer says goodbye", () => {
    const roster = new TabPresenceRoster("self");
    roster.receive({ type: "hello", id: "peer" }, now);
    expect(roster.occupied(now)).toBe(true);
    roster.receive({ type: "bye", id: "peer" }, now);
    expect(roster.occupied(now)).toBe(false);
  });

  it("counts the tabs that are left rather than latching on the first one", () => {
    const roster = new TabPresenceRoster("self");
    roster.receive({ type: "hello", id: "second" }, now);
    roster.receive({ type: "hello", id: "third" }, now);
    expect(roster.count(now)).toBe(2);
    roster.receive({ type: "bye", id: "third" }, now);
    expect(roster.occupied(now)).toBe(true);
    roster.receive({ type: "bye", id: "second" }, now);
    expect(roster.occupied(now)).toBe(false);
  });

  it("expires a peer that crashed without a goodbye, and asks again when it does", () => {
    const roster = new TabPresenceRoster("self");
    roster.receive({ type: "hello", id: "peer" }, now);
    expect(roster.sweep(now + PRESENCE_EXPIRY_MS - 1)).toBe(false);
    expect(roster.occupied(now + PRESENCE_EXPIRY_MS - 1)).toBe(true);
    expect(roster.sweep(now + PRESENCE_EXPIRY_MS)).toBe(true);
    expect(roster.occupied(now + PRESENCE_EXPIRY_MS)).toBe(false);
    // Nothing left to drop, so nothing left to re-probe.
    expect(roster.sweep(now + PRESENCE_EXPIRY_MS)).toBe(false);
  });

  it("keeps a heartbeating peer alive indefinitely", () => {
    const roster = new TabPresenceRoster("self");
    let clock = now;
    roster.receive({ type: "hello", id: "peer" }, clock);
    for (let beat = 0; beat < 10; beat += 1) {
      clock += PRESENCE_HEARTBEAT_MS;
      expect(roster.sweep(clock)).toBe(false);
      roster.receive({ type: "present", id: "peer" }, clock);
      expect(roster.occupied(clock)).toBe(true);
    }
  });

  /*
   * The other tab is the backgrounded one, and Chrome throttles timers in
   * hidden tabs to roughly one run a minute. An expiry that does not clear
   * that budget declares a live tab dead, which is the same defect pointed the
   * other way — so the relationship is asserted rather than the numbers.
   */
  it("tolerates a background-throttled heartbeat", () => {
    expect(PRESENCE_EXPIRY_MS).toBeGreaterThanOrEqual(60_000 + PRESENCE_HEARTBEAT_MS);
    expect(PRESENCE_EXPIRY_MS).toBeGreaterThanOrEqual(PRESENCE_HEARTBEAT_MS * 3);
    expect(PRESENCE_SWEEP_MS).toBeLessThanOrEqual(PRESENCE_HEARTBEAT_MS);
  });
});
