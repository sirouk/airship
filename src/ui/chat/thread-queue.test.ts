import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendThreadQueueItem, removeThreadQueueItem, type ThreadQueueItem } from "./thread-queue";

// The queue's app-side behavior (admission, dispatch, refusal handling) lives
// in <App /> closures today, so the half of these regressions that cannot run
// without a full browser shell pins the source contract instead — the same
// way route-layout and aria-name tests pin theirs.
const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");

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

  it("rejects the 25th append by identity, keeping the first 24", () => {
    const full = Array.from({ length: 24 }, (_, index) => ({
      id: String(index),
      prompt: `prompt ${index}`,
      attachments: [],
    })).reduce<readonly ThreadQueueItem<never>[]>((current, item) => appendThreadQueueItem(current, item), []);
    // The refused append returns the queue itself, so "did this enqueue" is
    // answerable without re-deriving the length before and after.
    const refused = { id: "24", prompt: "twenty-fifth", attachments: [] };
    expect(appendThreadQueueItem(full, refused)).toBe(full);
    expect(full).toHaveLength(24);
    expect(full.map(({ id }) => id)).toEqual(Array.from({ length: 24 }, (_, index) => String(index)));
  });

  it("reports the admitted queue length as the announcement count", () => {
    // The composer notice used to announce `messageQueue.length + 1`, which
    // read 25 while the cap had already discarded the item it claimed to
    // queue. The count is the length of the append result itself.
    let queue: readonly ThreadQueueItem<never>[] = [];
    const announced: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const appended = appendThreadQueueItem(queue, { id: String(index), prompt: `p ${String(index)}`, attachments: [] });
      if (appended.length > queue.length) {
        announced.push(appended.length);
        queue = appended;
      }
    }
    expect(announced).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  });
});

describe("thread queue surface contract", () => {
  it("acknowledges a queued local command exactly once, success or error", () => {
    // The non-chat slash branch returns before chat admission; without its
    // own onAdmitted call a queued built-in wedged the head forever and a
    // tool plan re-ran in an unbounded loop, because its busy toggling
    // re-fires the dispatch effect. The admission lives beside the
    // admission-lock release so both paths through the try/catch settle the
    // queue once.
    const branch = app.slice(app.indexOf('if (slashPlan.kind !== "chat")'));
    expect(branch.indexOf("queue?.onAdmitted();")).toBeGreaterThan(-1);
    expect(branch.indexOf("queue?.onAdmitted();")).toBeLessThan(branch.indexOf("localCommandAdmission.current = false;"));
    // Exactly once on this path: the chat path's admission is unreachable
    // past the branch's return.
    expect(branch.slice(0, branch.indexOf("return true;")).match(/queue\?\.onAdmitted\(\);/gu)).toHaveLength(1);
  });

  it("acknowledges a queued plan rewritten to empty content instead of wedging", () => {
    expect(app).toMatch(/content = slashPlan\.content\.trim\(\);\s*\n\s*if \(!content\) \{\s*\n(?:.*\n)*?\s*queue\?\.onAdmitted\(\);\s*\n\s*return false;/u);
  });

  it("retries a refused queue head when connectivity comes back", () => {
    // Offline / disconnected refusals deliberately keep the head in place and
    // change no dep, so reconnecting must be what re-fires the dispatch.
    expect(app).toContain("}, [busy, inferenceConnected, messageQueue, online, queuePaused, sessionId]);");
  });

  it("hands a refused fork-retry regeneration back to the branch composer", () => {
    const dispatch = app.slice(app.indexOf("void sendMessage(pending.prompt, pending.attachments)"));
    expect(dispatch).toContain(".then((admitted) =>");
    expect(dispatch).toContain("if (admitted) return;");
    expect(dispatch).toContain("setInput((current) => (current.trim() ? current : pending.prompt));");
    expect(dispatch).toContain("setAttachments((current) => (current.length ? current : pending.attachments));");
  });

  it("refuses a full queue without clearing the composer, and states the real count", () => {
    expect(app).toContain("setComposerNotice(`Queue full · ${String(waiting)} messages waiting — send or remove one first`);");
    expect(app).toContain("`Queued for this conversation · ${String(waiting)} waiting`");
    expect(app).not.toContain("messageQueue.length + 1");
    // Clearing is gated on admission, not unconditional.
    const enqueue = app.slice(app.indexOf("function enqueueCurrentComposer(): void {"));
    expect(enqueue.indexOf("if (!admitted)")).toBeLessThan(enqueue.indexOf('setInput("");'));
  });

  it("restores an aborted prompt only into an empty composer", () => {
    expect(app).toContain("setInput((current) => current.trim() ? current : activePrompt.current ?? current)");
  });
});
