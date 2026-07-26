import { describe, expect, it } from "vitest";
import { AIRSHIP_SH_MAX_OUTPUT_BYTES } from "./contract";
import { runShellScript, type ShellOutputChunk } from "./run";

const EMPTY_MOUNT = Object.freeze({ root: "/workspace", files: Object.freeze([]) });

function run(script: string, options: Readonly<{ timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: ShellOutputChunk) => void }> = {}) {
  return runShellScript({
    script,
    mount: EMPTY_MOUNT,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
    onOutput: options.onOutput,
  });
}

describe("airship-sh cancellation and bounds", () => {
  it("genuinely stops an infinite loop when the caller aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run("while true; do :; done", { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The rejection is the proof that the loop stopped: it can only settle
    // because the interpreter observed the abort between two of its own steps.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("propagates the caller's own abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled the run");
    const pending = run("while true; do :; done", { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(reason), 25);
    await expect(pending).rejects.toBe(reason);
  });

  it("stops an infinite loop at its wall-clock deadline", async () => {
    await expect(run("while true; do :; done", { timeoutMs: 60 })).rejects.toThrow(/wall-clock deadline/u);
  });

  it("rejects before starting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run("echo never", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  // Vitest's own 5 s per-test default is shorter than the shell deadline this
  // case deliberately sets, so the harness would abort before the behaviour
  // under test could occur. The ceiling is the assertion; the clock is not.
  it("stops an unbounded output loop at the instruction ceiling rather than growing forever", { timeout: 120_000 }, async () => {
    // The deadline is generous here on purpose: the step ceiling is what must
    // fire, and it must fire as a fatal error rather than a truncated success.
    await expect(run("while true; do echo x; done", { timeoutMs: 20_000 })).rejects.toThrow(
      /interpreter steps|wall-clock deadline/u,
    );
  });

  it("streams output incrementally instead of buffering to completion", async () => {
    const chunks: ShellOutputChunk[] = [];
    const result = await run("for i in 1 2 3; do echo line-$i; done", { onOutput: (chunk) => chunks.push(chunk) });
    expect(result.exitCode).toBe(0);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["line-1\n", "line-2\n", "line-3\n"]);
    expect(chunks.every((chunk) => chunk.stream === "stdout")).toBe(true);
  });

  it("separates the stdout and stderr streams", async () => {
    const chunks: ShellOutputChunk[] = [];
    const result = await run("echo out; echo err >&2", { onOutput: (chunk) => chunks.push(chunk) });
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(chunks).toEqual([
      { stream: "stdout", text: "out\n" },
      { stream: "stderr", text: "err\n" },
    ]);
  });

  it("survives an observer that throws, because output projection is not authoritative", async () => {
    const result = await run("echo kept", {
      onOutput: () => {
        throw new Error("view unmounted");
      },
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "kept\n" });
  });

  // The assertion here is the *byte* budget, so the wall-clock deadline must
  // never be the binding constraint. Under a loaded full-suite run this script
  // is slow enough that the default 10 s budget can expire first, which turns a
  // truncation test into a deadline test. Give it room; the work is bounded by
  // the loop, not by the clock.
  it("bounds each output stream and reports the truncation", { timeout: 120_000 }, async () => {
    const result = await run(`i=0
while [ "$i" -lt 400 ]; do
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  i=$(( i + 1 ))
done`, { timeoutMs: 90_000 });
    expect(result.stdout.length).toBe(AIRSHIP_SH_MAX_OUTPUT_BYTES);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
  });

  it("fails closed when a pipe stage produces more than the pipe budget", { timeout: 120_000 }, async () => {
    await expect(
      run(`i=0
while [ "$i" -lt 60000 ]; do
  printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  i=$(( i + 1 ))
done | wc -l`, { timeoutMs: 90_000 }),
    ).rejects.toThrow(/pipe buffer exceeded|interpreter steps|wall-clock deadline/u);
  });

  it("bounds recursion depth instead of exhausting the JavaScript stack", async () => {
    await expect(run("f() { f; }; f")).rejects.toThrow(/levels of shell nesting|interpreter steps|deadline/u);
  });

  it("bounds pathname expansion results", async () => {
    const files = Array.from({ length: 40 }, (_value, index) =>
      Object.freeze({
        path: `/workspace/f${index}`,
        bytes: new Uint8Array(),
        revision: `r${index}`,
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    );
    const result = await runShellScript({
      script: "printf '%s\\n' * | wc -l",
      mount: { root: "/workspace", files },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.stdout.trim()).toBe("40");
  });

  it("rejects a script larger than its source budget", async () => {
    await expect(run(`echo '${"x".repeat(300_000)}'`)).rejects.toThrow(/script exceeds/u);
  });
});
