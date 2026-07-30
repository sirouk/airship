import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import { Popover } from "../popover";
import { SessionStatusChip, type SessionStatusFact } from "./session-status-chip";
import { TRANSCRIPT_INTRO_DEMO_LINE } from "./transcript-intro";

/**
 * One 40px row for everything that is true of this conversation.
 *
 * It replaces an 88px two-column header plus a 42px guidance band: 219px of
 * chrome above an empty conversation on a 900px viewport, 24.3%, which is the
 * measurement this package exists to answer. Nothing in it was deleted — the
 * eyebrow moved into the monogram's accessible name, the trust row moved into
 * the status chip's popover, and the guidance band moved into the transcript
 * intro and the composer's permanent description.
 *
 * The right cluster is ordered by how often it is *read*, not by how often it
 * is clicked, and the `+` sits at the end at every width: promoting it out of
 * its phone-only slot is what permanently removes the tablet collision between
 * the new-conversation button and the model card.
 */

export type SessionJournal = Readonly<{
  eventCount: number;
  sessionId?: string;
  /** Present only for a forked conversation; the fork's source keeps its own target. */
  lineage?: Readonly<{ sourceSessionId: string; onOpen(): void }>;
}>;

export type PinnedSessionSkills = Readonly<{
  skillSetDigest: string;
  skills: readonly Readonly<{ skillId: string; name: string; digest: string }>[];
}>;

export type SessionBarProps = Readonly<{
  title: string;
  profileName: string;
  monogram: string;
  /** The model chip. A slot: this package places it, the model package fills it. */
  model: ComponentChildren;
  /** The immutable skill set that composed this conversation's prompt. */
  pinnedSkills?: PinnedSessionSkills;
  statusFacts: readonly SessionStatusFact[];
  durabilityLabel: string;
  journal: SessionJournal;
  onOpenSession(): void;
  onRename(title: string): void | Promise<void>;
  renameDisabled?: boolean;
  onNewConversation(): void;
  newConversationDisabled: boolean;
}>;

export function SessionBar({
  title,
  profileName,
  monogram,
  model,
  pinnedSkills,
  statusFacts,
  durabilityLabel,
  journal,
  onOpenSession,
  onRename,
  renameDisabled = false,
  onNewConversation,
  newConversationDisabled,
}: SessionBarProps) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInFlight = useRef(false);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  function startRename() {
    if (renameDisabled) return;
    setRenaming(true);
  }

  function cancelRename() {
    if (renameInFlight.current) return;
    setRenaming(false);
  }

  async function commitRename() {
    if (renameInFlight.current) return;
    const normalized = renameInput.current?.value.trim() ?? "";
    if (!normalized) {
      renameInput.current?.reportValidity();
      return;
    }
    if (normalized === title) {
      setRenaming(false);
      return;
    }
    renameInFlight.current = true;
    try {
      await onRename(normalized);
      setRenaming(false);
    } catch {
      requestAnimationFrame(() => renameInput.current?.focus());
    } finally {
      renameInFlight.current = false;
    }
  }

  return (
    <div class="session-bar">
      {/* The H1 stays an H1 — it is the document's title — but a heading is not
          phrasing content, so the control is inside it rather than around it. */}
      <h1 class={renaming ? "session-bar__identity is-renaming" : "session-bar__identity"}>
        {renaming ? (
          <span class="session-bar__rename">
            <span class="profile-monogram" role="img" aria-label={`Active session · ${profileName} profile`}>{monogram}</span>
            <input
              ref={renameInput}
              defaultValue={title}
              maxlength={240}
              required
              aria-label="Conversation title"
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.isComposing) {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          </span>
        ) : (
          <button
            class="session-bar__identity-button"
            type="button"
            title={`${title} · Double-click to rename`}
            disabled={renameDisabled}
            onClick={(event) => { if (event.detail === 0) startRename(); }}
            onDblClick={startRename}
            onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); startRename(); } }}
          >
            {/* Carries the retired `ACTIVE SESSION · GENERAL` eyebrow. The words
                are not lost, they stopped being 15px of band for a fact that
                labels the screen the user is already looking at. */}
            <span class="profile-monogram" role="img" aria-label={`Active session · ${profileName} profile`}>{monogram}</span>
            <span class="session-bar__title">{title}</span>
          </button>
        )}
      </h1>
      <div class="session-bar__chips">
        {model}
        {pinnedSkills ? <PinnedSkillsChip pin={pinnedSkills} /> : null}
        <SessionStatusChip facts={statusFacts} durabilityLabel={durabilityLabel} />
        <JournalChip journal={journal} onOpenSession={onOpenSession} />
        <button
          class="session-bar__rename-action"
          type="button"
          aria-label="Rename conversation"
          title="Rename conversation"
          disabled={renameDisabled || renaming}
          onClick={startRename}
        >
          <Icon name="edit" size={16} />
        </button>
        <button
          class="session-bar__new"
          type="button"
          aria-label="New conversation"
          title="New conversation"
          disabled={newConversationDisabled}
          onClick={onNewConversation}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>
  );
}

