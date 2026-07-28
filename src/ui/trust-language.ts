import type { SecurityPosture } from "../core/contracts";
import type { SealState } from "./seal";
import type { JsonValue } from "../core/contracts";
import type { ClaimKey, ProofLevel, ProofStatus } from "../receipts/types";

export function proofLevelLabel(value: ProofLevel): string {
  if (value === "local") return "Local evidence only";
  if (value === "encrypted") return "Encrypted";
  if (value === "attested-endpoint") return "Endpoint attested";
  if (value === "model-bound") return "Model policy bound";
  if (value === "conversation-bound") return "Conversation bound";
  return "Settlement verified";
}

export function postureLabel(value: SecurityPosture): string {
  if (value === "local") return "Local only";
  if (value === "plaintext-remote") return "Remote · not encrypted end to end";
  if (value === "encrypted-unattested") return "Encrypted · no required endpoint proof";
  return "Encrypted · fresh endpoint proof required";
}

/**
 * The three words a claim's standing may be spoken in, plus the two failures.
 *
 * "Established" is deliberately absent. It was Airship's most dangerous word
 * because it meant two opposite things 183px apart on one screen: the claim
 * rail counted `verified + asserted` as "7 established" while the metric card
 * beside it read "TEE verification — Not established" to mean *nothing was
 * proven*. "No evidence" says what the code knows — no record exists — without
 * borrowing the vocabulary of proof.
 *
 * "Asserted" is kept rather than softened to "Recorded": a party asserted this
 * claim, and dropping the author is how a self-report starts reading as a
 * finding.
 */
export function proofStatusLabel(value: ProofStatus): string {
  if (value === "verified") return "Verified";
  if (value === "partial") return "Asserted";
  if (value === "failed") return "Failed";
  if (value === "expired") return "Expired";
  return "No evidence";
}

export function relativeEvidenceAge(timestamp: string, now = Date.now()): string {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return "Time unavailable";
  const seconds = Math.round((then - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function claimLanguage(key: ClaimKey): Readonly<{ primary: string; technical: string }> {
  const labels: Readonly<Record<ClaimKey, readonly [string, string]>> = {
    encryption: ["Encrypted transport", "E2EE channel"],
    freshness: ["Fresh evidence", "Nonce and evidence age"],
    cpuTee: ["Protected CPU runtime", "CPU TEE"],
    gpuTee: ["Protected accelerator", "GPU TEE"],
    endpointKey: ["Endpoint identity", "Attested endpoint-key binding"],
    model: ["Model artifact", "Artifact and runtime policy"],
    conversation: ["Conversation integrity", "Request/response binding"],
    payment: ["Payment standing", "Settlement receipt"],
  };
  const [primary, technical] = labels[key];
  return Object.freeze({ primary, technical });
}

/**
 * The receipt's one-line standing, counted rather than characterised.
 *
 * It used to pick between "some claims are assertions", "verified claims are
 * listed below" and "no independently verified claim is available" — three
 * phrasings of a number, on a page that already printed the number twice and
 * disagreed with itself about what "established" meant. One count feeds every
 * surface now, so this sentence states it instead of describing it.
 */
export function rankedReceiptVerdict(args: Readonly<{ proofLevel: ProofLevel; posture: SecurityPosture; statuses: readonly ProofStatus[] }>): string {
  if (args.statuses.some((status) => status === "failed" || status === "expired")) return "Verification failed or expired · do not rely on this receipt";
  const verified = args.statuses.filter((status) => status === "verified").length;
  const scope = verified > 0 ? proofLevelLabel(args.proofLevel) : postureLabel(args.posture);
  return `${scope} · ${verified} of ${args.statuses.length} independently verified`;
}

export function claimExpiry(details: JsonValue | undefined): string | undefined {
  if (!details || Array.isArray(details) || typeof details !== "object") return undefined;
  for (const key of ["expiresAt", "expires_at", "notAfter", "not_after"]) {
    const value = details[key];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

/**
 * Every state a completed turn's evidence may be in. Six, and no seventh.
 *
 * Ordered strongest to weakest. This enumeration exists because six independent
 * reducers used to answer "is this turn proven" from six different slices of
 * the same state, so one viewport could carry "Evidence unavailable",
 * "evidence recorded", "Evidence not pulled", "Not established" and a green
 * "VERIFIED" simultaneously. A careful reader could not answer the question;
 * a careless one read the green check.
 */
export type TurnEvidenceState =
  | "proven"
  | "partly-proven"
  | "asserted"
  | "no-evidence"
  | "evidence-blocked"
  | "failed";

/**
 * The words themselves, addressable by state.
 *
 * Exported as data rather than hidden inside the reducer because the surfaces
 * that must agree are not all reducing a claim stack. A session-scoped
 * acquisition failure has no claim stack at all — it still has to say
 * "Evidence not pulled" and not invent a fifth phrasing, so it reads the word
 * out of this table instead of spelling it again.
 *
 * `chip` is ≤22 characters (the resting word every trust surface shows) and
 * `line` is ≤80 (one sentence, printable beside it).
 */
export const TURN_EVIDENCE_COPY: Readonly<Record<TurnEvidenceState, Readonly<{ seal: SealState; chip: string; line: string }>>> = Object.freeze({
  proven: Object.freeze({ seal: "verified", chip: "Proven this turn", line: "Every claim was verified by a named authority for this exact turn." }),
  "partly-proven": Object.freeze({ seal: "verified", chip: "Partly verified", line: "Some claims were verified by a named authority; the rest are assertions." }),
  asserted: Object.freeze({ seal: "asserted", chip: "Asserted, not verified", line: "This turn was recorded and asserted. No named authority verified a claim." }),
  "no-evidence": Object.freeze({ seal: "none", chip: "No evidence yet", line: "Evidence is recorded when a turn completes." }),
  "evidence-blocked": Object.freeze({ seal: "attention", chip: "Evidence not pulled", line: "Evidence could not be fetched. Nothing failed verification." }),
  // Kept verbatim from the shipped ranked verdict: the strongest sentence on
  // the surface is not the place to try out new wording.
  failed: Object.freeze({ seal: "failed", chip: "Verification failed", line: "Verification failed or expired · do not rely on this receipt" }),
});


/*
 * The words live here, with the rest of Airship's trust vocabulary, and the
 * reducer that chooses between them lives in `turn-evidence.ts`.
 *
 * The split is a delivery boundary, not a taxonomy: the shell states an
 * acquisition failure in the canonical word at first paint and never reduces a
 * claim stack to do it, while every surface that *does* reduce one is lazily
 * delivered. Two chunks, one dictionary — which is the only arrangement in
 * which "Evidence not pulled" cannot become two different sentences again.
 */
