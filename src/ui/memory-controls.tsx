import { useEffect, useState } from "preact/hooks";
import { KIND_VISUAL, type MemoryGraphSearchHit, type MemoryNodeKind } from "../memory-graph";

export function MemoryKindLegend({ counts, hidden, onToggle }: { counts: Readonly<Record<MemoryNodeKind, number>>; hidden: ReadonlySet<MemoryNodeKind>; onToggle: (kind: MemoryNodeKind) => void }) {
  return <div class="memory-legend" aria-label="Memory kind view filters">{Object.entries(KIND_VISUAL).map(([kind, visual]) => <button type="button" aria-pressed={!hidden.has(kind as MemoryNodeKind)} onClick={() => onToggle(kind as MemoryNodeKind)} title="View filter; source unchanged"><i data-kind={kind} data-shape={visual.shape} style={{ color: `var(${visual.colorToken})` }} /><span>{kind}</span><small>{counts[kind as MemoryNodeKind]}</small></button>)}</div>;
}

export function MemorySearch({ query, results, onQuery, onSelect }: { query: string; results: readonly MemoryGraphSearchHit[]; onQuery: (query: string) => void; onSelect: (id: string) => void }) {
  const [draft, setDraft] = useState(query);
  const [active, setActive] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => onQuery(draft), 140); return () => window.clearTimeout(timer); }, [draft, onQuery]);
  useEffect(() => setActive(0), [results]);
  return <div class="memory-search"><input role="combobox" placeholder="Search nodes" aria-expanded={results.length > 0} aria-controls="memory-search-results" aria-activedescendant={results[active] ? `memory-result-${active}` : undefined} value={draft} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); } if (event.key === "Enter" && results[active]) { event.preventDefault(); onSelect(results[active].node.id); } }} />{results.length ? <div id="memory-search-results" role="listbox">{results.map((result, index) => <button id={`memory-result-${index}`} role="option" aria-selected={index === active} onClick={() => onSelect(result.node.id)}>{result.node.label}</button>)}</div> : null}</div>;
}
