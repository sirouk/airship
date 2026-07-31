import { useEffect, useState } from "preact/hooks";
import { Icon } from "../icons";
import { formatInstant } from "../instant-format";
import { Seal } from "../seal";
import {
  credentialClause,
  EGRESS_NONE_OBSERVED,
  EGRESS_SCOPE_NOTE,
  egressCountLabel,
  egressRecorder,
  egressSummarySeal,
  egressTotals,
  installEgressRecorder,
  summarizeEgressHosts,
  type EgressCounts,
  type EgressRecord,
} from "./egress-record";
import "./egress-panel.css";

/**
 * The surface that answers "what left this device?".
 *
 * There was none. Proof audits the journal and the receipts and counts events,
 * turns, tool operations and shell records — nothing with a network dimension —
 * so the only way to see the third-party image host this page contacts was
 * devtools. This panel is a reading of the live ledger, so it can only ever
 * report what was observed: it has no list of expected hosts to compare against
 * and nothing it can fail to notice.
 *
 * It lives on Connection because that is where a person decides what to trust
 * with a credential. A rail destination of its own is the right end state and
 * needs `navigation-model.ts` and `app.tsx`, which this package does not own.
 */
export function EgressPanel() {
  const [records, setRecords] = useState<readonly EgressRecord[]>([]);
  const [dropped, setDropped] = useState(0);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const recorder = installEgressRecorder() ?? egressRecorder();
    if (!recorder) return;
    const read = () => {
      setRecords(recorder.read());
      setDropped(recorder.droppedCount());
      setTruncated(recorder.timelineTruncated());
    };
    read();
    return recorder.subscribe(read);
  }, []);

  const hosts = summarizeEgressHosts(records);
  const totals = egressTotals(records);

  return (
    <section class="access-connection-card egress-panel" aria-labelledby="egress-panel-title">
      <div class="egress-panel__head">
        <div>
          <h2 id="egress-panel-title">What has left this device</h2>
          {/*
            The completeness sentence is conditional on the guarantee that
            backs it: once the browser's resource timeline stops keeping
            entries, "every resource" is no longer something this panel can
            claim, so it stops claiming it and names the gap instead.
          */}
          <p class="egress-panel__lede">
            {truncated
              ? "Observed in this tab since it opened. The browser's resource timeline filled up, so loads it stopped keeping are not listed here; requests Airship sent are still recorded in full."
              : "Observed in this tab since it opened — the page's own requests and every resource the browser loaded from another host."}
          </p>
        </div>
        <Seal state={egressSummarySeal(records)} density="chip" label={egressCountLabel(records)} />
      </div>

      {/*
        The verdict, as a sentence rather than as the tail of a chip: it is the
        claim this panel exists to make, and the one a phone was clipping.
      */}
      {records.length > 0 ? (
        <p class={`egress-panel__verdict ${credentialTone(totals)}`}>{credentialClause(totals)}</p>
      ) : null}

      {hosts.length === 0 ? (
        <p class="egress-panel__empty"><Icon name="lock" size={16} />{EGRESS_NONE_OBSERVED}</p>
      ) : (
        <ul class="egress-panel__hosts">
          {hosts.map((host) => (
            <li key={host.host}>
              <strong>{host.host}</strong>
              <span class="egress-panel__count">{host.requests} request{host.requests === 1 ? "" : "s"} · {host.kinds.join(", ")}</span>
              {/*
                The credential clause is never omitted. "No credential attached"
                is the reassurance this reader came for, and an absent clause
                reads as an unanswered question rather than as a no. Its three
                tones are three different claims: a credential went (caution), no
                credential went (verified), the browser will not say (neutral) —
                an undisclosed row must not wear the colour of a clean one.
              */}
              <span class={`egress-panel__credential ${credentialTone(host)}`}>
                {credentialClause(host)}
              </span>
              <span class="egress-panel__when">Last {formatInstant(new Date(host.lastAt).toISOString(), "minute")}</span>
            </li>
          ))}
        </ul>
      )}

      <p class="egress-panel__scope">{EGRESS_SCOPE_NOTE}</p>

      {records.length > 0 ? (
        <details class="egress-panel__detail">
          <summary>Every request, in order</summary>
          {dropped > 0 ? (
            <p class="egress-panel__dropped">{dropped} earlier request{dropped === 1 ? " is" : "s are"} no longer listed; this tab keeps the most recent 250.</p>
          ) : null}
          <ol>
            {[...records].reverse().map((record) => (
              <li key={record.id}>
                <code>{record.method ?? "—"} {record.host}{record.path}</code>
                <span class="egress-panel__row-facts">
                  {outcomeLabel(record)}
                  {" · "}
                  {record.kind}
                  {" · "}
                  {credentialLabel(record)}
                  {record.bytes === undefined ? " · size not disclosed" : ` · ${formatBytes(record.bytes)}`}
                  {" · "}
                  {formatInstant(new Date(record.startedAt).toISOString(), "minute")}
                </span>
                {/*
                  Which witness saw it is a fact about how much the row can be
                  trusted, so it is printed rather than flattened away: only the
                  fetch witness can speak to method and credential at all.
                */}
                <span class="egress-panel__witness">{record.witness === "request" ? "Recorded as Airship sent it" : "Observed in the browser's resource timeline; method and credential not disclosed"}</span>
                {record.detail ? <span class="egress-panel__row-detail">{record.detail}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/** Three claims, three tones; `credentialClause` decides which claim. */
function credentialTone(counts: EgressCounts): string {
  if (counts.credentialed > 0) return "is-attached";
  return counts.unknownCredential > 0 ? "is-undisclosed" : "is-clean";
}

function outcomeLabel(record: EgressRecord): string {
  if (record.outcome === "in-flight") return "In flight";
  if (record.outcome === "failed") return "Failed";
  if (record.status !== undefined) return `HTTP ${String(record.status)}`;
  return record.outcome === "refused" ? "Refused" : "Answered";
}

function credentialLabel(record: EgressRecord): string {
  if (record.credential === "attached") return `credential attached (${record.credentialVia ?? "header"})`;
  return record.credential === "unknown" ? "credential not disclosed" : "no credential";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
