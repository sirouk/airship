import { useEffect, useRef, useState } from "preact/hooks";
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

/**
 * The refusal's id, fixed because at most one panel is ever mounted: the route
 * holds a single `editorTarget`, so there is no second copy to collide with.
 */
const SAVE_STATUS_ID = "skill-editor-save-status";

/**
 * Which input a refusal is *about*, when the refusal knows.
 *
 * Only the checks this panel performs itself can name a field. Everything
 * `onSave` rejects is written by `domain.ts` or `catalog.ts`, which speak about
 * drafts and profiles rather than about the boxes this form draws — so those
 * refusals carry no field and keep the behaviour they already had. Typed as a
 * key of `Fields` rather than a free string so a renamed field cannot leave a
 * refusal pointing at an input that no longer exists.
 */
type RefusedField = Extract<keyof Fields, "promptOrder">;

/**
 * A refused save, as one value.
 *
 * The message and the field it is about have to arrive together or the effect
 * below reads one of them from the wrong attempt. Held as a record rather than
 * two pieces of state for a second reason as well: a fresh object per attempt
 * is what makes a *repeat* press of a button that has already been refused once
 * do something. Keyed on the message alone, pressing Create twice with the same
 * invalid value collapsed to one unchanged string, the effect never re-ran, and
 * the second press left the person exactly where SO074 found them — looking at
 * a button that had gone quiet with the offending field off-screen.
 */
type SkillEditorRefusal = Readonly<{ message: string; field?: RefusedField }>;

