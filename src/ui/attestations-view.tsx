import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-client";
import type { ConversationReceipt, ProofStatus } from "../receipts/types";
import { Icon } from "./icons";
import { Seal, sealStateForProofStatus } from "./seal";
import { postureLabel, proofLevelLabel, proofStatusLabel, relativeEvidenceAge } from "./trust-language";
import {
  ATTESTATION_DIMENSIONS,
  ATTESTATION_TECHNICAL_LABELS,
  attestationInputOverflow,
  normalizeAttestationEvidence,
  serializePublicAttestationSummary,
  type AttestationDimension,
  type AttestationDimensionKey,
  type AttestationVerification,
  type NormalizedAttestationRecord,
} from "./attestations-model";
import "./attestations-view.css";

export type AttestationRefreshTarget =
  | Readonly<{ kind: "endpoint-evidence"; record: ChutesEndpointEvidenceRecord }>
  | Readonly<{ kind: "conversation-receipt"; receipt: ConversationReceipt }>;

export type AttestationsViewProps = Readonly<{
  endpointRecords?: readonly ChutesEndpointEvidenceRecord[];
  receipts?: readonly ConversationReceipt[];
  selectedRecordId?: string;
  onSelectRecord?: (recordId: string) => void;
  onRefresh?: (target: AttestationRefreshTarget, signal: AbortSignal) => Promise<void>;
  onCancel?: (recordId: string) => void;
  /** Public, pre-redacted acquisition state from the mounted controller. */
  acquisitionNotice?: string;
  /** Opens the provider connection surface when acquisition is unavailable. */
  onOpenConnection?: () => void;
  /** Receives an unsigned, privacy-safe status summary. Raw evidence is never passed here. */
  onExport?: (json: string) => void;
  /** Renders inside the unified Proof route without introducing a second page heading. */
  embedded?: boolean;
}>;

type InspectorSelection =
  | Readonly<{ kind: "dimension"; key: AttestationDimensionKey }>
  | Readonly<{ kind: "verification"; id: string }>;

