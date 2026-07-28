import { runShellScript, type ShellOutputChunk } from "./run";
import { decodeText, encodeText } from "./streams";

export type HarnessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Readonly<Record<string, string>>;
  chunks: readonly ShellOutputChunk[];
}>;

/** Shared table-driven harness: one script, one seeded tree, one observed run. */
export async function runScript(
  script: string,
  seed: Readonly<Record<string, string>> = {},
  options: Readonly<{ args?: readonly string[]; env?: Readonly<Record<string, string>>; timeoutMs?: number; signal?: AbortSignal }> = {},
): Promise<HarnessResult> {
  const chunks: ShellOutputChunk[] = [];
  const result = await runShellScript({
    script,
    mount: {
      root: "/workspace",
      files: Object.entries(seed).map(([path, content]) =>
        Object.freeze({
          path,
          bytes: encodeText(content),
          revision: `revision-${path}`,
          updatedAt: "2026-07-25T00:00:00.000Z",
        }),
      ),
    },
    args: options.args,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
    onOutput: (chunk) => chunks.push(chunk),
  });
  return Object.freeze({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    files: Object.freeze(Object.fromEntries(result.files.map((file) => [file.path, decodeText(file.bytes)]))),
    chunks: Object.freeze(chunks),
  });
}
