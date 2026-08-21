import { capabilityTierDetail, capabilityTierLabel, type CapabilityTier } from "./capability-tier";
import type { SessionPresentationMarker } from "./session-message-presentation";
import { densityAllows, usePresentationDensity } from "../density";
import { DeferredRunDetails } from "./deferred-run-details";

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
 * What Airship is, before a person types anything.
 *
 * Measured on the first screen of a cold load, both viewports: the body text
 * contained no occurrence of "browser" and none of "no server". The whole
 * self-description was the wordmark and the eyebrow "EDGE RUNTIME", and the
 * paragraph that does explain the product only arrived after a message had
 * been sent. Somebody who opens the link and reads was told what would not be
 * saved and that the composer is a demo, and never told what they had opened.
 *
 * Three plain facts, in the words a newcomer already has, and each one is what
 * the code does: the client is static and runs in the page, no Airship service
 * is behind it, and nothing asks for an account. It renders in every density,
 * beside the two sentences that already survive one, because "what is this" is
 * the same class of answer as "what will persist".
 */
export const TRANSCRIPT_INTRO_WHAT_LINE =
  "Airship runs in your browser. There is no Airship server and no account to create.";

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
export function transcriptIntroNote(
  content: string | undefined,
  seedBody: typeof TRANSCRIPT_SEED_BODY,
): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  const note = trimmed.endsWith(seedBody)
    ? trimmed.slice(0, -seedBody.length).trim()
    : trimmed;
  return note || undefined;
}

/**
 * What a conversation that is not being written down says about itself, before
 * anything has been typed into it.
 *
 * The Atlas scanned every leaf text node on the chat view for durability
 * language and got `[]`. The only statement of the fact lived inside a popover
 * behind an unlabelled 44px chip, and the persona who lost four messages to a
 * refresh had never seen it. This is the same fact at the moment it can still
 * be acted on — the Vault route's comparison table is good enough to carry the
 * decision, it was simply only ever reachable after the loss.
 */
export const TRANSCRIPT_INTRO_UNSAVED_LINE =
  "This conversation is not being saved. It lives in this tab's memory, and closing or reloading the page releases it.";

export type TranscriptIntroProps = Readonly<{
  /**
   * The seeded conversation's own context sentence — "Resumed X from the
   * encrypted Vault.", "General profile loaded in a new pinned session." — kept
   * verbatim. It is the one part of a seed message that is not boilerplate.
   */
  note?: string;
  /** True only while the composer really is answering from the local demo. */
  demo: boolean;
  /** True while this conversation's journal is page memory only. */
  unsaved?: boolean;
  /** Present with `unsaved`; the one gesture from the fact to the remedy. */
  onKeepConversations?(): void;
  tier?: CapabilityTier;
  onOpenCapabilities(): void;
}>;

export function TranscriptIntro({
  note,
  demo,
  unsaved = false,
  onKeepConversations,
  tier,
  onOpenCapabilities,
}: TranscriptIntroProps) {
  /*
   * Minimal spends the empty conversation on the composer, not on the
   * marketing: the capability sentence, the runtime line and the tier chip
   * are commentary and telemetry, and unmount. Consequence never mounts out —
   * the per-seed note, the not-being-saved warning and the honesty that the
   * composer is a demo stay in every density, because those are answers to
   * "what is this" and "what will persist", not interpretation of the chrome.
   */
  const density = usePresentationDensity();
  const full = densityAllows("commentary", density);
  if (!full && !note && !unsaved && !demo) return null;
  return (
    <section class="transcript-intro" aria-label="About this conversation">
      <div class="transcript-intro__copy">
        {/* First, because it is the question a newcomer asks first. Held to the
            same two states that already decide whether this component says
            anything at minimal density: nothing kept yet, or no provider yet.
            Somebody who has chosen storage and connected a model has answered
            it, and gets the quiet screen the density asks for. It reuses
            the lead's own recipe under its own name, so the density contract
            that asserts what the lead mounts stays unambiguous. */}
        {unsaved || demo ? <p class="transcript-intro__what">{TRANSCRIPT_INTRO_WHAT_LINE}</p> : null}
        {note ? <p class="transcript-intro__note">{note}</p> : null}
        {unsaved ? (
          <p class="transcript-intro__unsaved">
            {TRANSCRIPT_INTRO_UNSAVED_LINE}
            {onKeepConversations ? (
              <button type="button" class="transcript-intro__keep" onClick={onKeepConversations}>
                Keep it on this device<span aria-hidden="true"> →</span>
              </button>
            ) : null}
          </p>
        ) : null}
        {full ? (
          <p class="transcript-intro__lead">
            <strong>{TRANSCRIPT_INTRO_CAPABILITY_LINE}</strong>
            {demo ? ` ${TRANSCRIPT_INTRO_DEMO_LINE}` : null}
          </p>
        ) : demo ? (
          <p class="transcript-intro__lead">{TRANSCRIPT_INTRO_DEMO_LINE}</p>
        ) : null}
        {full ? <p class="transcript-intro__runtime">{TRANSCRIPT_INTRO_RUNTIME_LINE}</p> : null}
      </div>
      {full && tier ? (
        <button
          class={`message-capability-tier transcript-intro__tier ${tier}`}
          type="button"
          title={`Initial session observation. ${capabilityTierDetail(tier)} Tool results name their live producing runtime separately.`}
          aria-label={`${capabilityTierLabel(tier)}. Initial session observation. Open Capabilities.`}
          onClick={onOpenCapabilities}
        >
          <span class="message-capability-tier__dot" aria-hidden="true" />
          <span class="message-capability-tier__label">{capabilityTierLabel(tier)}</span>
        </button>
      ) : null}
    </section>
  );
}

export type TranscriptMarkerProps = Readonly<{
  marker: SessionPresentationMarker;
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
 * Historical or imported out-of-turn inference records can carry a receipt.
 * The neutral run metadata stays visible even though the record is not an
 * assistant row. Current conversation naming is local and creates no request.
 */
export function TranscriptMarker({ marker }: TranscriptMarkerProps) {
  const density = usePresentationDensity();
  return (
    <div
      class="transcript-marker"
      data-presentable={marker.presentable ? "true" : "false"}
      role="note"
      aria-label={`Session record. ${marker.detail}`}
    >
      <p class="transcript-marker__detail">{marker.detail}</p>
      {marker.receipt ? <DeferredRunDetails receipt={marker.receipt} /> : null}
      {/* The inherited turns, readable. The count in the sentence above was the
          only evidence a branch carried anything, and it sat over an empty
          transcript showing the newcomer empty state — so the person was asked
          to believe a number while the model answered from messages they could
          not see. Collapsed, because these are ancestors rather than this
          conversation's own turns. */}
      {marker.carriedContext?.length ? (
        <details class="transcript-marker__carried">
          <summary>{`Read the ${String(marker.carriedContext.length)} carried ${marker.carriedContext.length === 1 ? "message" : "messages"}`}</summary>
          <ol>
            {marker.carriedContext.map((message, index) => (
              <li key={`${String(index)}-${message.role}`}>
                <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "Airship" : message.role}</strong>
                <p>{message.content}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {/* The provenance line is raw detail — sequence, kind, digest — which
          the mantra puts one deliberate action away, always. The record's own
          sentence above is neither. */}
      {densityAllows("raw", density) ? (
        <p class="transcript-marker__provenance">
          {`Event ${String(marker.sequence)} · ${marker.kind} · ${marker.digest.slice(0, 15)}…`}
        </p>
      ) : null}
    </div>
  );
}
