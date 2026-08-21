import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_KERNEL_BUDGETS } from "../prime/kernel/kernel-contract";
import { kernelWorkerSource } from "../prime/kernel/kernel-worker-source";
import {
  DISPOSABLE_WORKER_AMBIENT_GLOBALS,
  DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS,
  DISPOSABLE_WORKER_CONTROLLER_GLOBALS,
  disposableWorkerIsolationPreludeSource,
} from "./disposable-worker-isolation-source";

const executionToolsSource = readFileSync(new URL("../tools/execution-tools.ts", import.meta.url), "utf8");

describe("disposable worker isolation source", () => {
  it("keeps one frozen ambient vocabulary in the strict JavaScript worker and post-boot Pyodide scrub", () => {
    expect(Object.isFrozen(DISPOSABLE_WORKER_AMBIENT_GLOBALS)).toBe(true);
    expect(DISPOSABLE_WORKER_AMBIENT_GLOBALS).toContain("FontFace");
    expect(DISPOSABLE_WORKER_AMBIENT_GLOBALS).toContain("fonts");

    const prelude = disposableWorkerIsolationPreludeSource();
    const kernel = kernelWorkerSource(DEFAULT_KERNEL_BUDGETS, "11".repeat(32));
    for (const name of DISPOSABLE_WORKER_AMBIENT_GLOBALS) {
      expect(prelude).toContain(`"${name}"`);
      expect(kernel).toContain(`"${name}"`);
    }
    expect(executionToolsSource).toContain("${disposableWorkerIsolationPreludeSource()}");
    expect(executionToolsSource).toContain("__scrubAmbient();");
  });

  it("routes both model-written JavaScript tools through the external strict worker instead of blob source", () => {
    expect(executionToolsSource.match(/new PrimeKernelHost\(/gu)).toHaveLength(2);
    expect(executionToolsSource).not.toContain("workspaceProgramWorkerSource");
    expect(executionToolsSource).not.toContain("function workerSource");
    expect(executionToolsSource).toContain("__airship_workspace_finalize");
  });

  it("emits prototype-chain removal, fail-closed verification, and guarded controller receivers", () => {
    const prelude = disposableWorkerIsolationPreludeSource();
    expect(prelude).toContain("target = __getPrototypeOf(__controllerGlobal)");
    expect(prelude).toContain("Worker isolation could not hide");
    expect(prelude).toContain("this === __controllerGlobal");
    const kernel = kernelWorkerSource(DEFAULT_KERNEL_BUDGETS, "22".repeat(32));
    for (const name of DISPOSABLE_WORKER_CONTROLLER_GLOBALS) {
      expect(prelude).toContain(`"${name}"`);
      expect(kernel).toContain(`"${name}"`);
    }
    for (const name of DISPOSABLE_WORKER_CONTROLLER_EVENT_METHODS) {
      expect(prelude).toContain(`"${name}"`);
      expect(kernel).toContain(`"${name}"`);
    }
    expect(kernel).toContain("Kernel isolation could not hide");
    expect(kernel).toContain("Kernel isolation could not guard controller method");
  });
});
