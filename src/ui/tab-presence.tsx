import { useEffect, useState } from "preact/hooks";

const CHANNEL = "airship-page-presence-v1";

/**
 * How often a tab re-announces itself, and how long silence is tolerated.
 *
 * The note latched on forever before this: a tab announced `hello`, every peer
 * answered `present`, and `setPeer(true)` was the last state change the
 * component ever made. Close the second tab and the first one kept warning
 * that page-memory state was not shared with a tab that no longer existed —
 * for the rest of the session, across every route.
 *
 * A departure broadcast is the honest primary signal and it is immediate, but
 * it cannot survive a crash or a force-quit, so the heartbeat is the backstop.
 * The expiry is deliberately not short: the *other* tab is by definition the
 * backgrounded one, and Chrome throttles timers in hidden tabs to roughly once
 * a minute, so consecutive beats can be 60s apart no matter what interval is
 * asked for. `EXPIRY_MS` clears that worst case plus a whole beat, so a peer is
 * only ever declared gone because it is gone — never because the OS slowed it
 * down. Shortening the window until the warning "goes away on its own" would
 * make it lie in the other direction; the departure broadcast is what makes
 * the ordinary case instant.
 */
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_EXPIRY_MS = 90_000;
/** How often the roster is re-checked. Cheap, and bounds how stale the note is. */
export const PRESENCE_SWEEP_MS = 5_000;

export type PresenceMessage = Readonly<{ type: "hello" | "present" | "bye"; id: string }>;

/**
 * The roster, as a value a test can drive without a browser.
 *
 * Kept deliberately free of `BroadcastChannel`, timers and Preact: the defect
 * this replaces was a state machine with no transition out of `true`, which is
 * exactly the thing worth asserting directly.
 */
function createPresenceRoster(selfId: string) {
  const peers = new Map<string, number>();
  /** Peers seen recently enough to still be believed. */
  const count = (now: number) =>
    [...peers.values()].filter((seen) => now - seen < PRESENCE_EXPIRY_MS).length;

  /** Fold a message in and return the reply this tab owes the sender, if any. */
  const receive = (message: PresenceMessage, now: number): PresenceMessage | undefined => {
    if (!message || message.id === selfId) return undefined;
    if (message.type === "bye") {
      peers.delete(message.id);
      return undefined;
    }
    if (message.type !== "hello" && message.type !== "present") return undefined;
    peers.set(message.id, now);
    return message.type === "hello" ? { type: "present", id: selfId } : undefined;
  };

  /** Drop expired peers and report whether the caller should re-probe. */
  const sweep = (now: number): boolean => {
    let dropped = false;
    for (const [id, seen] of peers) {
      if (now - seen >= PRESENCE_EXPIRY_MS) {
        peers.delete(id);
        dropped = true;
      }
    }
    return dropped;
  };

  return [count, receive, sweep] as const;
}

/** Public test adapter over the same closure the production note uses. */
export class TabPresenceRoster {
  readonly #roster: ReturnType<typeof createPresenceRoster>;

  constructor(selfId: string) {
    this.#roster = createPresenceRoster(selfId);
  }

  count(now: number): number {
    return this.#roster[0](now);
  }

  occupied(now: number): boolean {
    return this.count(now) > 0;
  }

  receive(message: PresenceMessage, now: number): PresenceMessage | undefined {
    return this.#roster[1](message, now);
  }

  sweep(now: number): boolean {
    return this.#roster[2](now);
  }
}

export function TabPresenceNote() {
  const [peers, setPeers] = useState(0);
  useEffect(() => {
    const page = globalThis;
    if (!("BroadcastChannel" in page)) return;
    const selfId = page.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const [count, receive, sweep] = createPresenceRoster(selfId);
    const channel = new BroadcastChannel(CHANNEL);
    const announce = (type: PresenceMessage["type"]) => channel.postMessage({ type, id: selfId });

    channel.onmessage = (event) => {
      const reply = receive(event.data as PresenceMessage, Date.now());
      if (reply) channel.postMessage(reply);
      setPeers(count(Date.now()));
    };

    const heartbeat = setInterval(() => announce("present"), PRESENCE_HEARTBEAT_MS);
    const sweepTimer = setInterval(() => {
      const now = Date.now();
      if (sweep(now)) announce("hello");
      setPeers(count(now));
    }, PRESENCE_SWEEP_MS);

    /*
     * `pagehide` rather than `beforeunload`: iOS Safari fires the latter
     * unreliably and never at all for a bfcache eviction, and this is the
     * signal that takes the warning down the instant the second tab closes.
     * A bfcache restore re-announces, because the peers that heard the
     * departure have already forgotten this tab.
     */
    const depart = () => announce("bye");
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) announce("hello");
    };
    page.addEventListener("pagehide", depart);
    page.addEventListener("pageshow", restore);

    announce("hello");
    return () => {
      clearInterval(heartbeat);
      clearInterval(sweepTimer);
      page.removeEventListener("pagehide", depart);
      page.removeEventListener("pageshow", restore);
      announce("bye");
      channel.close();
    };
  }, []);
  /*
   * Two forms of one fact, because a 390px topbar has no room for the sentence.
   *
   * Measured at 390×844: the sentence wrapped to a 71px-wide, 99px-tall
   * six-line block anchored at y=0 in a topbar whose next row starts at y=52 —
   * it overprinted the wordmark, the runtime chip and the profile title, so the
   * disclosure collided with the header instead of being read. The sentence is
   * clipped out of the *layout* below the phone breakpoint and stays in the
   * accessible name, and the count takes its place on screen: the eye gets a
   * legible fact at 40px, a screen reader still gets the whole claim.
   */
  return peers ? (
    <span class="tab-presence-note" role="status">
      <span class="tab-presence-note__sentence">Open in another tab · page-memory state is not shared</span>
      <span class="tab-presence-note__count" aria-hidden>{peers + 1} tabs</span>
    </span>
  ) : null;
}
