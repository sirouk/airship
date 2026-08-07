/**
 * Prime read-effect batch parallelism — a byte-faithful mirror of the airship
 * tool-phase pipeline (`src/core/agent.ts` `readEffectBatch` and the cursor
 * loop around it, lines 484-624) for sessions the prime engine settles.
 *
 * The canonical implementation lives in the airship agent, so the planning
 * and settlement discipline are mirrored here and pinned by colocated tests
 * against hand-computed traces of that pipeline.
 *
 * What the parity actually is:
 *   - planning is `readEffectBatch`'s cursor semantics (agent.ts:1012-1020):
 *     the maximal consecutive run of declared reads executes together, every
 *     other call is a batch of exactly one. Anything that is not a declared
 *     read is a barrier — including a tool that is not registered at all —
 *     because the safety argument is made from the declared effect, never
 *     from path analysis: a read cannot observe what another read did, so
 *     order within a read run cannot matter;
 *   - a batch of read-effect calls executes concurrently through
 *     `Promise.allSettled` (agent.ts:551-560: "the only thing that overlaps"
 *     — `allSettled`, not `all`, because one rejection must not discard the
 *     results that already landed). A non-parallel batch executes strictly
 *     serially, one settled call before the next start;
 *   - settlement is reported two ways on purpose: per-call outcomes in call
 *     order, which is the phase-3 journal order for `tool.resulted` /
 *     `tool.failed` (agent.ts:561-619: "journal in call order, whatever
 *     order they finished in"), plus a completion-order index map, which is
 *     the order `tool_execution_end` events must be emitted in. The session
 *     layer consumes the two projections separately and never derives one
 *     from the other;
 *   - abort blocks starts, never settlements (agent.ts:485 `throwIfAborted`
 *     between batches, and the "thrown after the batch, never inside it"
 *     note at 621-624): in a serial batch, an aborted signal blocks every
 *     later start and the blocked calls come back as `not-started`; in a
 *     parallel batch every call has already started, so an abort mid-flight
 *     changes nothing — in-flight calls allSettle and every one still earns
 *     its completion-order entry.
 */

export interface ToolBatch<TCall = unknown> {
  /** The calls that may execute together, in assistant source order. */
  readonly calls: readonly TCall[];
  /** True exactly for contiguous runs of declared read-effect calls. */
  readonly parallel: boolean;
}

export type PrimeSettledOutcome<TResult> =
  | Readonly<{ status: "fulfilled"; value: TResult }>
  | Readonly<{ status: "rejected"; reason: unknown }>
  | Readonly<{ status: "not-started" }>;

export interface PrimeBatchExecution<TResult> {
  /**
   * One outcome per batch call, in call order — the phase-3 journal order
   * (`tool.resulted` / `tool.failed` in assistant source order).
   */
  readonly outcomes: readonly PrimeSettledOutcome<TResult>[];
  /**
   * Call indexes in settlement order — the `tool_execution_end` emission
   * order. Identical to call order for serial batches; a race witness for
   * parallel ones. Calls blocked by an aborted signal never appear.
   */
  readonly completionOrder: readonly number[];
}

export interface PrimeBatchExecutionOptions {
  readonly signal?: AbortSignal;
}

/**
 * The `readEffectBatch` cursor walk hoisted over the whole call list: the
 * maximal consecutive run of read-effect calls from each cursor position is
 * one parallel batch; any other call is a serial batch of one and a barrier
 * nothing crosses. Two read runs separated by a single non-read call stay
 * two batches.
 */
export function planPrimeToolBatches<TCall>(
  calls: readonly TCall[],
  isReadEffect: (call: TCall) => boolean,
): ToolBatch<TCall>[] {
  const batches: ToolBatch<TCall>[] = [];
  let cursor = 0;
  while (cursor < calls.length) {
    let end = cursor;
    while (end < calls.length && isReadEffect(calls[end]!)) end += 1;
    if (end > cursor) {
      batches.push({ calls: calls.slice(cursor, end), parallel: true });
      cursor = end;
    } else {
      batches.push({ calls: [calls[cursor]!], parallel: false });
      cursor += 1;
    }
  }
  return batches;
}

/**
 * Executes one planned batch under the airship discipline: parallel batches
 * go through `Promise.allSettled` with every call starting together, serial
 * batches run one settled call before the next start. A synchronous throw
 * out of `exec` is a rejection, never a torn batch — the same conversion an
 * async `executeApproved` gives the airship loop for free.
 */
export async function executePrimeBatch<TCall, TResult>(
  batch: ToolBatch<TCall>,
  exec: (call: TCall, index: number) => Promise<TResult> | TResult,
  options?: PrimeBatchExecutionOptions,
): Promise<PrimeBatchExecution<TResult>> {
  const signal = options?.signal;
  const outcomes: PrimeSettledOutcome<TResult>[] = new Array<PrimeSettledOutcome<TResult>>(batch.calls.length);
  const completionOrder: number[] = [];

  if (batch.parallel) {
    if (signal?.aborted) {
      outcomes.fill({ status: "not-started" });
      return { outcomes, completionOrder };
    }
    await Promise.allSettled(
      batch.calls.map((call, index) =>
        Promise.resolve()
          .then(() => exec(call, index))
          .then(
            (value) => {
              outcomes[index] = { status: "fulfilled", value };
              completionOrder.push(index);
            },
            (reason: unknown) => {
              outcomes[index] = { status: "rejected", reason };
              completionOrder.push(index);
            },
          ),
      ),
    );
    return { outcomes, completionOrder };
  }

  for (let index = 0; index < batch.calls.length; index += 1) {
    if (signal?.aborted) {
      for (let rest = index; rest < batch.calls.length; rest += 1) outcomes[rest] = { status: "not-started" };
      break;
    }
    try {
      const value = await exec(batch.calls[index]!, index);
      outcomes[index] = { status: "fulfilled", value };
    } catch (reason) {
      outcomes[index] = { status: "rejected", reason };
    }
    completionOrder.push(index);
  }
  return { outcomes, completionOrder };
}
