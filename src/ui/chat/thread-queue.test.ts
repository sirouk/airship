import { describe, expect, it } from "vitest";
import { appendThreadQueueItem, removeThreadQueueItem, type ThreadQueueItem } from "./thread-queue";

describe("thread queue", () => {
  it("keeps FIFO order and rejects duplicate identities", () => {
    const first = { id: "a", prompt: "first", attachments: [] };
    const second = { id: "b", prompt: "second", attachments: [] };
    const queue = appendThreadQueueItem(appendThreadQueueItem([], first), second);
    expect(queue.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(appendThreadQueueItem(queue, first)).toBe(queue);
    expect(removeThreadQueueItem(queue, "a").map(({ id }) => id)).toEqual(["b"]);
  });

  it("bounds tab-local queue growth", () => {
    const items: readonly ThreadQueueItem<never>[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      prompt: `prompt ${index}`,
      attachments: [],
    }));
    const queue = items.reduce<readonly ThreadQueueItem<never>[]>(
      (current, item) => appendThreadQueueItem(current, item),
      [],
    );
    expect(queue).toHaveLength(24);
    expect(queue.at(-1)?.id).toBe("23");
  });
});
