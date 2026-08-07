/**
 * W4 read-effect batch parallelism, pinned against the airship pipeline the
 * planner and executor mirror (`src/core/agent.ts` `readEffectBatch`,
 * lines 1012-1020, and the cursor loop with its three phases, lines
 * 484-624):
 *
 *   (a) a read-effect batch completes in max-latency, not sum-latency;
 *   (b) only contiguous declared-read runs parallelize — any other call is
 *       a barrier of one, including a tool the registry does not know;
 *   (c) the session journal order — starts in source order, `end` events in
 *       completion order, results in source order — reproduces an exact
 *       hand-computed airship trace for a mixed six-call fixture;
 *   (d) an aborted signal blocks later serial starts but never tears a
 *       parallel batch already in flight;
 *   (e) one rejection must not discard the results that already landed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  executePrimeBatch,
  planPrimeToolBatches,
  type ToolBatch,
} from "./tool-batches";

type TestCall = Readonly<{ id: string; name: string }>;

const call = (id: string, name: string): TestCall => ({ id, name });

/*
 * Mirror of `tools.get(call.name)?.definition.effect === "read"`: a name the
 * registry does not hold is a barrier, never a read.
 */
const READ_EFFECT_TOOLS = new Set(["read_file", "glob", "grep"]);
const isReadEffect = (c: TestCall): boolean => READ_EFFECT_TOOLS.has(c.name);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delay = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("planPrimeToolBatches", () => {
  it("parallelizes only the contiguous read-effect run of a write/read/write mix", () => {
    const calls = [
      call("W0", "write_file"),
      call("R1", "read_file"),
      call("R2", "glob"),
      call("W3", "write_file"),
    ];
    expect(planPrimeToolBatches(calls, isReadEffect)).toEqual([
      { calls: [calls[0]], parallel: false },
      { calls: [calls[1], calls[2]], parallel: true },
      { calls: [calls[3]], parallel: false },
    ]);
  });

  it("treats an unregistered tool as a barrier, splitting otherwise adjacent reads", () => {
    const calls = [call("R0", "read_file"), call("X1", "launch_missiles"), call("R2", "grep")];
    expect(planPrimeToolBatches(calls, isReadEffect)).toEqual([
      { calls: [calls[0]], parallel: true },
      { calls: [calls[1]], parallel: false },
      { calls: [calls[2]], parallel: true },
    ]);
  });

  it("plans edge cases like the airship cursor walk", () => {
    expect(planPrimeToolBatches([], isReadEffect)).toEqual([]);

    const reads = [call("R0", "read_file"), call("R1", "read_file"), call("R2", "read_file")];
    expect(planPrimeToolBatches(reads, isReadEffect)).toEqual([{ calls: reads, parallel: true }]);

    const writes = [call("W0", "write_file"), call("W1", "bash"), call("W2", "write_file")];
    expect(planPrimeToolBatches(writes, isReadEffect)).toEqual([
      { calls: [writes[0]], parallel: false },
      { calls: [writes[1]], parallel: false },
      { calls: [writes[2]], parallel: false },
    ]);
  });
});

