import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { Popover } from "./popover";
import { Seal, type SealState } from "./seal";
import { SCROLL_EDGE_EPSILON, scrollEdges, type ScrollEdges } from "./scroll-affordance";

/**
 * USAGE — the one tab strip. Two variants, one "you are here" encoding.
 *
 * Region switching (Proof, Workspace, Connect methods, the profile hub):
 *
 *   <Tabs
 *     label="Proof views"
 *     items={[{ id: "summary", label: "Receipt & journal" },
 *             { id: "attestations", label: "Attestation evidence" }]}
 *     activeId={section}
 *     onSelect={onSectionChange}
 *     panelId={(id) => `proof-panel-${id}`}
 *   />
 *
 * Closable document tabs (Editor files, Terminal sessions):
 *
 *   <Tabs variant="document" label="Open files" overflowHeading="Open files"
 *     items={tabs.map((path) => ({
 *       id: path,
 *       label: middleTruncate(workspaceBaseName(path), TAB_LABEL_MAX),
 *       detail: path,
 *       state: dirty ? "attention" : undefined, stateLabel: "Unsaved",
 *       onClose: () => closeTab(path), closeLabel: `Close ${path}`,
 *     }))}
 *     activeId={activePath} onSelect={openTab} />
 *
 * What the strip does for you, and what you therefore must not rebuild:
 * - scrolls the active tab into view whenever it changes;
 * - paints an edge fade only on the side that genuinely hides tabs
 *   (`data-scroll-edges`, the shipped, measured affordance);
 * - grows a `⌄ n` overflow control whenever the tabs do not fit the row that
 *   control is *not* in (`tabStripOverflows`), whose panel lists **every** tab
 *   with its full untruncated `detail`, so a name that is clipped on the strip
 *   is still readable somewhere that is not a tooltip;
 * - roving tabindex with ←/→/Home/End, per the tablist pattern.
 *
 * Counts ride with the label as plain text (`Source Control 3`), never as a
 * filled badge. A live state is a `dot` Seal whose word is in the accessible
 * name — never a second line of text.
 */

export type TabsVariant = "section" | "document";

export type TabItem = Readonly<{
  id: string;
  /** Decorative leading mark, such as a deterministic file-type icon. */
  leading?: ComponentChildren;
  /** What the strip shows. Truncate with `middleTruncate` and pass `detail`. */
  label: string;
  /** The untruncated identity — a workspace-relative path, a full title. */
  detail?: string;
  /** A disambiguator rendered after the label (two files both named index.ts). */
  hint?: string;
  /** Travels with the label as plain text. */
  count?: number;
  /** What the count counts, for the accessible name: "3 changes". */
  countLabel?: string;
  /** A live state — Terminal's "Running", an unsaved buffer. */
  state?: SealState;
  /** The word for that state. Required reading: it is the accessible carrier. */
  stateLabel?: string;
  /** A replaceable document preview. Its visible label is italicized. */
  preview?: boolean;
  disabled?: boolean;
  onClose?(): void;
  closeLabel?: string;
}>;

export type TabsProps = Readonly<{
  /** Accessible name of the tablist. */
  label: string;
  items: readonly TabItem[];
  activeId: string;
  onSelect(id: string): void;
  variant?: TabsVariant;
  /** The id of the panel each tab controls, when the panels are in the DOM. */
  panelId?: (id: string) => string;
  /** Heading of the overflow panel. Defaults to the tablist's own name. */
  overflowHeading?: string;
  class?: string;
}>;

/** Where a tab sits inside the strip's scroll box, in CSS pixels. */
export type TabBox = Readonly<{ id: string; start: number; end: number }>;

export type TabViewport = Readonly<{ start: number; end: number }>;

export type TabOverflow = Readonly<{
  edges: ScrollEdges;
  /** Tabs not wholly inside the strip, in strip order. */
  hidden: readonly string[];
}>;

