import type { ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { MOBILE_SHELL_MEDIA_QUERY } from "./chat/composer-focus";

/** Minimum distance an anchored listbox keeps from the viewport edge. */
export const MENU_SELECT_EDGE_GUTTER = 8;

/**
 * How far an anchored listbox has to move to be on the screen at all.
 *
 * The edge flip below picks the better side of the anchor; this is what
 * happens when neither side is wide enough. Both are needed, and the gap
 * between them is where the highest-severity finding of the surface sweep
 * lived: the composer's approval-policy chooser opens *upward*, the flip is
 * written for the `down` placement only, and the panel is pinned by `right: 0`
 * to a trigger far narrower than itself. Measured on the shipped build at
 * 768x1024, the 400px panel rendered at x=-36.9 — so all three option labels
 * started off the left edge of the screen and the control that decides whether
 * the agent asks before taking effectful actions read as three unlabelled
 * rows: `…before effectual actions.`, `…k the active model to review each
 * effect`, `…every effect without prompting`. Ask First and Full Access were
 * indistinguishable.
 *
 * The left edge is repaid first, and that ordering is the whole content of
 * this function. A listbox wider than the screen can only show one of its
 * edges, and its labels are left-aligned: showing the right edge of an option
 * list is showing the part with no words in it.
 *
 * Kept free of the DOM, like `popoverPlacement` next door, because "can the
 * reader see what they are choosing between" is a correctness question and has
 * to be assertable without a browser.
 */
export function menuSelectShift(input: Readonly<{
  panelLeft: number;
  panelRight: number;
  viewportWidth: number;
}>): number {
  const overLeft = MENU_SELECT_EDGE_GUTTER - input.panelLeft;
  if (overLeft > 0) return Math.round(overLeft);
  const overRight = input.panelRight - (input.viewportWidth - MENU_SELECT_EDGE_GUTTER);
  return overRight > 0 ? -Math.round(overRight) : 0;
}

export type MenuSelectOption = Readonly<{
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}>;

export function MenuSelect({
  ariaLabel,
  options,
  value,
  onChange,
  className,
  compact = false,
  disabled = false,
  placement = "up",
  leading,
}: Readonly<{
  ariaLabel: string;
  options: readonly MenuSelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  placement?: "up" | "down";
  leading?: (option: MenuSelectOption) => ComponentChildren;
}>) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  /*
   * Two indices, because opening and displaying ask different questions.
   *
   * Where to open is a navigation question and has an answer even when nothing
   * matches: start at the top. What to display is a claim about state, and when
   * `value` matches no option the honest answer is that nothing is selected.
   * Clamping the miss to 0 for both answered the second question with the first
   * one, so a control whose `value` was empty, stale, or not yet in a freshly
   * fetched list rendered `options[0]` as chosen — a model picker asserting a
   * model the session had not pinned. `aria-selected` and the check mark below
   * both compare against `value` directly and were already right; only the
   * trigger's own label was lying, and the `?? "Choose"` fallback written for
   * exactly this case could never fire.
   */
  const matchedIndex = options.findIndex((option) => option.value === value);
  const selectedIndex = Math.max(0, matchedIndex);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = matchedIndex < 0 ? undefined : options[matchedIndex];

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const openAt = (index: number) => {
    if (disabled || options.length === 0) return;
    const next = nearestEnabledOption(options, index);
    setActiveIndex(next);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !popover.current || !trigger.current) return;
    const listbox = popover.current;
    const control = trigger.current;
    const narrowViewport = window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches;
    /*
     * The horizontal pass now runs for both placements, and it cleans up after
     * itself before it measures.
     *
     * This whole block used to sit behind `placement !== "down"`, so the panel
     * that opens upward — the composer's approval-policy chooser, the one
     * control on the route that decides what the agent may do without asking —
     * was never checked against the viewport at all. Nothing about staying on
     * the screen depends on which way a panel opens.
     *
     * Clearing the inline styles first is the other half. The flip writes
     * `left`/`right` onto the node and a shift writes `transform`, and both
     * used to survive the close: a listbox flipped once at 768px stayed
     * flipped when the same tree was later read at 1440px, because the
     * measurement that would have undone it was taken through the override.
     * Resetting makes each open measure the panel where the stylesheet puts
     * it, which is the only reading that means anything.
     */
    if (!narrowViewport) {
      listbox.style.left = "";
      listbox.style.right = "";
      listbox.style.transform = "";
      if (placement === "down" && listbox.getBoundingClientRect().right > window.innerWidth - MENU_SELECT_EDGE_GUTTER) {
        listbox.style.left = "auto";
        listbox.style.right = "0";
      }
      // The flip picks the better side of the anchor; this is what is left when
      // neither side is wide enough for the panel.
      const flipped = listbox.getBoundingClientRect();
      const shift = menuSelectShift({
        panelLeft: flipped.left,
        panelRight: flipped.right,
        viewportWidth: window.innerWidth,
      });
      if (shift !== 0) listbox.style.transform = `translateX(${shift}px)`;
    }
    if (placement !== "down") return;
    const fitBelow = () => {
      const viewport = window.visualViewport;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const available = Math.floor(viewportBottom - listbox.getBoundingClientRect().top - 8);
      listbox.style.setProperty("--menu-select-available-height", `${Math.max(44, available)}px`);
      return available;
    };
    if (fitBelow() >= 88 || narrowViewport) return;
    control.scrollIntoView({ block: "center", inline: "nearest" });
    const frame = requestAnimationFrame(fitBelow);
    return () => cancelAnimationFrame(frame);
  }, [open, placement]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  return (
    <div ref={root} class={`menu-select placement-${placement}${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}>
      <button
        ref={trigger}
        type="button"
        class="menu-select-trigger"
        aria-label={ariaLabel}
        aria-describedby={`${listboxId}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => open ? close(false) : openAt(selectedIndex)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const edge = event.key === "ArrowDown" || event.key === "Home" ? 0 : options.length - 1;
            openAt(event.key === "ArrowDown" || event.key === "ArrowUp" ? selectedIndex : edge);
          }
        }}
      >
        {/*
          The name is the field; the value is its description.
          `aria-label` alone left the chosen value out of everything a reader
          hears — in compact mode the monogram carried no value at all. Folding
          the value into the *name* fixed that and broke something worse: the
          control could no longer be called by the field it sets, which is what
          a voice user says and what every journey looks it up by. So the name
          stays the field, and `aria-describedby` carries the value, which is
          what a description is for. In compact mode the value has no visible
          box, so the description target is hidden text rather than absent.
        */}
        {selected && leading ? leading(selected) : null}
        {!compact
          ? <span class="menu-select-value" id={`${listboxId}-value`}><strong>{selected?.label ?? "Choose"}</strong></span>
          : <span class="sr-only" id={`${listboxId}-value`}><strong>{selected?.label ?? "Choose"}</strong></span>}
        <span class="menu-select-caret" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div ref={popover} id={listboxId} class="menu-select-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              id={`${listboxId}-${index}`}
              key={option.value}
              type="button"
              class="menu-select-option"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              aria-describedby={option.description ? `${listboxId}-${index}-description` : undefined}
              tabIndex={index === activeIndex ? 0 : -1}
              onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveIndex(moveMenuSelection(activeIndex, event.key, options));
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(activeIndex);
                } else if (event.key === "Escape" || event.key === "Tab") {
                  /*
                   * A key the listbox consumes is not the containing dialog's
                   * key: without `stopPropagation`, Escape inside an open
                   * `MenuSelect` bubbled into `PreferencesDialog`'s own
                   * keydown and closed the whole dialog under the listbox the
                   * reader was only trying to dismiss. `Tab` stays
                   * propagating on purpose — the listbox closes and focus must
                   * be allowed to travel onward, not be trapped behind it.
                   */
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                  close(event.key === "Escape");
                }
              }}
            >
              {/*
                Named from contents, not from an `aria-label` that overrode
                them — but the *name* is the label alone. Folding the
                description into the name made every option announce a whole
                sentence where a person wanted one word, and it is the name a
                voice user speaks and a reader navigates the list by. The
                description is a description: same information, announced
                after the name, carried by `aria-describedby`.
              */}
              {leading ? leading(option) : null}
              <span class="menu-select-option-copy">
                <strong>{option.label}</strong>
                {/*
                  `aria-hidden` keeps the sentence out of the option's NAME
                  while `aria-describedby` above still reads it: a referenced
                  element's text is used for the description even when hidden.
                  `role="presentation"` was not enough — it drops the role, not
                  the text, so the description was still folded into the name.
                */}
                {option.description
                  ? <small id={`${listboxId}-${index}-description`} aria-hidden="true">{option.description}</small>
                  : null}
              </span>
              {option.value === value ? <span class="menu-select-check" aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function moveMenuSelection(
  current: number,
  key: string,
  options: readonly Pick<MenuSelectOption, "disabled">[],
): number {
  if (!options.length) return 0;
  if (key === "Home") return nearestEnabledOption(options, 0);
  if (key === "End") return nearestEnabledOption(options, options.length - 1, -1);
  const direction = key === "ArrowUp" ? -1 : 1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return current;
}

function nearestEnabledOption(
  options: readonly Pick<MenuSelectOption, "disabled">[],
  start: number,
  direction = 1,
): number {
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = Math.max(0, Math.min(options.length - 1, start + direction * offset));
    if (!options[index]?.disabled) return index;
  }
  return 0;
}
