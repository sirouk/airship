import type { ExecutionAdapter, ExecutionCapability } from "../runtime-registry";
import {
  AIRSHIP_SH_MAX_FILES,
  AIRSHIP_SH_MAX_OUTPUT_BYTES,
  AIRSHIP_SH_MAX_SCRIPT_BYTES,
  AIRSHIP_SH_VERSION,
} from "./contract";

type ShellPack = typeof import("./pack");

let pack: Promise<ShellPack> | undefined;

/**
 * The honest capability record for Airship's own shell.
 *
 * It says `POSIX sh`, never `bash`. The interpreter implements the POSIX shell
 * command language plus a named set of utilities; it does not implement job
 * control, signals, arrays, process substitution, or any bash extension, and
 * every one of those is a parse error rather than a silent no-op.
 */
export const AIRSHIP_SH_CAPABILITY: ExecutionCapability = Object.freeze({
  id: "airship-sh",
  label: `POSIX sh · airship-sh ${AIRSHIP_SH_VERSION}`,
  languages: Object.freeze(["sh", "posix-shell"]),
  state: "ready",
  tier: "web-baseline",
  isolation: "in-page-interpreter",
  persistence: "workspace-checkpoint",
  commandInterface: "posix-sh-script",
  shell: "airship-sh",
  workspaceAccess: "bounded-snapshot-writeback",
  output: "bounded-stream",
  cancellation: "abort-interpreter",
  detail:
    "Airship's own POSIX-sh-compatible interpreter, written in TypeScript and executed over a bounded snapshot of the "
    + "encrypted workspace with optional revision-checked writeback. It implements the POSIX shell command language "
    + "(quoting, parameter/command/arithmetic expansion, globbing, pipelines, redirection, here-documents, control "
    + "flow, functions, traps on EXIT) and a fixed set of built-in utilities. It is NOT GNU Bash and never claims to "
    + `be: there is no job control, no signals beyond EXIT, no arrays, no process substitution, no \`[[ ]]\`, no `
    + "subprocesses, no host filesystem, and no network. Unimplemented syntax is a parse error and an unimplemented "
    + `utility flag is an error, never a silent no-op. Scripts are capped at ${AIRSHIP_SH_MAX_SCRIPT_BYTES} bytes, `
    + `output at ${AIRSHIP_SH_MAX_OUTPUT_BYTES} bytes per stream, and the mount at ${AIRSHIP_SH_MAX_FILES} files. `
    + "Cancellation stops the interpreter between steps, so a runaway loop genuinely halts.",
});

/**
 * The capability record is eager so `inspect_execution_runtimes` costs nothing,
 * while the interpreter itself is a separate lazy chunk that first paint never
 * downloads. This mirrors `src/load-execution-runtime.ts`.
 */
export function createAirshipShellAdapter(): ExecutionAdapter {
  return {
    capability: AIRSHIP_SH_CAPABILITY,
    async execute(request) {
      pack ??= import("./pack");
      return (await pack).executeAirshipShellRequest(request);
    },
  };
}
