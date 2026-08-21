/**
 * Production-safe engine selection for the Prime kernel.
 *
 * "javascript" constructs the stock job-scoped PrimeKernelHost. "pyodide"
 * remains in the persisted KernelEngine vocabulary, but activation fails
 * closed here. A prior Python cell can leave an asyncio task alive, and the
 * shared `pat` module cannot prove that a later bridge call came from the
 * current cell. The dormant direct research class is deliberately not
 * imported into this production selector.
 */

import type {
  KernelBudgets,
  KernelEngine,
  KernelEngineDescription,
  KernelJobEvent,
  KernelJobResult,
  KernelJobSpec,
} from "./kernel-contract";
import type { KernelHostPorts } from "./kernel-host";
import { PrimeKernelHost } from "./kernel-host";

/** Stable fail-closed reason for the dormant persistent interpreter lane. */
export const PYODIDE_ENGINE_QUARANTINE_MESSAGE =
  "The persistent Pyodide kernel is quarantined: cross-cell asyncio task provenance cannot be proven, so createKernelEngine cannot activate it.";

export class PyodideEngineQuarantinedError extends Error {
  override readonly name = "PyodideEngineQuarantinedError";

  constructor() {
    super(PYODIDE_ENGINE_QUARANTINE_MESSAGE);
  }
}

/** Production factory options. Pyodide research uses its direct class options instead. */
export type CreateKernelEngineOptions = Readonly<{
  budgets?: Partial<KernelBudgets>;
  ports: KernelHostPorts;
  label?: string;
}>;

/** The least common honest surface of both kernel engines. */
export interface PrimeKernelEngine {
  start(): Promise<void>;
  exec(spec: KernelJobSpec, listener?: (event: KernelJobEvent) => void): Promise<KernelJobResult>;
  cancel(jobId: string, reason?: string): boolean;
  terminate(reason?: string): Promise<void>;
  restart(): Promise<void>;
  onEvent(listener: (event: KernelJobEvent) => void): () => void;
  /** Capability truth in the airship runtime-registry vocabulary (kernel-contract KernelEngineDescription). */
  describe(): KernelEngineDescription;
}

export function createKernelEngine(kind: KernelEngine, options: CreateKernelEngineOptions): PrimeKernelEngine {
  switch (kind) {
    case "javascript":
      return new PrimeKernelHost(options);
    case "pyodide":
      throw new PyodideEngineQuarantinedError();
    default: {
      // Exhaustiveness: a new KernelEngine kind must fail here at compile
      // time, not silently boot the wrong interpreter at runtime.
      const exhaustive: never = kind;
      throw new Error(`createKernelEngine does not know engine kind ${String(exhaustive)}.`);
    }
  }
}
