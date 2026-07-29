import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import type { SessionManifest } from "../core/contracts";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import {
  nextFavoriteMovePayload,
  PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
  resolveProfileFavoriteOrder,
} from "./favorite-order";
import { SessionLibrary } from "./library";

const DIGEST = `sha256:${"A".repeat(43)}`;

describe("profile favorite order", () => {
  it("reorders by append-only moves while favorite writes leave recency stable", async () => {
    const journal = controlledJournal(new MemoryJournalBackend(), "primary");
    const first = await journal.createSession("First", await manifest("profile-1"));
    const second = await journal.createSession("Second", await manifest("profile-1"));
    const library = new SessionLibrary(journal);
    const activityBefore = new Map((await library.list({ profileId: "profile-1" })).items
      .map((item) => [item.id, item.updatedAt] as const));

    await library.setFavorite(first.id, "profile-1", true);
    await library.setFavorite(second.id, "profile-1", true);
    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId))
      .toEqual([first.id, second.id]);

    await library.moveFavoriteBefore(second.id, "profile-1", first.id);
    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId))
      .toEqual([second.id, first.id]);
    expect(new Map((await library.list({ profileId: "profile-1" })).items
      .map((item) => [item.id, item.updatedAt] as const))).toEqual(activityBefore);

    const events = await journal.readEvents(second.id);
    const move = events.find((event) => event.type === PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE);
    expect(move).toMatchObject({
      payload: {
        version: 1,
        profileId: "profile-1",
        sessionId: second.id,
        generation: 1,
      },
    });
  });

  it("deterministically replays concurrent equal-generation writers", async () => {
    const backend = new MemoryJournalBackend();
    const setup = controlledJournal(backend, "setup");
    const first = await setup.createSession("First", await manifest("profile-1"));
    const second = await setup.createSession("Second", await manifest("profile-1"));
    const third = await setup.createSession("Third", await manifest("profile-1"));
    const library = new SessionLibrary(setup);
    await library.setFavorite(first.id, "profile-1", true);
    await library.setFavorite(second.id, "profile-1", true);
    await library.setFavorite(third.id, "profile-1", true);
    const base = await resolveProfileFavoriteOrder(setup, "profile-1");

    const left = controlledJournal(backend, "left", "2026-07-18T01:00:00.000Z");
    const right = controlledJournal(backend, "right", "2026-07-18T01:00:00.000Z");
    await Promise.all([
      left.append(third.id, [{
        type: PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
        payload: nextFavoriteMovePayload(base, third.id, first.id),
      }]),
      right.append(first.id, [{
        type: PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
        payload: nextFavoriteMovePayload(base, first.id),
      }]),
    ]);

    const [fromLeft, fromRight] = await Promise.all([
      resolveProfileFavoriteOrder(left, "profile-1"),
      resolveProfileFavoriteOrder(right, "profile-1"),
    ]);
    expect(fromLeft.favorites).toEqual(fromRight.favorites);
    const ids = fromLeft.favorites.map((favorite) => favorite.sessionId);
    expect(ids.at(-1)).toBe(first.id);
    expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(first.id));
    const moves = (await Promise.all([
      left.readEvents(third.id),
      right.readEvents(first.id),
    ])).flat().filter((event) => event.type === PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE);
    expect(moves.map((event) => (event.payload as { generation: number }).generation)).toEqual([1, 1]);
  });

  it("does not carry an obsolete move across removal, re-pin, or profile boundaries", async () => {
    const journal = controlledJournal(new MemoryJournalBackend(), "epochs");
    const first = await journal.createSession("First", await manifest("profile-1"));
    const second = await journal.createSession("Second", await manifest("profile-1"));
    const foreign = await journal.createSession("Foreign", await manifest("profile-2"));
    const library = new SessionLibrary(journal);
    await library.setFavorite(first.id, "profile-1", true);
    await library.setFavorite(second.id, "profile-1", true);
    await library.moveFavoriteBefore(second.id, "profile-1", first.id);
    await library.setFavorite(second.id, "profile-1", false);
    await library.setFavorite(second.id, "profile-1", true);

    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId))
      .toEqual([first.id, second.id]);
    expect(await library.favorites("profile-2")).toEqual([]);
    await expect(library.moveFavoriteBefore(first.id, "profile-1", foreign.id))
      .rejects.toThrow(/anchor is not in the active profile/u);
    await expect(library.setFavorite(first.id, "profile-2", false))
      .rejects.toThrow(/active profile/u);
  });
});

function controlledJournal(
  backend: MemoryJournalBackend,
  namespace: string,
  fixedTime?: string,
): EventJournal {
  let tick = 0;
  let identity = 0;
  return new EventJournal(
    backend,
    () => fixedTime ?? `2026-07-18T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    () => `${namespace}-${String(++identity).padStart(4, "0")}`,
  );
}

async function manifest(profileId: string): Promise<SessionManifest> {
  return createSessionManifest({
    systemPrompt: "Keep favorite order profile-local.",
    providerId: "demo",
    model: "model-a",
    tools: [],
    workspaceId: `memory://${profileId}`,
    capabilityTier: "web-baseline",
    now: "2026-07-18T00:00:00.000Z",
    profile: {
      version: 1,
      profileId,
      profileRevision: DIGEST,
      themeId: "theme-1",
      themeDigest: DIGEST,
      resolvedSkills: [],
      skillSetDigest: DIGEST,
      resolutionDigest: DIGEST,
    },
  });
}
