import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { filterModels, modelPopularitySignal, sortModels } from "../models";
import type { AirshipModel, ModelSort } from "../models";
import { MenuSelect } from "./menu-select";
import { MODEL_CAPABILITY_WORDS } from "./model-vocabulary";
import { TRUST_LABEL_CONNECT_TRUST_READINESS } from "./trust-language";

/**
 * Choosing a model, with the catalogue travelling on the model.
 *
 * The rebuild is answering three measured defects. (1) The popover was a single
 * `overflow: auto` box, so at scrollTop 400 the search field, every facet, the
 * sort control and the provenance caveat were gone — you could not filter once
 * you had scrolled. It is now three regions and only the list scrolls. (2) The
 * capability payload the rows exist to carry was ellipsised on 12 of 12 rows
 * while popularity — provider telemetry nobody verified — was painted in the
 * verification colour and was the loudest thing on the row. Every field is now
 * visible at rest, popularity is muted, and price is at ink weight. (3) On a
 * phone the five facets stacked to 240px, which put the first result 384px into
 * a 652px sheet; they are one scroll-snap row.
 *
 * `PAGE_SIZE` stays. At 40+ models an unpaged list is roughly 5,000px, and the
 * pagination is what keeps the keyboard cursor inside a bounded set.
 */

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

/**
 * The provenance caveat, permanently visible in the sticky footer.
 *
 * It used to scroll away, which meant the one sentence qualifying every number
 * above it was absent exactly when someone was reading those numbers.
 */
export const MODEL_PICKER_PROVENANCE = "catalog metadata is not proof; fresh provider telemetry";

/**
 * One catalogue fact about one model: a label, a value, and its provenance.
 *
 * These are the four cells the `#access` panel used to render *beside* the
 * picker, in a 210px 2×2 tile grid that described whatever was already chosen.
 * That put the evidence about a model outside the control you choose it with,
 * so comparing two models meant choosing one, closing the popover, reading a
 * grid, reopening, choosing the other. The facts now belong to the picker and
 * move when the selection moves.
 */
export type ModelFact = Readonly<{ label: string; value: string; captions: readonly string[] }>;

/**
 * The four facts, verbatim from the tiles they replace.
 *
 * Every caption is provenance and is rendered in full: `provider management
 * snapshot` qualifies a live-looking availability word, and `catalog metadata
 * is not proof` is the caveat that stops `evidence candidate` from reading as
 * a verdict. A caption is never a `title`; touch has no hover.
 */
export function modelFacts(model: AirshipModel): readonly ModelFact[] {
  const context = model.contextTokens ?? model.maxModelTokens;
  return Object.freeze([
    Object.freeze({
      label: "Availability",
      value: model.availability,
      captions: Object.freeze([
        model.provenance.availability === "unavailable" ? "live status unavailable" : "provider management snapshot",
      ]),
    }),
    Object.freeze({
      label: "Context",
      value: context ? COMPACT_NUMBER.format(context) : "unknown",
      captions: Object.freeze([
        model.maxOutputTokens ? `${COMPACT_NUMBER.format(model.maxOutputTokens)} max output` : "output limit unavailable",
      ]),
    }),
    Object.freeze({
      label: "Input / output",
      value: `${formatUsd(model.pricing.input.usdPerMillion)} / ${formatUsd(model.pricing.output.usdPerMillion)}`,
      captions: Object.freeze(["USD per million tokens"]),
    }),
    Object.freeze({
      label: "Trust readiness",
      value: model.trust.consistency === "conflict" ? "metadata conflict" : "evidence candidate",
      // `verification remains unverified` is a retired name: `trust.verification`
      // is the literal `"unverified"` (models/types.ts), so the template said
      // the same word twice and neither time said when the check happens. Its
      // written successor carries both facts — the readiness AND "catalog
      // metadata is not proof", verbatim — so the second caption would now be a
      // duplicate of a clause inside the first rather than a fact of its own.
      captions: Object.freeze([TRUST_LABEL_CONNECT_TRUST_READINESS]),
    }),
  ]);
}