export function SkillEditor({ target, onSave, onClose }: SkillEditorProps) {
  /*
   * Mount-time initializer. The caller MUST give this component a key derived
   * from the target — pressing Edit on a second skill while the first is open
   * otherwise re-renders the same state under a new heading, and Save then fails
   * with "A skill's ID is fixed when it is created." about a skill the person
   * never opened.
   */
  const [fields, setFields] = useState<Fields>(() => initialFields(target));
  const [refusal, setRefusal] = useState<SkillEditorRefusal>();
  const [saving, setSaving] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  /**
   * The inputs a refusal can name. One entry today, written as a map because
   * the second local check will want the same wiring and should not have to
   * invent it.
   */
  const fieldRefs: Readonly<Record<RefusedField, { current: HTMLInputElement | null }>> = {
    promptOrder: useRef<HTMLInputElement>(null),
  };
  const creating = target.mode === "new";
  /* The message, unpacked so every read below and in the tree stays one word. */
  const status = refusal?.message;

  /*
   * A refusal that cannot be reached says nothing.
   *
   * This sentence is the only account a person gets of why their save did not
   * commit, and it renders under the actions, which are the last thing in the
   * panel. Measured on the shipped build: at desktop-1440 `Create skill` sat at
   * 887 in a 900px viewport and at tablet-768 at 1002 in a 1024px one, so the
   * sentence explaining the press landed below the fold both times and the
   * button read as simply dead. The route does not close the panel on a
   * refusal, so nothing else moved the page either.
   *
   * `nearest` and not `center` or `start`: the person is looking at the button
   * they just pressed, and the least scroll that brings the sentence in is the
   * one that keeps that button — and the field they have to go back and fix —
   * where they left it. When the sentence is already in frame, which is every
   * viewport short enough that the alignment above opened the panel from its
   * head, `nearest` moves nothing at all.
   *
   * That reasoning holds only while the panel does not know WHICH field is
   * wrong, and it is the whole of what SO074 caught. Measured on the shipped
   * build at phone-320 with Prompt order set to `not-a-number` and Create skill
   * pressed: `main.route-layout` spans y 82..512, the refusal renders at y=331
   * — in frame, exactly as the paragraph above intends — and the PROMPT ORDER
   * input holding the rejected value sits at y=34, above the scroller's top
   * edge and invisible, with `document.activeElement` still the submit button
   * at y=275. The sentence was doing its job and the person still could not see
   * the thing it was about.
   *
   * So the two cases are separated rather than one being traded for the other.
   * A refusal that names a field moves the keyboard to that field and centres
   * it — `center` and not `nearest`, because `nearest` from below would park
   * the input flush against the top edge of the scrollport, one pixel inside
   * the frame, which is not a place to type; and the same
   * `scrollIntoView` then `focus()` order `local-lab-setup.tsx` already uses
   * for the identical problem. A refusal that names nothing keeps the original
   * behaviour exactly, sentence and all.
   */
  useEffect(() => {
    if (!refusal) return;
    const field = refusal.field ? fieldRefs[refusal.field].current : null;
    if (field) {
      field.scrollIntoView({ block: "center" });
      field.focus();
      return;
    }
    statusRef.current?.scrollIntoView({ block: "nearest" });
  }, [refusal]);
  // Proposed, never silently substituted: an empty id field with a filled name
  // saves under this, and the field shows it, so what is committed is what was
  // read. A person who types their own leaf keeps it.
  const skillId = fields.skillId.trim() || (creating ? proposedSkillId(fields.name) : target.source.skillId);

  function update<K extends keyof Fields>(key: K, value: Fields[K]): void {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function save(): Promise<void> {
    setRefusal(undefined);
    setSaving(true);
    try {
      const promptOrder = Number(fields.promptOrder.trim());
      if (!Number.isSafeInteger(promptOrder)) {
        // The one refusal this panel writes itself, so the one that can say
        // which box it is about. Thrown rather than returned so both kinds of
        // refusal leave through the same `catch` and neither can skip
        // `setSaving(false)`.
        throw Object.assign(
          new Error("Prompt order must be a whole number between -10000 and 10000."),
          { airshipField: "promptOrder" as const },
        );
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
      // The field travels on the error rather than in a second `setState`
      // beside the throw, so there is exactly one place that decides what a
      // refused save looks like and no way for the message and the field it
      // names to come from different attempts.
      const field = error instanceof Error && "airshipField" in error
        ? (error as { airshipField: RefusedField }).airshipField
        : undefined;
      setRefusal({ message: error instanceof Error ? error.message : String(error), field });
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
        {/* The one field a refusal can name, so the one that says so on itself.
            `aria-invalid` marks it and `aria-describedby` points at the very
            sentence that is rendered below the actions — the refusal now names
            its own input in both directions, which is what makes arriving here
            by focus intelligible rather than mysterious.

            The whole refusal is dropped on the next keystroke in this field —
            the marking and the sentence together, because the sentence is about
            a value that no longer exists and a person correcting it must not be
            told they are still wrong while they are in the middle of being
            right. Dropping it entirely rather than only the marking is also
            what keeps the effect above quiet: it is keyed on the record, and a
            record that still carried a message would make every keystroke
            re-run it and scroll the panel under the typist. */}
        <label>
          <span class="eyebrow">Prompt order</span>
          <input
            ref={fieldRefs.promptOrder}
            type="text"
            inputMode="numeric"
            value={fields.promptOrder}
            aria-invalid={refusal?.field === "promptOrder" ? "true" : undefined}
            aria-describedby={refusal?.field === "promptOrder" ? SAVE_STATUS_ID : undefined}
            onInput={(event) => {
              update("promptOrder", (event.currentTarget as HTMLInputElement).value);
              setRefusal((current) => current?.field === "promptOrder" ? undefined : current);
            }}
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
        {/* The button carries the refusal as its description, so returning to it
            restates why it did nothing instead of leaving a screen-reader user
            to hunt for a sentence that is only ever below it. */}
        <button
          class="small-button"
          type="button"
          disabled={saving}
          aria-describedby={status ? SAVE_STATUS_ID : undefined}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : creating ? "Create skill" : "Save revision"}
        </button>
        <button class="small-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
      {/* `alert`, not `status`: everything this element can ever hold is a
          refusal — the success path closes the panel before it could say
          anything — and a polite live region waits for a pause that a person
          re-reading their own form never gives it. */}
      {status ? <p ref={statusRef} id={SAVE_STATUS_ID} class="skill-editor-status" role="alert">{status}</p> : null}
    </section>
  );
}
