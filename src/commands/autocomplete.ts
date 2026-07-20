import type { SlashCommandRegistry } from "./registry";
import type { SlashCommandDescriptor, SlashCompletion } from "./types";

export function completeSlashCommand(
  input: string,
  registry: SlashCommandRegistry,
  options: Readonly<{ limit?: number }> = {},
): readonly SlashCompletion[] {
  if (!input.startsWith("/") || input.length > 64 * 1024) return Object.freeze([]);
  const limit = integerWithin(options.limit ?? 12, 1, 50);
  const body = input.slice(1);
  const firstWhitespace = body.search(/\s/u);
  if (firstWhitespace < 0) return commandCompletions(body, registry, limit);

  const rawName = body.slice(0, firstWhitespace).toLowerCase();
  const command = registry.resolve(rawName);
  if (!command) return commandCompletions(rawName, registry, limit);
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

  const used = new Set(fragments.filter((fragment) => fragment.startsWith("--")).map((fragment) => fragment.split("=", 1)[0]));
  for (const argument of command.arguments) {
    if (used.has(argument.option) || !argument.option.startsWith(current)) continue;
    completions.push(completion(
      "option",
      argument.option,
      argument.option,
      argument.description ?? `${argument.name}: ${argument.valueHint}`,
      command,
    ));
  }
  return Object.freeze(completions.slice(0, limit));
}

function commandCompletions(
  queryValue: string,
  registry: SlashCommandRegistry,
  limit: number,
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
    return leftExact - rightExact || left.command.name.localeCompare(right.command.name);
  });
  return Object.freeze(candidates.slice(0, limit).map(({ command }) => completion(
    "command",
    `/${command.name}`,
    `/${command.name}`,
    command.summary,
    command,
  )));
}

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