const NO_OVERFLOW: TabOverflow = Object.freeze({ edges: "none", hidden: Object.freeze([]) });

/**
 * The tabs the strip is currently cutting off.
 *
 * Partially visible counts as hidden: a tab clipped mid-word is a name the
 * user cannot read, and the whole point of the overflow control is to be an
 * honest count of what the strip is not showing. Shares the scroll
 * affordance's epsilon so a resting strip never reports a phantom.
 */
export function tabsOutOfView(boxes: readonly TabBox[], viewport: TabViewport): readonly string[] {
  return Object.freeze(boxes
    .filter((box) => box.start < viewport.start - SCROLL_EDGE_EPSILON
      || box.end > viewport.end + SCROLL_EDGE_EPSILON)
    .map((box) => box.id));
}

/**
 * The scroll offset that brings a tab fully into view, and no other movement.
 *
 * Deliberately not `scrollIntoView`: with `block: "nearest"` the browser also
 * scrolls every scrollable ancestor, so mounting a tab strip that sits below
 * the fold silently scrolls the *page*. Measured doing exactly that at 430px.
 * A strip may move itself horizontally; it may not move the document.
 */
export function tabScrollLeft(box: TabBox, viewport: TabViewport): number {
  if (box.start < viewport.start) return Math.max(0, box.start);
  if (box.end > viewport.end) return Math.max(0, box.end - (viewport.end - viewport.start));
  return viewport.start;
}

/**
 * The horizontal reading of the shipped vertical overflow rule.
 *
 * `scrollEdges` is the measured, tested version of "is anything actually
 * hidden, and on which side" — a strip that painted a fade whenever it could
 * scroll would assert hidden tabs that are not there.
 */
export function tabStripEdges(metrics: Readonly<{
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}>): ScrollEdges {
  return scrollEdges({
    scrollTop: metrics.scrollLeft,
    scrollHeight: metrics.scrollWidth,
    clientHeight: metrics.clientWidth,
  });
}

/**
 * Whether the strip is cutting anything off — measured against the row it would
 * have if the `⌄ n` control were not standing in it.
 *
 * The control is the strip's *sibling* inside `.tabs`, so the instant it
 * appears it takes ~52px (a 44px target plus the row's gap) off the very box
 * whose fullness decided it should appear. That gives one row two stable
 * readings: 347px of tabs in the 374px row that has no control is "nothing
 * hidden", and the same 347px in the 322px row that has one is "one hidden".
 * Both are self-consistent, so whichever the strip happens to arrive in is the
 * one it keeps — a transient during load is enough to latch it, and nothing
 * afterwards can unwind it. Measured doing exactly that to the Workspace pane
 * switcher at 390px, which read "…lorer | Editor | Source Contro  ⌄ 1" — a
 * third of a phone's only navigation into that route behind a chevron — while
 * the container it sits in never changed width.
 *
 * Deciding the control's *presence* here is what has a single answer, because
 * neither term moves when the control does: the content is the tabs' own width
 * and the row is the container's. What the strip then *reports* is still
 * measured against the row it actually has, so `⌄ n` stays an honest count of
 * what cannot be read right now rather than of what could not be read in a
 * wider row that is no longer on screen.
 */
export function tabStripOverflows(metrics: Readonly<{
  contentWidth: number;
  rowWidth: number;
}>): boolean {
  // Written as an assertion that the tabs overflow, never as a negation of
  // their fitting: a strip read before layout has widths that compare false
  // either way round, and `!(content <= row)` would turn that into a chevron
  // grown over a row nobody has measured — this same latch by another door.
  return metrics.contentWidth > metrics.rowWidth + SCROLL_EDGE_EPSILON;
}

/**
 * The overflow control's accessible name: the count, and what opening it gives.
 *
 * "Counts are honest" — the affordance states its own cost. It also states
 * that the panel holds *every* tab, not only the hidden ones, because that is
 * what makes it a place to read a clipped name rather than a scroll shortcut.
 */
