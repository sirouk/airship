/**
 * Engine selection for the prime kernel (port-manifest §3.1: two engines,
 * one kernel authority). createKernelEngine is the single place a session
 * picks its interpreter:
 *
 *   - "javascript": PrimeKernelHost — the baseline persistent REPL worker.
 *     Returned through the same interface; zero edits to its code paths,
 *     so its behavior stays byte-identical to what its tests lock.
 *   - "pyodide": PyodideKernelEngine — the IPython analog: persistent
 *     CPython with a persistent namespace, pinned pack, hard honesty
 *     vocabulary via describe().
 *
 * The shared interface below is the least common honest surface both
 * engines already expose (kernel-worker lifecycle, serialized dispatch,
 * bridge-port egress, the KernelEngineDescription capability record). It
 * exists so the session/host layer depends on one shape, not on a class
 * name; both classes satisfy it structurally.
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
import { PyodideKernelEngine } from "./pyodide-engine";

/** Options understood by either engine; the pyodide-only extras are named, never silently widened. */
export type CreateKernelEngineOptions = Readonly<{
  budgets?: Partial<KernelBudgets>;
  ports: KernelHostPorts &
    Readonly<{
      /** Pyodide-only: pinned pack location ending in "/". Ignored by the javascript engine. */
      assetBase?: string;
    }>;
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
      return new PyodideKernelEngine(options);
    default: {
      // Exhaustiveness: a new KernelEngine kind must fail here at compile
      // time, not silently boot the wrong interpreter at runtime.
      const exhaustive: never = kind;
      throw new Error(`createKernelEngine does not know engine kind ${String(exhaustive)}.`);
    }
  }
}