export function AttestationsView({
  endpointRecords = [],
  receipts = [],
  selectedRecordId,
  onSelectRecord,
  onRefresh,
  onCancel,
  acquisitionNotice,
  onOpenConnection,
  onExport,
  embedded = false,
}: AttestationsViewProps) {
  const inputOverflow = attestationInputOverflow({ endpointRecords, receipts });
  const records = useMemo(
    () => attestationInputOverflow({ endpointRecords, receipts })
      ? []
      : normalizeAttestationEvidence({ endpointRecords, receipts }),
    [endpointRecords, receipts],
  );
  const [localRecordId, setLocalRecordId] = useState(records[0]?.id ?? "");
  const [inspector, setInspector] = useState<InspectorSelection>({ kind: "dimension", key: "endpoint-key" });
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const activeRefresh = useRef<Readonly<{ controller: AbortController; sourceId: string }>>();

  const requestedId = selectedRecordId ?? localRecordId;
  const selected = records.find((record) => record.id === requestedId) ?? records[0];

  useEffect(() => {
    if (!selected) return;
    if (!selectedRecordId && localRecordId !== selected.id) setLocalRecordId(selected.id);
  }, [selected?.id, selectedRecordId]);

  useEffect(() => {
    activeRefresh.current?.controller.abort();
    activeRefresh.current = undefined;
    setRefreshing(false);
    setInspector({ kind: "dimension", key: "endpoint-key" });
    setError(undefined);
    setStatus(undefined);
  }, [selected?.id]);

  useEffect(() => () => activeRefresh.current?.controller.abort(), []);

  function chooseRecord(record: NormalizedAttestationRecord) {
    if (!selectedRecordId) setLocalRecordId(record.id);
    onSelectRecord?.(record.id);
  }

  async function refresh() {
    if (!selected || !onRefresh || refreshing) return;
    const target = refreshTarget(selected, endpointRecords, receipts);
    if (!target) {
      setStatus(undefined);
      setError("The selected record no longer has a refresh source.");
      return;
    }
    activeRefresh.current?.controller.abort();
    const controller = new AbortController();
    const operation = { controller, sourceId: selected.sourceId };
    activeRefresh.current = operation;
    setRefreshing(true);
    setError(undefined);
    setStatus("Refreshing evidence with a new provider acquisition…");
    try {
      await onRefresh(target, controller.signal);
      if (!controller.signal.aborted && activeRefresh.current === operation) {
        setStatus("Evidence refresh completed. Review the new record and its timestamps independently.");
      }
    } catch (caught) {
      if (!controller.signal.aborted && activeRefresh.current === operation) {
        setStatus(undefined);
        setError(attestationRefreshError(caught));
      }
    } finally {
      if (activeRefresh.current === operation) {
        activeRefresh.current = undefined;
        setRefreshing(false);
      }
    }
  }

  function cancelRefresh() {
    const operation = activeRefresh.current;
    if (!operation) return;
    operation.controller.abort();
    activeRefresh.current = undefined;
    setRefreshing(false);
    setStatus("Refresh cancelled. Existing evidence remains unchanged.");
    onCancel?.(operation.sourceId);
  }

  function exportPublic() {
    const json = serializePublicAttestationSummary({ endpointRecords, receipts });
    if (onExport) onExport(json);
    else downloadPublicJson(json);
    setStatus("Unsigned privacy-safe status summary exported. It is not a verification bundle; sensitive evidence and plaintext digests were omitted.");
  }

  const inspectedDimension = selected && inspector.kind === "dimension"
    ? selected.dimensions[inspector.key]
    : undefined;
  const inspectedVerification = selected && inspector.kind === "verification"
    ? selected.verifications.find((verification) => verification.id === inspector.id)
    : undefined;

  return (
    <section class={`attestations-view${embedded ? " attestations-view--embedded" : ""}`} aria-labelledby="attestations-title">
      <header class="attestations-heading">
        <div>
          <span>Independent evidence ledger</span>
          {embedded ? <h2 id="attestations-title">Endpoint &amp; receipt evidence</h2> : <h1 id="attestations-title">Attestations</h1>}
          <p>Each result applies only to its named claim. A fetched quote, locally matched key, verified endpoint, model artifact, and signed conversation are separate facts with separate authorities.</p>
        </div>
        <div class="attestations-heading-actions">
          {refreshing
            ? <button class="danger" type="button" onClick={cancelRefresh}><Icon name="stop" /> Cancel refresh</button>
            : <button type="button" disabled={!selected || !onRefresh} onClick={refresh}><Icon name="proof" /> Refresh evidence</button>}
          <button class="primary" type="button" disabled={records.length === 0} onClick={exportPublic}><Icon name="cloud" /> Export status summary</button>
        </div>
      </header>

      <div class="attestations-boundary" role="note">
        <Icon name="lock" />
        <div><strong>Claim-scoped trust</strong><span>Structural presence and local digest matches remain partial. “Verified” requires the authority named on that exact record.</span></div>
        <small>Raw evidence withheld by design</small>
      </div>

      {acquisitionNotice ? <div class="attestations-alert" role="status"><Icon name="warning" /><span>{acquisitionNotice}</span></div> : null}
      {error ? <div class="attestations-alert error" role="alert"><Icon name="warning" /><span>{error}</span></div> : null}
      {inputOverflow ? (
        <div class="attestations-alert error" role="alert">
          <Icon name="warning" />
          <span>The {inputOverflow.source} page contains {inputOverflow.count} records and exceeds the {inputOverflow.limit}-record client boundary. It was rejected before copying or sorting; request a bounded page.</span>
        </div>
      ) : null}
      {status ? <div class="attestations-alert" role="status"><Icon name="proof" /><span>{status}</span></div> : null}

      {records.length === 0 || !selected ? (
        <div class="attestations-empty">
          <div class="attestations-empty__intro">
            <Icon name="proof" size={30} />
            <div><h2>{inputOverflow ? "Evidence page rejected" : "No evidence records yet"}</h2>
              <p>{inputOverflow
                ? "Load a bounded evidence page before opening the ledger. No records from the oversized input were interpreted."
                : onOpenConnection
                  ? "No Chutes inference provider is connected. Endpoint evidence cannot be acquired until you connect one; existing records remain inspectable."
                  : "Run a protected Chutes invocation or acquire endpoint evidence. Nothing is inferred while the ledger is empty."}</p>
              {!inputOverflow && onOpenConnection
                ? <button class="attestations-empty__connection primary" type="button" onClick={onOpenConnection}>Connect inference</button>
                : null}
            </div>
          </div>
          {!inputOverflow ? <div class="attestations-empty__flow" aria-label="Evidence lifecycle">
            <div><span>01</span><strong>Acquire</strong><small>{onOpenConnection
              ? "Connect Chutes inference, then fetch fresh endpoint evidence for that runtime."
              : "Fetch fresh endpoint evidence for the selected Chutes runtime."}</small></div>
            <div><span>02</span><strong>Bind</strong><small>Match the instance and endpoint-key digest to the exact turn.</small></div>
            <div><span>03</span><strong>Inspect</strong><small>Review each claim, authority, measurement, and warning separately.</small></div>
          </div> : null}
        </div>
      ) : (
        <div class="attestations-shell">
          <aside class="attestations-ledger" aria-label="Attestation evidence records">
            <div class="attestations-rail-heading"><span>Evidence records</span><strong>{records.length}</strong></div>
            <div class="attestation-record-list">
              {records.map((record) => (
                <button
                  class={record.id === selected.id ? "active" : ""}
                  type="button"
                  aria-current={record.id === selected.id ? "true" : undefined}
                  onClick={() => chooseRecord(record)}
                  key={record.id}
                >
                  <StatusMark state={record.overallState} />
                  <span>
                    <strong>{record.title}</strong>
                    <small>{record.subtitle}</small>
                    <em>{record.createdAt ? formatTimestamp(record.createdAt) : "Timestamp unavailable"}</em>
                  </span>
                  <b>{record.source === "endpoint-evidence" ? "ENDPOINT" : "ASSERTED"}</b>
                </button>
              ))}
            </div>
            <div class="attestations-ledger-note">
              <Icon name="warning" size={16} />
              <p>Records are not merged. Endpoint evidence cannot silently upgrade a conversation receipt, or vice versa.</p>
            </div>
          </aside>

          <section class="attestations-stage" aria-label="Selected attestation record">
            <RecordHeader record={selected} />
            <section class="attestation-matrix" aria-label="Attestation claim summary">
              {ATTESTATION_DIMENSIONS.map((key) => {
                const dimension = selected.dimensions[key];
                const active = inspector.kind === "dimension" && inspector.key === key;
                return (
                  <button class={`${dimension.state}${active ? " active" : ""}`} type="button" aria-pressed={active} onClick={() => setInspector({ kind: "dimension", key })} key={key}>
                    <span><StatusMark state={dimension.state} /></span>
                    <strong>{dimension.title}</strong>
                    <small>{qualifierLabel(dimension.qualifier, dimension.state)}</small>
                  </button>
                );
              })}
            </section>

            <section class="attestations-authorities">
              <div class="attestations-section-heading"><span>Verification records</span><small>Select an authority record to inspect exactly what it checked.</small></div>
              <div class="attestation-verification-list">
                {selected.verifications.length ? selected.verifications.map((verification) => (
                  <button
                    class={inspector.kind === "verification" && inspector.id === verification.id ? "active" : ""}
                    type="button"
                    aria-pressed={inspector.kind === "verification" && inspector.id === verification.id}
                    onClick={() => setInspector({ kind: "verification", id: verification.id })}
                    key={verification.id}
                  >
                    <StatusMark state={verification.state} />
                    <span><strong>{verification.title}</strong><small>{verification.authority}</small></span>
                  </button>
                )) : <div class="attestations-no-verifier">No verification authority records were supplied.</div>}
              </div>
            </section>

            <section class="attestations-bindings">
              <div class="attestations-section-heading"><span>Commitments &amp; measurements</span><small>Local normalized view · export policy may omit fields</small></div>
              <FactGrid facts={[...selected.bindings, ...selected.evidenceFacts]} empty="No public digests or measurement metadata are available." />
            </section>
          </section>

          <aside class="attestations-inspector" aria-label="Selected attestation evidence detail">
            {inspectedVerification
              ? <VerificationInspector verification={inspectedVerification} />
              : inspectedDimension
                ? <DimensionInspector dimension={inspectedDimension} />
                : <p>No evidence detail selected.</p>}
            {selected.warnings.length ? (
              <section class="attestations-warnings">
                <span>Record warnings</span>
                {selected.warnings.map((warning, index) => <p key={`${index}:${warning}`}><Icon name="warning" size={14} />{warning}</p>)}
              </section>
            ) : null}
            <section class="attestations-export-note">
              <Icon name="proof" />
              <div><strong>Unsigned status summary</strong><p>The export is a privacy-safe snapshot, not independently verifiable proof. It omits raw quotes, certificates, signatures, public keys, nonces, provider bodies, and dictionary-testable plaintext digests.</p></div>
            </section>
          </aside>
        </div>
      )}
    </section>
  );
}

