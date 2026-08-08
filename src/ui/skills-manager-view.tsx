import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  managedProfileRevisions,
  skillReferences,
  type ProfileCatalog,
} from "../profiles/catalog";
import {
  isCustomSkillId,
  resolveSkillDecisions,
  type SkillMode,
  type SkillRevision,
  type SkillRevisionDraft,
} from "../profiles/domain";
import type { ProfileCatalogStore } from "../profiles/persistence";
import { loadRetryableChunk } from "./chunk-recovery";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { RouteHeader } from "./route-header";

type SkillEditorComponent = typeof import("./skill-editor").SkillEditor;
type SkillEditorTarget = import("./skill-editor").SkillEditorTarget;

/** Exact refusal for the initiating surface; `undefined` means the switch committed. */
export type ProfileSwitchFailure = string | undefined;

export type SkillsManagerViewProps = Readonly<{
  catalog: ProfileCatalog;
  catalogDurability: ProfileCatalogStore["durability"];
  activeProfileId: string;
  onSetGlobal: (skillId: string, enabled: boolean) => Promise<void>;
  onSetProfile: (profileId: string, skillId: string, mode: SkillMode) => Promise<void>;
  onSaveSkill: (draft: SkillRevisionDraft) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
  /** Switches to the previewed profile and returns its exact refusal, if any. */
  onApply: (profileId: string) => Promise<ProfileSwitchFailure>;
  /** Opens a conversation pinned to the skill set currently resolved here. */
  onStartConversation: () => Promise<string | undefined>;
  /** Exact reason the initiating control cannot start a conversation now. */
  startConversationDisabledReason?: string;
  scope: string;
}>;

function developmentChunkEntry(path: string): string | undefined {
  return import.meta.env.DEV ? `${import.meta.env.BASE_URL}src/ui/${path}` : undefined;
}

/** The vertical extent of a box, in the coordinates `getBoundingClientRect` reports. */
export type BlockBox = Readonly<{ top: number; bottom: number }>;

/**
 * Where the authoring panel has to be scrolled to, or `undefined` when the
 * reader can already reach the whole of it.
 *
 * Two opposite failures meet here, and a rule that answers only one of them
 * reintroduces the other.
 *
 * Edit is normally pressed from a card scrolled well past the panel, so the
 * route's entire response to its own authoring verb landed off-screen and the
 * verb read as a dead button. Aligning unconditionally then made the opposite
 * mistake on a tall viewport, where New skill is pressed from a toolbar a few
 * hundred pixels above a panel that is already in frame: the scroll carried the
 * route's mode tabs and — worse — the APPLIES TO scope selector, which names the
 * profile the skill being authored resolves for, off the top while the author
 * filled the form that scope applies to.
 *
 * The gate written against that second failure asked only whether the panel's
 * *head* was reachable, and a form is not its head. Measured on the 320, 390,
 * 430, 768, 1024 and 1440 device classes, the panel opened with NAME in frame
 * and `Create skill` and `Cancel` past the fold at every one of them: the gate
 * said "already reachable" about a form whose only way out was somewhere the
 * reader had no reason to look for it. That is worse than opening off-screen,
 * because the reader believes they are in the form.
 *
 * So the question is whether the whole panel is reachable, and the answer also
 * says where to put it:
 *
 * - Nothing hanging out of the scrollport: leave the page alone. This is the
 *   1920x1080 case the previous gate was written for; it still holds, and it is
 *   the only class where the actions were already in frame.
 * - Hanging off the bottom and short enough to fit: `end`. That is the least
 *   scroll that brings the actions in, so it keeps the most route chrome — at
 *   1440x900 it moves the page 106px where `start` moves it 369px, which is the
 *   difference between keeping the Skills heading and the scope card and losing
 *   them along with the tabs.
 * - Anything else — hanging off the top, or taller than the scrollport at any
 *   scroll position: `start`. A panel that cannot be shown whole is shown from
 *   its beginning, which is where its header, its first field and therefore the
 *   keyboard already are.
 */
export function editorPanelAlignment(
  panel: BlockBox,
  scrollport: BlockBox,
): ScrollLogicalPosition | undefined {
  if (panel.top < scrollport.top) return "start";
  if (panel.bottom <= scrollport.bottom) return undefined;
  return panel.bottom - panel.top <= scrollport.bottom - scrollport.top ? "end" : "start";
}

