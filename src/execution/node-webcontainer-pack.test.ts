import { describe, expect, it, vi } from "vitest";
import type { WebContainerProcess } from "@webcontainer/api";
import { awaitBoundedWebContainerBoot, probeNodeWebContainerRuntime } from "./node-webcontainer-pack";

describe("bounded WebContainer boot", () => {
  it("rejects a provider boot that never settles", async () => {
    vi.useFakeTimers();
    const result = awaitBoundedWebContainerBoot(new Promise<never>(() => undefined), 1_000, new AbortController().signal);
    const rejection = expect(result).rejects.toThrow("activation exceeded 1000 ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    vi.useRealTimers();
  });

  it("honors cancellation before a provider result arrives", async () => {
    const controller = new AbortController();
    const result = awaitBoundedWebContainerBoot(new Promise<never>(() => undefined), 30_000, controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("promotes only after a real bounded npm process reports a version", async () => {
    const spawn = vi.fn(async () => probeProcess(0, "10.9.4\n"));
    await expect(probeNodeWebContainerRuntime({ spawn }, 1_000, new AbortController().signal))
      .resolves.toBe("10.9.4");
    expect(spawn).toHaveBeenCalledWith("npm", ["--version"], expect.objectContaining({
      env: { AIRSHIP_RUNTIME_PROBE: "node-webcontainer" },
    }));
  });

  it("rejects a booted host whose npm process cannot prove readiness", async () => {
    await expect(probeNodeWebContainerRuntime({
      spawn: async () => probeProcess(127, "npm unavailable\n"),
    }, 1_000, new AbortController().signal)).rejects.toThrow(/real npm version probe/u);
  });

  it("bounds a stalled npm spawn and kills a process that arrives after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveSpawn!: (process: WebContainerProcess) => void;
      const spawn = vi.fn(() => new Promise<WebContainerProcess>((resolve) => { resolveSpawn = resolve; }));
      const result = probeNodeWebContainerRuntime({ spawn }, 1_000, new AbortController().signal);
      const rejection = expect(result).rejects.toThrow("activation exceeded 1000 ms");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;

      const late = probeProcess(0, "10.9.4\n");
      resolveSpawn(late);
      await vi.runAllTimersAsync();
      expect(late.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function probeProcess(exitCode: number, output: string): WebContainerProcess {
  return {
    exit: Promise.resolve(exitCode),
    input: new WritableStream<string>(),
    output: new ReadableStream<string>({
      start(controller) {
        controller.enqueue(output);
        controller.close();
      },
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}
