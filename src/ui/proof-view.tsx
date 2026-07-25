import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { serializePortableReceipt } from "../attestation/receipt";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { SessionAuditReport } from "../core/session-audit";
import type { ConversationReceipt } from "../receipts/types";
import { Icon } from "./icons";
import type { ProofSection } from "./proof-route";
import { sealStateForReceipt, SEAL_LABELS, Seal } from "./seal";
import { proofLevelLabel, relativeEvidenceAge } from "./trust-language";

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
      const objectUrl = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
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
  const receiptSeal = sealStateForReceipt(receipt);
  const teeVerified = receiptSeal === "verified";

  return (
    <section class="work-view">
      <header class="page-heading"><span class="eyebrow">Inspectable, portable evidence</span><h1>Proof</h1><p>Endpoint attestation and conversation receipts are different claims. Airship never presents one as the other.</p></header>
      <nav class="proof-surface-tabs" aria-label="Proof views" role="tablist">
        <button id="proof-tab-summary" type="button" role="tab" aria-controls="proof-panel-summary" aria-selected={section === "summary"} tabIndex={section === "summary" ? 0 : -1} onClick={() => onSectionChange("summary")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onSectionChange("attestations"); requestAnimationFrame(() => document.getElementById("proof-tab-attestations")?.focus()); } }}>Receipt &amp; journal</button>
        <button id="proof-tab-attestations" type="button" role="tab" aria-controls="proof-panel-attestations" aria-selected={section === "attestations"} tabIndex={section === "attestations" ? 0 : -1} onClick={() => onSectionChange("attestations")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onSectionChange("summary"); requestAnimationFrame(() => document.getElementById("proof-tab-summary")?.focus()); } }}>Attestation evidence</button>
      </nav>
      <div id="proof-panel-attestations" class="proof-surface-panel" role="tabpanel" aria-labelledby="proof-tab-attestations" hidden={section !== "attestations"}>{evidenceLedger}</div>
      <div id="proof-panel-summary" class="proof-surface-panel" role="tabpanel" aria-labelledby="proof-tab-summary" hidden={section !== "summary"}>
        <div class="proof-overview">
          <div class="proof-hero panel">
            <Seal class="proof-hero-seal" state={receiptSeal} origin={receipt?.posture === "local" ? "local" : "remote"} label={SEAL_LABELS[receiptSeal]} detail={receipt ? summarizeReceipt(receipt) : "No completed turn receipt is selected."} size={44} />
            <div><span class="eyebrow">Current proof level</span><h2>{receipt ? proofLevelLabel(receipt.proofLevel) : requestedReceiptId ? "Receipt unavailable" : "No completed turn"}</h2><p>{receipt ? summarizeReceipt(receipt) : requestedReceiptId ? "The selected receipt is not available in this page runtime. Airship will not substitute a different turn receipt." : "Complete a turn to create the first local receipt."}</p></div>
          </div>
          <div class="metric"><span>Session journal</span><strong>{auditLabel}</strong><small>{audit ? `${audit.counts.events} event${audit.counts.events === 1 ? "" : "s"} · ${audit.commitment.digest.slice(0, 18)}…` : `${eventCount} observed event${eventCount === 1 ? "" : "s"}`}</small></div>
          <div class="metric"><span>TEE verification</span><strong>{teeVerified ? "Receipt-attested" : "Not established"}</strong><small>{receipt?.posture === "encrypted-unattested" ? "compatibility mode" : receipt?.posture === "encrypted-attested" && !teeVerified ? "receipt fields disagree; verification failed closed" : "production remote mode must fail closed"}</small></div>
        </div>
        {renderInspector(() => onSectionChange("attestations"))}
        <section class={`journal-audit panel ${audit?.status ?? "pending"}`} aria-labelledby="journal-audit-title">
          <div class="journal-audit-heading"><div><span class="eyebrow">Independent local consistency check</span><h2 id="journal-audit-title">Session journal integrity</h2></div><span class={`audit-state ${audit?.status ?? "pending"}`}>{auditLabel}</span></div>
          {audit ? <>
            <div class="audit-boundary"><Icon name={audit.status === "invalid" ? "warning" : "proof"} size={18} /><p><strong>A valid hash chain is not proof of authorship.</strong> This report checks schema, ordering, manifest bindings, turn/tool protocol, and receipt bindings. No separately trusted author identity was established.</p></div>
            <div class="audit-check-grid" aria-label="Journal audit checks">{([
              ["Schema", audit.checks.schema], ["Hash chain", audit.checks.chain], ["Manifest", audit.checks.manifest], ["Turn protocol", audit.checks.protocol], ["Receipt bindings", audit.checks.receiptBindings], ["Complete history", audit.checks.complete],
            ] as const).map(([label, passed]) => <div key={label} class={passed ? "pass" : "fail"}><Seal state={passed ? "verified" : "failed"} label={passed ? "Passed" : "Failed"} size={16} compact /><strong>{label}</strong><small>{passed ? "consistent" : "attention required"}</small></div>)}</div>
            <dl class="audit-commitment"><div><dt>Session</dt><dd>{audit.sessionId}</dd></div><div><dt>Journal events</dt><dd>{audit.commitment.sequence}</dd></div><div><dt>Checked</dt><dd><time dateTime={audit.checkedAt} title={new Date(audit.checkedAt).toLocaleString()}>{relativeEvidenceAge(audit.checkedAt)}</time></dd></div><div><dt>External anchor</dt><dd>{audit.anchor.status === "not-supplied" ? "Not supplied" : audit.anchor.status === "matched" ? "Matched" : "Did not match"}</dd></div></dl>
            <details><summary>Technical journal details</summary><code>{audit.commitment.digest}</code></details>
            {audit.findings.length > 0 ? <details class="audit-findings" open={audit.status === "invalid"}><summary>{audit.findings.length} audit finding{audit.findings.length === 1 ? "" : "s"}</summary><div>{audit.findings.slice(0, 30).map((finding, index) => <article key={`${finding.code}-${finding.sequence ?? index}`} data-severity={finding.severity}><span>{finding.severity}</span><strong>{finding.code}</strong><p>{finding.message}</p></article>)}</div></details> : <p class="audit-clean">No consistency findings were produced for this session prefix.</p>}
          </> : <p class="audit-loading" role="status">{auditError ?? (auditLoading ? "Recomputing the session commitment…" : "No active session is available to audit.")}</p>}
        </section>
        <div class="proof-actions" aria-label="Portable evidence actions">
          {receipt ? <button class="small-button" type="button" onClick={() => void copyReceipt()}><Icon name="proof" size={14} /> Copy safe summary</button> : null}
          {receipt ? <button class="small-button" type="button" onClick={() => download(serializePortableReceipt(receipt), `airship-receipt-${receipt.receiptId.slice(-8)}.json`, "Privacy-safe unsigned receipt summary exported")}><Icon name="cloud" size={14} /> Export safe summary</button> : null}
          {audit ? <button class="small-button" type="button" onClick={() => download(JSON.stringify(audit, null, 2), `airship-session-audit-${audit.sessionId.slice(0, 8)}.json`, "Session audit exported")}><Icon name="proof" size={14} /> Export session audit</button> : null}
          {receipt || audit || endpointEvidenceRecords.length > 0 ? <button class="small-button" type="button" onClick={() => void exportVerificationBundle()}><Icon name="proof" size={14} /> Export raw verification bundle</button> : null}
          {receiptAction ? <span role="status" aria-live="polite">{receiptAction}</span> : null}
        </div>
        {receipt ? <p class="proof-export-boundary">Default receipt export is an unsigned privacy-safe status summary. The explicitly labeled raw bundle adds bounded endpoint evidence and local commitments for independent verification, but it remains unsigned and does not include the full immutable journal.</p> : null}
      </div>
    </section>
  );
}
