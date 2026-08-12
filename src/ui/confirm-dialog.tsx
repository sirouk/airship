import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { trapFocus } from "./focus-trap";
import "./workspace-view.css";
// The dialog's shape is defined once, beside the surface that first shipped it.
// This import carries those rules onto routes that never render the Explorer —
// a terminal tab is closed from #terminal, where workspace-view.css is not
// otherwise loaded, and an unstyled scrim is not a confirmation.
// Styles live in styles.css (the entry stylesheet) for a gate reason: the
// release build may contain exactly one production index stylesheet. The
// shared modal is still the only confirmation grammar in the product.

export type ConfirmDialogProps = Readonly<{
  title: string;
  /** The full subject — a path, a URL — shown on hover where the title truncates. */
  titleDetail?: string;
  /** The sentence that says what this costs, in the surface's own words. */
  children: ComponentChildren;
  confirmLabel: string;
  cancelLabel?: string;
  /** True when the confirm button ends something; it takes the danger colour. */
  destructive?: boolean;
  confirmDisabled?: boolean;
  /** A third choice, between Cancel and confirm — "Save and close", never a fourth verb. */
  extraActions?: ComponentChildren;
  /** Supplied when the caller already owns focus restoration for this dialog. */
  boxRef?: RefObject<HTMLDivElement>;
  onCancel(): void;
  onConfirm(): void;
}>;

/**
 * One shape for "are you sure", for every action that cannot be undone.
 *
 * Airship shipped three answers to that question: deleting one workspace file
 * opened this designed modal, naming the revision check; removing a profile
 * threw the browser's grey `window.confirm`, stamped with the origin and unable
 * to carry a consequence sentence; and closing a terminal tab — which ends a
 * live process and its shell history — had no gate at all. Three grammars in
 * one product means a person cannot calibrate how dangerous a button is from
 * its shape, so the most careful of the three wins and the others import it.
 *
 * Escape and the Tab trap are part of the primitive rather than the caller,
 * because the one modal that shipped without them is how they got audited.
 */
export function ConfirmDialog({
  title,
  titleDetail,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  extraActions,
  boxRef,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const box = boxRef ?? fallbackRef;
  const titleId = useId();

  // Whoever asked the question gets the keyboard back when it is answered.
  //
  // Measured on Preferences: `Reset preferences` opens this gate, Cancel tears
  // it down with `setResetArmed(false)`, and with nothing handing focus back it
  // landed on `<body>` — outside the element carrying the parent dialog's own
  // `Tab`/`trapFocus` handler, so the next Tab was the browser's and walked
  // into the shell behind the scrim. The trap was not merely lost, it was
  // escaped. `useOpenerRestore` cannot do this job: it deliberately ignores
  // openers inside OVERLAY_ROOTS, and every opener of this primitive is a
  // control inside the surface that is still open behind it. Captured on mount
  // only, because nothing here inerts the opener before effects run — the one
  // race that hook exists for.
  const opener = useRef<HTMLElement>();
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) opener.current = active;
    return () => {
      const target = opener.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  // Keyed on the subject, not on mount: the Workspace dialog stays mounted
  // while its kind changes underneath it, and a modal that reused a previous
  // dialog's focus would leave the keyboard on a button that now means
  // something else.
  useEffect(() => {
    const element = box.current;
    const focusable = element?.querySelector<HTMLElement>("input, [role=\"option\"]:not([disabled]), button");
    (focusable ?? element)?.focus();
  }, [title, titleDetail]);

  return <div class="workbench-dialog-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div
      class="workbench-dialog"
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        else if (event.key === "Tab") trapFocus(event, box.current);
      }}
    >
      <h2 id={titleId} title={titleDetail}>{title}</h2>
      {children}
      <div>
        <button type="button" onClick={onCancel}>{cancelLabel}</button>
        {extraActions}
        <button class={destructive ? "danger" : "primary"} type="button" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>;
}
