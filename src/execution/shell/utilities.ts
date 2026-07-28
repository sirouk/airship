import type { CommandHandler } from "./command";
import { FILE_UTILITIES } from "./utilities-files";
import { TEXT_UTILITIES } from "./utilities-text";

/**
 * The complete command table.
 *
 * A name absent from this map is `command not found` (status 127). Nothing is
 * stubbed: there is no entry that accepts an invocation and does nothing, and
 * no entry that pretends to be a program Airship does not actually implement.
 *
 * `git`, `python`, and a WASI command are deliberately NOT here. Airship owns
 * real engines for all three, but each lives behind an approval-gated tool
 * with its own workspace transaction; routing them through this table without
 * that gating would create a bypass, so the honest answer for now is that the
 * shell does not provide them.
 */
export const UTILITIES: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ...FILE_UTILITIES,
  ...TEXT_UTILITIES,
]);

export const UTILITY_NAMES: readonly string[] = Object.freeze([...UTILITIES.keys()].sort());
