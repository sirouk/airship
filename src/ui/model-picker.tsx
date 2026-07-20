import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { filterModels, modelPopularitySignal, sortModels } from "../models";
import type { AirshipModel, ModelSort } from "../models";
import { MenuSelect } from "./menu-select";

const PAGE_SIZE = 30;
const COMPACT_NUMBER = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
type Facet = "all" | "vision" | "tools" | "confidential" | "hot";
type PickerSort = Extract<ModelSort, "popularity" | "recommended" | "utilization" | "price" | "context" | "name">;

const FACETS = ["all", "vision", "tools", "confidential", "hot"] as const;
const SORTS: readonly Readonly<{ value: PickerSort; label: string }>[] = Object.freeze([
  { value: "popularity", label: "Popular" },
  { value: "recommended", label: "Recommended" },
  { value: "utilization", label: "Least loaded" },
  { value: "price", label: "Lowest price" },
  { value: "context", label: "Largest context" },
  { value: "name", label: "Name" },
]);

/** Provider/model badge: real Chutes logo when available, provider monogram otherwise. */
export function ModelLogo({ model }: Readonly<{ model: AirshipModel }>) {
  return (
    <span class="model-logo" aria-hidden="true">
      {model.logoId
        ? <img class="model-logo-img" src={`https://logos.chutes.ai/logos/${model.logoId}.webp`} alt="" />
        : model.provider.slice(0, 1)}
    </span>
  );
}

export function ModelPicker({ models, value, disabled, onSelect }: Readonly<{ models: readonly AirshipModel[]; value?: string; disabled?: boolean; onSelect: (id: string) => void }>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const [sort, setSort] = useState<PickerSort>("popularity");
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const optionsId = useId();
  useEffect(() => { const timer = window.setTimeout(() => setQuery(draft), 140); return () => window.clearTimeout(timer); }, [draft]);
  useEffect(() => setShowAll(false), [query, facet, sort]);
  const eligible = useMemo(() => {
    const filters = facet === "vision"
      ? { query, inputModalities: ["image"] }
      : facet === "tools"
        ? { query, features: ["tools"] }
        : facet === "confidential"
          ? { query, confidentialCompute: "required" as const }
          : facet === "hot"
            ? { query, availability: ["hot" as const] }
            : { query };
    return sortModels(filterModels(models, filters), sort);
  }, [facet, models, query, sort]);
  const visible = showAll ? eligible : eligible.slice(0, PAGE_SIZE);
  const selected = models.find((model) => model.id === value);
  const close = (restore = true) => { setOpen(false); if (restore) requestAnimationFrame(() => trigger.current?.focus()); };
  const openPicker = () => { setOpen(true); setActive(Math.max(0, visible.findIndex((model) => model.id === value))); requestAnimationFrame(() => search.current?.focus()); };
  const choose = (index: number) => { const model = visible[index]; if (!model) return; onSelect(model.id); close(); };
  useEffect(() => setActive((current) => Math.max(0, Math.min(current, visible.length - 1))), [eligible.length, showAll]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [open]);
  return <div class="model-picker" ref={root}>
    <button ref={trigger} class="model-picker-trigger" type="button" disabled={disabled} aria-haspopup="dialog" aria-controls={open ? `${optionsId}-dialog` : undefined} aria-expanded={open} onClick={() => open ? close(false) : openPicker()} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); openPicker(); setActive(event.key === "ArrowUp" || event.key === "End" ? Math.max(0, visible.length - 1) : 0); } if (event.key === "Escape" && open) { event.preventDefault(); close(); } }}>{selected ? <ModelLogo model={selected} /> : null}<span class="model-picker-value">{selected?.id ?? "Choose model"}</span><span aria-hidden="true">⌄</span></button>
    {open ? <div id={`${optionsId}-dialog`} class="model-picker-popover" role="dialog" aria-label="Choose a Chutes model" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((current) => nextModelIndex(visible.length, current, event.key === "ArrowDown" ? 1 : -1)); }
      if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : Math.max(0, visible.length - 1)); }
      if (event.key === "Enter" && event.target === search.current) { event.preventDefault(); choose(active); }
    }}>
      <input ref={search} type="search" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} placeholder="Search models" aria-label="Search models" aria-controls={optionsId} aria-activedescendant={visible[active] ? `${optionsId}-option-${active}` : undefined} />
      <div class="model-picker-toolbar">
        <div class="model-picker-facets" role="group" aria-label="Model capability filters">{FACETS.map((item) => <button type="button" aria-pressed={facet === item} onClick={() => setFacet(item)}>{facetLabel(item)}</button>)}</div>
        <div class="model-picker-sort"><span>Sort</span><MenuSelect ariaLabel="Sort models" placement="down" value={sort} options={SORTS} onChange={(value) => setSort(value as PickerSort)} /></div>
      </div>
      <p class="model-picker-provenance">Capabilities are source-declared. Popularity and load use fresh provider telemetry when available.</p>
      <div id={optionsId} class="model-picker-list" role="listbox" aria-label={`${eligible.length} eligible models`}>{visible.map((model, index) => <button id={`${optionsId}-option-${index}`} type="button" role="option" aria-selected={model.id === value} data-active={index === active} class={index === 0 ? "recommended" : ""} onPointerMove={() => setActive(index)} onClick={() => choose(index)} key={model.id}>
        <ModelLogo model={model} />
        <span><strong>{model.id}</strong><small>{capabilityLabels(model).join(" · ") || "Capabilities not declared"}</small></span>
        <span title={operationalTitle(model)}><em>{operationalLabel(model)}</em><small>{formatContext(model)} · {formatPrice(model)}</small></span>
      </button>)}</div>
      {!showAll && eligible.length > PAGE_SIZE ? <button class="model-picker-show-all" type="button" onClick={() => setShowAll(true)}>Show all {eligible.length}</button> : null}
      {!eligible.length ? <p>No matching models.</p> : null}
    </div> : null}
  </div>;
}

