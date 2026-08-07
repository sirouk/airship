/**
 * Engine-status derivation tests: the read-side must answer with the gate's
 * own rule (`src/load-agent-runtime.ts` `sessionRuntimeKind`), so these cases
 * pin both the evidence classes and the exact sentences the session view
 * renders.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_SEAL_EVENT_TYPE,
  formatAgentRuntimeStatusLine,
  getAgentRuntimeStatus,
} from "./agent-runtimes";

const PINNED_AIRSHIP_LINE = "engine: airship-core (pinned by journal evidence — fork the session to switch)";
const PINNED_PRIME_LINE = "engine: prime (pinned by journal evidence — fork the session to switch)";
const DEFAULT_PRIME_LINE = "engine: prime (default)";

describe("getAgentRuntimeStatus", () => {
  it("leaves an empty journal unpinned, prime by default, with no fork question to answer", () => {
    const status = getAgentRuntimeStatus({ sessionId: "s-empty", events: [] });
    expect(status.pinnedEngine).toBeNull();
    expect(status.defaultEngine).toBe("prime");
    expect(status.evidenceType).toBe("empty");
    expect(status.canForkSwitch).toBe(false);
    expect(status.forkRemedy).toBeUndefined();
    expect(formatAgentRuntimeStatusLine(status)).toBe(DEFAULT_PRIME_LINE);
  });

  it("reads a journal holding only bootstrapping records as the same unclaimed land", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-created",
      events: [{ type: "session.created" }, { type: "session.renamed" }],
    });
    expect(status.pinnedEngine).toBeNull();
    expect(status.evidenceType).toBe("empty");
    expect(status.canForkSwitch).toBe(false);
    expect(formatAgentRuntimeStatusLine(status)).toBe(DEFAULT_PRIME_LINE);
  });

  it("pins prime on any prime.* record, before the first turn's seal exists", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-prime",
      events: [{ type: "session.created" }, { type: "prime.notice" }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.evidenceType).toBe("prime-events");
    expect(status.canForkSwitch).toBe(true);
    expect(status.forkRemedy).toBe("fork the session to use the airship-core engine.");
    expect(formatAgentRuntimeStatusLine(status)).toBe(PINNED_PRIME_LINE);
  });

  it("pins airship-core on turn-protocol records and names the fork remedy", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-airship",
      events: [{ type: "session.created" }, { type: "turn.requested" }, { type: "turn.completed" }],
    });
    expect(status.pinnedEngine).toBe("airship-core");
    expect(status.evidenceType).toBe("airship-history");
    expect(status.canForkSwitch).toBe(true);
    expect(status.forkRemedy).toBe("fork the session to use the prime engine.");
    expect(formatAgentRuntimeStatusLine(status)).toBe(PINNED_AIRSHIP_LINE);
  });

  it("pins airship-core on inference.* records the way the gate does", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-inference",
      events: [{ type: "inference.usage" }],
    });
    expect(status.pinnedEngine).toBe("airship-core");
    expect(status.evidenceType).toBe("airship-history");
  });

  it("pins prime with seal evidence when the first prime turn landed the seal", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-sealed",
      events: [{ type: "session.created" }, { type: AGENT_RUNTIME_SEAL_EVENT_TYPE }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.evidenceType).toBe("seal");
    expect(status.canForkSwitch).toBe(true);
    expect(formatAgentRuntimeStatusLine(status)).toBe(PINNED_PRIME_LINE);
  });

  it("names the seal the pin's evidence even beside later prime records", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-sealed-noticed",
      events: [
        { type: AGENT_RUNTIME_SEAL_EVENT_TYPE },
        { type: "prime.kernel.job.started" },
      ],
    });
    expect(status.evidenceType).toBe("seal");
  });

  it("reads prime first when a journal somehow carries both engines' evidence", () => {
    // The gate's own ordering — any `prime.*` record outranks airship
    // turn-protocol history — and the status reports it rather than restating it.
    const status = getAgentRuntimeStatus({
      sessionId: "s-mixed",
      events: [{ type: "turn.requested" }, { type: AGENT_RUNTIME_SEAL_EVENT_TYPE }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.evidenceType).toBe("seal");
  });

  it("pins the seal literal the writer emits, so read and write cannot drift silently", () => {
    expect(AGENT_RUNTIME_SEAL_EVENT_TYPE).toBe("prime.session.runtime.seal");
  });
});