function RecordHeader({ record }: { record: NormalizedAttestationRecord }) {
  const counts = countStates(record);
  const receiptTrust = record.source === "conversation-receipt"
    ? "Receipt integrity is unauthenticated; every non-unavailable claim is shown as an assertion."
    : "This is endpoint acquisition evidence, not a conversation receipt.";
  return (
    <header class="attestation-record-heading">
      <div>
        <span>{record.source === "endpoint-evidence" ? "Endpoint acquisition" : "Conversation evidence"}</span>
        <h2>{record.subtitle}</h2>
        <p>{record.proofLevel ? `Declared proof level: ${proofLevelLabel(record.proofLevel)}.` : ""} {record.posture ? `Transport: ${postureLabel(record.posture as Parameters<typeof postureLabel>[0])}.` : "Inference transport is not asserted by this record."} {receiptTrust}</p>
      </div>
      <dl>
        <div><dt>Verified</dt><dd>{counts.verified}</dd></div>
        <div><dt>Partial</dt><dd>{counts.partial}</dd></div>
        <div><dt>Failed</dt><dd>{counts.failed + counts.expired}</dd></div>
        <div><dt>Unavailable</dt><dd>{counts.unavailable}</dd></div>
      </dl>
    </header>
  );
}

function DimensionInspector({ dimension }: { dimension: AttestationDimension }) {
  return (
    <section class="attestation-inspection">
      <span>Claim detail</span>
      <div class="attestation-inspection-title"><StatusMark state={dimension.state} /><div><h2>{dimension.title}</h2><small>{ATTESTATION_TECHNICAL_LABELS[dimension.key]}</small><strong class={dimension.state}>{statusLabel(dimension.state)} · {qualifierLabel(dimension.qualifier, dimension.state)}</strong></div></div>
      <p>{dimension.summary}</p>
      <dl>
        <Detail label="Verification authority" value={dimension.authority} />
        <Detail label="Authority class" value={authorityLabel(dimension.authorityKind)} />
        <Detail label="Checked" value={dimension.checkedAt ? relativeEvidenceAge(dimension.checkedAt) : "Not supplied"} datetime={dimension.checkedAt} />
        <Detail label="Expires" value={dimension.expiresAt ? relativeEvidenceAge(dimension.expiresAt) : "Not supplied"} datetime={dimension.expiresAt} />
      </dl>
      <details><summary>Technical details</summary><DetailList><Detail label="Verifier policy digest" value={dimension.policyDigest ?? "Not supplied"} mono /></DetailList><FactGrid facts={dimension.facts} empty="No normalized measurement or digest fields were supplied for this claim." /></details>
    </section>
  );
}

