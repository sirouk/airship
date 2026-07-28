import { useState } from "preact/hooks";
import { Popover } from "./popover";
import "./provenance-chip.css";

/**
 * The one carrier for revision, digest and ranking lineage.
 *
 * #memory printed 68 monospace leaf tokens on a single populated screen — 11.5%
 * of the route's visible characters were raw digests and UUIDs, with one
 * generation digest rendered three separate times. None of that lineage is
 * wrong or unwanted: it is the evidence that makes three independently scored
 * lanes correct rather than arbitrary. It was being shouted rather than filed.
 *
 * So the lineage moves exactly one rung down the ladder (L1: chip → popover)
 * and gains three things it did not have: full untruncated values, a copy
 * button, and a dedup rule that says *where* a repeated digest is already
 * asserted instead of asserting it twice.
 */

/** The tail length that reads as an identity rather than as noise. */
export const PROVENANCE_TAIL = 8;

export type ProvenanceRow =
  /** A plain labelled value — a path, a corpus name, a duration. */
  | Readonly<{ kind: "fact"; label: string; value: string }>
  /** A content-addressed value. Rendered `…tail`, copied and titled in full. */
  | Readonly<{ kind: "digest"; label: string; value: string }>
  /**
   * A value the enclosing scope already asserted.
   *
   * This is the rule that removes the 3× and 2× repeats: a hit inside the
   * workspace lane says "same as this scope" and names where the canonical
   * copy lives, rather than printing the generation digest a second time.
   */
  | Readonly<{ kind: "inherited"; label: string; value: string; scope: string }>
  /** A sentence — a ranking contract, a quarantine count, a retention rule. */
  | Readonly<{ kind: "note"; text: string; tone?: "neutral" | "caution" }>;

export function provenanceFact(label: string, value: string): ProvenanceRow {
  return Object.freeze({ kind: "fact", label, value });
}

export function provenanceDigest(label: string, value: string): ProvenanceRow {
  return Object.freeze({ kind: "digest", label, value });
}

export function provenanceInherited(label: string, value: string, scope: string): ProvenanceRow {
  return Object.freeze({ kind: "inherited", label, value, scope });
}

export function provenanceNote(text: string, tone: "neutral" | "caution" = "neutral"): ProvenanceRow {
  return Object.freeze({ kind: "note", text, tone });
}

/**
 * The visible short form of a content-addressed value.
 *
 * The tail, not the head: `sha256:` prefixes and shared generation stems make
 * the first characters of two different digests identical, so a head-truncated
 * token silently reads as "the same one".
 */
export function provenanceTail(value: string, length: number = PROVENANCE_TAIL): string {
  const trimmed = value.trim();
  return trimmed.length <= length ? trimmed : trimmed.slice(-length);
}

/**
 * The chip's accessible name — what it holds, and how much of it.
 *
 * "Counts are honest": a disclosure that hides *n* facts states *n*, so the
 * affordance declares its own cost instead of looking like decoration.
 */
export function provenanceLabel(subject: string, rows: readonly ProvenanceRow[]): string {
  const values = rows.filter((row) => row.kind !== "note").length;
  const notes = rows.length - values;
  const parts = [`${values} recorded ${values === 1 ? "field" : "fields"}`];
  if (notes > 0) parts.push(`${notes} ${notes === 1 ? "contract note" : "contract notes"}`);
  return `Provenance for ${subject}. ${parts.join(" and ")}.`;
}

export type ProvenanceChipProps = Readonly<{
  /** What the lineage belongs to, for the accessible name. */
  subject: string;
  rows: readonly ProvenanceRow[];
  /**
   * The visible token. Defaults to the tail of the first digest row; pass `""`
   * where the row is too narrow for one, and the count carries the chip alone.
   * A placeholder like "pinned revision" is never tailed into the trigger —
   * "…revision" looks like a digest and is not one.
   */
  summary?: string;
  class?: string;
}>;

export function ProvenanceChip({ subject, rows, summary, class: className }: ProvenanceChipProps) {
  const firstDigest = rows.find((row): row is Extract<ProvenanceRow, { kind: "digest" }> => row.kind === "digest");
  const token = summary ?? (firstDigest ? provenanceTail(firstDigest.value) : "");
  return (
    <Popover
      class={["provenance-chip", className].filter(Boolean).join(" ")}
      triggerClass="provenance-chip__trigger"
      label={provenanceLabel(subject, rows)}
      heading={`Provenance · ${subject}`}
      trigger={<>
        <span class="provenance-chip__glyph" aria-hidden="true">⛓</span>
        {token ? <span class="provenance-chip__token">{token}</span> : null}
        <small class="provenance-chip__count" aria-hidden="true">{rows.length}</small>
      </>}
    >
      <dl class="provenance-rows">
        {rows.map((row, index) => <ProvenanceRowView key={`${row.kind}-${index}`} row={row} />)}
      </dl>
    </Popover>
  );
}

function ProvenanceRowView({ row }: Readonly<{ row: ProvenanceRow }>) {
  if (row.kind === "note") {
    return <div class="provenance-rows__note" data-tone={row.tone ?? "neutral"}><dd>{row.text}</dd></div>;
  }
  if (row.kind === "inherited") {
    return (
      <div class="provenance-rows__row" data-kind="inherited">
        <dt>{row.label}</dt>
        {/*
          * No second rendering of the value: that is the entire point of the
          * dedup rule, and a tail here would read as a different, shorter
          * identifier. The scope names where the full value is already on
          * screen, `title` carries it for a pointer, and the copy button
          * yields it verbatim — so "same as" stays checkable.
          */}
        <dd><span title={row.value}>Same as {row.scope}</span></dd>
        <CopyValue label={row.label} value={row.value} />
      </div>
    );
  }
  return (
    <div class="provenance-rows__row" data-kind={row.kind}>
      <dt>{row.label}</dt>
      <dd>
        {row.kind === "digest"
          ? <code title={row.value}>…{provenanceTail(row.value)}</code>
          : <span title={row.value}>{row.value}</span>}
      </dd>
      <CopyValue label={row.label} value={row.value} />
    </div>
  );
}

/**
 * Copy, or nothing.
 *
 * A copy control that silently fails is worse than none, so where the
 * Clipboard API is absent the button does not render and the `title` remains
 * the full value. The digest is never *only* behind this button.
 */
function CopyValue({ label, value }: Readonly<{ label: string; value: string }>) {
  const [copied, setCopied] = useState(false);
  if (typeof navigator === "undefined" || !navigator.clipboard) return null;
  return (
    <button
      class="provenance-rows__copy"
      type="button"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_400);
          },
          () => setCopied(false),
        );
      }}
    >
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}
