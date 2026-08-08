/**
 * `airship-sh` is Airship's own POSIX-sh-compatible interpreter. It is written
 * in TypeScript and executes over the authoritative `WorkspacePort`, so it is
 * the one shell tier that needs no cross-origin isolation, no downloaded pack,
 * and no third-party runtime.
 *
 * It is deliberately NOT GNU Bash and must never be labelled `bash`. Everything
 * this engine does not implement is an explicit error rather than a silent
 * no-op, so a script either runs with real POSIX semantics or fails closed.
 */
export const AIRSHIP_SH_ID = "airship-sh";
export const AIRSHIP_SH_VERSION = "1.0.0";
export const AIRSHIP_SH_ENGINE = `airship-sh-${AIRSHIP_SH_VERSION}-interpreter`;

/** Source budget. A script is a tool argument, not a repository. */
export const AIRSHIP_SH_MAX_SCRIPT_BYTES = 256 * 1_024;

/** Per-stream ceiling, matching every other Airship execution tier. */
export const AIRSHIP_SH_MAX_OUTPUT_BYTES = 256 * 1_024;

/**
 * Instruction ceiling. Every command, loop iteration, expansion, and utility
 * input line charges one step, so an unbounded script fails loudly instead of
 * occupying the page until the wall-clock deadline.
 */
export const AIRSHIP_SH_MAX_STEPS = 2_000_000;

/**
 * The interpreter runs on the page's own task queue rather than in a Worker,
 * because cancellation is implemented by owning every interpreter step instead
 * of by killing a thread. Yielding a macrotask on this interval keeps the page
 * responsive while a long script runs.
 */
export const AIRSHIP_SH_YIELD_INTERVAL_STEPS = 4_096;

/**
 * Every Nth yield uses a real timer task rather than a message task, because
 * an `AbortController` is normally fired from a timer or an input event and a
 * message-only yield can starve those. This bounds cancellation latency.
 */
export const AIRSHIP_SH_TIMER_YIELD_INTERVAL = 4;

/** Function calls, subshells, `eval`, `.`, and command substitution nest. */
export const AIRSHIP_SH_MAX_DEPTH = 64;

/** A glob that matches the whole tree is a bug, not a request. */
export const AIRSHIP_SH_MAX_GLOB_RESULTS = 4_096;

/** One expanded word, one pipe stage, and one captured substitution. */
export const AIRSHIP_SH_MAX_EXPANSION_BYTES = 1_024 * 1_024;
export const AIRSHIP_SH_MAX_PIPE_BYTES = 4 * 1_024 * 1_024;

/** Shell state is bounded exactly like the filesystem it operates on. */
export const AIRSHIP_SH_MAX_VARIABLES = 512;
export const AIRSHIP_SH_MAX_FUNCTIONS = 128;
export const AIRSHIP_SH_MAX_ALIASES = 64;
export const AIRSHIP_SH_MAX_POSITIONAL = 1_024;

/** Mount and writeback budgets, identical to the WASI and Python tiers. */
export const AIRSHIP_SH_MAX_FILES = 256;
export const AIRSHIP_SH_MAX_FILE_BYTES = 512 * 1_024;
export const AIRSHIP_SH_MAX_WORKSPACE_BYTES = 4 * 1_024 * 1_024;

/** Scratch tree the guest may use freely; it is never adopted. */
export const AIRSHIP_SH_SCRATCH_ROOT = "/tmp";

/** Never reachable from the shell, on read or on write. */
export const AIRSHIP_SH_EXCLUDED_SEGMENTS = Object.freeze([".airship", ".git", "node_modules"] as const);

/** A bounded diagnostic, never an unbounded guest string. */
export const AIRSHIP_SH_MAX_WORKSPACE_ERROR_CHARS = 512;

/**
 * Exit statuses the interpreter itself produces. Utilities and the script's own
 * commands own every other value, and it is propagated faithfully.
 */
export const AIRSHIP_SH_STATUS = Object.freeze({
  /** A word that resolved to no builtin, function, or utility. */
  commandNotFound: 127,
  /**
   * A resolved name that could not be run as a command. Reserved: nothing in
   * this engine executes a file, so no dispatch path produces 126 today. It is
   * stated here so an exec-a-file surface reports what POSIX requires rather
   * than inventing a status.
   */
  notExecutable: 126,
  /** Parse errors and builtin misuse. */
  usage: 2,
});
