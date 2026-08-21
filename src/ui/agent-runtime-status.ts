/**
 * The agent-runtime status surface for the session view — and the reason it
 * is a deferred chunk.
 *
 * The tag answers one question beside the conversation's title: which engine
 * owns this session, and what a person can do about a pin they did not
 * choose. The answer is a pure function of the session's journal (see
 * `src/prime/runtime/agent-runtimes.ts`, the authority this module renders),
 * so the tag itself is tiny — but nothing reads it at first paint. An empty
 * conversation has not been asked who owns it yet, and the journal read it
 * takes is async anyway; the engine question can afford to arrive after the
 * shell the way every other instrument on this bar does.
 *
 * Loading is the caller's side (`app.tsx` fetches this module on mount with
 * the same `loadRetryableChunk` path the other deferred surfaces use). What
 * lives here is the surface itself: a pure element factory for tests and
 * layout, and the journal-reading tag the session view mounts.
 */

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChild } from "preact";
import type { SessionManifest } from "../core/contracts";
import type { DurableEvent, EventJournal } from "../core/journal";
import {
  formatAgentRuntimeStatusLine,
  getAgentRuntimeStatus,
  type AgentRuntimeStatus,
  type AgentRuntimeStatusRecord,
} from "../prime/runtime/agent-runtimes";

/**
 * Neutral detail for the record class that carried the engine pin. A marker is
 * a stored selection, not a statement about the engine's integrity or origin.
 */
const RECORD_DETAIL: Readonly<Record<AgentRuntimeStatusRecord, string>> = Object.freeze({
  "selection-marker": "The journal records Prime as the selected engine for this session.",
  "legacy-selection-marker": "A historical journal marker records Prime as the selected engine for this session.",
  "prime-records": "Prime journal records select the Prime engine for this session.",
  "airship-history": "Airship turn records select the airship-core engine for this session.",
  /*
   * Names no engine. The authority supplies `defaultEngine`, so this sentence
   * remains correct if the gate's default changes.
   */
  empty: "No engine-selection record is present; the engine below is the one this session would start on.",
});

/**
 * The tag, pure: the whole render is a function of the authority's status,
 * so tests and stories never need a journal.
 *
 * The full sentence rides on `title` (hover and focus) rather than being
 * duplicated in the row — the bar's one-line budget belongs to the engine
 * claim, and the remedy, where there is one, is exactly the vocabulary the
 * gate's refusal already uses.
 */
export function renderAgentRuntimeStatus(status: AgentRuntimeStatus): ComponentChild {
  const line = formatAgentRuntimeStatusLine(status);
  const detail = status.canForkSwitch && status.forkRemedy
    ? `${RECORD_DETAIL[status.recordType]} ${status.forkRemedy}`
    : RECORD_DETAIL[status.recordType];
  return h(
    "span",
    {
      // `eyebrow` is the shell's small-fact class, so the tag reads as one
      // more instrument on the bar without styling of its own.
      class: "eyebrow agent-runtime-status",
      "data-engine": status.pinnedEngine ?? "unpinned",
      "data-record": status.recordType,
      title: detail,
    },
    line,
  );
}

export type AgentRuntimeStatusTagProps = Readonly<{
  journal: EventJournal;
  sessionId: string;
  manifest?: SessionManifest;
  /** Bumped by the shell as journal events land; the pin can only move once. */
  revision: number;
}>;

/**
 * The mounted tag: reads the session's journal once per revision and renders
 * the status. Until the read lands it renders nothing — an early tag saying
 * "prime (default)" beside a session whose airship history is still loading
 * is a wrong answer, and a wrong engine claim is worse than a brief absence,
 * because the pin, once written, never moves again.
 */
export function AgentRuntimeStatusTag(props: AgentRuntimeStatusTagProps): ComponentChild {
  const [events, setEvents] = useState<DurableEvent[]>();
  useEffect(() => {
    let live = true;
    props.journal.readEvents(props.sessionId)
      .then((read) => { if (live) setEvents(read); })
      // A failed read renders nothing, the same honest absence as a journal
      // that is still loading, rather than a claim derived from partial events.
      .catch(() => { if (live) setEvents(undefined); });
    return () => { live = false; };
  }, [props.journal, props.sessionId, props.revision]);
  if (events === undefined) return null;
  return renderAgentRuntimeStatus(getAgentRuntimeStatus({
    sessionId: props.sessionId,
    events,
    manifest: props.manifest,
  }));
}
