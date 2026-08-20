import { describe, expect, it, beforeEach, vi } from "vitest";
import { runTurn, sessionRuntimeKind } from "./load-agent-runtime";

function event(type: string): { type: string } {
  return { type };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

  it("pins Prime on the current runtime-selection marker", () => {
    expect(sessionRuntimeKind([event("prime.session.runtime.selected")])).toBe("prime");
  });

  it("retains read compatibility for the historical runtime-selection marker", () => {
    expect(sessionRuntimeKind([event("prime.session.runtime.seal")])).toBe("prime");
  });

  it("pins Prime on any other prime.* record", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("prime.kernel.job.started")])).toBe("prime");
  });

  it("journal with ordinary turn history and no Prime record is airship-core", () => {
    expect(sessionRuntimeKind([event("session.created"), event("turn.requested"), event("inference.started")])).toBe("airship-core");
  });

  it("Prime records beat later Airship turn protocol (engine flips only via fork)", () => {
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

  it("keeps a journal with the current runtime-selection marker on Prime", async () => {
    await runTurn(gateOptions([event("session.created"), event("prime.session.runtime.selected")]));
    expect(engines.calls).toEqual(["prime"]);
  });

  it("keeps a journal with the historical runtime-selection marker on Prime", async () => {
    await runTurn(gateOptions([event("session.created"), event("prime.session.runtime.seal")]));
    expect(engines.calls).toEqual(["prime"]);
  });

  it("refuses an explicit airship-core against Prime records, and names the fork", async () => {
    await expect(runTurn(gateOptions(
      [event("prime.session.runtime.selected")],
      { runtime: "airship-core" },
    ))).rejects.toThrow(/prime-pinned by journal records; fork the session/);
    expect(engines.calls).toEqual([]);
  });

  it("refuses an explicit prime against airship-core records, and names the fork", async () => {
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

  it("snapshots caller runtime authority before awaiting journal history", async () => {
    const readStarted = deferred();
    const releaseRead = deferred();
    const options = gateOptions([event("session.created")], {
      runtime: "prime",
      journal: {
        async readEvents() {
          readStarted.resolve();
          await releaseRead.promise;
          return [event("session.created")];
        },
      },
    });

    const turn = runTurn(options);
    await readStarted.promise;
    options.runtime = "airship-core";
    releaseRead.resolve();

    await turn;
    expect(engines.calls).toEqual(["prime"]);
  });
});
