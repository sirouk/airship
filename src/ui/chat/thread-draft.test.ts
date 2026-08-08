import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  claimThreadDraftHydration,
  readThreadDraft,
  threadDraftKey,
  writeThreadDraft,
} from "./thread-draft";

describe("thread drafts", () => {
  it("isolates drafts by opaque conversation identity", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    writeThreadDraft("session-a", "alpha", storage);
    writeThreadDraft("session-b", "bravo", storage);
    expect(readThreadDraft("session-a", storage)).toBe("alpha");
    expect(readThreadDraft("session-b", storage)).toBe("bravo");
    expect(threadDraftKey("session-a")).not.toBe(threadDraftKey("session-b"));
  });

  it("fails closed on malformed optional storage", () => {
    expect(readThreadDraft("session-a", { getItem: () => "not-json" })).toBe("");
    const values = new Map([["seed", "value"]]);
    writeThreadDraft("session-a", "", {
      setItem: () => undefined,
      removeItem: (key) => { values.set(key, "removed"); },
    });
    expect([...values.values()]).toContain("removed");
  });

  it("hydrates each effective identity once while route state normalizes", () => {
    const fence: { current: string | undefined } = { current: undefined };

    expect(claimThreadDraftHydration(fence, "session-b")).toBe("hydrate");
    // The route request cleared after session-b became active. The effective
    // identity did not change, so this must not hydrate an empty draft again.
    expect(claimThreadDraftHydration(fence, "session-b")).toBe("unchanged");

    expect(claimThreadDraftHydration(fence, "session-a")).toBe("hydrate");
    expect(claimThreadDraftHydration(fence, "session-b")).toBe("hydrate");
  });

  it("protects a fork prefill through the same-identity normalization pass", () => {
    const fence: { current: string | undefined } = { current: "source-session" };

    expect(claimThreadDraftHydration(fence, "fork-session", "fork-session")).toBe("preserve");
    expect(claimThreadDraftHydration(fence, "fork-session")).toBe("unchanged");
  });
});

/*
 * The one caller of `claimThreadDraftHydration`, read where it lives.
 *
 * This module cannot see the defect on its own: `hydrate` is the correct
 * verdict for a cold boot, and what went wrong was what `app.tsx` then did with
 * it. The composer is editable from the first paint; the boot conversation is
 * minted a beat later; the hydration pass that identity triggers used to assign
 * that conversation's stored draft — empty, because it is seconds old —
 * straight over whatever had been typed while it was being minted.
 *
 * It cost `narrow-viewport-overflow`'s three paragraph specs an intermittent
 * 30-second timeout each, on `Send message` never becoming enabled after a
 * `fill`, and it cost a person who types the instant the page paints their
 * whole opening line with nothing on screen to explain it.
 *
 * So the assertion is about assignment shape rather than about a name: the
 * hydration effect may not set the composer or its attachments to a computed
 * value outright, because there is no frame in which it can know that nothing
 * is being typed underneath it.
 */
describe("the composer's hydration pass in app.tsx", () => {
  it("never assigns over the live composer without reading it first", async () => {
    const appSource = await readFile(new URL("../app.tsx", import.meta.url), "utf8");
    const claim = appSource.indexOf("claimThreadDraftHydration(");
    expect(claim, "app.tsx claims a hydration pass").toBeGreaterThan(-1);
    const start = appSource.lastIndexOf("useEffect(() => {", claim);
    const end = appSource.indexOf("}, [chatRouteRequest, sessionId]);", claim);
    expect(start, "the claim sits inside an effect").toBeGreaterThan(-1);
    expect(end, "the hydration effect closes on its own dependencies").toBeGreaterThan(claim);
    const effect = appSource.slice(start, end);

    // A functional updater is the only form that can see a keystroke that
    // landed between this effect being scheduled and being run.
    for (const [call] of effect.matchAll(/set(?:Input|Attachments)\([^\n]*/gu)) {
      expect(call, "hydration must read the live composer before replacing it")
        .toMatch(/set(?:Input|Attachments)\(\(current\) =>/u);
    }
    expect(effect, "the boot claim is the pass with nothing behind it to switch away from")
      .toContain("draftHydrationIdentity.current === undefined");
  });
});
