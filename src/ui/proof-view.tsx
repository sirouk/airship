import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { serializePortableReceipt } from "../attestation/receipt";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { DurableEvent } from "../core/journal";
import type { SessionAuditReport } from "../core/session-audit";
import type { ConversationReceipt } from "../receipts/types";
import {
  proofActivityLedger,
  proofActivityRowForTurn,
  proofGroundingIndex,
  type ProofActivityLedger,
  type ProofActivityRow,
} from "./proof-activity";
import {
  claimQualifierLabel,
  claimStackPopoverFacts,
  turnEvidenceVerdict,
  CLAIM_CEILING_LABELS,
  CLAIM_CEILING_SCOPES,
  CLAIM_CEILING_SENTENCES,
  CLAIM_STATE_LEGEND,
  PROOF_STATE_MEANINGS,
} from "./claim-stack-facts";
import { claimStackEndpointRecord, composeClaimStack, type ClaimStackItem } from "./claim-stack-model";
import { downloadFileName, downloadText } from "./file-download";
import { Icon } from "./icons";
import { Popover } from "./popover";
import "./popover.css";
import { useShellIsPhone } from "./phone-viewport";
import type { ProofSection } from "./proof-route";
import { RouteHeader } from "./route-header";
import { sealStateForProofStatus, Seal, type SealState } from "./seal";
import { sealStateForReceipt } from "./seal-states";
import { Tabs } from "./tabs";
import { claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, relativeEvidenceAge } from "./trust-language";
import "./proof-view.css";

/**
 * What Proof is handed about a session: the verdict *and* the record.
 *
 * The route used to receive `SessionAuditReport` alone, which is a judgement
 * about events it could not read. Everything this route could say about a
 * session was therefore limited to what `counts` classifies — and `counts` has
 * no field for a human-approved effect, no record of what a local command ran,
 * and no route to the sources `turn.context.selected` already seals.
 */
export type ProofJournalRead = Readonly<{
  report: SessionAuditReport;
  events: readonly DurableEvent[];
  /** The conversation's own name, from the same read. A uuid names nothing. */
  title: string;
}>;

