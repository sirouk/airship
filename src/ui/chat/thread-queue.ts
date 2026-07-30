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
  // At capacity the queue is unchanged — returned by identity, so a caller
  // can tell "refused, nothing dropped" apart from the old silent slicer,
  // which kept the first `maximum` and discarded the new item while the
  // enqueue surface still announced it as queued.
  if (current.length >= maximum) return current;
  return Object.freeze([...current, item]);
}

export function removeThreadQueueItem<T>(
  current: readonly ThreadQueueItem<T>[],
  itemId: string,
): readonly ThreadQueueItem<T>[] {
  return Object.freeze(current.filter((item) => item.id !== itemId));
}