export function pinnedSkillsLabel(count: number): string {
  return `${count} skill${count === 1 ? "" : "s"} pinned to this conversation`;
}

function PinnedSkillsChip({ pin }: Readonly<{ pin: PinnedSessionSkills }>) {
  const label = pinnedSkillsLabel(pin.skills.length);
  return (
    <Popover
      class="session-skills-popover"
      triggerClass="session-skills-chip"
      label={`${label}. Skill-set digest ${pin.skillSetDigest}.`}
      heading="Pinned conversation skills"
      trigger={<><Icon name="skills" size={14} /><span class="session-skills-chip__label">{pin.skills.length} skills</span></>}
    >
      <p>This immutable set composed the conversation prompt. Later Skill changes apply only to a new conversation.</p>
      {pin.skills.length ? <ul>{pin.skills.map((skill) => <li key={`${skill.skillId}:${skill.digest}`}><strong>{skill.name}</strong><code>{skill.digest.slice(-9)}</code></li>)}</ul> : <p>No Skill instructions were pinned.</p>}
      <code>{pin.skillSetDigest}</code>
    </Popover>
  );
}

/**
 * The model chip while no provider is connected.
 *
 * It states what is actually answering — a deterministic local demo — instead
 * of naming a model id (`airship/demo-v1`) that reads like a connection. The
 * sentence the guidance band used to shout at 42px is the popover's lead, and
 * the connect action travels with it, so the one thing a disconnected user must
 * do is one gesture from the fact that tells them to do it.
 */
export function DemoModelChip({ onConnect }: Readonly<{ onConnect(): void }>) {
  return (
    <Popover
      class="session-model-popover"
      triggerClass="session-model-chip session-model-chip--demo"
      label={`Session model. Demo · local. ${TRANSCRIPT_INTRO_DEMO_LINE}`}
      heading="Session model"
      trigger={<>
        <span class="session-model-chip__glyph" aria-hidden="true">⬡</span>
        <span class="session-model-chip__label">Demo · local</span>
      </>}
    >
      <p>{TRANSCRIPT_INTRO_DEMO_LINE}</p>
      <p>Local slash commands, the workspace, the editor, the terminal and browser-owned Git do not need one.</p>
      <button class="popover__action" type="button" onClick={onConnect}>
        Connect a model<span aria-hidden="true"> →</span>
      </button>
    </Popover>
  );
}

function JournalChip({ journal, onOpenSession }: Readonly<{ journal: SessionJournal; onOpenSession(): void }>) {
  const shortId = journal.sessionId ? journal.sessionId.slice(0, 8) : "starting";
  const steps = `${String(journal.eventCount)} recorded step${journal.eventCount === 1 ? "" : "s"}`;
  return (
    <span class="journal-chip">
      {journal.lineage ? (
        <button
          class="journal-chip__branch"
          type="button"
          title={`Open source conversation ${journal.lineage.sourceSessionId}`}
          // `Branch from #xxxxxxxx` is the shipped accessible name of the
          // link this chip replaces, and it is a live e2e selector. The
          // glyph is what shrank; the name did not.
          aria-label={`Branch from #${journal.lineage.sourceSessionId.slice(0, 8)}. Open the source conversation.`}
          onClick={journal.lineage.onOpen}
        >
          <Icon name="branch" size={13} />
        </button>
      ) : null}
      <button
        class="journal-chip__record"
        type="button"
        // P11: the number leads, the plain-language count is the accessible
        // name, and `page-journal event` — the internal record name — stays on
        // hover. The count is no longer a fact that lives only in a tooltip.
        title={`${String(journal.eventCount)} page-journal event${journal.eventCount === 1 ? "" : "s"}`}
        aria-label={`${steps} in conversation #${shortId}. Open conversation details.`}
        onClick={onOpenSession}
      >
        <span class="journal-chip__glyph" aria-hidden="true">⌗</span>
        {/* The unit is rendered text, not an attribute. A bare integer beside
            the model chip's own bare integer is two numbers of unstated kind;
            a glyph plus a tooltip is not a label for the one number a reader
            is asked to compare with the one next to it. It is clipped with the
            short id at scrolled widths, so it costs nothing at rest. */}
        <span class="journal-chip__count">
          {journal.eventCount}{" "}
          <span class="journal-chip__unit">{journal.eventCount === 1 ? "event" : "events"}</span>
        </span>
        <small class="journal-chip__id">#{shortId}</small>
      </button>
    </span>
  );
}
