import { AIRSHIP_SH_MAX_STEPS, AIRSHIP_SH_TIMER_YIELD_INTERVAL, AIRSHIP_SH_YIELD_INTERVAL_STEPS } from "./contract";
import { ShellFatalError } from "./errors";

/**
 * Cancellation, the wall-clock deadline, and the instruction ceiling, in one
 * place that every interpreter step passes through.
 *
 * This is why `airship-sh` cancels for real without a Worker to kill: the
 * engine owns every step, so `while true; do :; done` observes the abort on its
 * next charge. The periodic macrotask yield is load-bearing — an abort raised
 * by a timer or a click can only be observed after the task queue runs, so a
 * loop that awaited only microtasks would starve the very event that stops it.
 */
export class ShellBudget {
  private steps = 0;
  private sinceYield = 0;
  private yields = 0;

  constructor(
    private readonly deadline: number,
    private readonly signal: AbortSignal,
    private readonly now: () => number = () => Date.now(),
  ) {}

  charge(count = 1): void {
    this.steps += count;
    if (this.signal.aborted) {
      throw new ShellFatalError("cancelled", "airship-sh: execution cancelled.");
    }
    if (this.steps > AIRSHIP_SH_MAX_STEPS) {
      throw new ShellFatalError("budget", `airship-sh: script exceeded ${AIRSHIP_SH_MAX_STEPS} interpreter steps.`);
    }
    if (this.now() > this.deadline) {
      throw new ShellFatalError("deadline", "airship-sh: script exceeded its wall-clock deadline.");
    }
  }

  async tick(count = 1): Promise<void> {
    this.charge(count);
    this.sinceYield += count;
    if (this.sinceYield < AIRSHIP_SH_YIELD_INTERVAL_STEPS) return;
    this.sinceYield = 0;
    this.yields += 1;
    // A `MessagePort` task is cheap but does not reliably drain the timer
    // queue, and an `AbortController` is usually fired from a timer or an
    // input event. Every few yields therefore takes the slower `setTimeout`
    // path, which bounds how long a runaway loop can ignore a cancellation.
    await yieldToTaskQueue(this.yields % AIRSHIP_SH_TIMER_YIELD_INTERVAL === 0);
    this.charge(0);
  }

  get chargedSteps(): number {
    return this.steps;
  }
}

let channel: MessageChannel | undefined;

/**
 * A real macrotask. `MessageChannel` is preferred over `setTimeout` because
 * browsers clamp nested timers to 4 ms, which would otherwise dominate the
 * runtime of any script long enough to need yielding at all.
 */
function yieldToTaskQueue(useTimer: boolean): Promise<void> {
  if (!useTimer && typeof MessageChannel === "function") {
    channel ??= new MessageChannel();
    const port = channel.port2;
    return new Promise((resolve) => {
      const handle = (): void => {
        port.removeEventListener("message", handle);
        resolve();
      };
      port.addEventListener("message", handle);
      port.start();
      channel!.port1.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
