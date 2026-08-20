import { useEffect, useState } from "preact/hooks";
import { densityAllows, usePresentationDensity } from "../density";
import { COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";

/**
 * The parts of the composer that are decisions rather than plumbing.
 *
 * The composer's footer is the one band whose scope is "the keystroke you are
 * about to make", so everything here answers a question the user has at the
 * instant they press a key: what Enter will do, and
 * how much of the screen may this box take before it starts eating the
 * conversation. Each is a pure function first and a component second, because
 * every one of them was previously either invisible, hover-only (the growth
 * cap), or nowhere at all
 * (the Enter contract), and a fact that only exists inside a render pass cannot
 * be asserted.
 */

/**
 * The resting placeholder.
 *
 * The old string ("Ask Airship or type / for tools and session commands…")
 * measured 396px into a 338px desktop content box and a 175px phone one, so it
 * wrapped and was sliced mid-line at both. The words it drops are not lost:
 * the slash menu enumerates the commands by name under its own sticky header,
 * and the full sentence stays in the textarea's `title`. A menu listing the
 * commands is a better carrier than a clipped sentence describing the menu.
 */
export const COMPOSER_PLACEHOLDER = "Message Airship — / for commands";
export const COMPOSER_PLACEHOLDER_NARROW = "Message Airship";
/** Below this width even the em-dash form starts to crowd the send control. */
export const COMPOSER_NARROW_PLACEHOLDER_QUERY = "(max-width: 480px)";
/** The words the placeholder no longer spells out, kept verbatim on the control. */
export const COMPOSER_PLACEHOLDER_TITLE =
  "Ask Airship, or type / for tools and session commands.";
/** The slash menu is now the carrier for what the placeholder used to describe. */
export const SLASH_MENU_HEADER = "Commands and session tools · Enter or Tab to accept";

export function composerPlaceholder(narrow: boolean): string {
  return narrow ? COMPOSER_PLACEHOLDER_NARROW : COMPOSER_PLACEHOLDER;
}

/** The declared ceiling on a tall viewport; unchanged from the shipped value. */
export const COMPOSER_MAX_HEIGHT = 180;
/**
 * The share of the *visible* viewport the textarea may claim.
 *
 * With a soft keyboard up, an iPhone 14 Pro Max reports a 404px visual
 * viewport. The old flat 180px cap therefore let the composer region take 64%
 * of what the user could see and left the transcript 24px — the message being
 * replied to was off-screen. 0.34 keeps the composer under half the visible
 * height at every keyboard height while leaving the desktop cap untouched.
 */
export const COMPOSER_VIEWPORT_SHARE = 0.34;

/**
 * The tallest the textarea may grow, given its declared cap and what is visible.
 *
 * Deliberately takes numbers rather than reading the DOM: the whole point of the
 * cap is a claim about the ratio between the composer and the transcript, and
 * that claim has to be checkable without a browser.
 */
export function composerGrowthCap(
  declaredMaximum: number,
  availableHeight: number,
  minimumHeight: number,
): number {
  const declared = Number.isFinite(declaredMaximum) && declaredMaximum > 0
    ? declaredMaximum
    : COMPOSER_MAX_HEIGHT;
  const visible = Number.isFinite(availableHeight) && availableHeight > 0
    ? Math.round(availableHeight * COMPOSER_VIEWPORT_SHARE)
    : declared;
  return Math.max(minimumHeight, Math.min(declared, visible));
}

/**
 * Whether the placeholder should shorten, tracked as state so the value the
 * textarea renders is the value the viewport currently justifies.
 */
export function useNarrowComposer(query = COMPOSER_NARROW_PLACEHOLDER_QUERY): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return narrow;
}


/**
 * Why an attachment-only composer refuses Enter, in one sentence, everywhere.
 *
 * The sentence stays at the one fact this composer owns: the image travels in
 * the request beside the prompt, so a sendable turn needs both.
 */
export function composerAttachmentNeedsText(): string {
  return "Add a message to send with this attachment. The image travels inside the request beside your prompt, so a turn needs both.";
}

/** What this page runtime can currently do with an image the composer holds. */
export type ComposerVisionCapability = "supported" | "model-lacks-vision" | "disconnected";

/**
 * What just happened to the files someone dropped on the composer.
 *
 * Every refusal is counted, including the one that used to be silent. The
 * attachment cap was treated as a non-event: only the MIME rejection produced
 * a sentence, and the success clause was derived from the *admitted* count, so
 * dropping a ninth image onto eight pending ones announced "0 images are ready
 * for inline vision inference" — a success sentence, with a zero in it, for a
 * file that was thrown away. A refusal that cannot be read is
 * indistinguishable from a bug, so the counts are stated and the success
 * clause only appears when something was actually admitted.
 */
export function composerAttachmentNotice(input: Readonly<{
  added: number;
  rejected: number;
  overflow: number;
  capability: ComposerVisionCapability;
}>): string | undefined {
  const refusals: string[] = [];
  if (input.rejected > 0) {
    refusals.push(`${input.rejected} non-image attachment${input.rejected === 1 ? " was" : "s were"} not added — this milestone sends bounded image inputs`);
  }
  if (input.overflow > 0) {
    refusals.push(`${input.overflow} image${input.overflow === 1 ? " was" : "s were"} not added: the composer holds at most ${COMPOSER_ATTACHMENT_LIMIT} attachments`);
  }
  const admitted = input.added > 0
    ? input.capability === "supported"
      ? `${input.added} image${input.added === 1 ? " is" : "s are"} ready for inline vision inference.`
      : input.capability === "model-lacks-vision"
        ? "Choose a model whose provider or local-discovery record explicitly includes image input before sending."
        : "Connect a vision-capable inference model before sending this image."
    : undefined;
  if (refusals.length === 0) return admitted;
  return `${refusals.join("; ")}.${admitted ? ` ${admitted}` : ""}`;
}

export type ComposerKeyhint = Readonly<{ key: string; action: string }>;

/**
 * The Enter contract, stated before the user trips over it.
 *
 * Enter-sends, Shift+Enter-newlines and Enter-while-busy-queues have all shipped
 * for three waves and appeared nowhere in `src/ui/` — the queue behaviour in
 * particular is discoverable only by pressing Enter during a turn and being
 * surprised. The legend swaps its first verb while a turn is running, so the
 * hint never states something that is not currently true.
 */
export function composerKeyhints(busy: boolean): readonly ComposerKeyhint[] {
  return Object.freeze([
    Object.freeze({ key: "↵", action: busy ? "queue" : "send" }),
    Object.freeze({ key: "⇧↵", action: "newline" }),
  ]);
}

export function ComposerKeyhintLegend({ busy }: Readonly<{ busy: boolean }>) {
  /*
   * The chords a person learns once are commentary on an interface they can
   * already feel: at minimal the composer stays unadorned, and the legend is
   * off the keys until the density asks for the explanatory shell back.
   */
  const density = usePresentationDensity();
  if (!densityAllows("commentary", density)) return null;
  return (
    // `aria-hidden`: this is a redundant legend for a contract screen-reader
    // users already receive from the textarea's own role and from the queue's
    // `aria-live` region. Rendering it into the accessible name would make the
    // composer's label churn on every focus change.
    <span class="composer-keyhint" aria-hidden="true">
      {composerKeyhints(busy).map((hint) => (
        <span key={hint.action}><kbd>{hint.key}</kbd> {hint.action}</span>
      ))}
    </span>
  );
}