/**
 * The box the reader actually sees this element through.
 *
 * Found by walking rather than by naming the shell's `.main`, because the
 * question this answers — "is the panel on screen" — is asked of whichever
 * ancestor happens to scroll, and a class name here would be a second copy of
 * the shell's layout that could drift from it silently. The window is the
 * fallback, not the assumption: the route chrome this regression was about sits
 * inside the scrolling element, so measuring against `innerHeight` would call
 * a panel visible while it sat behind the top bar.
 */
function scrollportBox(element: Element): BlockBox {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (node.scrollHeight <= node.clientHeight) continue;
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

/** The route-local Skills catalog, deferred until a person opens Skills. */
export function SkillsManagerView({
  catalog,
  catalogDurability,
  activeProfileId,
  onSetGlobal,
  onSetProfile,
  onSaveSkill,
  onDeleteSkill,
  onApply,
  onStartConversation,
  startConversationDisabledReason,
  scope,
}: SkillsManagerViewProps) {
  const [selectedProfileId, setSelectedProfileId] = useState(activeProfileId);
  const profiles = useMemo(() => managedProfileRevisions(catalog), [catalog]);
  const scopedProfileId = scope === "global" ? selectedProfileId : scope;
  const profile = profiles.find((candidate) => candidate.profileId === scopedProfileId) ?? profiles[0]!;
  const [status, setStatus] = useState<string>();
  const [profileSwitchFailure, setProfileSwitchFailure] = useState<string>();
  const [conversationStartFailure, setConversationStartFailure] = useState<string>();
  /*
   * The grid asks `domain.ts` the same question the session pin asks it. It
   * used to recompute `on` / `inherit` / global-default itself, so a change to
   * the precedence had to be made here as well to keep the card's "resolved on"
   * badge honest about what the next conversation would actually load.
   */
  const decisions = useMemo(() => resolveSkillDecisions({
    skillModes: profile.skillModes,
    skills: catalog.skills,
    globalSkills: catalog.globalSkills,
  }), [profile, catalog]);
  const decisionBySkillId = useMemo(
    () => new Map(decisions.map((decision) => [decision.skillId, decision] as const)),
    [decisions],
  );
  const resolvedCount = decisions.filter((decision) => decision.enabled).length;
  const [editorTarget, setEditorTarget] = useState<SkillEditorTarget>();
  const [SkillEditorPanel, setSkillEditorPanel] = useState<SkillEditorComponent>();
  const [editorError, setEditorError] = useState<string>();
  const editorRef = useRef<HTMLDivElement>(null);

  /*
   * The authoring panel mounts above the grid, and Edit is pressed from a card
   * that is normally scrolled well below it — so on a catalog of any length the
   * entire response to the route's primary authoring verb landed outside the
   * viewport and the button read as dead. The panel comes to the reader and the
   * Name field takes the keyboard, which is also where a keyboard arrival
   * belongs; `preventScroll` because the alignment above already chose the
   * position and focus must not re-choose it.
   *
   * It comes only when it is not already there, and only as far as it has to.
   * `editorPanelAlignment` carries both reasons: an unconditional `block:
   * "start"` also fired for New skill on a viewport where the panel was in frame
   * the whole time, and paid for a scroll nobody needed with the route's tab
   * strip and scope selector; a gate that watched only the panel's top edge then
   * left `Create skill` and `Cancel` under the fold on every device class but
   * the tallest. The focus still happens either way — the keyboard has to land
   * in the form whether or not the page moved.
   *
   * Gated on `SkillEditorPanel` because the panel is a deferred chunk: without
   * it this would align the one-line "Loading the skill editor…" placeholder
   * and then leave the panel to appear wherever the reflow put it. Keyed on
   * `editorTarget` by identity, so pressing Edit again on the skill already
   * open re-aligns rather than concluding that nothing changed.
   */
  useEffect(() => {
    if (!editorTarget || !SkillEditorPanel) return;
    const panel = editorRef.current;
    if (!panel) return;
    const alignment = editorPanelAlignment(panel.getBoundingClientRect(), scrollportBox(panel));
    if (alignment) panel.scrollIntoView({ block: alignment });
    panel.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [editorTarget, SkillEditorPanel]);

  useEffect(() => {
    setProfileSwitchFailure(undefined);
    setConversationStartFailure(undefined);
  }, [profile.profileId]);

  useEffect(() => {
    if (!editorTarget || SkillEditorPanel) return;
    let current = true;
    setEditorError(undefined);
    /*
     * Through the recovery loader for the same reason the Memory route uses it:
     * a module URL that has failed once is recorded as failed in this document's
     * module map, so a plain retry button issues no network request at all and
     * the panel stays dead for the life of the tab.
     */
    void loadRetryableChunk(
      "skill-editor",
      () => import("./skill-editor"),
      developmentChunkEntry("skill-editor.tsx"),
    ).then((module) => {
      if (current) setSkillEditorPanel(() => module.SkillEditor);
    }).catch(() => {
      if (current) setEditorError("The skill editor could not be loaded. No skill was created or changed.");
    });
    return () => { current = false; };
  }, [editorTarget, SkillEditorPanel]);

  async function removeSkill(skill: SkillRevision): Promise<void> {
    setStatus(undefined);
    setProfileSwitchFailure(undefined);
    try {
      await onDeleteSkill(skill.skillId);
      // Removing skill A while editing B must not close B's unsaved draft.
      setEditorTarget((current) => (current?.mode === "edit" && current.source.skillId === skill.skillId ? undefined : current));
      setStatus(`${skill.name} removed.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateGlobal(skillId: string, enabled: boolean): Promise<void> {
    setStatus(undefined);
    setProfileSwitchFailure(undefined);
    try {
      await onSetGlobal(skillId, enabled);
      setStatus(catalogDurability === "encrypted-vault" ? "Global skill policy saved to the encrypted Vault." : "Global skill policy updated for this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateProfileSkill(skillId: string, mode: SkillMode): Promise<void> {
    setStatus(undefined);
    setProfileSwitchFailure(undefined);
    try {
      await onSetProfile(profile.profileId, skillId, mode);
      setStatus(catalogDurability === "encrypted-vault" ? "Profile skill policy saved to the encrypted Vault." : "Profile skill policy updated for this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  /** The initiating route owns the exact profile-switch refusal. */
  async function applyProfile(): Promise<void> {
    setProfileSwitchFailure(undefined);
    try {
      const failure = await onApply(profile.profileId);
      if (failure) setProfileSwitchFailure(failure);
    } catch (error) {
      setProfileSwitchFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function startConversation(): Promise<void> {
    setConversationStartFailure(undefined);
    try {
      const failure = await onStartConversation();
      if (failure) setConversationStartFailure(failure);
    } catch (error) {
      setConversationStartFailure(error instanceof Error ? error.message : String(error));
    }
  }

  const conversationStartStatus = startConversationDisabledReason ?? conversationStartFailure;

  return (
    <section class="work-view">
      <RouteHeader
        routeId="skills"
        title="Skills"
        eyebrow="Resolved instruction modules"
        description={scope === "global" ? "Set global skill defaults. Enabled instructions are pinned into the next conversation manifest." : `Set inherit/on/off overrides for ${profile.name}. Existing conversations remain pinned.`}
      />
      <div class="skills-toolbar panel">
        {scope === "global" ? <div class="skill-select-field"><span>Preview resolution for</span><MenuSelect placement="down" ariaLabel="Preview profile resolution" value={profile.profileId} options={profiles.map((candidate) => ({ value: candidate.profileId, label: candidate.name }))} onChange={setSelectedProfileId} /></div> : <div><span class="eyebrow">Profile scope</span><strong>{profile.name}</strong></div>}
        <div><span class="eyebrow">Effective set</span><strong>{resolvedCount} of {catalog.skills.length}</strong></div>
        {/* This is the one action that makes the resolved set live. */}
        {profile.profileId === activeProfileId
          ? <button
              class="small-button"
              type="button"
              title={`Pins the ${resolvedCount} resolved skills into a new conversation's prompt.`}
              aria-describedby={conversationStartStatus ? "skill-conversation-start-status" : undefined}
              disabled={Boolean(startConversationDisabledReason)}
              onClick={() => void startConversation()}
            >New conversation with this set</button>
          : <button class="small-button" type="button" aria-describedby={profileSwitchFailure ? "skill-profile-switch-failure" : undefined} onClick={() => void applyProfile()}>Switch to {profile.name}</button>}
        <button class="small-button" type="button" onClick={() => setEditorTarget({ mode: "new" })}>New skill</button>
        {conversationStartStatus ? <p
          id="skill-conversation-start-status"
          class={`skills-toolbar-status${conversationStartFailure && !startConversationDisabledReason ? " failure" : ""}`}
          role={conversationStartFailure && !startConversationDisabledReason ? "alert" : "status"}
        >{conversationStartStatus}</p> : null}
        {profileSwitchFailure ? <p id="skill-profile-switch-failure" class="profile-switch-failure" role="alert">{profileSwitchFailure}</p> : null}
      </div>
      {/* The wrapper exists only so the effect above has something to align to:
          `SkillEditor` is a plain function component, so a ref on it would not
          reach the panel's own element. */}
      {editorTarget ? <div ref={editorRef}>{SkillEditorPanel ? (
        <SkillEditorPanel
          key={`${editorTarget.mode}:${editorTarget.mode === "new" ? "" : editorTarget.source.skillId}`}
          target={editorTarget}
          onSave={onSaveSkill}
          onClose={() => setEditorTarget(undefined)}
        />
      ) : editorError ? <p class="skill-editor-status" role="status" aria-live="polite">{editorError}</p> : <p role="status" aria-live="polite">Loading the skill editor…</p>}</div> : null}
      <div class="skill-grid">
        {catalog.skills.map((skill) => {
          const { mode, globallyEnabled: globalEnabled, enabled } = decisionBySkillId.get(skill.skillId)!;
          const authored = isCustomSkillId(skill.skillId);
          // An inherited key does not reference a skill; the domain helper owns this rule.
          const referencing = authored ? skillReferences(catalog, skill.skillId) : [];
          return (
            <article class={enabled ? "skill-card panel enabled" : "skill-card panel"} key={skill.skillId}>
              <header><span class="skill-glyph"><Icon name="skills" /></span><div><h2>{skill.name}</h2><code>{skill.skillId}</code></div><span class={enabled ? "skill-state on" : "skill-state"}>{enabled ? "resolved on" : "resolved off"}</span></header>
              <p>{skill.description}</p>
              <div class="skill-controls">
                {scope === "global" ? <button class={globalEnabled ? "toggle-control on" : "toggle-control"} role="switch" aria-label={`Global default for ${skill.name}`} aria-checked={globalEnabled} type="button" onClick={() => void updateGlobal(skill.skillId, !globalEnabled)}><span /> Global default</button> : <div class="skill-select-field"><span>{profile.name}</span><MenuSelect placement="down" ariaLabel={`${profile.name} mode for ${skill.name}`} value={mode} options={[{ value: "inherit", label: "Inherit global" }, { value: "on", label: "Always on" }, { value: "off", label: "Always off" }]} onChange={(next) => void updateProfileSkill(skill.skillId, next as SkillMode)} /></div>}
              </div>
              {authored ? (
                <div class="skill-authoring">
                  <button class="small-button" type="button" onClick={() => setEditorTarget({ mode: "edit", source: skill })}>Edit</button>
                  <button class="small-button danger" type="button" disabled={referencing.length > 0} onClick={() => void removeSkill(skill)}>Remove</button>
                  {/* Disabled controls have no reliable tooltip, especially on touch. */}
                  {referencing.length > 0 ? <span class="skill-authoring-note">{referencing.join(", ")} set this skill explicitly. Return each to Inherit global first.</span> : null}
                </div>
              ) : null}
              <details class="skill-details"><summary>Instruction boundary</summary><footer><span>{skill.requiredTools.length ? `References ${skill.requiredTools.join(" · ")}` : "Instruction-only"}<br />Tools remain approval-gated.</span><code>{skill.digest.slice(-9)}</code></footer></details>
            </article>
          );
        })}
      </div>
      {status ? <p role="status" aria-live="polite">{status}</p> : null}
      <details class="callout compact-callout"><summary><Icon name="lock" /><strong>Conversation boundary</strong></summary><p>Changes affect future resolution only. Running conversations keep their pinned prompt and skill-set digests.</p></details>
    </section>
  );
}