export function tabOverflowLabel(input: Readonly<{ hidden: number; total: number }>): string {
  const cut = input.hidden === 1 ? "1 tab is" : `${input.hidden} tabs are`;
  return `${cut} cut off. Open the full list of all ${input.total}.`;
}

/**
 * A tab's accessible name: label, disambiguator, count and live-state word.
 *
 * The state word is concatenated rather than left to the seal alone so the
 * name is complete even where the seal is decorative, and `detail` leads when
 * the visible label has been truncated — the accessible tree gets the whole
 * identity even when 15ch of strip does not.
 */
export function tabAccessibleName(item: TabItem): string {
  const parts: string[] = [item.detail && item.detail !== item.label ? item.detail : item.label];
  if (item.hint) parts.push(item.hint);
  if (item.count !== undefined) parts.push(item.countLabel ?? String(item.count));
  if (item.preview) parts.push("Preview");
  if (item.stateLabel) parts.push(item.stateLabel);
  return parts.join(", ");
}

/** Button 1 is the browser-standard auxiliary/middle activation. */
export function isTabCloseAuxiliaryActivation(button: number): boolean {
  return button === 1;
}

/**
 * Roving-tabindex movement, skipping disabled tabs and wrapping at the ends.
 *
 * Returns `undefined` for keys the strip does not own, so the caller can leave
 * the event alone — a tablist that swallows Tab is a keyboard trap.
 */
export function nextTabId(
  items: readonly TabItem[],
  activeId: string,
  key: string,
): string | undefined {
  const reachable = items.filter((item) => !item.disabled);
  if (reachable.length === 0) return undefined;
  if (key === "Home") return reachable[0]?.id;
  if (key === "End") return reachable[reachable.length - 1]?.id;
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return undefined;
  const current = reachable.findIndex((item) => item.id === activeId);
  if (current < 0) return reachable[step === 1 ? 0 : reachable.length - 1]?.id;
  const next = (current + step + reachable.length) % reachable.length;
  return reachable[next]?.id;
}

/** The strip's default label budget: 15ch, measured against 9 open editor tabs. */
export const TAB_LABEL_MAX = 15;

/**
 * Truncate in the middle, so a file keeps its extension.
 *
 * `really-long-component-name-panel.tsx` ellipsised at the end becomes
 * `really-long-comp…`, which loses the one part of a filename that says what
 * the file *is*. The whole string stays in `detail`, which is both the
 * accessible name and a visible row in the overflow panel.
 */
export function middleTruncate(label: string, max: number = TAB_LABEL_MAX): string {
  const characters = [...label];
  if (max < 3 || characters.length <= max) return label;
  const tail = Math.max(1, Math.floor((max - 1) / 2));
  const head = max - 1 - tail;
  return `${characters.slice(0, head).join("")}…${characters.slice(characters.length - tail).join("")}`;
}

