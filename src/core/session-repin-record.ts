/**
 * The re-pin record: its name, and the one question a turn asks of it.
 *
 * Its own file, and that is not tidiness. `inference-binding.ts` is reachable
 * from `sessions/domain.ts`, which the shell imports eagerly, so a predicate
 * living there would ride into the baseline JavaScript a first paint waits on
 * — for a rule only two turn engines ever ask. Both of those are lazily loaded.
 * The name is here rather than in `sessions/session-repin.ts` because `core`
 * may not import `sessions` back without closing a cycle, and the writer and
 * the reader of this record must not be able to drift apart.
 */

export const SESSION_RE_PINNED_EVENT_TYPE = "session.re-pinned";

/**
 * Whether this journal has already recorded that the thread runs on the route
 * a turn is about to use.
 *
 * The exact-binding refusal in `assertPinnedInferenceTransport` exists so a
 * conversation is never *silently* retargeted at a different account. A
 * journaled re-pin is the opposite of silent: the person was shown what had
 * moved, pressed the verb themselves, and the change went into the same digest
 * chain as the transcript, before this turn. So the refusal keeps its whole
 * point and stops being the reason a finished conversation could only be
 * forked.
 *
 * The latest record wins and only the latest is consulted: a route that has
 * been re-pinned away from is authority for nothing.
 */
export function journalRePinsToRoute(
  events: readonly Readonly<{ type: string; payload: unknown }>[],
  providerId: string,
  posture: string,
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== SESSION_RE_PINNED_EVENT_TYPE) continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    return record.version === 1 && record.providerId === providerId && record.posture === posture;
  }
  return false;
}
