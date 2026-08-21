import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_SELECTION_EVENT_TYPE,
  getAgentRuntimeStatus,
} from "../prime/runtime/agent-runtimes";
import { renderAgentRuntimeStatus } from "./agent-runtime-status";

const HISTORICAL_SELECTION_EVENT_TYPE = "prime.session.runtime.seal";

function renderedProps(events: readonly { type: string }[]): Record<string, unknown> {
  const status = getAgentRuntimeStatus({ sessionId: "status-test", events });
  const node = renderAgentRuntimeStatus(status) as unknown as { props: Record<string, unknown> };
  return node.props;
}

describe("renderAgentRuntimeStatus", () => {
  it("marks the current selection record without trust language", () => {
    const props = renderedProps([{ type: AGENT_RUNTIME_SELECTION_EVENT_TYPE }]);

    expect(props["data-engine"]).toBe("prime");
    expect(props["data-record"]).toBe("selection-marker");
    expect(props).not.toHaveProperty("data-evidence");
    expect(`${String(props.children)} ${String(props.title)}`).toBe(
      "engine: prime (recorded selection — fork the session to switch) "
      + "The journal records Prime as the selected engine for this session. "
      + "fork the session to use the airship-core engine.",
    );
    expect(`${String(props.children)} ${String(props.title)}`).not.toMatch(/seal|evidence|proof|verif/iu);
  });

  it("handles the historical marker as a distinct read-only record class", () => {
    const props = renderedProps([{ type: HISTORICAL_SELECTION_EVENT_TYPE }]);

    expect(props["data-engine"]).toBe("prime");
    expect(props["data-record"]).toBe("legacy-selection-marker");
    expect(String(props.title)).toContain("A historical journal marker records Prime");
    expect(String(props.title)).not.toMatch(/seal|evidence|proof|verif/iu);
  });

  it("uses an empty record class before the first engine-producing event", () => {
    const props = renderedProps([{ type: "session.created" }]);

    expect(props["data-engine"]).toBe("unpinned");
    expect(props["data-record"]).toBe("empty");
    expect(props.children).toBe("engine: prime (default)");
  });
});