export function Tabs({
  label,
  items,
  activeId,
  onSelect,
  variant = "section",
  panelId,
  overflowHeading,
  class: className,
}: TabsProps) {
  const baseId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<TabOverflow>(NO_OVERFLOW);
  const signature = items.map((item) => item.id).join("\u0000");

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let last = "";
    const measure = () => {
      const next = measureTabOverflow(strip);
      const key = `${next.edges}\u0000${next.hidden.join("\u0000")}`;
      if (key === last) return;
      last = key;
      setOverflow(next);
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // A tab strip changes width without a scroll or a resize — a file is
    // opened, a count grows a digit — so the box itself has to be observed.
    let resizeFrame: number | undefined;
    const scheduleMeasure = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        measure();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    };
  }, [signature]);

  useEffect(() => {
    // The measured defect this replaces: nine open tabs, 1593px of strip in a
    // 797px box, and the active tab never scrolled to. The phone showed three
    // filenames while the toolbar named a fourth.
    const strip = stripRef.current;
    const active = findTabElement(strip, activeId);
    if (!strip || !active) return;
    const next = tabScrollLeft(tabBox(strip, active), stripViewport(strip));
    if (next !== strip.scrollLeft) strip.scrollLeft = next;
  }, [activeId, signature]);

  function move(key: string): boolean {
    const next = nextTabId(items, activeId, key);
    if (next === undefined || next === activeId) return next !== undefined;
    onSelect(next);
    const target = findTabElement(stripRef.current, next);
    target?.querySelector<HTMLButtonElement>(".tabs__tab-button")?.focus();
    return true;
  }

  return (
    <div class={["tabs", className].filter(Boolean).join(" ")} data-variant={variant}>
      <div
        class="tabs__strip"
        ref={stripRef}
        role="tablist"
        aria-label={label}
        data-scroll-edges={overflow.edges}
      >
        {/* The wrapper is presentational so the tablist still owns the tab
            itself: a closable tab is a tab plus a second control, and only one
            of them is the tab. */}
        {items.map((item) => (
          <div
            class="tabs__tab"
            key={item.id}
            role="presentation"
            data-tab-id={item.id}
            data-active={item.id === activeId ? "true" : "false"}
            data-preview={item.preview ? "true" : "false"}
          >
            <button
              class="tabs__tab-button"
              type="button"
              role="tab"
              id={`${baseId}-${item.id}`}
              aria-selected={item.id === activeId}
              aria-controls={panelId?.(item.id)}
              aria-label={tabAccessibleName(item)}
              title={item.detail}
              disabled={item.disabled}
              tabIndex={item.id === activeId ? 0 : -1}
              onClick={() => onSelect(item.id)}
              onMouseDown={(event) => {
                // Prevent the browser's middle-button autoscroll cursor. The
                // ensuing auxiliary activation owns the close action.
                if (item.onClose && isTabCloseAuxiliaryActivation(event.button)) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (!item.onClose || !isTabCloseAuxiliaryActivation(event.button)) return;
                event.preventDefault();
                item.onClose();
              }}
              onKeyDown={(event) => { if (move(event.key)) event.preventDefault(); }}
            >
              {item.leading ? <span class="tabs__leading" aria-hidden="true">{item.leading}</span> : null}
              {item.state ? (
                <Seal state={item.state} label={item.stateLabel} density="dot" size={16} class="tabs__state" />
              ) : null}
              <span class="tabs__label">{item.label}</span>
              {item.hint ? <small class="tabs__hint">{item.hint}</small> : null}
              {item.count !== undefined ? <span class="tabs__count">{item.count}</span> : null}
            </button>
            {item.onClose ? (
              <button
                class="tabs__close"
                type="button"
                aria-label={item.closeLabel ?? `Close ${item.detail ?? item.label}`}
                onClick={item.onClose}
              >
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {overflow.hidden.length > 0 ? (
        <Popover
          class="tabs__overflow"
          triggerClass="tabs__overflow-trigger"
          label={tabOverflowLabel({ hidden: overflow.hidden.length, total: items.length })}
          heading={overflowHeading ?? label}
          trigger={<>
            <span aria-hidden="true">⌄</span>
            <span class="tabs__overflow-count">{overflow.hidden.length}</span>
          </>}
        >
          <div class="tabs__overflow-list">
            {items.map((item) => (
              <button
                class="tabs__overflow-item"
                key={item.id}
                type="button"
                aria-current={item.id === activeId ? "true" : undefined}
                data-hidden={overflow.hidden.includes(item.id) ? "true" : "false"}
                data-preview={item.preview ? "true" : "false"}
                disabled={item.disabled}
                onClick={() => onSelect(item.id)}
              >
                {item.leading ? <span class="tabs__leading" aria-hidden="true">{item.leading}</span> : null}
                {item.state ? (
                  <Seal state={item.state} label={item.stateLabel} density="dot" size={16} />
                ) : null}
                <span class="tabs__overflow-label">{item.detail ?? item.label}</span>
                {item.count !== undefined ? <small>{item.countLabel ?? item.count}</small> : null}
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * A tab's position in the strip's own scroll coordinates.
 *
 * Rect deltas rather than `offsetLeft`, which is measured from the nearest
 * *positioned* ancestor: inside a padded route body that reads 32px larger
 * than the strip's own scroll box, and the strip then reports a tab as cut off
 * while it is plainly on screen. Measured doing exactly that on a two-tab
 * strip, which claimed one tab was hidden.
 */
export function tabBox(strip: HTMLElement, tab: HTMLElement): TabBox {
  const origin = strip.getBoundingClientRect().left - strip.scrollLeft;
  const rect = tab.getBoundingClientRect();
  return { id: tab.dataset.tabId ?? "", start: rect.left - origin, end: rect.right - origin };
}

/**
 * The strip's own visible window, in the same coordinates as `tabBox`.
 *
 * Exported alongside `tabBox` for the one strip that cannot adopt `Tabs`:
 * Terminal replaces a tab with a text input while it is being renamed, and
 * `TabItem` has no shape for that. It takes the measured rule rather than a
 * second copy of it, which is the part of "one tab strip" that is actually
 * about behaviour rather than markup.
 */
export function stripViewport(strip: HTMLElement): TabViewport {
  return { start: strip.scrollLeft, end: strip.scrollLeft + strip.clientWidth };
}

/**
 * The scrollable width the strip would have with no `⌄ n` control beside it.
 *
 * `.tabs` holds exactly two children — this strip and, when there is something
 * to report, the overflow control — so the strip may occupy the whole of its
 * container's content box. That number is the one thing in this measurement
 * the control cannot move, which is why `tabStripOverflows` decides against it.
 * `scrollWidth` is read in the strip's padding box, so the comparison is made
 * there too: whatever of the strip's own box is border rather than scrollable
 * area comes back off.
 */
function tabStripRowWidth(strip: HTMLElement): number {
  const row = strip.parentElement;
  if (!row) return strip.clientWidth;
  const style = getComputedStyle(row);
  const inner = row.clientWidth
    - (Number.parseFloat(style.paddingLeft) || 0)
    - (Number.parseFloat(style.paddingRight) || 0);
  return Math.max(0, inner - (strip.offsetWidth - strip.clientWidth));
}

/** Reads the live strip geometry. The rules it feeds are pure and tested above. */
function measureTabOverflow(strip: HTMLElement): TabOverflow {
  // Asked before anything else, and of the row without the control in it: a
  // strip that fits once the chevron is gone has nothing to fade and nothing to
  // list, and saying so here is what stops the two readings from latching.
  if (!tabStripOverflows({ contentWidth: strip.scrollWidth, rowWidth: tabStripRowWidth(strip) })) {
    return NO_OVERFLOW;
  }
  const boxes: TabBox[] = [];
  for (let index = 0; index < strip.children.length; index += 1) {
    const child = strip.children[index];
    if (!(child instanceof HTMLElement)) continue;
    if (child.dataset.tabId === undefined) continue;
    boxes.push(tabBox(strip, child));
  }
  const viewport = stripViewport(strip);
  return Object.freeze({
    edges: tabStripEdges({
      scrollLeft: strip.scrollLeft,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
    }),
    hidden: tabsOutOfView(boxes, viewport),
  });
}

/**
 * Finds a tab by id without a selector.
 *
 * Document tab ids are file paths, which contain quotes, brackets and slashes;
 * building a selector out of one is a bug waiting for a filename.
 */
function findTabElement(strip: HTMLElement | null, id: string): HTMLElement | undefined {
  if (!strip) return undefined;
  for (let index = 0; index < strip.children.length; index += 1) {
    const child = strip.children[index];
    if (child instanceof HTMLElement && child.dataset.tabId === id) return child;
  }
  return undefined;
}