/**
 * The selected model's catalogue facts, rendered inside the control itself.
 *
 * One label column and one flowing value column, rather than the four boxed
 * tiles this replaces: at a 664px measure four columns are ~150px each, which
 * wrapped `provider management snapshot` onto three lines and made the block
 * taller than the tile grid it was meant to compress. Nothing is truncated —
 * every caption is provenance, and a caption cut in half is a claim with its
 * qualifier removed.
 */
function ModelFactStrip({ model }: Readonly<{ model: AirshipModel }>) {
  return (
    <dl class="model-picker-meta" aria-label={`Catalog metadata for ${model.id}`}>
      {modelFacts(model).map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            <strong>{fact.value}</strong>
            {fact.captions.map((caption) => <small key={caption}>{caption}</small>)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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

export function ModelPicker({
  models,
  value,
  disabled,
  onSelect,
  recommendedModelId,
  attachFacts = false,
}: Readonly<{
  models: readonly AirshipModel[];
  value?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  /**
   * The catalogue's own privacy-first pick, when the caller has one.
   *
   * Passed in rather than inferred from row order: "recommended" is a claim,
   * and the first row of whatever sort happens to be active is not that claim.
   */
  recommendedModelId?: string;
  /**
   * Renders the selected model's catalogue facts inside the control.
   *
   * Opt-in because the connected-summary `<dl>` already states the connection's
   * own facts around it; the credential panel is where the four tiles used to
   * sit beside the picker, and it is the surface that asks for a *choice*.
   */
  attachFacts?: boolean;
}>) {
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
  useEffect(() => {
    if (!draft) return;
    const timer = window.setTimeout(() => setQuery(draft), 140);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => setShowAll(false), [query, facet, sort]);
  const searched = useMemo(() => filterModels(models, { query }), [models, query]);
  const eligible = useMemo(() => sortModels(facetModels(searched, facet), sort), [facet, searched, sort]);
  const counts = useMemo(() => facetCounts(searched), [searched]);
  const visible = showAll ? eligible : eligible.slice(0, PAGE_SIZE);
  const selected = models.find((model) => model.id === value);
  const close = (restore = true) => { setOpen(false); if (restore) requestAnimationFrame(() => trigger.current?.focus()); };
  const openPicker = () => { setOpen(true); setActive(Math.max(0, visible.findIndex((model) => model.id === value))); requestAnimationFrame(() => search.current?.focus()); };
  const choose = (index: number, selectionQuery = query) => {
    const model = modelForPickerSelection(models, selectionQuery, facet, sort, showAll, index);
    if (!model) return;
    onSelect(model.id);
    close();
  };
  useEffect(() => setActive((current) => Math.max(0, Math.min(current, visible.length - 1))), [eligible.length, showAll]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [open]);
  const recommended = recommendedModelId !== undefined && value === recommendedModelId;
  return <div class="model-picker" ref={root} data-open={open ? "true" : "false"}>
    <button ref={trigger} class="model-picker-trigger" type="button" disabled={disabled} aria-haspopup="dialog" aria-controls={open ? `${optionsId}-dialog` : undefined} aria-expanded={open} onClick={() => open ? close(false) : openPicker()} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); openPicker(); setActive(event.key === "ArrowUp" || event.key === "End" ? Math.max(0, visible.length - 1) : 0); } if (event.key === "Escape" && open) { event.preventDefault(); close(); } }}>
      {selected ? <ModelLogo model={selected} /> : null}
      <span class="model-picker-value">{selected?.id ?? "Choose model"}</span>
      {/* The recommendation travels inside the control, with the model it
          describes, instead of floating above it as its own 22px label. */}
      {recommended ? <span class="model-picker-badge">✦ privacy-first recommendation</span> : null}
      <span class="model-picker-caret" aria-hidden="true">⌄</span>
    </button>
    {/* The catalogue facts travel with the model, inside the control that
        chooses it. They used to be a 210px tile grid parked beside the picker,
        describing the current selection from outside the thing that changes
        it — and the open popover then covered them. */}
    {attachFacts && selected ? <ModelFactStrip model={selected} /> : null}
    {open ? <div id={`${optionsId}-dialog`} class="model-picker-popover" role="dialog" aria-label="Choose a model" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      /* Search owns this listbox's virtual focus. Facets, Sort and Done are
         ordinary controls and must keep their own Arrow/Enter behaviour. */
      else if (event.target === search.current) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((current) => nextModelIndex(visible.length, current, event.key === "ArrowDown" ? 1 : -1)); }
        else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : Math.max(0, visible.length - 1)); }
        else if (event.key === "Enter") {
          event.preventDefault();
          // Input and paste update the field before the debounced query state.
          // Resolve this explicit commit from what the person can already see.
          const currentDraft = (event.target as HTMLInputElement).value;
          if (currentDraft !== query) setQuery(currentDraft);
          choose(active, currentDraft);
        }
      }
    }}>
      <div class="model-picker-header">
        {/* Only rendered as a sheet header at ≤640px, where the popover covers
            its own trigger and there is otherwise nothing saying what this is
            or how to leave it. */}
        <div class="model-picker-sheet-bar">
          <strong>Session model</strong>
          <button type="button" class="model-picker-done" onClick={() => close()}>Done</button>
        </div>
        <input ref={search} type="search" value={draft} role="combobox" aria-autocomplete="list" aria-expanded="true" onInput={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);
          // Clearing is a completed reset, not another search to debounce. Keep
          // the listbox and its active descendant in lockstep with the empty
          // field so keyboard and assistive-tech users never land on no result
          // after they have already cleared the query.
          if (!nextDraft) setQuery("");
        }} placeholder="Search models" aria-label="Search models" aria-controls={optionsId} aria-activedescendant={visible[active] ? `${optionsId}-option-${active}` : undefined} />
        <div class="model-picker-facets" role="group" aria-label="Model capability filters">
          {FACETS.map((item) => (
            /*
             * Every facet keeps its count visible, and none is disabled. A
             * facet matching all 12 of 12 excludes nothing — and the number,
             * rendered beside `All`, is what says so. Disabling it would move
             * that fact into a `title`, which a thumb cannot read.
             */
            <button key={item} type="button" aria-pressed={facet === item} onClick={() => setFacet(item)}>
              {facetLabel(item)}<small>{counts[item]}</small>
            </button>
          ))}
        </div>
        <div class="model-picker-status">
          <span role="status" aria-live="polite" aria-atomic="true">{eligible.length
            ? `${eligible.length} model${eligible.length === 1 ? "" : "s"}`
            : "No matching models."}</span>
          <MenuSelect ariaLabel="Sort models" placement="down" value={sort} options={SORTS} onChange={(value) => setSort(value as PickerSort)} />
        </div>
      </div>
      <div id={optionsId} class="model-picker-list" role="listbox" aria-label={`${eligible.length} eligible models`}>{visible.map((model, index) => <button id={`${optionsId}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === active} data-active={index === active} data-recommended={model.id === recommendedModelId ? "true" : undefined} onPointerMove={() => setActive(index)} onClick={() => choose(index)} key={model.id}>
        {/*
          The grid lives on this span, not on the `<button>`. A button does not
          grow past its min-height for grid rows it contains, which silently
          clipped the capability and metric lines out of a 44px row on a phone —
          i.e. it deleted two facts by layout rather than by decision.
        */}
        <span class="model-row">
        <ModelLogo model={model} />
        <span class="model-row-id">{model.id}</span>
        <span class="model-row-price">{formatPrice(model)}</span>
        {/*
          Capability tokens stay words, not glyphs. A glyph's absence is a
          silent negative the first time a non-confidential model appears in
          this catalogue, and every one of these rows currently reads
          "Confidential candidate" — so the day one does not, it has to be
          readable rather than inferable from a missing shape.
        */}
        <span class="model-row-capabilities">
          {model.id === recommendedModelId ? <em class="model-row-flag">Recommended</em> : null}
          {model.id === value ? <em class="model-row-flag">Selected</em> : null}
          {capabilityLabels(model).length > 0
            ? capabilityLabels(model).map((label) => <span key={label}>{label}</span>)
            : <span>Capabilities not declared</span>}
          {/*
            Availability and trust readiness are per-model catalogue facts that
            existed only in the tile grid outside this control, so comparing two
            models on them was impossible without choosing one first. Words, not
            glyphs: `metadata conflict` and `cold` are the cases that decide a
            choice, and an absent glyph is a negative nobody reads.
          */}
          {catalogTokens(model).map((label) => <span key={label} class="model-row-catalog">{label}</span>)}
        </span>
        <span class="model-row-metrics" title={operationalTitle(model)}>{formatContext(model)} · {operationalLabel(model)}</span>
        </span>
      </button>)}
      </div>
      {!eligible.length ? <p class="model-picker-empty" aria-hidden="true">No matching models.</p> : null}
      <div class="model-picker-footer">
        {!showAll && eligible.length > PAGE_SIZE ? <button class="model-picker-show-all" type="button" onClick={() => setShowAll(true)}>Show all {eligible.length}</button> : null}
        <p class="model-picker-provenance">{MODEL_PICKER_PROVENANCE}</p>
      </div>
    </div> : null}
  </div>;
}

export function visibleModelCount(total: number, showAll: boolean): number { return showAll ? total : Math.min(PAGE_SIZE, total); }
export function nextModelIndex(count: number, current: number, delta: -1 | 1): number { return count <= 0 ? -1 : (Math.max(0, current) + delta + count) % count; }

/** Resolve Enter against the query currently visible in Search, even while its
 * debounced presentation state still describes the previous catalogue. */
export function modelForPickerSelection(
  models: readonly AirshipModel[],
  query: string,
  facet: Facet,
  sort: PickerSort,
  showAll: boolean,
  active: number,
): AirshipModel | undefined {
  const searched = filterModels(models, { query });
  const eligible = sortModels(facetModels(searched, facet), sort);
  const visible = showAll ? eligible : eligible.slice(0, PAGE_SIZE);
  return visible[Math.max(0, Math.min(active, visible.length - 1))];
}

/** One facet, applied to an already-searched set so counts and list agree. */
export function facetModels(models: readonly AirshipModel[], facet: Facet): readonly AirshipModel[] {
  if (facet === "vision") return filterModels(models, { inputModalities: ["image"] });
  if (facet === "tools") return filterModels(models, { features: ["tools"] });
  if (facet === "confidential") return filterModels(models, { confidentialCompute: "required" });
  if (facet === "hot") return filterModels(models, { availability: ["hot"] });
  return models;
}

/**
 * How many models each facet would leave, given the current search.
 *
 * Rendered on the chips themselves: a filter that costs a tap and a decision
 * has to say up front what it would remove, and `Confidential 12` beside
 * `All 12` says "nothing" without needing a hover.
 */
export function facetCounts(models: readonly AirshipModel[]): Readonly<Record<Facet, number>> {
  return Object.freeze({
    all: models.length,
    vision: facetModels(models, "vision").length,
    tools: facetModels(models, "tools").length,
    confidential: facetModels(models, "confidential").length,
    hot: facetModels(models, "hot").length,
  });
}

function facetLabel(value: Facet): string { return value[0]!.toUpperCase() + value.slice(1); }

export function capabilityLabels(model: AirshipModel): string[] {
  if (model.provenance.capabilities !== "llm-models" && model.provenance.capabilities !== "local-discovery") return [];
  const labels: string[] = [];
  if (model.inputModalities.some((value) => value.toLowerCase() === "text")) labels.push(MODEL_CAPABILITY_WORDS.text);
  if (model.inputModalities.some((value) => value.toLowerCase() === "image")) labels.push(MODEL_CAPABILITY_WORDS.vision);
  if (model.inputModalities.some((value) => value.toLowerCase() === "video")) labels.push(MODEL_CAPABILITY_WORDS.video);
  if (model.features.some((value) => value.toLowerCase() === "tools")) labels.push(MODEL_CAPABILITY_WORDS.tools);
  if (model.trust.confidentialCompute === "asserted") labels.push(MODEL_CAPABILITY_WORDS.confidential);
  return labels;
}
/**
 * The two catalogue facts a row could not previously carry.
 *
 * `trust.consistency === "conflict"` is the one state a person must not choose
 * blind, so it is named on the row rather than only after selection.
 */
export function catalogTokens(model: AirshipModel): readonly string[] {
  return Object.freeze([
    model.availability,
    model.tags?.includes("local")
      ? "local discovery"
      : model.trust.consistency === "conflict" ? "metadata conflict" : "evidence candidate",
  ]);
}
function formatUsd(value: number | undefined): string {
  return value === undefined
    ? "unknown"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
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
