/**
 * The shell's verbs, as command-palette rows.
 *
 * Measured on the live shell: the palette answered "new conversation", "retry"
 * and "rename" with "No matching destination or command." while buttons of
 * exactly those names were on screen, so every action still cost menu
 * archaeology on the one surface a keyboard-first person reaches for first.
 *
 * It is a module of its own, fetched when the palette first opens, because the
 * entry chunk's first-paint budget does not move for feature work — the same
 * deferral `app.tsx` already applies to the approval dock and the resume
 * report. Nothing here paints before a person presses ⌘K.
 *
 * The host owns availability; this owns the words. A verb that cannot run right
 * now is listed with its reason rather than withheld: a person searching for
 * "retry" after a failed turn needs to be told why it is unavailable, not that
 * the word does not exist here.
 */
export type PaletteAction = Readonly<{
  id: string;
  label: string;
  description: string;
  keywords: readonly string[];
  /** Present when the verb cannot run; becomes the row's description. */
  reason?: string;
  run(): void;
}>;

export type ConversationVerbs = Readonly<{
  /** A sentence, or nothing when the verb can run. */
  newConversationBlocked?: string;
  renameBlocked?: string;
  retryBlocked?: string;
  editBranchBlocked?: string;
  forkBlocked?: string;
  onNewConversation(): void;
  onRename(): void;
  onRetry(): void;
  onEditBranch(): void;
  onFork(): void;
}>;

export function conversationPaletteActions(verbs: ConversationVerbs): readonly PaletteAction[] {
  return Object.freeze([
    action("new-conversation", "New conversation", "Start a fresh conversation in this profile",
      ["new", "conversation", "thread", "chat", "start"], verbs.newConversationBlocked, verbs.onNewConversation),
    action("rename-conversation", "Rename conversation", "Rename the conversation you are in",
      ["rename", "title", "name", "conversation"], verbs.renameBlocked, verbs.onRename),
    action("retry-turn", "Retry", "Branch before the last answer and ask it again",
      ["retry", "again", "regenerate", "answer"], verbs.retryBlocked, verbs.onRetry),
    action("edit-branch", "Edit & branch", "Reopen the last prompt on a new branch",
      ["edit", "branch", "fork", "prompt", "revise"], verbs.editBranchBlocked, verbs.onEditBranch),
    action("fork-here", "Fork from here", "Copy this conversation up to its last answer",
      ["fork", "branch", "copy", "duplicate"], verbs.forkBlocked, verbs.onFork),
  ]);
}

function action(
  id: string,
  label: string,
  description: string,
  keywords: readonly string[],
  reason: string | undefined,
  run: () => void,
): PaletteAction {
  return Object.freeze({ id, label, description, keywords: Object.freeze(keywords), ...(reason ? { reason } : {}), run });
}
