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
} from "./claim-stack-facts";
import { claimStackEndpointRecord, composeClaimStack, type ClaimStackItem } from "./claim-stack-model";
import { downloadFileName, downloadText } from "./file-download";
import { Icon } from "./icons";
import { Popover } from "./popover";
import "./popover.css";
import type { ProofSection } from "./proof-route";
import { RouteHeader } from "./route-header";
import { sealStateForProofStatus, Seal } from "./seal";
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
  }, [sessionId, eventCount]);

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
        ],
      };
      const suffix = receipt?.receiptId.slice(-8) ?? sessionId?.slice(0, 8) ?? "evidence";
      download(JSON.stringify(bundle, null, 2), `airship-verification-bundle-${suffix}.json`, "Raw verification bundle exported");
    } catch (error) {
      setReceiptAction(error instanceof Error ? error.message : String(error));
    }
  }

  const auditLabel = audit?.status === "verified"
    ? "Journal structure passed"
    : audit?.status === "incomplete"
      ? "Consistent but incomplete"
      : audit?.status === "invalid"
        ? "Integrity failure"
        : auditLoading ? "Checking journal" : "Not checked";
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
            {/* An acquisition failure is a modifier on the verdict, never a
                second verdict: the fetch that did not happen is not a
                verification that failed. */}
            {verdict.modifier ? <p class="proof-verdict__modifier"><Icon name="warning" size={14} />{verdict.modifier}</p> : null}
            {receipt ? <p class="proof-verdict__summary">{summarizeReceipt(receipt)}</p> : null}
            {receipt ? null : <p class="proof-verdict__context">{requestedReceiptId
              ? "The selected receipt is not available in this page runtime. Airship will not substitute a different turn receipt."
              : "Complete a turn to create the first local receipt."}</p>}
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
            {verdict.counts.failed > 0 ? <div data-status="failed"><dt><Seal state="failed" density="dot" size={16} />Failed</dt><dd>{verdict.counts.failed}</dd><small>A claim was checked or declared and did not hold.</small></div> : null}
            {/* Its own row, beside Failed and never inside it. Expiry used to
                fall through this tab's `else` and be counted as a failed check,
                so one expired endpoint observation printed "Failed: 1" here
                while the Attestation tab called the same claim a stale
                observation. The word comes from `proofStatusLabel` — the
                legend's own — and doubles as the dot's label, because the seal
                for expiry is the failure seal and would otherwise announce
                "Failed" beside a line that does not say it. */}
            {verdict.counts.expired > 0 ? <div data-status="expired"><dt><Seal state={sealStateForProofStatus("expired")} density="dot" size={16} label={proofStatusLabel("expired")} />{proofStatusLabel("expired")}</dt><dd>{verdict.counts.expired}</dd><small>A time-bounded endpoint observation expired. The immutable turn receipt did not become stale.</small></div> : null}
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
            </dl>
          ) : null}
        </section>
        {renderInspector(() => onSectionChange("attestations"))}
        <details class={`proof-journal panel ${audit?.status ?? "pending"}`} open={!audit || audit.findings.length > 0 || audit.status !== "verified"}>
          <summary class="proof-journal__row">
            {/* Same rule as the claim rows: the visible state word is the
                label, so the seal cannot announce a fifth vocabulary. */}
            <Seal state={journalSeal(audit, auditLoading)} density="dot" size={16} label={auditLabel} />
            <h2 id="journal-audit-title">Session journal integrity</h2>
            <span class="proof-journal__state">{auditLabel}{audit ? ` · ${passedChecks(audit)} of 6 structure checks passed` : ""}{audit && audit.findings.length > 0 ? ` · ${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"} to read` : ""}</span>
            <span class="proof-journal__facts">{audit ? `${audit.counts.events} event${audit.counts.events === 1 ? "" : "s"} · ${audit.commitment.digest.slice(0, 18)}…` : `${eventCount} observed event${eventCount === 1 ? "" : "s"}`}</span>
          </summary>
          <div class="proof-journal__body">
            <p class="proof-journal__scope"><span class="eyebrow">Independent local consistency check</span></p>
            {audit ? <>
              <div class="audit-boundary"><Icon name={audit.status === "invalid" ? "warning" : "proof"} size={18} /><p><strong>A valid hash chain is not proof of authorship.</strong> This report checks schema, ordering, manifest bindings, turn/tool protocol, and receipt bindings. No separately trusted author identity was verified.</p></div>
              <div class="audit-check-grid" role="group" aria-label="Journal audit checks">{auditChecks(audit).map(([label, passed]) => <div key={label} class={passed ? "pass" : "fail"}><Seal state={passed ? "verified" : "failed"} label={passed ? "Passed" : "Failed"} size={16} compact /><strong>{label}</strong><small>{passed ? "consistent" : "attention required"}</small></div>)}</div>
              {/* "Shell records" is here because until this pass the terminal
                  was the one effectful surface with no representation on this
                  screen at all: a `jsh` command that rewrote the workspace was
                  audited by nothing, so a reader could not tell a session where
                  no shell ran from one whose shell work was simply not
                  recorded. A zero is a fact; an absence was not. */}
              <dl class="audit-commitment"><div><dt>Session</dt><dd>{audit.sessionId}</dd></div><div><dt>Journal events</dt><dd>{audit.commitment.sequence}</dd></div><div><dt>Shell records</dt><dd>{audit.counts.shellRecords}</dd></div><div><dt>Checked</dt><dd><time dateTime={audit.checkedAt} title={new Date(audit.checkedAt).toLocaleString()}>{relativeEvidenceAge(audit.checkedAt)}</time></dd></div><div><dt>External anchor</dt><dd>{audit.anchor.status === "not-supplied" ? "Not supplied" : audit.anchor.status === "matched" ? "Matched" : "Did not match"}</dd></div></dl>
              <details><summary>Technical journal details</summary><code>{audit.commitment.digest}</code></details>
              {/* Open whenever findings exist. A warning collapsed under a row
                  announcing that everything passed is the shape of a burial. */}
              {audit.findings.length > 0 ? <details class="audit-findings" open><summary>{audit.findings.length} audit finding{audit.findings.length === 1 ? "" : "s"}</summary><div>{audit.findings.slice(0, 30).map((finding, index) => <article key={`${finding.code}-${finding.sequence ?? index}`} data-severity={finding.severity}><span>{finding.severity}</span><strong>{finding.code}</strong><p>{finding.message}</p></article>)}</div></details> : <p class="audit-clean">No consistency findings were produced for this session prefix.</p>}
            </> : <p class="audit-loading" role="status">{auditError ?? (auditLoading ? "Recomputing the session commitment…" : "No active session is available to audit.")}</p>}
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
 * The row's seal reflects the worst thing in the report, not only its status.
 *
 * A journal whose structure passed while carrying a warning is not the same
 * artifact as one with no findings at all, and the resting row is the only
 * place a reader who never expands it will learn the difference.
 */
function journalSeal(audit: SessionAuditReport | undefined, loading: boolean) {
  if (!audit) return loading ? "checking" as const : "none" as const;
  if (audit.status === "invalid") return "failed" as const;
  if (audit.status === "incomplete" || audit.findings.length > 0) return "attention" as const;
  return "verified" as const;
}