export function ProofView({
  receipt,
  eventCount,
  sessionId,
  requestedReceiptId,
  requestedTurnId,
  onReturnToTurn,
  loadAudit,
  section,
  onSectionChange,
  evidenceLedger,
  endpointEvidenceRecords,
  renderInspector,
  summarizeReceipt,
  acquisitionFailure,
}: Readonly<{
  receipt?: ConversationReceipt;
  eventCount: number;
  sessionId?: string;
  requestedReceiptId?: string;
  /** The turn the address is scoped to, from `#proof?turn=`. */
  requestedTurnId?: string;
  /**
   * Back to the message this view was opened from. Absent when the caller
   * cannot land on it — Proof then says so rather than offering a dead door.
   */
  onReturnToTurn?: (sessionId: string, turnId: string) => void;
  loadAudit: (sessionId: string) => Promise<ProofJournalRead>;
  section: ProofSection;
  onSectionChange: (section: ProofSection) => void;
  evidenceLedger: ComponentChildren;
  endpointEvidenceRecords: readonly ChutesEndpointEvidenceRecord[];
  renderInspector: (onOpenAttestations: () => void) => ComponentChildren;
  summarizeReceipt: (receipt: ConversationReceipt) => string;
  /**
   * `attestationFailureLabel()`'s string, verbatim, when evidence could not be
   * fetched. Optional so the acquisition state can be wired from `app.tsx`
   * without this route ever inventing one: absent means "not asked", which is
   * a different fact from "asked and blocked".
   */
  acquisitionFailure?: string;
}>) {
  const [receiptAction, setReceiptAction] = useState<string>();
  const [journal, setJournal] = useState<ProofJournalRead>();
  const [auditError, setAuditError] = useState<string>();
  const [auditLoading, setAuditLoading] = useState(false);
  /*
   * The only way back from a journal read that failed.
   *
   * The effect is keyed on the session and the event count, so a rejected
   * `loadAudit` left the reader with no gesture that re-runs it — recovery on
   * the product's integrity surface meant reloading the page. The nonce is a
   * dependency, so bumping it re-audits the same session.
   */
  const [auditAttempt, setAuditAttempt] = useState(0);
  /** Decides only what starts open, never what exists. */
  const phone = useShellIsPhone();

  useEffect(() => {
    let current = true;
    setJournal(undefined);
    setAuditError(undefined);
    if (!sessionId) return () => { current = false; };
    setAuditLoading(true);
    void loadAudit(sessionId)
      .then((read) => {
        if (current) setJournal(read);
      })
      .catch((error) => {
        if (current) setAuditError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current) setAuditLoading(false);
      });
    return () => { current = false; };
  }, [sessionId, eventCount, auditAttempt]);

  async function copyReceipt() {
    if (!receipt) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser context.");
      await navigator.clipboard.writeText(serializePortableReceipt(receipt));
      setReceiptAction("Privacy-safe unsigned receipt summary copied");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  function download(payload: string, filename: string, status: string) {
    try {
      // One download path for the whole product: the Blob, the object URL and
      // the revoke live in `file-download`, so a receipt cannot leak an object
      // URL that this copy forgot to revoke. The name is sanitized on the way
      // through because it interpolates an id this view did not mint.
      downloadText(payload, downloadFileName(filename, "airship-export.json"));
      setReceiptAction(status);
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportVerificationBundle() {
    if (!receipt && !audit && endpointEvidenceRecords.length === 0) return;
    try {
      const { exportChutesEndpointEvidenceRecord } = await import("../attestation/provider-client");
      const relevantEvidence = receipt
        ? endpointEvidenceRecords.filter((record) =>
            record.subject.instanceId === receipt.instanceId
            && (!receipt.bindings.endpointKeyDigest
              || record.subject.e2ePublicKeyDigest === receipt.bindings.endpointKeyDigest),
          )
        : endpointEvidenceRecords;
      /*
       * The journal, in the artifact that prints its commitment.
       *
       * The shipped bundle ended with "A journal audit commitment can be
       * recomputed only with the corresponding immutable session journal." and
       * then shipped a commitment without one — and no control anywhere in the
       * product emitted it. An auditor was handed a digest and told, in the
       * same file, that they could not check it. The events were always one
       * reference away from this function.
       */
      const journalEvents = journal?.events ?? [];
      const bundle = {
        schema: "airship.verification-bundle.v2",
        exportedAt: new Date().toISOString(),
        scope: {
          sessionId: sessionId ?? null,
          receiptId: receipt?.receiptId ?? requestedReceiptId ?? null,
          turnId: requestedTurnId ?? receipt?.turnId ?? null,
        },
        receipt: receipt ?? null,
        journalAudit: audit ?? null,
        sessionJournal: audit
          ? {
            eventCount: journalEvents.length,
            /*
             * Whether the digest above can actually be recomputed from what is
             * in this file. `boundedSessionPresentationEvents` cuts a very long
             * journal to its newest whole turns, and a partial prefix hashes to
             * something else — saying so is the difference between an artifact
             * that fails verification and one that lied about being verifiable.
             */
            coversCommitment: journalEvents.length === audit.commitment.sequence,
            events: journalEvents,
          }
          : null,
        answerProvenance: proofGroundingIndex(activity),
        endpointEvidence: relevantEvidence.map((record) =>
          JSON.parse(exportChutesEndpointEvidenceRecord(record, { includeRawEvidence: true })) as unknown,
        ),
        // Generated from the fields this artifact actually carries, in the same
        // words the screen uses before the button is pressed. Hand-written
        // boundary prose is how a bundle came to disclose a plaintext-testable
        // digest of the conversation under a heading about hardware quotes.
        disclosure: exportDisclosure(Boolean(receipt), journalEvents.length > 0),
        verificationBoundary: verificationBoundary(relevantEvidence.length > 0, Boolean(audit), journalEvents.length > 0),
      };
      const suffix = receipt?.receiptId.slice(-8) ?? sessionId?.slice(0, 8) ?? "evidence";
      download(JSON.stringify(bundle, null, 2), `airship-verification-bundle-${suffix}.json`, "Raw verification bundle exported");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  const audit = journal?.report;
  const auditReading = journalAuditReading(audit, auditLoading, Boolean(auditError));
  const auditLabel = auditReading.label;
  const activity = proofActivityLedger(journal?.events ?? []);
  const scopedTurn = proofActivityRowForTurn(activity, requestedTurnId ?? receipt?.turnId);
  const recordedActivity = recordedActivityFacts(audit?.counts);
  const claimStack = composeClaimStack(
    receipt,
    // Instance + key digest, like the inspector and the export above: an
    // instance-only match binds yesterday's key after an endpoint re-key.
    claimStackEndpointRecord(endpointEvidenceRecords, receipt),
  );
  // One reducer, one answer. `sealStateForReceipt`'s fail-closed rule (an
  // attested posture whose endpoint-key claim and proof level disagree) is fed
  // in as a predicate rather than being a seventh opinion drawn beside this one.
  const verdict = turnEvidenceVerdict({
    stack: claimStack,
    hasReceipt: Boolean(receipt),
    attestedFieldsDisagree: Boolean(receipt) && sealStateForReceipt(receipt) === "failed",
    acquisitionFailure,
  });
  /*
   * The hero's second line, when there is no receipt to speak for.
   *
   * `verdict.line` is "Evidence is recorded when a turn completes." — an
   * instruction, and the second-loudest string on the page. Measured (J069): a
   * person who had just made a Git commit under two approvals met it at 390×844
   * directly above a journal that had recorded both. The verdict word stays
   * (no *turn* evidence exists, which is true); the sentence under it becomes
   * the one this route can stand behind about this session, which is the same
   * sentence the body was already printing two lines below.
   */
  const heroDetail = receipt ? verdict.line : missingReceiptReading(audit, requestedReceiptId);
  const attestationNote = receipt?.posture === "encrypted-unattested"
    ? "compatibility mode"
    : receipt?.posture === "encrypted-attested" && verdict.state === "failed"
      ? "receipt fields disagree; verification failed closed"
      : "production remote mode must fail closed";

  return (
    <section
      class="work-view proof-view"
      // VIS-02. The shell caps every route child at a 1160px *prose* measure
      // (`routes.css`), and this route's evidence surface is not prose: the
      // attestation ledger is a list-plus-inspector grid printing 64-hex
      // measurements, so the cap left the inspector ~830px and wrapped every
      // digest while the desktop had the width to spare. The route declares its
      // kind here rather than growing another `:has()` one-off; the receipt
      // panel below opts *back* into the measure in this route's own sheet,
      // because the half of this page that is a verdict and a paragraph does
      // get harder to read the wider it is.
      data-route-measure="wide"
    >
      {/* `document` density, deliberately, on the one route where §3.7's move
          into the ⓘ cannot be taken. Two reasons, both measured: this route's
          sentence is one of the two the ledger names as must-be-verbatim, and a
          proof page is the wrong place to make someone open something to learn
          what the page means; and the auto-opening panel lands directly over
          the tab strip, so the first gesture on a first visit is dismissing a
          disclosure rather than reading evidence. Nothing here is disclosed —
          the slab is made small instead, in this route's own sheet. */}
      <RouteHeader
        routeId="proof"
        title="Proof"
        headingId="proof-title"
        eyebrow="Inspectable, portable evidence"
        description="Endpoint attestation and conversation receipts are different claims. Airship never presents one as the other."
      />
      <div class="proof-surface-switch">
        <Tabs
          label="Proof views"
          class="proof-surface-tabs"
          items={[
            { id: "summary", label: "Receipt & journal" },
            { id: "attestations", label: "Attestation evidence" },
          ]}
          activeId={section}
          onSelect={(id) => onSectionChange(id as ProofSection)}
          panelId={(id) => `proof-panel-${id}`}
        />
      </div>
      <div id="proof-panel-attestations" class="proof-surface-panel" role="tabpanel" aria-labelledby="attestations-title" hidden={section !== "attestations"}>{evidenceLedger}</div>
      <div id="proof-panel-summary" class="proof-surface-panel proof-surface-panel--prose" role="tabpanel" aria-labelledby="proof-summary-title" hidden={section !== "summary"}>
        <h2 class="sr-only" id="proof-summary-title">Receipt &amp; journal</h2>
        <section class="proof-verdict" data-state={verdict.state} aria-label={`Turn evidence. ${verdict.chip}. ${heroDetail}`}>
          {/* The route's one hero seal, and the one place a seal renders its
              detail as visible text rather than a tooltip. It is a button
              because §4.4's disclosure contract is universal: every chip and
              hero expands into the claim stack, so the eight claims behind
              this single word are one gesture away on a touch device too. */}
          <Popover
            class="proof-verdict__claims"
            heading="Claim stack"
            /* "turn claims", with its subject. Measured (J055): a reader met
               "4 axes" in the topbar, "4 claims" in the session chip and "8"
               here within two clicks, and nothing said the three counts were
               about three different subjects. The noun is now one word
               everywhere it means this; what changes is that each count names
               what it counts. */
            label={`Turn evidence: ${verdict.chip}. ${verdict.line} ${claimStack.items.length} turn claims. Open the claim stack.`}
            trigger={<Seal
              class="proof-hero-seal"
              state={verdict.seal}
              density="hero"
              origin={receipt?.posture === "local" ? "local" : "remote"}
              label={verdict.chip}
              detail={heroDetail}
            />}
          >
            <p class="proof-hero-claims__evidence">{claimStack.evidenceSummary}</p>
            {claimStack.items.map((item) => <ClaimPopoverRow key={item.key} item={item} />)}
          </Popover>
          {/*
            * The counts read second, directly under the word they decompose.
            *
            * Measured at 430×932: this block sat 572px down the route, behind
            * the header, the tab pair, the verdict card, a `TURN EVIDENCE`
            * panel and a five-row journal ledger — a wall of text in front of
            * the one part of the page the owner said reads well. Nothing is
            * removed; the subject and the ledger simply stop coming first,
            * because "what was checked, and how did it come out" is the
            * question a person opens this route with, and "which conversation
            * is this about" is the one they ask after reading the answer.
            *
            * On desktop the counts take the verdict's second column, so the
            * DOM order and the visual order agree at both widths rather than
            * one of them being achieved with `order:`.
            */}
          <dl class="proof-counts" aria-label="Claim states in this turn">
            {CLAIM_STATE_LEGEND.map((entry) => (
              <div key={entry.status} data-status={entry.status}>
                {/* The dot's label is the legend's own word. Left to default,
                    the `none` seal announced "Not checked" immediately before
                    the visible "No evidence" — a fifth state word, audible
                    only to the readers who cannot see the one beside it. */}
                <dt><Seal state={sealStateForProofStatus(entry.status)} density="dot" size={16} label={entry.word} />{entry.word}</dt>
                <dd>{entry.status === "verified" ? verdict.counts.verified : entry.status === "partial" ? verdict.counts.asserted : verdict.counts.noEvidence}</dd>
                <small>{entry.meaning}</small>
              </div>
            ))}
            {/* The sentence comes from `PROOF_STATE_MEANINGS`, not from a
                literal here: this row and the Attestation evidence legend one
                tab away printed "A claim was checked…" and "The claim was
                checked…" for the identical word. */}
            {verdict.counts.failed > 0 ? <div data-status="failed"><dt><Seal state="failed" density="dot" size={16} label={proofStatusLabel("failed")} />{proofStatusLabel("failed")}</dt><dd>{verdict.counts.failed}</dd><small>{PROOF_STATE_MEANINGS.failed}</small></div> : null}
            {/* Its own row, beside Failed and never inside it. Expiry used to
                fall through this tab's `else` and be counted as a failed check,
                so one expired endpoint observation printed "Failed: 1" here
                while the Attestation tab called the same claim a stale
                observation. The word comes from `proofStatusLabel` — the
                legend's own — and doubles as the dot's label, because the seal
                for expiry is the failure seal and would otherwise announce
                "Failed" beside a line that does not say it. */}
            {verdict.counts.expired > 0 ? <div data-status="expired"><dt><Seal state={sealStateForProofStatus("expired")} density="dot" size={16} label={proofStatusLabel("expired")} />{proofStatusLabel("expired")}</dt><dd>{verdict.counts.expired}</dd><small>{PROOF_STATE_MEANINGS.expired}</small></div> : null}
          </dl>
          {verdict.ceilings.length > 0 ? (
            <section class="proof-ceilings" aria-label="Why declared verifications are shown as assertions">
              <p class="proof-ceilings__figures">
                <strong>{verdict.declaredVerified}</strong> claim{verdict.declaredVerified === 1 ? "" : "s"} on this turn declare verification.
                {" "}<strong>{verdict.counts.verified}</strong> of them survive Airship's checks. Two independent ceilings apply, and they are not the same rule.
              </p>
              {verdict.ceilings.map((ceiling) => (
                <div key={ceiling} class="proof-ceilings__rule">
                  <strong>{CLAIM_CEILING_LABELS[ceiling]}</strong>
                  <small>{CLAIM_CEILING_SCOPES[ceiling]}</small>
                  <p>{CLAIM_CEILING_SENTENCES[ceiling]}</p>
                </div>
              ))}
            </section>
          ) : null}
          {/* The hero seal is the verdict: `density="hero"` is the one place a
              seal renders its own word and detail as visible text, so restating
              `chip` and `line` here would reopen the defect this package
              closes — one turn, several phrasings, in one viewport. */}
          <div class="proof-verdict__body">
            {/* The hero's word is about one turn's claim stack, and it was read
                as a verdict on the whole session: after two human-approved Git
                effects this panel led with "No evidence", and a person who had
                just committed concluded Airship had recorded nothing. The scope
                line is the same device the journal panel below already uses —
                the verdict keeps its one word, and the word stops covering more
                than it checked. */}
            <p class="proof-verdict__context"><span class="eyebrow">Turn evidence</span></p>
            {/* The subject, named. This route was reached by a deep link
                carrying `session`, `receipt` and `turn`, rendered the claim
                stack for that turn, and then named neither the conversation nor
                the message — so the one question a reader arrives with ("which
                answer is this about?") had no answer on the page, and every
                enabled control led further in. */}
            <ProofScope
              sessionId={sessionId}
              conversationTitle={journal?.title}
              turn={scopedTurn}
              requestedTurnId={requestedTurnId ?? receipt?.turnId}
              journalRead={Boolean(journal)}
              onReturnToTurn={onReturnToTurn}
            />
            {/* An acquisition failure is a modifier on the verdict, never a
                second verdict: the fetch that did not happen is not a
                verification that failed. */}
            {verdict.modifier ? <p class="proof-verdict__modifier"><Icon name="warning" size={14} />{verdict.modifier}</p> : null}
            {receipt ? <p class="proof-verdict__summary">{summarizeReceipt(receipt)}</p> : null}
            {/* Inside the body, under its own scope line, because it is the one
                block here that is not about the turn: an unlabelled ledger sat
                under "Turn evidence" and claimed the wrong subject at 390px,
                where the two columns become one. Present exactly when there is
                an audited journal to speak for — an unread or unreadable
                journal must not render four zeros as if it had counted them. */}
            {/*
              * A five-row ledger, behind its own count.
              *
              * It is not the turn's evidence and never was — it is what the
              * whole session recorded — and at 430px its five mono labels wrap
              * into ten lines of chrome directly above the block a reader came
              * for. The disclosure states its own total in the summary, so the
              * fact that work *was* recorded survives at rest and the breakdown
              * is one tap; the rule from TRM-06 is unchanged, every kind still
              * renders including the zeros. `open` on desktop, where there is
              * no fold to spend.
              */}
            {recordedActivity.length > 0 ? (
              <details class="proof-recorded" open={!phone}>
                <summary>
                  <span class="eyebrow">Recorded in this session’s journal</span>
                  <span class="proof-recorded__total">{recordedActivitySummary(recordedActivity)}</span>
                </summary>
                <dl class="proof-posture proof-recorded__facts" aria-label="Work recorded in this session’s journal">
                  {recordedActivity.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
                </dl>
              </details>
            ) : null}
          </div>
          {receipt ? (
            <dl class="proof-posture" aria-label="Declared turn posture">
              <div><dt>Declared proof level</dt><dd>{proofLevelLabel(receipt.proofLevel)}</dd></div>
              <div><dt>Transport</dt><dd>{postureLabel(receipt.posture)}</dd></div>
              <div><dt>Endpoint attestation</dt><dd>{attestationNote}</dd></div>
              {/* The researcher's question, now answered from where the answer
                  has always been. No receipt shape carries provenance —
                  `createLocalReceipt` mints bindings only, and a provider
                  receipt arrives with claims — but the turn seam journals its
                  selection as `turn.context.selected` with a path, a revision,
                  a chunk id and a content digest per source, and the audit
                  verifies the seal over all of it. The row stops being a
                  constant apology and states what this turn was selected from,
                  or that nothing was. */}
              <div><dt>Answer provenance</dt><dd>{answerProvenanceReading(scopedTurn, Boolean(journal))}</dd></div>
            </dl>
          ) : null}
        </section>
        {/* The counts above are the audit's classification; this is the record
            they classify, and it takes the route's own measure rather than the
            verdict's column — a source path with a revision and a 51-character
            digest does not read in 530px. Five integers cannot say what a local
            command ran, which file a commit touched, or what an answer was
            selected from, and a reader who had just done all three met four
            zeros. */}
        <ProofActivityList
          activity={activity}
          scopedTurnId={scopedTurn?.turnId}
          sessionId={sessionId}
          onReturnToTurn={onReturnToTurn}
        />
        {renderInspector(() => onSectionChange("attestations"))}
        <details class={`proof-journal panel ${audit?.status ?? (auditError ? "unreadable" : "pending")}`} open={!audit || audit.findings.length > 0 || audit.status !== "verified"}>
          <summary class="proof-journal__row">
            {/* Same rule as the claim rows: the visible state word is the
                label, so the seal cannot announce a fifth vocabulary. */}
            <Seal state={auditReading.seal} density="dot" size={16} label={auditLabel} />
            <h2 id="journal-audit-title">Session journal integrity</h2>
            <span class="proof-journal__state">{auditLabel}{audit ? ` · ${passedChecks(audit)} of 6 structure checks passed` : ""}{audit && audit.findings.length > 0 ? ` · ${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"} to read` : ""}</span>
            <span class="proof-journal__facts">{audit ? `${audit.counts.events} event${audit.counts.events === 1 ? "" : "s"} · ${audit.commitment.digest.slice(0, 18)}…` : `${eventCount} observed event${eventCount === 1 ? "" : "s"}`}</span>
          </summary>
          <div class="proof-journal__body">
            <p class="proof-journal__scope"><span class="eyebrow">Independent local consistency check</span></p>
            {audit ? <>
              {/* The second sentence exists because the first check grid below
                  prints "Complete history · consistent" and the exported audit
                  prints `"complete": true` — read, verbatim, as "everything
                  that happened is in here" by a reader who had just committed
                  under two approvals. `complete` is the absence of a
                  completeness *finding* about the events that are present; it
                  is silent by construction about an effect that was never
                  journaled. The word stays; what it means is now beside it. */}
              <div class="audit-boundary"><Icon name={audit.status === "invalid" ? "warning" : "proof"} size={18} /><p><strong>A valid hash chain is not proof of authorship.</strong> This report checks schema, ordering, manifest bindings, turn/tool protocol, and receipt bindings. No separately trusted author identity was verified. “Complete history” means no gap was found among the events that are present; it cannot show that an effect which was never recorded is missing.</p></div>
              <div class="audit-check-grid" role="group" aria-label="Journal audit checks">{auditChecks(audit).map(([label, passed]) => <div key={label} class={passed ? "pass" : "fail"}><Seal state={passed ? "verified" : "failed"} label={passed ? "Passed" : "Failed"} size={16} compact /><strong>{label}</strong><small>{passed ? "consistent" : "attention required"}</small></div>)}</div>
              {/* "Shell records" used to be the one recorded-work count on this
                  screen, and it sat here — inside a disclosure that is closed
                  whenever the structure passes, which is exactly the session
                  where a reader is asking what was recorded. It now rides with
                  the rest of the recorded work in `recordedActivityFacts`,
                  above the fold and beside the verdict; this list keeps the
                  facts that are about the *check* rather than about the
                  session. */}
              <dl class="audit-commitment"><div><dt>Session</dt><dd>{audit.sessionId}</dd></div><div><dt>Journal events</dt><dd>{audit.commitment.sequence}</dd></div><div><dt>Checked</dt><dd><time dateTime={audit.checkedAt} title={new Date(audit.checkedAt).toLocaleString()}>{relativeEvidenceAge(audit.checkedAt)}</time></dd></div><div><dt>External anchor</dt><dd>{audit.anchor.status === "not-supplied" ? "Not supplied" : audit.anchor.status === "matched" ? "Matched" : "Did not match"}</dd></div></dl>
              <details><summary>Technical journal details</summary><code>{audit.commitment.digest}</code></details>
              {/* Open whenever findings exist. A warning collapsed under a row
                  announcing that everything passed is the shape of a burial. */}
              {audit.findings.length > 0 ? <details class="audit-findings" open><summary>{audit.findings.length} audit finding{audit.findings.length === 1 ? "" : "s"}</summary><div>{audit.findings.slice(0, 30).map((finding, index) => <article key={`${finding.code}-${finding.sequence ?? index}`} data-severity={finding.severity}><span>{finding.severity}</span><strong>{finding.code}</strong><p>{finding.message}</p></article>)}</div></details> : <p class="audit-clean">No consistency findings were produced for this session prefix.</p>}
            </> : auditError ? (
              /* The failure gets its own assertive element and its own verb.
                 It used to share `.audit-loading` with the idle copy, so a
                 journal that could not be read was announced as politely as
                 "No active session is available to audit." — and with no
                 control anywhere that re-runs the check. */
              <div class="audit-unreadable">
                <p role="alert"><Icon name="warning" size={16} /> {auditError}</p>
                <button class="small-button" type="button" onClick={() => setAuditAttempt((value) => value + 1)}><Icon name="proof" size={14} /> Audit again</button>
              </div>
            ) : <p class="audit-loading" role="status">{auditLoading ? "Recomputing the session commitment…" : "No active session is available to audit."}</p>}
          </div>
        </details>
        {/* The network dimension the journal does not have.
            "What has left this device" is observed by the recorder the
            Connection route installs; Proof reads the same singleton rather
            than growing a second witness, because two observers of one wire is
            how a product ends up with two answers to one question. Proof's job
            is that the answer is reachable from the surface a person opens when
            they want to know what actually happened. */}
        <ProofEgressSummary />
        <div class="proof-actions" role="group" aria-label="Portable evidence actions">
            {/* Emphasis follows verifiability: the bundle a third party can
                actually check is the primary, and the privacy-safe summary — whose
                own note says it is not proof — stops being the loudest control on
                the trust surface. */}
            {receipt || audit || endpointEvidenceRecords.length > 0 ? <button class="small-button primary" type="button" onClick={() => void exportVerificationBundle()}><Icon name="proof" size={14} /> Export raw verification bundle</button> : null}
            {receipt ? <button class="small-button" type="button" onClick={() => void copyReceipt()}><Icon name="proof" size={14} /> Copy safe summary</button> : null}
            {receipt ? <button class="small-button" type="button" onClick={() => download(serializePortableReceipt(receipt), `airship-receipt-${receipt.receiptId.slice(-8)}.json`, "Privacy-safe unsigned receipt summary exported")}><Icon name="cloud" size={14} /> Export safe summary</button> : null}
            {audit ? <button class="small-button" type="button" onClick={() => download(JSON.stringify(audit, null, 2), `airship-session-audit-${audit.sessionId.slice(0, 8)}.json`, "Session audit exported")}><Icon name="proof" size={14} /> Export session audit</button> : null}
            {receiptAction ? <span role="status" aria-live="polite">{receiptAction}</span> : null}
        </div>
        {/* What each control discloses, before it is pressed, in the words the
              artifact itself carries. The raw bundle's primacy was earned on
              verifiability and then left undeclared: it ships `responseDigest`,
              an unsalted SHA-256 of the assistant's verbatim reply, which anyone
              holding a candidate answer can confirm by hashing it. That is a
              content-recoverable field on the export a privacy-first operator
              hands to a third party, and the page said only "bounded endpoint
              evidence and local commitments". */}
        <dl class="proof-export-boundary" aria-label="What each export discloses">
          {EXPORT_DISCLOSURE_LINES.map((line) => <div key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}
        </dl>
      </div>
    </section>
  );
}

/**
 * One claim, with the reason it sits where it does printed beside the word.
 *
 * The status word and the qualifier are rendered as one clause on purpose:
 * "Asserted · receipt integrity not authenticated" is one statement, whereas
 * the shipped inspector printed the status word twice in two casings
 * ("ASSERTED · ASSERTED PARTIAL · RECEIPT UNAUTHENTICATED") because the
 * qualifier re-prefixed a word the line already carried.
 */
function ClaimPopoverRow({ item }: Readonly<{ item: ClaimStackItem }>) {
  const language = claimLanguage(item.key);
  const delta = claimQualifierLabel(item.qualifier);
  return (
    <section class="claim-popover-row">
      {/* The same defect the legend above fixes, at the call site that
          actually renders per claim. Left to default, the seal announces
          SEAL_LABELS[state] — "Not checked" for `none` and "Failed" for
          `expired` — while the word rendered two nodes away says "No evidence"
          and "Stale observation". In the default local-demo state seven of eight rows
          did it, so a screen-reader user heard a different verdict from the
          one on screen. The visible word is the label. */}
      <Seal state={sealStateForProofStatus(item.status)} density="dot" label={proofStatusLabel(item.status)} />
      <strong>{language.primary}</strong>
      <span class="claim-popover-row__state">{proofStatusLabel(item.status)}{delta ? ` · ${delta}` : ""}</span>
      <p>{item.claim.summary}</p>
      <dl>
        {claimStackPopoverFacts(item).map((fact) => (
          <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
        ))}
      </dl>
    </section>
  );
}

/** One label/value pair in a Proof `<dl>`. */
export type ProofFact = Readonly<{ label: string; value: string }>;

/**
 * What this session's journal recorded, taken from the report already in hand.
 *
 * The measured defect, in two journeys with one cause. After two
 * human-approved Git effects this route rendered "No evidence · Evidence is
 * recorded when a turn completes · Complete a turn to create the first local
 * receipt" at 1440×900 and 390×844 alike; after a local `/read` turn the
 * transcript printed "COMPLETED TURN" twice while this route said no turn had
 * completed. Both readings came from treating *provider turn receipt* as a
 * synonym for *evidence*, while `loadAudit` had already returned counts of the
 * local commands, tool operations, shell records and turns the journal holds.
 * Nothing is computed here that the report does not already carry; it is
 * rendered, which is the whole of the fix this function is.
 *
 * Every row renders, zeros included — the rule the shell-record row was added
 * under (TRM-06: "a count of zero is a fact; the absence was not"), now applied
 * to all four kinds of recorded work instead of only the one. A reader can tell
 * a session that ran no tools from one whose tool work went unreported, and on
 * a session whose journal holds events that every count reports as zero, the
 * gap between the sentence above and this list is itself the finding.
 * `terminal*` companions are folded into their row's value because "1 local
 * command · 1 finished" is one fact about one thing.
 *
 * The fifth row is the one this list could not print: two approved Git commits
 * are journaled as `human.intent.reviewed`, validated by the audit, and were
 * counted by no field — so a session that had changed a repository twice
 * rendered four zeros. `counts.humanIntentDecisions` now exists in
 * `SessionAuditReport` and this reads it; a denial is evidence too, so the
 * breakdown names what was permitted rather than implying every decision was.
 */
export function recordedActivityFacts(counts?: SessionAuditReport["counts"]): readonly ProofFact[] {
  if (!counts) return Object.freeze([]);
  // A started turn with no terminal record is a real state (it is running, or
  // the tab died holding it), so an outcome is named only once one is written
  // rather than padded to a zero that would imply a record exists.
  const outcomes = [
    counts.completedTurns > 0 ? `${counts.completedTurns} completed` : "",
    counts.failedTurns > 0 ? `${counts.failedTurns} failed` : "",
    counts.cancelledTurns > 0 ? `${counts.cancelledTurns} cancelled` : "",
  ].filter(Boolean);
  // At zero the breakdown is dropped, not spelled: "0 requested · 0 finished"
  // says nothing "0" does not, and four such rows read as a form rather than a
  // ledger on the session this route is most often opened for — one that has
  // recorded work no count classifies.
  return Object.freeze([
    { label: "Provider turns", value: counts.turns === 0 ? "0" : [`${counts.turns} started`, ...outcomes].join(" · ") },
    { label: "Tool operations", value: counts.toolOperations === 0 ? "0" : `${counts.toolOperations} requested · ${counts.terminalToolOperations} finished` },
    { label: "Local commands", value: counts.localCommands === 0 ? "0" : `${counts.localCommands} run on this device · ${counts.terminalLocalCommands} finished` },
    { label: "Shell records", value: `${counts.shellRecords}` },
    { label: "Approved by you", value: counts.humanIntentDecisions === 0 ? "0" : `${counts.humanIntentDecisions} decided · ${counts.humanIntentAllowed} allowed` },
  ]);
}

/**
 * The one line a collapsed journal ledger owes its reader.
 *
 * A disclosure that hides five facts and says nothing about them is a place to
 * bury things, and this particular list exists *because* a person who had just
 * committed under two approvals was told nothing had been recorded. So the
 * summary states the count and, when it is not zero, names the kinds — the
 * closed row still distinguishes "this session recorded nothing" from "this
 * session recorded work you have not looked at".
 *
 * The kinds are read back out of the rendered facts rather than recomputed from
 * `counts`: the two must never be able to disagree about what is in the list.
 * A value is "recorded" when it does not begin with the zero row that
 * `recordedActivityFacts` writes for an empty kind.
 */
export function recordedActivitySummary(facts: readonly ProofFact[]): string {
  const recorded = facts.filter((fact) => fact.value !== "0");
  if (recorded.length === 0) return `Nothing recorded · ${facts.length} kinds checked`;
  return `${recorded.length} of ${facts.length} kinds recorded · ${recorded.map((fact) => fact.label.toLowerCase()).join(", ")}`;
}

/**
 * What the route says when it is holding no turn receipt.
 *
 * "Complete a turn to create the first local receipt." is true of a session
 * that has done nothing and false of one that has done work through any path
 * but a provider turn — and it was the sentence a person met immediately after
 * committing under two approvals. It survives here for the case it describes
 * (no audited journal to speak for the session) and is replaced by the count
 * everywhere else, because the journal event total is a fact this route can
 * stand behind on any session, including one whose recorded events its counts
 * do not classify.
 */
export function missingReceiptReading(
  audit: SessionAuditReport | undefined,
  requestedReceiptId: string | undefined,
): string {
  if (requestedReceiptId) {
    return "The selected receipt is not available in this page runtime. Airship will not substitute a different turn receipt.";
  }
  if (!audit || audit.counts.events === 0) return "Complete a turn to create the first local receipt.";
  const { completedTurns, events: total, localCommands } = audit.counts;
  const events = `${total} recorded event${total === 1 ? "" : "s"}`;
  // A completed turn with no receipt in hand is a different fact from a session
  // that never ran one, and saying the first as the second is how this sentence
  // became wrong in the first place.
  if (completedTurns > 0) {
    return `This session's journal holds ${events}, including ${completedTurns} completed turn${completedTurns === 1 ? "" : "s"}, but no turn receipt is loaded for this view.`;
  }
  // The transcript prints "COMPLETED TURN" on a `/read` and this route replied
  // "Complete a turn to create the first local receipt" about the same session.
  // Both were true of different things and neither said which, so a local
  // command turn now gets named as what it is: a completion that never reached
  // a provider, and therefore never had a receipt to mint.
  if (localCommands > 0) {
    return `${localCommands} local command${localCommands === 1 ? "" : "s"} ran on this device and called no provider, so no turn receipt was minted. This session's journal holds ${events}, audited below.`;
  }
  return `No provider turn has completed, so this session has no turn receipt yet. Its journal holds ${events}, audited below.`;
}

function auditChecks(audit: SessionAuditReport): readonly (readonly [string, boolean])[] {
  return [
    ["Schema", audit.checks.schema], ["Hash chain", audit.checks.chain], ["Manifest", audit.checks.manifest],
    ["Turn protocol", audit.checks.protocol], ["Receipt bindings", audit.checks.receiptBindings], ["Complete history", audit.checks.complete],
  ] as const;
}

function passedChecks(audit: SessionAuditReport): number {
  return auditChecks(audit).filter(([, passed]) => passed).length;
}

/**
 * The journal's state word and its seal, decided once, from the same facts.
 *
 * Two measured defects, both closed by putting the word and the glyph in one
 * function. A read that *failed* rendered "Not checked" with a `none` seal —
 * byte-for-byte the rendering used when there is no session at all — so a
 * reader whose encrypted journal could not be read was shown a benign,
 * unalarmed headline on the surface that exists to tell them whether their
 * record is intact. And the seal reflects the worst thing in the report, not
 * only its status: a journal whose structure passed while carrying a warning
 * is not the same artifact as one with no findings, and the resting row is the
 * only place a reader who never expands it learns the difference.
 */
export function journalAuditReading(
  audit: SessionAuditReport | undefined,
  loading: boolean,
  failed: boolean,
): Readonly<{ label: string; seal: SealState }> {
  if (!audit) {
    if (loading) return Object.freeze({ label: "Checking journal", seal: "checking" as const });
    // A read that was attempted and refused is not a read that never happened.
    if (failed) return Object.freeze({ label: "Journal could not be read", seal: "attention" as const });
    return Object.freeze({ label: "Not checked", seal: "none" as const });
  }
  if (audit.status === "invalid") return Object.freeze({ label: "Integrity failure", seal: "failed" as const });
  if (audit.status === "incomplete") return Object.freeze({ label: "Consistent but incomplete", seal: "attention" as const });
  return Object.freeze({
    label: "Journal structure passed",
    seal: audit.findings.length > 0 ? "attention" as const : "verified" as const,
  });
}

/**
 * The subject this view is scoped to, named.
 *
 * Measured: `#proof?session=0b1fea50…&receipt=urn…&turn=1c52c6d1…` rendered the
 * claim stack for that turn and named neither the conversation nor the message,
 * and every enabled control in `main` led further into evidence. A reader who
 * arrived from "Inspect evidence →" could not tell which answer they were
 * reading about and had no way back to it — the one-way door.
 *
 * The control is offered only when the caller can actually land on the message.
 * A door that opens onto nothing is worse than a stated absence, which is why
 * the unresolvable cases each say what they are instead.
 */
function ProofScope({
  sessionId,
  conversationTitle,
  turn,
  requestedTurnId,
  journalRead,
  onReturnToTurn,
}: Readonly<{
  sessionId?: string;
  conversationTitle?: string;
  turn?: ProofActivityRow;
  requestedTurnId?: string;
  journalRead: boolean;
  onReturnToTurn?: (sessionId: string, turnId: string) => void;
}>) {
  if (!sessionId) return null;
  return (
    <section class="proof-scope" aria-label="What this evidence is about">
      <p class="proof-scope__conversation">
        <span class="eyebrow">Conversation</span>
        <strong>{conversationTitle ?? "This conversation"}</strong>
        <code>{sessionId.slice(0, 8)}</code>
      </p>
      {turn ? <>
        <p class="proof-scope__turn"><span class="eyebrow">Turn</span>{turn.title}</p>
        <p class="proof-scope__state">{turn.outcomeLabel}{turn.receiptId ? " · receipt minted" : turn.receiptNote ? ` · ${turn.receiptNote}` : ""}</p>
      </> : requestedTurnId ? (
        <p class="proof-scope__turn">
          <span class="eyebrow">Turn</span>
          {journalRead
            ? `This session's journal holds no record of turn ${requestedTurnId.slice(0, 8)}. Airship will not show a different turn under its address.`
            : "Reading this session's journal…"}
        </p>
      ) : null}
      {turn?.turnId && onReturnToTurn ? (
        <button class="small-button proof-scope__return" type="button" onClick={() => onReturnToTurn(sessionId, turn.turnId!)}>
          <Icon name="chat" size={14} /> {returnLabel(turn)}
        </button>
      ) : null}
    </section>
  );
}

/** How many rows render before the list asks to be expanded. */
const ACTIVITY_PAGE = 8;

/**
 * Every recorded thing this session did, in journal order.
 *
 * The counts above are the audit's own classification and stay; this is the
 * record they classify. Five integers cannot say which file a commit touched,
 * what a `/read` read, or what an answer was selected from — and those are the
 * three questions the people who open this route arrive with.
 */
function ProofActivityList({
  activity,
  scopedTurnId,
  sessionId,
  onReturnToTurn,
}: Readonly<{
  activity: ProofActivityLedger;
  scopedTurnId?: string;
  sessionId?: string;
  onReturnToTurn?: (sessionId: string, turnId: string) => void;
}>) {
  const [expanded, setExpanded] = useState(false);
  if (activity.rows.length === 0) return null;
  const hidden = Math.max(0, activity.rows.length - ACTIVITY_PAGE);
  // Newest first: the thing a reader is asking about is almost always the last
  // thing that happened, and a chronological list buried it under the day.
  const ordered = [...activity.rows].reverse();
  const shown = expanded ? ordered : ordered.slice(0, ACTIVITY_PAGE);
  return (
    <section class="proof-activity" aria-label="Records in this session's journal">
      <ol class="proof-activity__list">
        {shown.map((row) => (
          <li key={row.id} class="proof-activity__row" data-kind={row.kind} data-scoped={row.turnId && row.turnId === scopedTurnId ? "true" : undefined}>
            <p class="proof-activity__head">
              <span class="proof-activity__kind">{ACTIVITY_KIND_LABELS[row.kind]}</span>
              <span class="proof-activity__state" data-outcome={row.outcome}>{row.outcomeLabel}</span>
            </p>
            <p class="proof-activity__title">{row.title}</p>
            {row.facts.length > 0 ? (
              <dl class="proof-activity__facts">{row.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
            ) : null}
            {/* The researcher's question, answered where the answer is. Each
                source is the tuple the selection sealed: which file, at which
                revision, which chunk, and the digest of that chunk's bytes —
                enough to fetch it and check it, which is what provenance means
                and what a request/response digest pair cannot say. */}
            {row.grounding.length > 0 ? (
              <details class="proof-activity__grounding">
                <summary>{row.grounding.length} source{row.grounding.length === 1 ? "" : "s"} selected for this turn{row.groundingTruncated ? " · selection was cut at its byte ceiling" : ""}</summary>
                <ul>
                  {row.grounding.map((source) => (
                    <li key={`${source.path}#${source.chunkId}`}>
                      <strong>{source.path}</strong>
                      <span>rev {source.revision} · chunk {source.chunkIndex}{source.corpus ? ` · ${source.corpus}` : ""}</span>
                      <code>{source.contentDigest}</code>
                    </li>
                  ))}
                </ul>
              </details>
            ) : row.kind === "provider-turn" ? (
              <p class="proof-activity__grounding-absent">No sources were selected for this turn.</p>
            ) : null}
            {row.receiptId ? <p class="proof-activity__receipt"><code>{row.receiptId}</code></p> : null}
            {/* Not on the scoped row: the block above already offers this exact
                action for this exact turn, and two identical controls 200px
                apart for one action is menu noise, not disclosure. */}
            {row.turnId && sessionId && onReturnToTurn && row.turnId !== scopedTurnId ? (
              <button class="proof-activity__open" type="button" onClick={() => onReturnToTurn(sessionId, row.turnId!)}>{returnLabel(row)} <span aria-hidden="true">→</span></button>
            ) : null}
          </li>
        ))}
      </ol>
      {hidden > 0 && !expanded ? (
        <button class="small-button" type="button" onClick={() => setExpanded(true)}>Show {hidden} older record{hidden === 1 ? "" : "s"}</button>
      ) : null}
      {/* A ledger that silently skips what it cannot classify is the defect
          this module exists to close, one level up. The figures are stated so
          a reader can see the difference between "nothing else happened" and
          "this reading does not cover everything in the journal". */}
      <p class="proof-activity__coverage">{activity.accountedEvents} of {activity.totalEvents} journal event{activity.totalEvents === 1 ? "" : "s"} are accounted for by these records. The rest are session lifecycle and protocol steps, audited above.</p>
    </section>
  );
}

/**
 * What the return control can honestly promise for this row.
 *
 * A transcript card learns its turn identity from its receipt, so a local
 * command — which mints none — has no card to land on. Offering "Open this
 * turn" there would be a control that opens the conversation and then quietly
 * does not do the thing its label names, which is the class of claim this whole
 * route exists to retire. The capability is not withdrawn: the conversation
 * still opens, and the label says that is what happens.
 */
function returnLabel(row: ProofActivityRow): string {
  return row.receiptId ? "Return to this turn" : "Open the conversation";
}

const ACTIVITY_KIND_LABELS: Readonly<Record<ProofActivityRow["kind"], string>> = Object.freeze({
  "provider-turn": "Provider turn",
  "local-command": "Local command",
  "approved-effect": "Approved by you",
  shell: "Shell",
  naming: "Conversation naming",
});

/**
 * The dimension this journal does not have, said on the surface that audits it.
 *
 * Measured (J061): Proof audits the journal and receipts only — its counts are
 * events, turns, tool operations and shell records, with no network dimension —
 * and a reader auditing "what actually happened" had no way to know that the
 * absence of network facts here was a boundary rather than an all-clear. The
 * observed record itself is the Connection route's: one wire, one witness, and
 * this route imports nothing of it, because a second observer of one wire is
 * how a product ends up with two answers to one question.
 */
function ProofEgressSummary() {
  return (
    <section class="proof-egress" aria-label="What has left this device">
      <p class="proof-egress__head"><span class="eyebrow">What has left this device</span></p>
      <p class="proof-egress__line">Nothing on this page is evidence about the network. The session journal records turns, tools, local commands, shell work and your approvals; it has no field for a request, and the exports above inherit that boundary.</p>
      <p class="proof-egress__route">The observed record — every off-origin host, method, path, outcome, and whether a credential rode along — is kept on <a href="#access">Connection</a> under “What has left this device”.</p>
    </section>
  );
}

/**
 * What the receipt can say about where an answer came from.
 *
 * "Not bound to this receipt. A turn's selected sources are journal records."
 * was true and useless: it named an absence without naming where the thing
 * actually is. It now reads the selection the turn seam sealed, and the three
 * states it distinguishes are three different facts — sources were selected,
 * none were, or the journal has not been read yet.
 */
export function answerProvenanceReading(turn: ProofActivityRow | undefined, journalRead: boolean): string {
  if (!journalRead) return "Reading this session's journal for the sources selected for this turn.";
  if (!turn) return "This turn is not in the journal read for this view, so its selected sources cannot be named.";
  if (turn.grounding.length === 0) {
    return "No sources were selected for this turn. The receipt binds the request and response bytes only.";
  }
  const bytes = turn.groundingBytes === undefined ? "" : ` · ${turn.groundingBytes.toLocaleString()} bytes`;
  return `${turn.grounding.length} source${turn.grounding.length === 1 ? "" : "s"} selected and journaled${bytes}. Path, revision, chunk and content digest are listed with this turn's record on this page.`;
}

/**
 * What each export control discloses, stated before it is pressed.
 *
 * The primary control ships `responseDigest`: an unsalted SHA-256 over the
 * assistant's verbatim reply. Anyone holding a candidate answer can hash it and
 * confirm the match, which makes the field content-recoverable in every sense
 * that matters to the operator who exports it for a third party — and the page
 * described the same artifact as "bounded endpoint evidence and local
 * commitments". The class is named here in the same words the artifact carries.
 */
export const EXPORT_DISCLOSURE_LINES: readonly ProofFact[] = Object.freeze([
  Object.freeze({
    label: "Raw verification bundle",
    value: "Content-recoverable. Carries unsalted SHA-256 digests of the request and the reply, the selected source paths and revisions, and the session journal itself, whose events include message text. Anyone holding a candidate message can confirm it against these digests.",
  }),
  Object.freeze({
    label: "Safe summary",
    value: "Metadata only. Claim states, posture and identifiers; no message digest and no journal. It is not proof, and it is not signed.",
  }),
  Object.freeze({
    label: "Session audit",
    value: "Metadata only. Structure checks, counts, findings and the journal commitment digest — no message text and no message digest.",
  }),
]);

/** The exported disclosure map, generated from the fields actually present. */
function exportDisclosure(hasReceipt: boolean, hasJournal: boolean): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(hasReceipt ? {
      "receipt.bindings.requestDigest": "content-recoverable — unsalted SHA-256 of the canonical request",
      "receipt.bindings.responseDigest": "content-recoverable — unsalted SHA-256 of the verbatim reply",
      "receipt.claims": "metadata-only",
    } : {}),
    ...(hasJournal ? {
      "sessionJournal.events": "content-recoverable — the immutable journal, including message payloads",
    } : {}),
    answerProvenance: "content-recoverable — source paths, revisions and chunk digests",
    journalAudit: "metadata-only — structure checks, counts and the commitment digest",
    endpointEvidence: "opaque — raw bounded attestation payloads as the endpoint returned them",
  });
}

/** The boundary sentences the bundle can actually stand behind, given its fields. */
function verificationBoundary(hasEndpointEvidence: boolean, hasAudit: boolean, hasJournal: boolean): readonly string[] {
  return Object.freeze([
    "This bundle preserves raw bounded endpoint evidence and local commitments; it is not signed by Airship or an enclave.",
    ...(hasEndpointEvidence ? [
      "Verify Intel TDX quote signatures and collateral independently, then check report_data against SHA-256(nonce + E2E public key).",
      "Verify NVIDIA evidence with NVIDIA's verifier, including nonce binding, certificate/revocation state, firmware RIM policy, and freshness.",
    ] : ["No endpoint evidence was bound to this receipt, so no hardware claim in this bundle has an external verifier."]),
    ...(hasAudit ? [hasJournal
      ? "Recompute journalAudit.commitment.digest over sessionJournal.events; sessionJournal.coversCommitment states whether these events are the whole prefix the commitment was taken over."
      : "journalAudit.commitment.digest cannot be recomputed from this file: no session journal was available to include."] : []),
    // The artifact an auditor reads away from the screen has to carry the
    // boundary the screen states. Measured: an audit exported right after two
    // human-approved Git commits read "toolOperations": 0 and "complete": true,
    // and nothing in the file said its counts have no field for a
    // human-initiated effect.
    "journalAudit.counts classifies turns, tool operations, local commands, shell records and human-approved decisions; checks.complete reports only that no completeness finding was raised for the events present.",
    "Digests in this bundle are unsalted. A party holding a candidate message can confirm it by hashing; see the disclosure map for which fields are content-recoverable.",
    "Nothing in this bundle is evidence about the network. The session journal has no field for a request, so no host, method or credential fact can be recomputed from it.",
  ]);
}
