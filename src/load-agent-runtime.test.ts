import { describe, expect, it, beforeEach, vi } from "vitest";
import { runTurn, sessionRuntimeKind } from "./load-agent-runtime";

function event(type: string): { type: string } {
  return { type };
}

/*
 * Both engines are stubbed at the module boundary the gate actually crosses:
 * it reaches them through `import()`, so what these assert is the routing
 * decision and nothing about either loop. `vi.hoisted` because a `vi.mock`
 * factory is lifted above the file's own bindings and may not close over one
 * declared normally.
 */
const engines = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("./core/agent", () => ({
  runTurn: async () => {
    engines.calls.push("airship-core");
    return { turnId: "turn-core", content: "", receipt: {}, events: [] };
  },
}));

vi.mock("./prime/runtime/runtime", () => ({
  runPrimeTurn: async () => {
    engines.calls.push("prime");
    return { turnId: "turn-prime", content: "", receipt: {}, events: [] };
  },
}));

function gateOptions(
  history: readonly { type: string }[],
  overrides: Record<string, unknown> = {},
) {
  return {
    sessionId: "session-1",
    content: "hello",
    transport: { id: "chutes", posture: "local", stream: async function* () {} },
    tools: {},
    journal: { readEvents: async () => history },
    approvalPolicy: {},
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as Parameters<typeof runTurn>[0];
}

describe("sessionRuntimeKind", () => {
  it("classifies a fresh (empty) journal as unpinned", () => {
    expect(sessionRuntimeKind([event("session.created")])).toBe("unpinned");
  });

  it("any prime.* evidence pins the session prime", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("prime.kernel.job.started")])).toBe("prime");
    expect(sessionRuntimeKind([event("prime.session.runtime.seal")])).toBe("prime");
  });

  it("journal with ordinary turn history and no prime evidence is airship-core", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("inference.started")])).toBe("airship-core");
  });

  it("prime evidence beats later airship turn protocol (engine flips only via fork)", () => {
    expect(sessionRuntimeKind([event("prime.kernel.tool.requested"), event("turn.requested")])).toBe("prime");
  });
});

/*
 * The half `sessionRuntimeKind` cannot speak for. Classification was covered
 * from the day it landed; *selection* was not, which is how the default-on
 * branch could narrow to "airship-core whenever a transport is attached" —
 * true of every type-checked caller — without a single red test.
 */
describe("runTurn engine selection", () => {
  beforeEach(() => { engines.calls.length = 0; });

  it("runs a fresh unpinned session on prime: prime is the default engine", async () => {
    await runTurn(gateOptions([event("session.created")]));
    expect(engines.calls).toEqual(["prime"]);
  });

  it("keeps the demo transport on prime too — the carve-out died with the credential bridge", async () => {
    await runTurn(gateOptions([event("session.created")], {
      transport: { id: "airship-demo", posture: "local", stream: async function* () {} },
    }));
    expect(engines.calls).toEqual(["prime"]);
  });

  it("a transport no longer decides the engine: same journal, any vendor, still prime", async () => {
    for (const id of ["anthropic", "openai", "ollama", "lm-studio"]) {
      await runTurn(gateOptions([event("session.created")], {
        transport: { id, posture: "local", stream: async function* () {} },
      }));
    }
    expect(engines.calls).toEqual(["prime", "prime", "prime", "prime"]);
  });

  it("leaves an airship-core-pinned journal on airship-core", async () => {
    await runTurn(gateOptions([event("session.created"), event("turn.requested")]));
    expect(engines.calls).toEqual(["airship-core"]);
  });

  it("keeps a prime-pinned journal on prime", async () => {
    await runTurn(gateOptions([event("session.created"), event("prime.session.runtime.seal")]));
    expect(engines.calls).toEqual(["prime"]);
  });

  it("refuses an explicit airship-core against prime evidence, and names the fork", async () => {
    await expect(runTurn(gateOptions(
      [event("prime.session.runtime.seal")],
      { runtime: "airship-core" },
    ))).rejects.toThrow(/prime-pinned by journal evidence; fork the session/);
    expect(engines.calls).toEqual([]);
  });

  it("refuses an explicit prime against airship-core evidence, and names the fork", async () => {
    await expect(runTurn(gateOptions(
      [event("turn.requested")],
      { runtime: "prime" },
    ))).rejects.toThrow(/runs airship-core; fork the session/);
    expect(engines.calls).toEqual([]);
  });

  it("honours an explicit override an unpinned journal does not contradict", async () => {
    await runTurn(gateOptions([event("session.created")], { runtime: "airship-core" }));
    expect(engines.calls).toEqual(["airship-core"]);
  });
});
