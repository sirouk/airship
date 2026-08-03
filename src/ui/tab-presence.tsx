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
export class TabPresenceRoster {
  readonly #peers = new Map<string, number>();

  constructor(private readonly selfId: string) {}

  /** Peers seen recently enough to still be believed. */
  count(now: number): number {
    return [...this.#peers.values()].filter((seen) => now - seen < PRESENCE_EXPIRY_MS).length;
  }

  occupied(now: number): boolean {
    return this.count(now) > 0;
  }

  /**
   * Fold a message in. Returns the reply this tab owes the sender, if any:
   * a `hello` is an arrival asking who else is here, so it is answered; a
   * `present` is already an answer and must not be, or two tabs ping-pong.
   */
  receive(message: PresenceMessage, now: number): PresenceMessage | undefined {
    if (!message || message.id === this.selfId) return undefined;
    if (message.type === "bye") {
      this.#peers.delete(message.id);
      return undefined;
    }
    if (message.type !== "hello" && message.type !== "present") return undefined;
    this.#peers.set(message.id, now);
    return message.type === "hello" ? { type: "present", id: this.selfId } : undefined;
  }

  /**
   * Drop the expired and report whether anyone was dropped, so the caller can
   * re-probe: a peer that merely missed its window under background throttling
   * answers the follow-up `hello` and is back inside one round trip.
   */
  sweep(now: number): boolean {
    let dropped = false;
    for (const [id, seen] of this.#peers) {
      if (now - seen >= PRESENCE_EXPIRY_MS) {
        this.#peers.delete(id);
        dropped = true;
      }
    }
    return dropped;
  }
}

export function TabPresenceNote() {
  const [peers, setPeers] = useState(0);
  const peer = peers > 0;
  useEffect(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const selfId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const roster = new TabPresenceRoster(selfId);
    const channel = new BroadcastChannel(CHANNEL);
    const announce = (type: PresenceMessage["type"]) => channel.postMessage({ type, id: selfId });

    channel.onmessage = (event) => {
      const reply = roster.receive(event.data as PresenceMessage, Date.now());
      if (reply) channel.postMessage(reply);
      setPeers(roster.count(Date.now()));
    };

    const heartbeat = setInterval(() => announce("present"), PRESENCE_HEARTBEAT_MS);
    const sweep = setInterval(() => {
      const now = Date.now();
      if (roster.sweep(now)) announce("hello");
      setPeers(roster.count(now));
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
    globalThis.addEventListener("pagehide", depart);
    globalThis.addEventListener("pageshow", restore);

    announce("hello");
    return () => {
      clearInterval(heartbeat);
      clearInterval(sweep);
      globalThis.removeEventListener("pagehide", depart);
      globalThis.removeEventListener("pageshow", restore);
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
  return peer ? (
    <span class="tab-presence-note" role="status">
      <span class="tab-presence-note__sentence">Open in another tab · page-memory state is not shared</span>
      <span class="tab-presence-note__count" aria-hidden="true">{peers + 1} tabs</span>
    </span>
  ) : null;
}
