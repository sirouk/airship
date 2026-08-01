import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import { MenuSelect } from "../menu-select";
import { Popover } from "../popover";
import { RENAME_START_HINT, renameEditorKeyHandler, renameStartKeyHandler } from "../rename-interaction";
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

/**
 * A conversation the switcher can move to. The rail's row shape, minus the
 * gestures only a rail row has.
 */
export type SwitchableConversation = Readonly<{
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  open(): void;
}>;

/** Sentinel option value; no session id can collide with it. */
export const SESSION_SWITCH_ALL = "airship:all-conversations";

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
  /** The profile's recent threads, newest first. Empty is a valid state. */
  conversations: readonly SwitchableConversation[];
  activeConversationId: string;
  formatTime(value: string): string;
  onOpenAllConversations(): void;
  /**
   * Bumped by the shell to start the rename editor from somewhere else — the
   * command palette's "Rename conversation" row. A counter rather than a flag
   * so the same request can be made twice.
   */
  renameRequest?: number;
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
  conversations,
  activeConversationId,
  formatTime,
  onOpenAllConversations,
  renameRequest = 0,
}: SessionBarProps) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameInFlight = useRef(false);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (renameRequest > 0 && !renameDisabled) setRenaming(true);
  }, [renameRequest]);

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
              onKeyDown={renameEditorKeyHandler({ commit: () => void commitRename(), cancel: cancelRename })}
            />
          </span>
        ) : (
          <button
            class="session-bar__identity-button"
            type="button"
            // The tooltip named the mouse gesture and not the key, so F2 was a
            // shortcut only its author knew about — and it is the only rename
            // start a keyboard user has here.
            title={`${title} · ${RENAME_START_HINT}`}
            disabled={renameDisabled}
            onClick={(event) => { if (event.detail === 0) startRename(); }}
            onDblClick={startRename}
            onKeyDown={renameStartKeyHandler(startRename)}
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
        {/*
          * Instruments scroll; actions do not.
          *
          * The cluster absorbs surplus width by scrolling inside itself, which
          * is right for the four status chips — they are readings, and a
          * reading you have to scroll to is still a reading. It is wrong for
          * Rename and New conversation, which are the bar's two verbs: measured
          * at 390px, `+` scrolled out of sight, and at 320px so did Rename. A
          * verb that scrolls away is a verb nobody finds.
          *
          * Splitting them lets the title keep its floor, the chips keep their
          * exact sizes, and the two actions stay pinned to the right edge at
          * every width — the three constraints this row has to satisfy at once.
          */}
        <div class="session-bar__instruments">
          {model}
          {pinnedSkills ? <PinnedSkillsChip pin={pinnedSkills} /> : null}
          <SessionStatusChip facts={statusFacts} durabilityLabel={durabilityLabel} />
          <JournalChip journal={journal} durabilityLabel={durabilityLabel} onOpenSession={onOpenSession} />
        </div>
        {/*
          * The conversation switcher, in the primary chrome at every width.
          *
          * On a phone the profile's conversation list existed only behind
          * More → "All conversations", and the bar's own H1 rendered 85px of a
          * 557px title — measured at hour eight of a session named after its
          * first message, so a person could neither read which conversation
          * they were in nor reach another one from the surface they were
          * working on. Both facts are one tap from here: the list carries every
          * title in full, and the current one is the checked row.
          *
          * It sits with Rename and `+` outside the instrument strip because it
          * is a verb, and the strip scrolls.
          */}
        <MenuSelect
          className="session-bar__switch"
          ariaLabel="Switch conversation"
          compact
          placement="down"
          value={activeConversationId}
          disabled={conversations.length === 0}
          options={[
            ...conversations.map((conversation) => ({
              value: conversation.id,
              label: conversation.title,
              description: `${conversation.preview} · ${formatTime(conversation.updatedAt)}`,
            })),
            { value: SESSION_SWITCH_ALL, label: "All conversations", description: "Search, filter and inspect every conversation" },
          ]}
          leading={() => <Icon name="chat" size={15} />}
          onChange={(value) => {
            if (value === SESSION_SWITCH_ALL) { onOpenAllConversations(); return; }
            conversations.find((conversation) => conversation.id === value)?.open();
          }}
        />
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
        {/* The word survives the shed; the qualifier does not. Measured at
            390×844 the whole label was clipped, so the only two chips carrying
            "you are talking to a demo" were both bare glyphs — and once the
            empty state scrolled away nothing visible on the phone said it at
            all. Four characters is what that fact costs. */}
        <span class="session-model-chip__label">Demo<span class="session-model-chip__qualifier"> · local</span></span>
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

function JournalChip({ journal, durabilityLabel, onOpenSession }: Readonly<{
  journal: SessionJournal;
  /** The active posture, so the count cannot out-claim the store holding it. */
  durabilityLabel: string;
  onOpenSession(): void;
}>) {
  const shortId = journal.sessionId ? journal.sessionId.slice(0, 8) : "starting";
  /*
   * The count says where it is kept.
   *
   * Measured after 180 turns: the chip read "⌗ 1079", its accessible name read
   * "1079 recorded steps in conversation #5b583f0d", and
   * `navigator.storage.estimate().usage` was byte-identical before turn 1 and
   * after turn 180 — nothing had been written to disk at all. "Recorded" and a
   * chained-looking counter is a durability claim, and this was the one place
   * in the product making it without the posture attached.
   */
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
        title={`${String(journal.eventCount)} page-journal event${journal.eventCount === 1 ? "" : "s"} · ${durabilityLabel}`}
        aria-label={`${steps} in conversation #${shortId}, held as ${durabilityLabel}. Open conversation details.`}
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