function VerificationInspector({ verification }: { verification: AttestationVerification }) {
  return (
    <section class="attestation-inspection">
      <span>Authority record</span>
      <div class="attestation-inspection-title"><StatusMark state={verification.state} /><div><h2>{verification.title}</h2><strong class={verification.state}>{statusLabel(verification.state)}</strong></div></div>
      <p>{verification.summary}</p>
      <dl>
        <Detail label="Verifier" value={verification.authority} />
        <Detail label="Authority class" value={authorityLabel(verification.authorityKind)} />
        <Detail label="Verifier version" value={verification.version ?? "Not supplied"} />
        <Detail label="Checked" value={verification.checkedAt ? relativeEvidenceAge(verification.checkedAt) : "Not supplied"} datetime={verification.checkedAt} />
      </dl>
      <details><summary>Technical details</summary><DetailList><Detail label="Verifier policy digest" value={verification.policyDigest ?? "Not supplied"} mono /></DetailList><FactGrid facts={verification.facts} empty="No normalized verifier facts were supplied." /></details>
    </section>
  );
}

function Detail({ label, value, datetime, mono = false }: { label: string; value: string; datetime?: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd class={mono ? "mono" : ""}>{datetime ? <time dateTime={datetime} title={formatTimestamp(datetime)}>{value}</time> : value}</dd></div>;
}

function DetailList({ children }: { children: import("preact").ComponentChildren }) { return <dl>{children}</dl>; }

function FactGrid({ facts, empty }: { facts: readonly { key: string; label: string; value: string; kind: string }[]; empty: string }) {
  if (!facts.length) return <div class="attestation-facts-empty">{empty}</div>;
  return (
    <dl class="attestation-facts">
      {facts.map((fact, index) => <div key={`${index}:${fact.key}:${fact.value}`}><dt>{fact.label}</dt><dd class={fact.kind === "digest" || fact.kind === "measurement" ? "mono" : ""}>{fact.kind === "timestamp" ? <time dateTime={fact.value}>{formatTimestamp(fact.value)}</time> : fact.value}</dd></div>)}
    </dl>
  );
}

function StatusMark({ state }: { state: ProofStatus }) {
  return (
    <Seal
      class="attestation-status-mark"
      state={sealStateForProofStatus(state)}
      label={statusLabel(state)}
      size={18}
      compact
    />
  );
}

function refreshTarget(
  selected: NormalizedAttestationRecord,
  endpointRecords: readonly ChutesEndpointEvidenceRecord[],
  receipts: readonly ConversationReceipt[],
): AttestationRefreshTarget | undefined {
  if (selected.source === "endpoint-evidence") {
    const record = endpointRecords.find((candidate) =>
      candidate.recordId === selected.sourceId &&
      (!selected.createdAt || sameTimestamp(candidate.acquisition.fetchedAt, selected.createdAt)),
    ) ?? endpointRecords.find((candidate) => candidate.recordId === selected.sourceId);
    return record ? { kind: "endpoint-evidence", record } : undefined;
  }
  const receipt = receipts.find((candidate) =>
    candidate.receiptId === selected.sourceId &&
    (!selected.createdAt || sameTimestamp(candidate.createdAt, selected.createdAt)),
  ) ?? receipts.find((candidate) => candidate.receiptId === selected.sourceId);
  return receipt ? { kind: "conversation-receipt", receipt } : undefined;
}

function countStates(record: NormalizedAttestationRecord): Record<ProofStatus, number> {
  const counts: Record<ProofStatus, number> = { verified: 0, partial: 0, failed: 0, expired: 0, unavailable: 0 };
  for (const key of ATTESTATION_DIMENSIONS) counts[record.dimensions[key].state] += 1;
  return counts;
}

function statusLabel(state: ProofStatus): string {
  return proofStatusLabel(state);
}

function qualifierLabel(qualifier: string, state: ProofStatus): string {
  if (qualifier.startsWith("asserted-")) return `Asserted ${qualifier.slice("asserted-".length)} · receipt unauthenticated`;
  if (qualifier === "verified-without-authority") return "Declared verified · authority absent";
  if (qualifier === "matched") return "Locally matched · not verified";
  if (qualifier === "present") return "Present · authenticity unverified";
  if (qualifier === "unverified") return "Independent verifier absent";
  return statusLabel(state);
}

function authorityLabel(kind: AttestationDimension["authorityKind"]): string {
  if (kind === "external") return "External verifier";
  if (kind === "mixed") return "Mixed local and external chain";
  if (kind === "local") return "Local client check";
  return "No trusted authority established";
}

function sameTimestamp(left: string, right: string): boolean {
  const parsed = Date.parse(left);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === right;
}

export function attestationRefreshError(caught: unknown): string {
  const code = publicAttestationErrorCode(caught);
  if (code === "cross-origin-unreadable") {
    return "Provider evidence is cross-origin unreadable: CORS authorization or the network path may have failed, so evidence was not pulled. This is not a TEE verification failure, and no claim was promoted.";
  }
  if (code === "unauthorized") {
    return "The provider rejected evidence access for this credential. Evidence was not pulled and no TEE claim was evaluated.";
  }
  if (code === "forbidden") {
    return "The provider forbids this browser from reading the selected evidence. Evidence was not pulled and no TEE claim was evaluated.";
  }
  return "Evidence refresh failed safely. Evidence was not pulled, and no verification state was inferred from the failure.";
}

function publicAttestationErrorCode(caught: unknown): string | undefined {
  if (!caught || typeof caught !== "object") return undefined;
  const candidate = caught as { name?: unknown; code?: unknown };
  if (candidate.name !== "AttestationEvidenceClientError" || typeof candidate.code !== "string") return undefined;
  return candidate.code;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "Unavailable";
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function downloadPublicJson(json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `airship-attestation-status-summary-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
