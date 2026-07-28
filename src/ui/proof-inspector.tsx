import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { ConversationReceipt } from "../receipts/types";
import { composeClaimStack, type ClaimStackFact, type ClaimStackItem } from "./claim-stack-model";
import { Icon } from "./icons";
import { Seal, sealStateForProofStatus } from "./seal";
import { sealStateForReceipt } from "./seal-states";
import { claimExpiry, claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, relativeEvidenceAge } from "./trust-language";
import { turnEvidenceVerdict } from "./turn-evidence";

/*
 * The claim rail, delivered with the evidence it renders.
 *
 * It used to live in `app.tsx`, which put `composeClaimStack`, the whole claim
 * vocabulary and the verdict reducer into the first-paint bundle for a panel
 * that cannot render until a turn has produced a receipt. Nothing about the
 * rail is needed to draw an empty conversation, so nothing about it is
 * downloaded to draw one. The chat aside and the Proof route both mount it
 * through the same lazy import the other evidence surfaces already use.
 *
 * `export` on all three because the module is the boundary now, not the file.
 */

export function ProofInspector({
  receipt,
  endpointRecord,
  now = Date.now(),
  compact = false,
  onOpenAttestations,
}: {
  receipt?: ConversationReceipt;
  endpointRecord?: ChutesEndpointEvidenceRecord;
  now?: number;
  compact?: boolean;
  onOpenAttestations?: () => void;
}) {
  const model = composeClaimStack(receipt, endpointRecord, now);
  /*
   * The rail speaks the canonical verdict, in the canonical words.
   *
   * It used to print `{verified + asserted} established`, which is the exact
   * usage `trust-language.ts` retired: "established" counted assertions as
   * proof here while the metric card beside it used the same word to mean
   * nothing was proven. It also printed a second bottom-line sentence from a
   * different reducer than the Proof route's hero, so one turn had two
   * verdicts one route apart. One reducer now answers both.
   */
  const verdict = turnEvidenceVerdict({
    stack: model,
    hasReceipt: Boolean(receipt),
    attestedFieldsDisagree: Boolean(receipt) && sealStateForReceipt(receipt) === "failed",
  });
  const evidenceTone = model.evidence === "absent"
    ? "absent"
    : model.evidence.startsWith("stale-") ? "stale" : "matched";
  const evidenceLabel = model.evidence === "turn-bound"
    ? "Receipt-bound endpoint evidence"
    : model.evidence === "same-endpoint"
      ? "Same endpoint · not turn-bound"
      : model.evidence === "stale-turn-bound"
        ? "Receipt evidence refresh due"
        : model.evidence === "stale-same-endpoint"
          ? "Endpoint comparison expired"
          : "Turn receipt only";
  return (
    <div class={compact ? "proof-inspector compact" : "proof-inspector panel"}>
      <div class="inspector-heading"><div><span class="eyebrow">Claim stack</span><h2>Verification</h2></div><span class="proof-level">{receipt ? proofLevelLabel(receipt.proofLevel) : "Not checked"}</span></div>
      {receipt ? <p class="proof-bottom-line" data-state={verdict.state}><strong>{verdict.chip}</strong> <span>{verdict.line}</span></p> : null}
      {receipt ? (
        <section class={`evidence-join evidence-join--${evidenceTone}`} aria-label="Evidence composition">
          <div class="evidence-join__heading">
            <strong class={`evidence-join__state evidence-join__state--${evidenceTone}`}><span aria-hidden="true" />{evidenceLabel}</strong>
            {/* Three counts in the three words the legend defines, so a reader
                who learns the vocabulary once can read this row. The old pair
                folded assertions into "established" and then called absence
                "not established" — the same word for proof and for its
                absence, 183px apart. */}
            <span>{verdict.counts.verified} verified · {verdict.counts.asserted} asserted · {verdict.counts.noEvidence} no evidence</span>
          </div>
          <p>{model.evidenceSummary}</p>
          {endpointRecord ? <dl class="evidence-join__facts">
            <div><dt>Instance</dt><dd>{endpointRecord.subject.instanceId}</dd></div>
            <div><dt>Evidence</dt><dd>{relativeEvidenceAge(endpointRecord.acquisition.fetchedAt, now)}</dd></div>
          </dl> : null}
          {onOpenAttestations ? <button class="evidence-join__action" type="button" onClick={onOpenAttestations}>{endpointRecord ? "Inspect endpoint evidence" : "Inspect evidence"} <span aria-hidden="true">→</span></button> : null}
        </section>
      ) : null}
      <div class="claim-groups">
        <ClaimGroup label="Needs attention" tone="failed" items={model.groups.failed} receipt={receipt} />
        <ClaimGroup label="Verified" tone="verified" items={model.groups.verified} receipt={receipt} />
        <ClaimGroup label="Assertions" tone="asserted" items={model.groups.asserted} receipt={receipt} />
        {model.groups.unavailable.length > 0 ? (
          <details class="claim-absence" open={!receipt}>
            {/* "No evidence", the legend's own word for absence. "Not
                established" was the other half of the retired pair: the rail
                counted assertions as "established" one row above while this
                row used the same verb to mean nothing was proven, so one page
                gave the word two opposite meanings. */}
            <summary><span>No evidence</span><strong>{model.groups.unavailable.length}</strong><small>Future or unavailable claims</small></summary>
            <div class="claim-absence__list">
              {model.groups.unavailable.map((item) => {
                const language = claimLanguage(item.key);
                return <div key={item.key}><span>{language.primary}</span><small>{item.claim.summary}</small></div>;
              })}
            </div>
          </details>
        ) : null}
      </div>
      {receipt ? (
         <details class="receipt-record"><summary>Technical receipt details</summary>
          <div class="receipt-id"><span>Receipt</span><code>{receipt.receiptId}</code></div>
          <dl class="receipt-metadata">
             <div><dt>Created</dt><dd><time dateTime={receipt.createdAt}>{relativeEvidenceAge(receipt.createdAt)}</time></dd></div>
             <div><dt>Posture</dt><dd>{postureLabel(receipt.posture)}</dd></div>
            <div><dt>Provider</dt><dd>{receipt.provider}</dd></div>
            <div><dt>Model</dt><dd>{receipt.model ?? "not recorded"}</dd></div>
            <div><dt>Session</dt><dd>{receipt.sessionId}</dd></div>
            <div><dt>Turn</dt><dd>{receipt.turnId}</dd></div>
            <div><dt>Binding</dt><dd>{receipt.bindings.algorithm}</dd></div>
            <div><dt>Evidence</dt><dd>{receipt.evidence?.format ?? "not attached"}</dd></div>
          </dl>
          <dl class="binding-record">
            {receipt.bindings.requestDigest ? <div><dt>Request digest</dt><dd>{receipt.bindings.requestDigest}</dd></div> : null}
            {receipt.bindings.responseDigest ? <div><dt>Response digest</dt><dd>{receipt.bindings.responseDigest}</dd></div> : null}
            {receipt.bindings.requestCiphertextDigest ? <div><dt>Request ciphertext</dt><dd>{receipt.bindings.requestCiphertextDigest}</dd></div> : null}
            {receipt.bindings.responseCiphertextDigest ? <div><dt>Response ciphertext</dt><dd>{receipt.bindings.responseCiphertextDigest}</dd></div> : null}
            {receipt.bindings.evidenceDigest ? <div><dt>Evidence digest</dt><dd>{receipt.bindings.evidenceDigest}</dd></div> : null}
          </dl>
         </details>
      ) : <p class="inspector-note">No turn receipt yet. Production remote mode must verify fresh endpoint evidence before inference; the compatibility lab remains visibly unattested.</p>}
    </div>
  );
}

