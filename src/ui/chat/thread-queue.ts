export type ThreadQueueItem<TAttachment> = Readonly<{
  id: string;
  prompt: string;
  attachments: readonly TAttachment[];
}>;

export function appendThreadQueueItem<T>(
  current: readonly ThreadQueueItem<T>[],
  item: ThreadQueueItem<T>,
  maximum = 24,
): readonly ThreadQueueItem<T>[] {
  if (!item.prompt.trim()) return current;
  if (current.some((candidate) => candidate.id === item.id)) return current;
  return Object.freeze([...current, item].slice(0, maximum));
}

export function removeThreadQueueItem<T>(
  current: readonly ThreadQueueItem<T>[],
  itemId: string,
): readonly ThreadQueueItem<T>[] {
  return Object.freeze(current.filter((item) => item.id !== itemId));
}
