/**
 * Engine-status derivation tests. The read side uses the gate's own
 * `sessionRuntimeKind` rule, then reports the journal record class and the
 * exact sentence rendered by the session view.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_SELECTION_EVENT_TYPE,
  formatAgentRuntimeStatusLine,
  getAgentRuntimeStatus,
} from "./agent-runtimes";

const RECORDED_AIRSHIP_LINE = "engine: airship-core (recorded selection — fork the session to switch)";
const RECORDED_PRIME_LINE = "engine: prime (recorded selection — fork the session to switch)";
const DEFAULT_LINE = "engine: prime (default)";
const HISTORICAL_SELECTION_EVENT_TYPE = "prime.session.runtime.seal";

describe("getAgentRuntimeStatus", () => {
  it("leaves an empty journal unpinned at the gate's default", () => {
    const status = getAgentRuntimeStatus({ sessionId: "s-empty", events: [] });
    expect(status.pinnedEngine).toBeNull();
    expect(status.defaultEngine).toBe("prime");
    expect(status.recordType).toBe("empty");
    expect(status.canForkSwitch).toBe(false);
    expect(status.forkRemedy).toBeUndefined();
    expect(formatAgentRuntimeStatusLine(status)).toBe(DEFAULT_LINE);
  });

  it("reads bootstrapping records as the same unclaimed history", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-created",
      events: [{ type: "session.created" }, { type: "session.renamed" }],
    });
    expect(status.pinnedEngine).toBeNull();
    expect(status.recordType).toBe("empty");
    expect(status.canForkSwitch).toBe(false);
    expect(formatAgentRuntimeStatusLine(status)).toBe(DEFAULT_LINE);
  });

  it("pins Prime on any other prime.* record", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-prime",
      events: [{ type: "session.created" }, { type: "prime.notice" }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.recordType).toBe("prime-records");
    expect(status.canForkSwitch).toBe(true);
    expect(status.forkRemedy).toBe("fork the session to use the airship-core engine.");
    expect(formatAgentRuntimeStatusLine(status)).toBe(RECORDED_PRIME_LINE);
  });

  it("pins airship-core on turn-protocol records and names the fork remedy", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-airship",
      events: [{ type: "session.created" }, { type: "turn.requested" }, { type: "turn.completed" }],
    });
    expect(status.pinnedEngine).toBe("airship-core");
    expect(status.recordType).toBe("airship-history");
    expect(status.canForkSwitch).toBe(true);
    expect(status.forkRemedy).toBe("fork the session to use the prime engine.");
    expect(formatAgentRuntimeStatusLine(status)).toBe(RECORDED_AIRSHIP_LINE);
  });

  it("pins airship-core on inference.* records the way the gate does", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-inference",
      events: [{ type: "inference.usage" }],
    });
    expect(status.pinnedEngine).toBe("airship-core");
    expect(status.recordType).toBe("airship-history");
  });

  it("distinguishes the current runtime-selection marker", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-selected",
      events: [{ type: "session.created" }, { type: AGENT_RUNTIME_SELECTION_EVENT_TYPE }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.recordType).toBe("selection-marker");
    expect(status.canForkSwitch).toBe(true);
    expect(formatAgentRuntimeStatusLine(status)).toBe(RECORDED_PRIME_LINE);
  });

  it("retains bounded read compatibility for the historical marker", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-historical",
      events: [{ type: "session.created" }, { type: HISTORICAL_SELECTION_EVENT_TYPE }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.recordType).toBe("legacy-selection-marker");
    expect(formatAgentRuntimeStatusLine(status)).toBe(RECORDED_PRIME_LINE);
  });

  it("prefers the current marker when a migrated journal contains both names", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-both",
      events: [
        { type: HISTORICAL_SELECTION_EVENT_TYPE },
        { type: AGENT_RUNTIME_SELECTION_EVENT_TYPE },
      ],
    });
    expect(status.recordType).toBe("selection-marker");
  });

  it("reads Prime first when a journal carries both engines' records", () => {
    const status = getAgentRuntimeStatus({
      sessionId: "s-mixed",
      events: [{ type: "turn.requested" }, { type: AGENT_RUNTIME_SELECTION_EVENT_TYPE }],
    });
    expect(status.pinnedEngine).toBe("prime");
    expect(status.recordType).toBe("selection-marker");
  });

  it("exports only the current runtime-selection marker", () => {
    expect(AGENT_RUNTIME_SELECTION_EVENT_TYPE).toBe("prime.session.runtime.selected");
    expect(AGENT_RUNTIME_SELECTION_EVENT_TYPE).not.toBe(HISTORICAL_SELECTION_EVENT_TYPE);
  });
});
