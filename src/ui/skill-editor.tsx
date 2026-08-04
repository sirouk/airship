import { useState } from "preact/hooks";
import {
  CUSTOM_SKILL_ID_PREFIX,
  type SkillRevision,
  type SkillRevisionDraft,
} from "../profiles/domain";
import "./skill-editor.css";

/**
 * Which skill this panel is authoring.
 *
 * `new` carries no source because a new skill has no revision yet; `edit`
 * carries the whole revision rather than an id so the panel never has to look a
 * skill up in a catalog it does not own.
 */
export type SkillEditorTarget = Readonly<
  | { mode: "new" }
  | { mode: "edit"; source: SkillRevision }
>;

export type SkillEditorProps = Readonly<{
  target: SkillEditorTarget;
  /**
   * Mints and commits the revision. Rejections are rendered verbatim: every
   * refusal a draft can produce is written by `domain.ts` or `catalog.ts` and
   * already names the field or the profile at fault, so restating it here would
   * only be a chance to say something less true.
   */
  onSave: (draft: SkillRevisionDraft) => Promise<void>;
  onClose: () => void;
}>;

type Fields = Readonly<{
  skillId: string;
  name: string;
  description: string;
  systemPrompt: string;
  promptOrder: string;
  requiredTools: string;
}>;

/**
 * The id a new skill is proposed under.
 *
 * Always inside `custom.`, because that namespace is the only thing keeping a
 * future release's built-in from replacing an authored skill's text without a
 * record (see `reconcileBuiltInSkills`). The person may edit the leaf; the
 * prefix is not offered as a choice, and `upsertAuthoredSkill` refuses anything
 * outside it regardless of what this field says.
 */
export function proposedSkillId(name: string): string {
  const leaf = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  return `${CUSTOM_SKILL_ID_PREFIX}${leaf || "skill"}`;
}

function initialFields(target: SkillEditorTarget): Fields {
  if (target.mode === "new") {
    return { skillId: "", name: "", description: "", systemPrompt: "", promptOrder: "100", requiredTools: "" };
  }
  const { source } = target;
  return {
    skillId: source.skillId,
    name: source.name,
    description: source.description,
    systemPrompt: source.systemPrompt,
    promptOrder: String(source.promptOrder),
    requiredTools: source.requiredTools.join(", "),
  };
}

export function SkillEditor({ target, onSave, onClose }: SkillEditorProps) {
  /*
   * Mount-time initializer. The caller MUST give this component a key derived
   * from the target — pressing Edit on a second skill while the first is open
   * otherwise re-renders the same state under a new heading, and Save then fails
   * with "A skill's ID is fixed when it is created." about a skill the person
   * never opened.
   */
  const [fields, setFields] = useState<Fields>(() => initialFields(target));
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);
  const creating = target.mode === "new";
  // Proposed, never silently substituted: an empty id field with a filled name
  // saves under this, and the field shows it, so what is committed is what was
  // read. A person who types their own leaf keeps it.
  const skillId = fields.skillId.trim() || (creating ? proposedSkillId(fields.name) : target.source.skillId);

  function update<K extends keyof Fields>(key: K, value: Fields[K]): void {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function save(): Promise<void> {
    setStatus(undefined);
    setSaving(true);
    try {
      const promptOrder = Number(fields.promptOrder.trim());
      if (!Number.isSafeInteger(promptOrder)) {
        throw new Error("Prompt order must be a whole number between -10000 and 10000.");
      }
      await onSave({
        skillId,
        name: fields.name,
        description: fields.description,
        systemPrompt: fields.systemPrompt,
        promptOrder,
        requiredTools: fields.requiredTools
          .split(/[\s,]+/u)
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0),
      });
      /*
       * No success sentence here. `onSave` closes this panel, so anything set
       * now renders into an unmounted tree; the route's own status line — fed
       * by the same commit through `setRuntimeStatus` — is what the person
       * actually reads, and it names the storage authority this went to.
       */
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="skill-editor panel" aria-label={creating ? "New skill" : `Edit ${target.source.name}`}>
      <header>
        <div>
          <span class="eyebrow">{creating ? "New skill" : "Edit skill"}</span>
          <h2>{fields.name.trim() || (creating ? "Untitled skill" : target.source.name)}</h2>
        </div>
        <code>{skillId}</code>
      </header>
      <div class="skill-editor-fields">
        <label>
          <span class="eyebrow">Name</span>
          <input
            type="text"
            value={fields.name}
            maxLength={120}
            onInput={(event) => update("name", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span class="eyebrow">Skill ID</span>
          <input
            type="text"
            value={fields.skillId}
            placeholder={creating ? proposedSkillId(fields.name) : target.source.skillId}
            // A skill's ID is its identity in every pinned manifest that already
            // named it, so editing one would be a delete and a create wearing
            // one button. Renaming is a new skill plus a removal, deliberately.
            disabled={!creating}
            onInput={(event) => update("skillId", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="skill-editor-wide">
          <span class="eyebrow">Description</span>
          <input
            type="text"
            value={fields.description}
            maxLength={4096}
            onInput={(event) => update("description", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="skill-editor-wide">
          <span class="eyebrow">Instruction</span>
          <textarea
            rows={9}
            value={fields.systemPrompt}
            onInput={(event) => update("systemPrompt", (event.currentTarget as HTMLTextAreaElement).value)}
          />
        </label>
        <label>
          <span class="eyebrow">Prompt order</span>
          <input
            type="text"
            inputMode="numeric"
            value={fields.promptOrder}
            onInput={(event) => update("promptOrder", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span class="eyebrow">Referenced tools</span>
          <input
            type="text"
            value={fields.requiredTools}
            placeholder="read_file, search_text"
            onInput={(event) => update("requiredTools", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
      </div>
      <p class="skill-editor-boundary">
        Naming a tool documents the instruction's dependency. It grants nothing: every tool stays approval-gated,
        and this text reaches a model only in conversations started after it is saved.
      </p>
      <div class="skill-editor-actions">
        <button class="small-button" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : creating ? "Create skill" : "Save revision"}
        </button>
        <button class="small-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
      {status ? <p class="skill-editor-status" role="status" aria-live="polite">{status}</p> : null}
    </section>
  );
}
