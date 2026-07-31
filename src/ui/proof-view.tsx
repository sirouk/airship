import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { serializePortableReceipt } from "../attestation/receipt";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { SessionAuditReport } from "../core/session-audit";
import type { ConversationReceipt } from "../receipts/types";
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
import type { ProofSection } from "./proof-route";
import { RouteHeader } from "./route-header";
import { sealStateForProofStatus, Seal, type SealState } from "./seal";
import { sealStateForReceipt } from "./seal-states";
import { Tabs } from "./tabs";
import { claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, relativeEvidenceAge } from "./trust-language";
import "./proof-view.css";

export function ProofView({
  receipt,
  eventCount,
  sessionId,
  requestedReceiptId,
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
  loadAudit: (sessionId: string) => Promise<SessionAuditReport>;
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
  const [audit, setAudit] = useState<SessionAuditReport>();
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

  useEffect(() => {
    let current = true;
    setAudit(undefined);
    setAuditError(undefined);
    if (!sessionId) return () => { current = false; };
    setAuditLoading(true);
    void loadAudit(sessionId)
      .then((report) => {
        if (current) setAudit(report);
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
      const bundle = {
        schema: "airship.verification-bundle.v1",
        exportedAt: new Date().toISOString(),
        scope: {
          sessionId: sessionId ?? null,
          receiptId: receipt?.receiptId ?? requestedReceiptId ?? null,
        },
        receipt: receipt ?? null,
        journalAudit: audit ?? null,
        endpointEvidence: relevantEvidence.map((record) =>
          JSON.parse(exportChutesEndpointEvidenceRecord(record, { includeRawEvidence: true })) as unknown,
        ),
        verificationBoundary: [
          "This bundle preserves raw bounded endpoint evidence and local commitments; it is not signed by Airship or an enclave.",
          "Verify Intel TDX quote signatures and collateral independently, then check report_data against SHA-256(nonce + E2E public key).",
          "Verify NVIDIA evidence with NVIDIA's verifier, including nonce binding, certificate/revocation state, firmware RIM policy, and freshness.",
          "A journal audit commitment can be recomputed only with the corresponding immutable session journal.",
          // The artifact an auditor reads away from the screen has to carry the
          // boundary the screen now states. Measured: an audit exported right
          // after two human-approved Git commits read "toolOperations": 0 and
          // "complete": true, and nothing in the file said that its counts have
          // no field for a human-initiated effect — so the export both
          // under-reported and looked authoritative about it.
          "journalAudit.counts covers turns, tool operations, local commands and shell records. Human-approved effects journaled as human.intent.reviewed are validated by the audit but counted by no field, and checks.complete reports only that no completeness finding was raised for the events present.",
        ],
      };
      const suffix = receipt?.receiptId.slice(-8) ?? sessionId?.slice(0, 8) ?? "evidence";
      download(JSON.stringify(bundle, null, 2), `airship-verification-bundle-${suffix}.json`, "Raw verification bundle exported");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  const auditReading = journalAuditReading(audit, auditLoading, Boolean(auditError));
  const auditLabel = auditReading.label;
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
        <section class="proof-verdict" data-state={verdict.state} aria-label={`Turn evidence. ${verdict.chip}. ${verdict.line}`}>
          {/* The route's one hero seal, and the one place a seal renders its
              detail as visible text rather than a tooltip. It is a button
              because §4.4's disclosure contract is universal: every chip and
              hero expands into the claim stack, so the eight claims behind
              this single word are one gesture away on a touch device too. */}
          <Popover
            class="proof-verdict__claims"
            heading="Claim stack"
            label={`Turn evidence: ${verdict.chip}. ${verdict.line} ${claimStack.items.length} claims. Open the claim stack.`}
            trigger={<Seal
              class="proof-hero-seal"
              state={verdict.seal}
              density="hero"
              origin={receipt?.posture === "local" ? "local" : "remote"}
              label={verdict.chip}
              detail={verdict.line}
            />}
          >
            <p class="proof-hero-claims__evidence">{claimStack.evidenceSummary}</p>
            {claimStack.items.map((item) => <ClaimPopoverRow key={item.key} item={item} />)}
          </Popover>
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
            {/* An acquisition failure is a modifier on the verdict, never a
                second verdict: the fetch that did not happen is not a
                verification that failed. */}
            {verdict.modifier ? <p class="proof-verdict__modifier"><Icon name="warning" size={14} />{verdict.modifier}</p> : null}
            {receipt ? <p class="proof-verdict__summary">{summarizeReceipt(receipt)}</p> : null}
            {receipt ? null : <p class="proof-verdict__context">{missingReceiptReading(audit, requestedReceiptId)}</p>}
            {/* Inside the body, under its own scope line, because it is the one
                block here that is not about the turn: an unlabelled ledger sat
                under "Turn evidence" and claimed the wrong subject at 390px,
                where the two columns become one. Present exactly when there is
                an audited journal to speak for — an unread or unreadable
                journal must not render four zeros as if it had counted them. */}
            {recordedActivity.length > 0 ? <>
              <p class="proof-verdict__context"><span class="eyebrow">Recorded in this session’s journal</span></p>
              <dl class="proof-posture" aria-label="Work recorded in this session’s journal">
                {recordedActivity.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
              </dl>
            </> : null}
          </div>
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
          {receipt ? (
            <dl class="proof-posture" aria-label="Declared turn posture">
              <div><dt>Declared proof level</dt><dd>{proofLevelLabel(receipt.proofLevel)}</dd></div>
              <div><dt>Transport</dt><dd>{postureLabel(receipt.posture)}</dd></div>
              <div><dt>Endpoint attestation</dt><dd>{attestationNote}</dd></div>
              {/* The researcher's question, answered by its absence rather than
                  by silence: a reader who opened a receipt looking for what the
                  answer was grounded in found a request digest, a response
                  digest and eight attestation claims, and no statement anywhere
                  that provenance is not among them. No receipt shape carries it
                  — `createLocalReceipt` mints bindings only, and a provider
                  receipt arrives with claims — so this row is a constant until
                  the turn seam (`src/core/agent.ts`) passes the selection it
                  already journals as `turn.context.selected` into the receipt
                  it mints two hundred lines later. */}
              <div><dt>Answer provenance</dt><dd>Not bound to this receipt. A turn's selected sources are journal records.</dd></div>
            </dl>
          ) : null}
        </section>
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
        {receipt ? <p class="proof-export-boundary">Default receipt export is an unsigned privacy-safe status summary. The explicitly labeled raw bundle adds bounded endpoint evidence and local commitments for independent verification, but it remains unsigned and does not include the full immutable journal.</p> : null}
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
 * What it cannot say, and why: two approved Git commits are journaled as
 * `human.intent.reviewed` and validated by the audit, but `counts` has no
 * field for them, so they are countable by nothing this route can read. That
 * field belongs in `SessionAuditReport["counts"]` (`src/core/session-audit.ts`)
 * — until it exists, the sentence beside this list reports the event total
 * rather than inventing a category.
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
  ]);
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
