import { ShellBudget } from "./budget";
import { AIRSHIP_SH_MAX_OUTPUT_BYTES, AIRSHIP_SH_MAX_SCRIPT_BYTES } from "./contract";
import { ShellFatalError } from "./errors";
import { ShellFileSystem, type ShellMount } from "./filesystem";
import { Interpreter } from "./interpreter";
import { BoundedOutputStream } from "./streams";

export type ShellOutputChunk = Readonly<{ stream: "stdout" | "stderr"; text: string }>;

export type ShellRunOptions = Readonly<{
  script: string;
  mount: ShellMount;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal: AbortSignal;
  /** Live, non-authoritative projection. The bounded result stays the truth. */
  onOutput?: (chunk: ShellOutputChunk) => void;
  runId?: number;
  now?: () => number;
}>;

export type ShellRunResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  droppedBytes: number;
  steps: number;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  /**
   * Directories the script created that hold no file. `WorkspacePort` stores
   * files only, so these cannot be adopted and are named instead of dropped.
   */
  emptyDirectories: readonly string[];
}>;

/**
 * Runs one script to completion over a mounted workspace snapshot.
 *
 * Cancellation, the deadline, and the instruction ceiling all reject rather
 * than returning a partial success, because a script that was stopped is not a
 * script that finished — and every other Airship execution tier makes the same
 * distinction.
 */
export async function runShellScript(options: ShellRunOptions): Promise<ShellRunResult> {
  const scriptBytes = new TextEncoder().encode(options.script).byteLength;
  if (scriptBytes > AIRSHIP_SH_MAX_SCRIPT_BYTES) {
    throw new Error(`airship-sh script exceeds ${AIRSHIP_SH_MAX_SCRIPT_BYTES} bytes.`);
  }
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date().toISOString();
  const fs = new ShellFileSystem(options.mount.root, options.mount.files, startedAt);
  const budget = new ShellBudget(now() + options.timeoutMs, options.signal, now);
  const stdout = new BoundedOutputStream(AIRSHIP_SH_MAX_OUTPUT_BYTES, (text) =>
    emit(options.onOutput, { stream: "stdout", text }),
  );
  const stderr = new BoundedOutputStream(AIRSHIP_SH_MAX_OUTPUT_BYTES, (text) =>
    emit(options.onOutput, { stream: "stderr", text }),
  );
  const interpreter = new Interpreter({
    fs,
    budget,
    stdout,
    stderr,
    environment: options.env,
    positional: options.args,
    scriptName: "airship-sh",
    runId: options.runId ?? 1,
  });

  let exitCode: number;
  try {
    exitCode = await interpreter.run(options.script);
  } catch (error) {
    if (error instanceof ShellFatalError) {
      if (error.reason === "cancelled") {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw new Error(error.message);
    }
    throw error;
  }

  return Object.freeze({
    exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    droppedBytes: stdout.droppedBytes + stderr.droppedBytes,
    steps: budget.chargedSteps,
    files: fs.collect(),
    emptyDirectories: fs.emptyCreatedDirectories(),
  });
}

/** A presentation observer can never poison, delay, or change execution. */
function emit(observer: ShellRunOptions["onOutput"], chunk: ShellOutputChunk): void {
  try {
    observer?.(Object.freeze(chunk));
  } catch {
    // Output projection is deliberately non-authoritative.
  }
}
