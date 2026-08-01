/**
 * Whether reloading this page right now would throw away someone's work.
 *
 * The shell reloads itself when a new service worker takes control, so
 * COOP/COEP are established before anyone starts working. That is the right
 * instinct and the fence around it was too narrow: it only asked whether a
 * trusted input gesture had been observed. A conversation exists before anyone
 * types, and page memory does not cross a reload.
 *
 * Measured on a fresh context against the production build — which is what a
 * first visit actually is — the takeover landed during the Vault ceremony's
 * hand-off to chat: one main-frame navigation after the ceremony, three after
 * loading `#chat`. The conversation created before that reload was page-memory,
 * so it did not survive, and every downstream symptom followed from that single
 * fact: the first screen reporting a conversation lost to a reload nobody asked
 * for, a turn rendered and reported complete but never journaled, and the
 * address afterwards resolving against a journal that could not hold it
 * ("Fork required") beside a topbar reading "Encrypted Local Device vault
 * active".
 *
 * It hid because a warm service worker has no update pending: ten consecutive
 * runs in a reused browser profile survived. Every fresh context failed.
 *
 * The question this module answers is deliberately narrow. It is not "has the
 * person interacted" and not "is anything unsaved" — it is "is there state on
 * this page that a reload would destroy and no authority could give back".
 * Under a durable Vault the answer is no however much has been said, because
 * the journal is on the far side of the reload. Under page memory the answer is
 * yes as soon as there is anything at all.
 */
export type ReloadRisk = Readonly<{
  /** True once the journal this page writes through survives a page load. */
  durableAuthority: boolean;
  /** Turns already recorded in the conversation on screen. */
  recordedTurns: number;
  /** Text sitting in the composer that has not been sent. */
  unsentDraft: boolean;
}>;

export function reloadWouldDiscardWork(risk: ReloadRisk): boolean {
  // A durable journal is the whole point of adopting one: it is readable again
  // on the other side, so a reload costs a repaint and nothing else.
  if (risk.durableAuthority) return false;
  return risk.recordedTurns > 0 || risk.unsentDraft;
}

const NOTHING_AT_RISK: ReloadRisk = Object.freeze({
  durableAuthority: false,
  recordedTurns: 0,
  unsentDraft: false,
});

let current: ReloadRisk = NOTHING_AT_RISK;

/**
 * Published by the shell as its own state changes, read by the service-worker
 * listener at the moment it has to choose between reloading and offering.
 *
 * A module-scope holder rather than a prop or a context because the reader is a
 * `controllerchange` handler registered once at mount, outside any render, and
 * threading a live value into it through Preact would mean re-registering the
 * listener on every keystroke.
 */
export function publishReloadRisk(risk: ReloadRisk): void {
  current = Object.freeze({ ...risk });
}

export function readReloadRisk(): ReloadRisk {
  return current;
}

/** Test seam: restores the module to the state a fresh page load has. */
export function resetReloadRisk(): void {
  current = NOTHING_AT_RISK;
}
