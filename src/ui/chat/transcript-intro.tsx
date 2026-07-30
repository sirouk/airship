import type { ConversationReceipt } from "../../receipts/types";
import { capabilityTierDetail, capabilityTierLabel, type CapabilityTier } from "./capability-tier";
import type { SessionPresentationMarker } from "./session-message-presentation";

/**
 * What an empty conversation says, in one place.
 *
 * Three components used to say it: a welcome *message* dressed as a turn no
 * model produced (avatar, Copy/Retry/Branch menu, a receipt pill reading
 * `Initial · Browser baseline`), a 42px guidance band above the transcript, and
 * a topbar action pill — three renderings of two sentences, ~119px of chrome,
 * and a Retry button with no referent.
 *
 * This is the one rendering. Both guidance sentences survive verbatim; the
 * welcome body's only claim they did not already make — that none of it needs
 * an account — survives as the runtime line; the capability tier keeps its
 * chip, its click target and its tooltip. `Initial` is the only string that
 * stops rendering, because it is definitionally true of the first item in an
 * empty transcript.
 */

/** Verbatim from `.chat-live-guidance`, line 1. */
export const TRANSCRIPT_INTRO_CAPABILITY_LINE = "Workspace, editor, terminal and Git work right now.";
/** Verbatim from `.chat-live-guidance`, line 2. Rendered only while it is true. */
export const TRANSCRIPT_INTRO_DEMO_LINE = "Chat needs a model provider; this composer is a deterministic demo.";
/** The welcome message's residue after deduplication against the two lines above. */
export const TRANSCRIPT_INTRO_RUNTIME_LINE = "The edge runtime is ready in this tab, with no account.";

/**
 * The seed message's body, which the three lines above now say between them.
 *
 * Kept as a constant rather than a literal because it is also the suffix that
 * `transcriptIntroNote` strips: a seeded conversation prefixes its own context
 * sentence to this body, and that sentence is the only part of a seed that is
 * not boilerplate — so it is the only part that still renders.
 */
export const TRANSCRIPT_SEED_BODY =
  "The edge runtime is ready. The workspace, editor, terminal and browser-owned Git already work in this tab with no account. Real model-backed chat needs a provider; until you connect one, the composer uses a deterministic local demo.";

/**
 * The per-conversation sentence a seed carries, with the shared body removed.
 *
 * Some seeds prefix their sentence to the body ("Resumed X from the encrypted
 * Vault."); others replace the body entirely ("Approval policy changed to Auto
 * Approve in this new pinned conversation. …"). Both are claims about *this*
 * conversation and both survive here — only the boilerplate the three intro
 * lines already say is subtracted. Whether a message is a seed at all is
 * decided by its own flag, not by this function.
 */
export function transcriptIntroNote(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const note = content.endsWith(TRANSCRIPT_SEED_BODY)
    ? content.slice(0, content.length - TRANSCRIPT_SEED_BODY.length)
    : content;
  const trimmed = note.trim();
  return trimmed.length > 0 && trimmed !== TRANSCRIPT_SEED_BODY ? trimmed : undefined;
}

export type TranscriptIntroProps = Readonly<{
  /**
   * The seeded conversation's own context sentence — "Resumed X from the
   * encrypted Vault.", "General profile loaded in a new pinned session." — kept
   * verbatim. It is the one part of a seed message that is not boilerplate.
   */
  note?: string;
  /** True only while the composer really is answering from the local demo. */
  demo: boolean;
  tier?: CapabilityTier;
  onOpenCapabilities(): void;
}>;

export function TranscriptIntro({ note, demo, tier, onOpenCapabilities }: TranscriptIntroProps) {
  return (
    <section class="transcript-intro" aria-label="About this conversation">
      <div class="transcript-intro__copy">
        {note ? <p class="transcript-intro__note">{note}</p> : null}
        <p class="transcript-intro__lead">
          <strong>{TRANSCRIPT_INTRO_CAPABILITY_LINE}</strong>
          {demo ? ` ${TRANSCRIPT_INTRO_DEMO_LINE}` : null}
        </p>
        <p class="transcript-intro__runtime">{TRANSCRIPT_INTRO_RUNTIME_LINE}</p>
      </div>
      {tier ? (
        <button
          class={`message-capability-tier transcript-intro__tier ${tier}`}
          type="button"
          title={`Initial session observation. ${capabilityTierDetail(tier)} Tool results name their live producing runtime separately.`}
          aria-label={`${capabilityTierLabel(tier)}. Initial session observation. Open Capabilities.`}
          onClick={onOpenCapabilities}
        >
          <span aria-hidden="true" />{capabilityTierLabel(tier)}
        </button>
      ) : null}
    </section>
  );
}

export type TranscriptMarkerProps = Readonly<{
  marker: SessionPresentationMarker;
  /**
   * Opens Proof at this marker's receipt. Only markers that record a billed
   * provider request have one, so the control appears only where there is
   * something to open.
   */
  onOpenProof?: (receipt: ConversationReceipt) => void;
}>;

/**
 * One session-scoped durable record, in the transcript, in sequence order.
 *
 * A rename is not a turn: it has no speaker, no answer, nothing to retry or
 * branch from, so it is a divider rather than a card. It is here at all because
 * the alternative that was shipped — a renderer that threw on it — cost users
 * an entire vault, and the alternative that is tempting — skipping it — would
 * quietly delete a record the user created while the page kept reporting its
 * turn count as though nothing were missing.
 *
 * The provenance line is not decoration. It states the durable sequence and the
 * event type, so a marker on screen can be found in the journal it came from,
 * and so a record this build cannot read still says exactly where it is.
 *
 * Where the record is an out-of-turn *inference* — today, the naming call — it
 * also carries a receipt, and this is the only surface that can hand that
 * receipt to Proof: turn receipts arrive on assistant rows, and a record with no
 * row had no route at all. A receipt nothing can open is not evidence.
 */
export function TranscriptMarker({ marker, onOpenProof }: TranscriptMarkerProps) {
  const receipt = marker.receipt;
  return (
    <div
      class="transcript-marker"
      data-presentable={marker.presentable ? "true" : "false"}
      role="note"
      aria-label={`Session record. ${marker.detail}`}
    >
      <p class="transcript-marker__detail">{marker.detail}</p>
      <p class="transcript-marker__provenance">
        {`Event ${String(marker.sequence)} · ${marker.kind} · ${marker.digest.slice(0, 15)}…`}
      </p>
      {receipt && onOpenProof ? (
        <button
          type="button"
          class="transcript-marker__proof"
          // The receipt id is in the name because a conversation can hold more
          // than one of these records, and "Open proof" alone would give a
          // screen-reader user several identically named controls.
          aria-label={`Open proof for receipt ${receipt.receiptId}`}
          onClick={() => onOpenProof(receipt)}
        >
          Open proof
        </button>
      ) : null}
    </div>
  );
}
