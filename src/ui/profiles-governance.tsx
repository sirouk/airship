import type { ComponentChildren } from "preact";
import { useId, useState } from "preact/hooks";
import "./profiles-governance.css";
import {
  profileGovernanceCellLabel,
  type ProfileGovernanceCell,
  type ProfileGovernanceCellKey,
} from "./profiles-governance";

/**
 * USAGE — the always-visible "Governs" strip, replacing the four-accordion
 * profile editor.
 *
 *   const cells = profileGovernanceCells({ … });
 *   <ProfileGovernanceStrip
 *     cells={cells}
 *     editors={{
 *       instructions: <label>…the existing prompt textarea…</label>,
 *       theme: <div class="theme-manager">…</div>,
 *       memory: <label>…the memory MenuSelect…</label>,
 *       approvals: <label>…the approvals MenuSelect…</label>,
 *       proof: <label>…the minimum-proof MenuSelect…</label>,
 *     }}
 *     onFollowLink={(hash) => navigate(hash)}
 *   />
 *
 * Every value is legible with zero clicks and every editor is still exactly one
 * click away — the same disclosure budget, spent on the value rather than on
 * the field's name. A cell with no editor and a `link` is a destination, not a
 * disclosure, and says so in its accessible name.
 */

export type ProfileGovernanceStripProps = Readonly<{
  cells: readonly ProfileGovernanceCell[];
  /** The existing editors, rendered in place beneath the strip, one at a time. */
  editors?: Partial<Record<ProfileGovernanceCellKey, ComponentChildren>>;
  onFollowLink?: (hash: string) => void;
  class?: string;
}>;

export function ProfileGovernanceStrip({ cells, editors, onFollowLink, class: className }: ProfileGovernanceStripProps) {
  const panelId = useId();
  const [openKey, setOpenKey] = useState<ProfileGovernanceCellKey>();
  const open = openKey ? cells.find((cell) => cell.key === openKey) : undefined;
  const openEditor = openKey ? editors?.[openKey] : undefined;

  return (
    <div class={["profile-governs", className].filter(Boolean).join(" ")}>
      <div class="profile-governs__strip" role="group" aria-label="What this profile governs">
        {cells.map((cell) => {
          const editable = editors?.[cell.key] !== undefined;
          const expanded = editable ? cell.key === openKey : undefined;
          return (
            <button
              class="profile-governs__cell"
              type="button"
              key={cell.key}
              data-key={cell.key}
              aria-label={profileGovernanceCellLabel(cell)}
              aria-expanded={expanded}
              aria-controls={editable ? panelId : undefined}
              onClick={() => {
                if (!editable) {
                  if (cell.link) onFollowLink?.(cell.link);
                  return;
                }
                // One open at a time: a strip that can open six editors is the
                // four-accordion editor again, with two more accordions.
                setOpenKey((current) => (current === cell.key ? undefined : cell.key));
              }}
            >
              <small>{cell.label}</small>
              <strong>{cell.value}</strong>
              {cell.link && !editable ? <span class="profile-governs__link" aria-hidden="true">→</span> : null}
            </button>
          );
        })}
      </div>
      {open && openEditor !== undefined ? (
        <div class="profile-governs__editor" id={panelId} aria-label={open.label}>
          {openEditor}
        </div>
      ) : null}
    </div>
  );
}
