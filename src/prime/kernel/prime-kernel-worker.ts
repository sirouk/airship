/**
 * Same-origin entry for one disposable Prime JavaScript kernel job.
 *
 * The page sends one generation-local initialization frame. Only after that
 * trusted frame arrives do we install the generated runtime. The runtime keeps
 * its native controller sender, listener, protocol capability, and job-scoped
 * namespace in its own closure before it removes the ambient worker surfaces.
 *
 * This file is deliberately a Vite worker entry rather than a blob. Its hashed
 * production response receives the one path-scoped CSP in Airship that grants
 * `unsafe-eval`, which the runtime needs for AsyncFunction-backed REPL cells.
 */

import type { KernelBudgets } from "./kernel-contract";
import { DEFAULT_KERNEL_BUDGETS, KERNEL_PROTOCOL_TOKEN_BYTES } from "./kernel-contract";
import { kernelWorkerSource } from "./kernel-worker-source";

const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeRemoveEventListener = globalThis.removeEventListener.bind(globalThis);
const nativeEvaluate = globalThis.eval;
const budgetNames = Object.freeze(Object.keys(DEFAULT_KERNEL_BUDGETS) as (keyof KernelBudgets)[]);
const protocolTokenPattern = new RegExp(`^[0-9a-f]{${KERNEL_PROTOCOL_TOKEN_BYTES * 2}}$`);

type Initialization = Readonly<{
  type: "init";
  budgets: KernelBudgets;
  protocolToken: string;
}>;

function readInitialization(value: unknown): Initialization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Prime kernel initialization must be a plain record.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Prime kernel initialization must have a plain-object prototype.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== ["budgets", "protocolToken", "type"].sort().join(",") || record.type !== "init") {
    throw new TypeError("Prime kernel initialization has an invalid wire shape.");
  }
  if (typeof record.protocolToken !== "string" || !protocolTokenPattern.test(record.protocolToken)) {
    throw new TypeError("Prime kernel initialization requires a fresh protocol capability.");
  }
  if (typeof record.budgets !== "object" || record.budgets === null || Array.isArray(record.budgets)) {
    throw new TypeError("Prime kernel initialization requires a budget record.");
  }
  const budgetPrototype = Object.getPrototypeOf(record.budgets);
  if (budgetPrototype !== Object.prototype && budgetPrototype !== null) {
    throw new TypeError("Prime kernel budgets must have a plain-object prototype.");
  }
  const budgets = record.budgets as Record<string, unknown>;
  if (Object.keys(budgets).sort().join(",") !== [...budgetNames].sort().join(",")) {
    throw new TypeError("Prime kernel initialization carries an unknown or missing budget.");
  }
  for (const name of budgetNames) {
    const amount = budgets[name];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError(`Prime kernel budget ${name} must be a non-negative safe integer.`);
    }
    if (name === "maxJobWallMs" && amount === 0) {
      throw new TypeError("Prime kernel budget maxJobWallMs must be positive.");
    }
  }
  return {
    type: "init",
    budgets: record.budgets as KernelBudgets,
    protocolToken: record.protocolToken,
  };
}

function initialize(event: MessageEvent<unknown>): void {
  // A script-created MessageEvent is never controller authority. No evaluated
  // cell exists yet, but keeping the same trusted-event rule at both bootstrap
  // and runtime boundaries prevents this entry from becoming a second lane.
  if (event.isTrusted !== true) return;

  // The first trusted controller frame consumes the only initialization lane,
  // even when its shape is invalid. A malformed attempt must end in the host's
  // worker-error path, never leave a reusable capability-delivery listener.
  nativeRemoveEventListener("message", initialize);
  const initialization = readInitialization(event.data);

  // Indirect eval installs the already unit-tested runtime as a classic global
  // script. Its IIFE, not this bootstrap module, owns all controller secrets.
  // The worker response CSP grants this operation; the page policy does not.
  nativeEvaluate(kernelWorkerSource(initialization.budgets, initialization.protocolToken));
}

nativeAddEventListener("message", initialize);
