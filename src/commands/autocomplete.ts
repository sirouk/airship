import type { SlashCommandRegistry } from "./registry";
import type { SlashCommandDescriptor, SlashCompletion } from "./types";

/**
 * A completion list plus the size of the set it was cut from.
 *
 * The menu can only show a handful of rows, and a truncated list that does not
 * say it is truncated is a lie about what the product can do: a user who types
 * `/` and sees ten tool names has been told, wrongly, that those ten are all
 * there is. `total` is what lets the menu state "10 of 34" instead.
 */
export type SlashCompletionMenu = Readonly<{
  completions: readonly SlashCompletion[];
  total: number;
}>;

export function completeSlashCommand(
  input: string,
  registry: SlashCommandRegistry,
  options: Readonly<{ limit?: number }> = {},
): readonly SlashCompletion[] {
  return completeSlashCommandMenu(input, registry, options).completions;
}

export function completeSlashCommandMenu(
  input: string,
  registry: SlashCommandRegistry,
  options: Readonly<{ limit?: number }> = {},
): SlashCompletionMenu {
  if (!input.startsWith("/") || input.length > 64 * 1024) return EMPTY_MENU;
  const limit = integerWithin(options.limit ?? 12, 1, 50);
  const body = input.slice(1);
  const firstWhitespace = body.search(/\s/u);
  if (firstWhitespace < 0) return menu(commandCompletions(body, registry), limit);

  const rawName = body.slice(0, firstWhitespace).toLowerCase();
  const command = registry.resolve(rawName);
  if (!command) return menu(commandCompletions(rawName, registry), limit);
  const tail = body.slice(firstWhitespace).trimStart();
  const fragments = tail.split(/\s+/u);
  const current = tail && !/\s$/u.test(tail) ? fragments.at(-1)! : "";
  const completions: SlashCompletion[] = [];

  if (fragments.length <= 1 && !current.startsWith("--")) {
    for (const subcommand of command.subcommands) {
      if (!subcommand.startsWith(current.toLowerCase())) continue;
      completions.push(completion("subcommand", subcommand, subcommand, command.summary, command));
    }
  }

  /*
   * Options are offered when the reader is typing one, not whenever there is
   * nothing else to say. An empty fragment matched every unused option, so
   * Enter on `/ls` accepted `--path` and then sent a command with an option and
   * no value ("Option --path requires a value."), and on `/read` the same reflex
   * built `--path --offset` and never sent anything at all.
   */
  const used = new Set(fragments.filter((fragment) => fragment.startsWith("--")).map((fragment) => fragment.split("=", 1)[0]));
  for (const argument of current.startsWith("--") ? command.arguments : []) {
    if (used.has(argument.option) || !argument.option.startsWith(current)) continue;
    completions.push(completion(
      "option",
      argument.option,
      argument.option,
      argument.description ?? `${argument.name}: ${argument.valueHint}`,
      command,
    ));
  }
  return menu(completions, limit);
}

function commandCompletions(
  queryValue: string,
  registry: SlashCommandRegistry,
): readonly SlashCompletion[] {
  const query = queryValue.toLowerCase();
  const candidates = registry.descriptors().flatMap((command) => {
    const names = [command.name, ...command.aliases];
    const matchingName = names.find((name) => name.startsWith(query));
    return matchingName ? [{ command, matchingName }] : [];
  });
  candidates.sort((left, right) => {
    const leftExact = left.command.name === query ? 0 : left.matchingName === query ? 1 : 2;
    const rightExact = right.command.name === query ? 0 : right.matchingName === query ? 1 : 2;
    // Alphabetical order alone is not a ranking, it is an accident of naming:
    // the tool namespace is large and its names cluster early in the alphabet,
    // so a bare `/` used to fill every visible row with tools and bury `/help`,
    // `/models` and `/sessions` — the three commands a first-time user needs
    // most and the only ones that are not discoverable anywhere else in the
    // menu. Built-ins therefore outrank tools on a tie.
    return leftExact - rightExact
      || categoryRank(left.command) - categoryRank(right.command)
      || left.command.name.localeCompare(right.command.name);
  });
  return candidates.map(({ command }) => completion(
    "command",
    `/${command.name}`,
    `/${command.name}`,
    command.summary,
    command,
  ));
}

function categoryRank(command: SlashCommandDescriptor): number {
  return command.category === "tool" ? 1 : 0;
}

function menu(completions: readonly SlashCompletion[], limit: number): SlashCompletionMenu {
  return Object.freeze({
    completions: Object.freeze(completions.slice(0, limit)),
    total: completions.length,
  });
}

const EMPTY_MENU: SlashCompletionMenu = Object.freeze({ completions: Object.freeze([]), total: 0 });

function completion(
  kind: SlashCompletion["kind"],
  insertText: string,
  label: string,
  detail: string,
  command: SlashCommandDescriptor,
): SlashCompletion {
  return Object.freeze({
    kind,
    insertText,
    label,
    detail,
    command,
    ...(!command.availability.enabled ? { disabledReason: command.availability.reason } : {}),
  });
}

function integerWithin(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return 12;
  return value;
}