export function visibleModelCount(total: number, showAll: boolean): number { return showAll ? total : Math.min(PAGE_SIZE, total); }
export function nextModelIndex(count: number, current: number, delta: -1 | 1): number { return count <= 0 ? -1 : (Math.max(0, current) + delta + count) % count; }

function facetLabel(value: Facet): string { return value[0]!.toUpperCase() + value.slice(1); }
function capabilityLabels(model: AirshipModel): string[] {
  if (model.provenance.capabilities !== "llm-models") return [];
  const labels: string[] = [];
  if (model.inputModalities.some((value) => value.toLowerCase() === "text")) labels.push("Text");
  if (model.inputModalities.some((value) => value.toLowerCase() === "image")) labels.push("Vision");
  if (model.inputModalities.some((value) => value.toLowerCase() === "video")) labels.push("Video");
  if (model.features.some((value) => value.toLowerCase() === "tools")) labels.push("Tools");
  if (model.trust.confidentialCompute === "asserted") labels.push("Confidential candidate");
  return labels;
}
function operationalLabel(model: AirshipModel): string {
  const popularity = modelPopularitySignal(model);
  const utilization = model.telemetry?.freshness === "fresh" ? model.telemetry.utilization.oneHour : undefined;
  const load = utilization === undefined ? "" : ` · ${Math.round(utilization * 100)}% load`;
  if (popularity && popularity.basis !== "lifetime-invocations") return `${formatCount(popularity.value)} req/h${load}`;
  if (popularity) return `${formatCount(popularity.value)} invocations`;
  if (utilization !== undefined) return `${Math.round(utilization * 100)}% load`;
  return model.availability === "hot" ? "Hot" : model.availability;
}
function operationalTitle(model: AirshipModel): string {
  const popularity = modelPopularitySignal(model);
  const parts = popularity
    ? [`Popularity: ${popularity.basis}`, `source: ${popularity.source}`]
    : ["Popularity unavailable"];
  if (popularity?.observedAt) parts.push(`observed ${popularity.observedAt}`);
  if (model.telemetry) parts.push(`telemetry ${model.telemetry.freshness}`);
  return parts.join(" · ");
}
function formatCount(value: number | undefined): string { return value === undefined ? "Demand unknown" : COMPACT_NUMBER.format(value); }
function formatContext(model: AirshipModel): string { const value = model.contextTokens ?? model.maxModelTokens; return value ? `${Math.round(value / 1_000)}k ctx` : "context unknown"; }
function formatPrice(model: AirshipModel): string { const input = model.pricing.input.usdPerMillion; const output = model.pricing.output.usdPerMillion; return input === undefined || output === undefined ? "price unknown" : `$${input}/$${output} per 1M`; }
