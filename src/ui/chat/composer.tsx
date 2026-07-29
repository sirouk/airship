import { useEffect, useState } from "preact/hooks";
import { Popover } from "../popover";
import { Seal, type SealState } from "../seal";
import { COMPOSER_ATTACHMENT_LIMIT } from "./composer-state";

/**
 * The parts of the composer that are decisions rather than plumbing.
 *
 * The composer's footer is the one band whose scope is "the keystroke you are
 * about to make", so everything here answers a question the user has at the
 * instant they press a key: what holds my credential, what will Enter do, and
 * how much of the screen may this box take before it starts eating the
 * conversation. Each is a pure function first and a component second, because
 * every one of them was previously either invisible (the credential posture was
 * `display:none` on a phone), hover-only (the growth cap), or nowhere at all
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

export type ComposerPostureKind = "local-demo" | "local-endpoint" | "key-in-memory" | "offline";

export type ComposerPostureClaim = Readonly<{
  kind: ComposerPostureKind;
  state: SealState;
  /** ≤ 16 characters: the resting chip may never truncate its own verdict. */
  label: string;
  /** The full sentence. Visible in the popover — never hover-only. */
  detail: string;
}>;

const COMPOSER_POSTURE_CLAIMS: Readonly<Record<ComposerPostureKind, ComposerPostureClaim>> = Object.freeze({
  "local-demo": Object.freeze({
    kind: "local-demo",
    state: "none",
    label: "Local demo",
    detail: "No provider credential is held. Replies come from a deterministic local demo and this conversation's journal is page memory only.",
  }),
  "local-endpoint": Object.freeze({
    kind: "local-endpoint",
    state: "verified",
    label: "Local endpoint",
    detail: "Inference runs against a model server on this machine. No account credential is held, and nothing leaves this computer.",
  }),
  "key-in-memory": Object.freeze({
    kind: "key-in-memory",
    state: "asserted",
    label: "Key in memory",
    detail: "The provider credential is held in this tab's page memory only. It is never written to disk and is gone when the tab closes.",
  }),
  offline: Object.freeze({
    kind: "offline",
    state: "attention",
    label: "Offline",
    detail: "",
  }),
});

/**
 * What holds the credential for the message about to be sent.
 *
 * This fact shipped as a 164.9px caption on desktop and at literally 0×0px on a
 * phone (`.composer-tools span:nth-child(2) { display: none }`), which is a P9
 * violation: the surface that states what your keystroke is about to trust was
 * blank on the device most likely to be someone else's. It is a chip now, at
 * every breakpoint, and the chip expands to the whole sentence.
 */
export function composerPosture(input: Readonly<{
  online: boolean;
  offlineReason: string;
  inferenceConnected: boolean;
  /** `"local-none"` is the binding a self-hosted model server produces. */
  authMethod?: string;
}>): ComposerPostureClaim {
  if (!input.online) {
    return Object.freeze({ ...COMPOSER_POSTURE_CLAIMS.offline, detail: input.offlineReason });
  }
  if (!input.inferenceConnected) return COMPOSER_POSTURE_CLAIMS["local-demo"];
  return input.authMethod === "local-none"
    ? COMPOSER_POSTURE_CLAIMS["local-endpoint"]
    : COMPOSER_POSTURE_CLAIMS["key-in-memory"];
}

export function ComposerPostureChip({
  claim,
  blockedReason,
}: Readonly<{
  claim: ComposerPostureClaim;
  /** Why Send is refusing, mirrored here because a `title` has no touch gesture. */
  blockedReason?: string;
}>) {
  return (
    <Popover
      class="composer-posture-popover"
      triggerClass="composer-posture"
      label={`Credential posture. ${claim.label}. ${claim.detail}`}
      heading="Credential posture"
      width={300}
    trigger={<>
      <Seal state={claim.state} density="dot" size={16} label={claim.label} />
      <span class="composer-posture__word" data-state={claim.state}>{claim.label}</span>
    </>}
    >
      <p class="composer-posture__detail">{claim.detail}</p>
      {blockedReason ? <p class="composer-posture__blocked" role="status">{blockedReason}</p> : null}
    </Popover>
  );
}

/** Why an attachment-only composer refuses Enter, in one sentence, everywhere. */
export const COMPOSER_ATTACHMENT_NEEDS_TEXT =
  "Add a message to send with this attachment. The image travels inside the encrypted request beside your prompt, so a turn needs both.";

/** What this page runtime can currently do with an image the composer holds. */
export type ComposerVisionCapability = "supported" | "model-lacks-vision" | "disconnected";

/**
 * What just happened to the files someone dropped on the composer.
 *
 * Every refusal is counted, including the one that used to be silent. The
 * attachment cap was treated as a non-event: only the MIME rejection produced
 * a sentence, and the success clause was derived from the *admitted* count, so
 * dropping a ninth image onto eight pending ones announced "0 images are ready
 * for inline encrypted vision inference" — a success sentence, with a zero in
 * it, for a file that was thrown away. A refusal that cannot be read is
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
      ? `${input.added} image${input.added === 1 ? " is" : "s are"} ready for inline encrypted vision inference.`
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
