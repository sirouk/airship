export type SlashMenuOption = Readonly<{ disabledReason?: string }>;

export function firstEnabledSlashIndex(options: readonly SlashMenuOption[]): number {
  return options.findIndex((option) => !option.disabledReason);
}

export function moveSlashSelection(
  options: readonly SlashMenuOption[],
  current: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  const first = firstEnabledSlashIndex(options);
  if (first < 0) return -1;
  let index = current >= 0 && current < options.length ? current : first;
  for (let visited = 0; visited < options.length; visited += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabledReason) return index;
  }
  return first;
}

export function enabledSlashSelection<T extends SlashMenuOption>(
  options: readonly T[],
  selected: number,
): T | undefined {
  const option = options[selected];
  return option && !option.disabledReason ? option : undefined;
}