describe("executePrimeBatch", () => {
  it("runs a read-effect batch concurrently: max-latency, not sum", async () => {
    vi.useFakeTimers();
    try {
      const calls = [
        call("R0", "read_file"),
        call("R1", "read_file"),
        call("R2", "read_file"),
        call("R3", "read_file"),
      ];
      const batches = planPrimeToolBatches(calls, isReadEffect);
      expect(batches).toEqual([{ calls, parallel: true }]);

      const latencies = [40, 80, 120, 160];
      const events: string[] = [];
      const clockStart = Date.now();
      const execution = executePrimeBatch(batches[0]!, (c, index) => {
        events.push(`start:${c.id}`);
        return delay(latencies[index]!, undefined).then(() => {
          events.push(`settle:${c.id}`);
          return `result:${c.id}`;
        });
      });

      /*
       * After 40 ms only the fastest call may have settled, yet all four must
       * have started: serial execution would read start/settle pairs and no
       * second start before the first settle.
       */
      await vi.advanceTimersByTimeAsync(40);
      expect(events).toEqual([
        "start:R0",
        "start:R1",
        "start:R2",
        "start:R3",
        "settle:R0",
      ]);

      await vi.advanceTimersByTimeAsync(120);
      const result = await execution;

      // Sum would be 400 ms; the batch paid only the slowest call.
      expect(Date.now() - clockStart).toBe(160);
      expect(result.outcomes).toEqual([
        { status: "fulfilled", value: "result:R0" },
        { status: "fulfilled", value: "result:R1" },
        { status: "fulfilled", value: "result:R2" },
        { status: "fulfilled", value: "result:R3" },
      ]);
      expect(result.completionOrder).toEqual([0, 1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks later serial starts once the signal aborts", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const batch: ToolBatch<TestCall> = {
      calls: [call("W0", "write_file"), call("W1", "write_file"), call("W2", "write_file")],
      parallel: false,
    };
    const result = await executePrimeBatch(
      batch,
      (c) => {
        started.push(c.id);
        if (c.id === "W0") controller.abort(); // lands as the first call settles
        return `done:${c.id}`;
      },
      { signal: controller.signal },
    );
    expect(started).toEqual(["W0"]);
    expect(result.outcomes).toEqual([
      { status: "fulfilled", value: "done:W0" },
      { status: "not-started" },
      { status: "not-started" },
    ]);
    expect(result.completionOrder).toEqual([0]);
  });

  it("starts nothing at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started: string[] = [];

    const serial: ToolBatch<TestCall> = {
      calls: [call("W0", "write_file"), call("W1", "write_file")],
      parallel: false,
    };
    const serialResult = await executePrimeBatch(serial, (c) => (started.push(c.id), c.id), {
      signal: controller.signal,
    });
    expect(serialResult.outcomes).toEqual([{ status: "not-started" }, { status: "not-started" }]);
    expect(serialResult.completionOrder).toEqual([]);

    const parallel: ToolBatch<TestCall> = {
      calls: [call("R0", "read_file"), call("R1", "read_file"), call("R2", "read_file")],
      parallel: true,
    };
    const parallelResult = await executePrimeBatch(parallel, (c) => (started.push(c.id), c.id), {
      signal: controller.signal,
    });
    expect(parallelResult.outcomes).toEqual([
      { status: "not-started" },
      { status: "not-started" },
      { status: "not-started" },
    ]);
    expect(parallelResult.completionOrder).toEqual([]);
    expect(started).toEqual([]);
  });

  it("lets an abort mid-parallel keep every in-flight allSettled end", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const mains = [deferred<string>(), deferred<string>(), deferred<string>()];
    const batch: ToolBatch<TestCall> = {
      calls: [call("R1", "read_file"), call("R2", "read_file"), call("R3", "read_file")],
      parallel: true,
    };
    const execution = executePrimeBatch(
      batch,
      (c, index) => {
        started.push(c.id);
        gates[index]!.resolve();
        // Queued from the first start, lands only after all three starts.
        if (index === 0) queueMicrotask(() => controller.abort());
        return mains[index]!.promise;
      },
      { signal: controller.signal },
    );

    await Promise.all(gates.map((gate) => gate.promise));
    expect(started).toEqual(["R1", "R2", "R3"]);
    expect(controller.signal.aborted).toBe(true);

    mains[2]!.resolve("result:R3");
    mains[0]!.resolve("result:R1");
    mains[1]!.resolve("result:R2");
    const result = await execution;

    expect(result.outcomes).toEqual([
      { status: "fulfilled", value: "result:R1" },
      { status: "fulfilled", value: "result:R2" },
      { status: "fulfilled", value: "result:R3" },
    ]);
    expect(result.completionOrder).toEqual([2, 0, 1]);
  });

  it("keeps every landed result when one call rejects, and keeps sync throws as rejections", async () => {
    const mains = [deferred<string>(), deferred<string>(), deferred<string>()];
    const batch: ToolBatch<TestCall> = {
      calls: [call("R0", "read_file"), call("R1", "read_file"), call("R2", "read_file")],
      parallel: true,
    };
    const failure = new Error("disk ate it");
    const execution = executePrimeBatch(batch, (_c, index) => mains[index]!.promise);
    mains[0]!.resolve("result:R0");
    mains[1]!.reject(failure);
    mains[2]!.resolve("result:R2");
    const result = await execution;
    expect(result.outcomes).toEqual([
      { status: "fulfilled", value: "result:R0" },
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "result:R2" },
    ]);
    expect(result.completionOrder).toEqual([0, 1, 2]);

    const torn: ToolBatch<TestCall> = { calls: [call("R3", "read_file"), call("R4", "read_file")], parallel: true };
    const tornResult = await executePrimeBatch(torn, (c) => {
      if (c.id === "R3") throw failure;
      return "result:R4";
    });
    expect(tornResult.outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "result:R4" },
    ]);
    expect(tornResult.completionOrder).toEqual([0, 1]);
  });
});

