import type { ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";

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
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];

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
    if (!open || placement !== "down" || !popover.current || !trigger.current) return;
    const listbox = popover.current;
    const control = trigger.current;
    const narrowViewport = window.matchMedia("(max-width: 640px)").matches;
    if (!narrowViewport) {
      const bounds = listbox.getBoundingClientRect();
      if (bounds.right > window.innerWidth - 8) {
        listbox.style.left = "auto";
        listbox.style.right = "0";
      }
    }
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
        {selected && leading ? leading(selected) : null}
        {!compact ? <span class="menu-select-value"><strong>{selected?.label ?? "Choose"}</strong></span> : null}
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
              aria-label={option.label}
              aria-selected={option.value === value}
              disabled={option.disabled}
              tabIndex={index === activeIndex ? 0 : -1}
              onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  setActiveIndex(moveMenuSelection(activeIndex, event.key, options));
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(activeIndex);
                } else if (event.key === "Escape" || event.key === "Tab") {
                  if (event.key === "Escape") event.preventDefault();
                  close(event.key === "Escape");
                }
              }}
            >
              {leading ? leading(option) : null}
              <span class="menu-select-option-copy"><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
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