function ClaimGroup({ label, tone, items, receipt }: { label: string; tone: "failed" | "verified" | "asserted"; items: readonly ClaimStackItem[]; receipt?: ConversationReceipt }) {
  if (items.length === 0) return null;
  return <section class={`claim-group claim-group--${tone}`} aria-label={`${label} claims`}>
    <header><span>{label}</span><strong>{items.length}</strong></header>
    <div class="claim-list">{items.map((item) => <ClaimRow key={item.key} item={item} receipt={receipt} />)}</div>
  </section>;
}

function ClaimRow({ item, receipt }: { item: ClaimStackItem; receipt?: ConversationReceipt }) {
  const { key: claimKey, claim, verification, facts, source, status } = item;
  const sealState = sealStateForProofStatus(status);
  const language = claimLanguage(claimKey);
  const expiresAt = claimExpiry(claim.details);
  return (
    <details class="claim-row">
      <summary>
        <span class="claim-title">{language.primary}</span>
        <span class="claim-disclosure"><span aria-hidden="true" /></span>
        <span class="claim-meta">
          <Seal class="claim-seal" state={sealState} label={proofStatusLabel(status)} size={16} compact />
          <span class={`claim-source claim-source--${source}`}>{source === "endpoint-evidence" ? "Receipt-bound evidence" : "Turn receipt"}</span>
        </span>
      </summary>
      <div class="claim-detail">
         <p>{claim.summary}</p>
         <dl><dt>Claim</dt><dd>{language.technical}</dd></dl>
         <dl><dt>Source</dt><dd>{source === "endpoint-evidence" ? "Endpoint evidence whose normalized payload digest matches this receipt" : "This conversation turn receipt"}</dd></dl>
         <dl><dt>Issuer</dt><dd>{claim.verifier ?? verification?.verifier ?? receipt?.provider ?? "Not supplied"}</dd></dl>
         <dl><dt>Subject</dt><dd>{receipt?.model ?? receipt?.sessionId ?? "Not supplied"}</dd></dl>
         <dl><dt>Scope</dt><dd>{claimKey === "conversation" ? "This conversation turn" : claimKey === "payment" ? "This account observation" : "This inference endpoint"}</dd></dl>
         <dl><dt>Status</dt><dd>{proofStatusLabel(status)}</dd></dl>
        {claim.verifier || verification?.verifier ? <dl><dt>Verifier</dt><dd>{claim.verifier ?? verification?.verifier}</dd></dl> : null}
        {verification?.version ? <dl><dt>Version</dt><dd>{verification.version}</dd></dl> : null}
         {claim.checkedAt || verification?.checkedAt ? <dl><dt>Checked</dt><dd><time dateTime={claim.checkedAt ?? verification?.checkedAt}>{relativeEvidenceAge((claim.checkedAt ?? verification?.checkedAt)!)}</time></dd></dl> : null}
         <dl><dt>Expires</dt><dd>{expiresAt ? <time dateTime={expiresAt} title={new Date(expiresAt).toLocaleString()}>{relativeEvidenceAge(expiresAt)}</time> : "Not supplied"}</dd></dl>
        {facts.map((fact: ClaimStackFact) => <dl key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></dl>)}
        {verification?.detail ? <dl><dt>Verifier note</dt><dd>{verification.detail}</dd></dl> : null}
         {claim.policyDigest || claim.details !== undefined ? <details><summary>Technical details</summary>{claim.policyDigest ? <dl><dt>Verifier policy digest</dt><dd>{claim.policyDigest}</dd></dl> : null}{claim.details !== undefined ? <pre>{JSON.stringify(claim.details, null, 2)}</pre> : null}</details> : null}
      </div>
    </details>
  );
}
