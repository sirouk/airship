import { describe, expect, it } from "vitest";
import {
  createContinuumJobLifecycle,
  isContinuumJobSettled,
  transitionContinuumJob,
  type ContinuumJobLifecycle,
  type ContinuumJobPhase,
} from "./continuum-job-state";

const START = "2026-07-23T12:00:00.000Z";

function job(): ContinuumJobLifecycle {
  return createContinuumJobLifecycle({
    operationId: "operation-1",
    idempotencyKey: "idempotency-1",
    placement: "browser",
    now: START,
  });
}

function advance(initial: ContinuumJobLifecycle, phases: readonly ContinuumJobPhase[]): ContinuumJobLifecycle {
  const base = Date.parse(initial.updatedAt);
  return phases.reduce(
    (state, phase, index) => transitionContinuumJob(state, phase, new Date(base + index + 1).toISOString()),
    initial,
  );
}

describe("continuum job lifecycle", () => {
  it("completes a verified job without writeback", () => {
    const phases: ContinuumJobPhase[] = [
      "planned",
      "awaiting-approval",
      "approved",
      "staging",
      "dispatching",
      "accepted",
      "running",
      "result-received",
      "verifying-result",
      "verified",
      "completed-without-writeback",
    ];
    const result = advance(job(), phases);
    expect(result).toMatchObject({
      phase: "completed-without-writeback",
      sequence: phases.length,
      accepted: true,
      terminalObserved: true,
      resultVerified: true,
    });
    expect(isContinuumJobSettled(result.phase)).toBe(true);
  });

  it("adopts a verified delta or preserves a conflict as separate settled outcomes", () => {
    const prefix: ContinuumJobPhase[] = [
      "planned", "awaiting-approval", "approved", "staging", "dispatching",
      "accepted", "result-received", "verifying-result", "verified",
      "awaiting-adoption", "adopting",
    ];
    expect(advance(job(), [...prefix, "completed"]).phase).toBe("completed");
    expect(advance(job(), [...prefix, "conflicted"]).phase).toBe("conflicted");
  });

  it("forces an unknown dispatch and a disconnect through reconciliation", () => {
    const unknown = advance(job(), [
      "planned", "awaiting-approval", "approved", "staging", "dispatching", "dispatch-unknown",
    ]);
    expect(() => transitionContinuumJob(unknown, "dispatching")).toThrow(/Illegal/u);
    const reconciled = advance(unknown, ["reconciling", "result-received"]);
    expect(reconciled).toMatchObject({ accepted: true, terminalObserved: true });

    const disconnected = advance(job(), [
      "planned", "awaiting-approval", "approved", "staging", "dispatching", "accepted", "running", "disconnected",
    ]);
    expect(advance(disconnected, ["reconciling", "running"])).toMatchObject({ phase: "running", accepted: true });
  });

  it("does not treat a cancellation request as completion", () => {
    const cancelling = advance(job(), [
      "planned", "awaiting-approval", "approved", "staging", "dispatching", "accepted", "running", "cancelling", "draining",
    ]);
    expect(cancelling.terminalObserved).toBe(false);
    expect(isContinuumJobSettled(cancelling.phase)).toBe(false);
    expect(() => transitionContinuumJob(cancelling, "verifying-result")).toThrow(/Illegal/u);

    const reconciled = advance(cancelling, ["disconnected", "reconciling"]);
    const afterReconcile = new Date(Date.parse(reconciled.updatedAt) + 1).toISOString();
    expect(() => transitionContinuumJob(reconciled, "running", afterReconcile)).toThrow(/cancelled/u);
    const verified = advance(reconciled, ["result-received", "verifying-result", "verified"]);
    const afterVerify = new Date(Date.parse(verified.updatedAt) + 1).toISOString();
    expect(() => transitionContinuumJob(verified, "awaiting-adoption", afterVerify)).toThrow(/cancelled/u);
    expect(transitionContinuumJob(verified, "completed-without-writeback", afterVerify).phase)
      .toBe("completed-without-writeback");
  });

  it("keeps denied, quarantined, and completed states immutable", () => {
    const denied = advance(job(), ["planned", "awaiting-approval", "denied"]);
    expect(() => transitionContinuumJob(denied, "approved")).toThrow(/Illegal/u);

    const quarantined = advance(job(), [
      "planned", "awaiting-approval", "approved", "staging", "dispatching",
      "accepted", "result-received", "verifying-result", "quarantined",
    ]);
    expect(() => transitionContinuumJob(quarantined, "awaiting-adoption")).toThrow(/Illegal/u);

    const completed = advance(job(), [
      "planned", "awaiting-approval", "approved", "staging", "dispatching",
      "accepted", "result-received", "verifying-result", "verified",
      "awaiting-adoption", "adopting", "completed",
    ]);
    expect(() => transitionContinuumJob(completed, "conflicted")).toThrow(/Illegal/u);
  });

  it("rejects timestamp regression and illegal completion before verification", () => {
    const planned = transitionContinuumJob(job(), "planned", "2026-07-23T12:00:01.000Z");
    expect(() => transitionContinuumJob(planned, "awaiting-approval", START)).toThrow(/regressed/u);
    expect(() => transitionContinuumJob(planned, "completed")).toThrow(/Illegal/u);
  });

  it("keeps exhausted lost jobs unresolved and accepts a late terminal observation", () => {
    const limited = createContinuumJobLifecycle({
      operationId: "operation-lost",
      idempotencyKey: "idempotency-lost",
      placement: "browser",
      now: START,
      maxReconciliationAttempts: 1,
    });
    const reconciling = advance(limited, [
      "planned", "awaiting-approval", "approved", "staging", "dispatching",
      "dispatch-unknown", "reconciling",
    ]);
    const lost = transitionContinuumJob(reconciling, "lost", new Date(Date.parse(reconciling.updatedAt) + 1).toISOString());
    expect(isContinuumJobSettled(lost.phase)).toBe(false);
    expect(transitionContinuumJob(lost, "result-received", new Date(Date.parse(lost.updatedAt) + 1).toISOString()))
      .toMatchObject({ accepted: true, terminalObserved: true });
  });

  it("strictly rejects unknown fields, coercible IDs, and exhausted sequence numbers", () => {
    const planned = transitionContinuumJob(job(), "planned", "2026-07-23T12:00:01.000Z");
    expect(() => transitionContinuumJob({ ...planned, extra: true } as unknown as ContinuumJobLifecycle, "awaiting-approval"))
      .toThrow(/unknown or missing/u);
    expect(() => transitionContinuumJob({ ...planned, operationId: 123 } as unknown as ContinuumJobLifecycle, "awaiting-approval"))
      .toThrow(/operation ID/u);
    expect(() => transitionContinuumJob(
      { ...planned, sequence: 1_000_000 },
      "awaiting-approval",
      "2026-07-23T12:00:02.000Z",
    ))
      .toThrow(/exhausted/u);
  });

  it("rejects accessor-backed construction and transition records", () => {
    const constructorArgs = {
      operationId: "operation-accessor",
      idempotencyKey: "idempotency-accessor",
      placement: "browser",
      now: START,
    } as Record<string, unknown>;
    let constructorReads = 0;
    Object.defineProperty(constructorArgs, "placement", {
      enumerable: true,
      get: () => constructorReads++ === 0 ? "browser" : "remote-confidential",
    });
    expect(() => createContinuumJobLifecycle(constructorArgs as unknown as Parameters<typeof createContinuumJobLifecycle>[0]))
      .toThrow(/accessors/u);

    const planned = transitionContinuumJob(job(), "planned", "2026-07-23T12:00:01.000Z");
    const transitionInput = { ...planned } as unknown as Record<string, unknown>;
    let transitionReads = 0;
    Object.defineProperty(transitionInput, "placement", {
      enumerable: true,
      get: () => transitionReads++ === 0 ? "browser" : "remote-confidential",
    });
    expect(() => transitionContinuumJob(
      transitionInput as unknown as ContinuumJobLifecycle,
      "awaiting-approval",
      "2026-07-23T12:00:02.000Z",
    )).toThrow(/accessors/u);
  });
});