describe("journal ordering parity with src/core/agent.ts", () => {
  /*
   * The session-layer projection the executor exists for: starts reach the
   * journal in assistant source order (phase 1, agent.ts:494-550), end
   * events in settlement order (completionOrder), and tool.resulted /
   * tool.failed in assistant source order (phase 3, agent.ts:561-619).
   */
  async function emitJournalTrace(calls: readonly TestCall[], latencyById: ReadonlyMap<string, number>): Promise<string[]> {
    const trace: string[] = [];
    for (const batch of planPrimeToolBatches(calls, isReadEffect)) {
      for (const c of batch.calls) trace.push(`start:${c.id}`);
      const result = await executePrimeBatch(batch, (c) => delay(latencyById.get(c.id)!, undefined).then(() => c.id));
      for (const index of result.completionOrder) trace.push(`end:${batch.calls[index]!.id}`);
      result.outcomes.forEach((outcome, index) => {
        trace.push(outcome.status === "fulfilled" ? `result:${batch.calls[index]!.id}` : `failed:${batch.calls[index]!.id}`);
      });
    }
    return trace;
  }

  it("reproduces the hand-computed airship trace for a six-call mixed fixture", async () => {
    vi.useFakeTimers();
    try {
      const calls = [
        call("W0", "write_file"),
        call("R1", "read_file"),
        call("R2", "read_file"),
        call("R3", "read_file"),
        call("W4", "write_file"),
        call("R5", "read_file"),
      ];
      /*
       * Crossed read latencies so settlement order visibly disagrees with
       * source order inside the three-read run: R2 < R3 < R1.
       */
      const latencies = new Map([
        ["W0", 10],
        ["R1", 120],
        ["R2", 40],
        ["R3", 80],
        ["W4", 10],
        ["R5", 10],
      ]);

      const tracePromise = emitJournalTrace(calls, latencies);
      await vi.advanceTimersByTimeAsync(200);
      const trace = await tracePromise;

      /*
       * Hand-computed from the airship pipeline:
       *   batch [W0] (barrier, serial): start, end, result;
       *   batch [R1,R2,R3] (reads, allSettled): three starts in source order,
       *     ends in settlement order R2(40) R3(80) R1(120), results re-sorted
       *     into source order R1 R2 R3;
       *   batch [W4] and batch [R5] follow, never reordered across barriers.
       */
      expect(trace).toEqual([
        "start:W0",
        "end:W0",
        "result:W0",
        "start:R1",
        "start:R2",
        "start:R3",
        "end:R2",
        "end:R3",
        "end:R1",
        "result:R1",
        "result:R2",
        "result:R3",
        "start:W4",
        "end:W4",
        "result:W4",
        "start:R5",
        "end:R5",
        "result:R5",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
