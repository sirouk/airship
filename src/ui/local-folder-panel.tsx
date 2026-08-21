import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  LOCAL_FOLDER_MAX_ENTRIES,
  forgetLocalFolder,
  LOCAL_FOLDER_UNSUPPORTED_NOTICE,
  LocalFolderAccessError,
  localFolderAttachmentRecorded,
  localFolderPickerAvailable,
  openLocalFolder,
  reconnectLocalFolder,
  restoreLocalFolder,
  type LocalFolderRecord,
  type LocalFolderWorkspacePort,
} from "../workspace/local-folder";

/**
 * What the route knows about the folder right now.
 *
 * `blocked` is a first-class state rather than an error, because it is the
 * ordinary one: a browser drops a directory grant when the tab closes, so the
 * common case on a second visit is a remembered folder that cannot be read
 * until the person says so again.
 */
export type LocalFolderState =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "attached"; name: string; mountPath: string }>
  | Readonly<{ kind: "blocked"; name: string; record: LocalFolderRecord; reason: string }>;

/**
 * The tier, in the six rows the Vault route compares every destination with.
 *
 * Same questions, same order, same voice — a person deciding where their work
 * lives should be able to read this column against Local Device and Google
 * Drive without translating. It is stated here rather than in the Vault
 * selector because this is not a Vault backend: a folder cannot hold the
 * encrypted journal, the profile catalog or the session records, and offering
 * it as one would be a promise Airship could not keep.
 */
export const LOCAL_FOLDER_TIER = Object.freeze({
  title: "Folder on this device",
  description: "Your own folder, opened in place and never copied",
  note: "This device, this browser, revocable. Airship reads and writes the files where they already are — it copies the folder nowhere: not into the Vault, not into Airship's Git, not off this device. The folder is not added to the searchable index Airship can publish to your Vault, so ask for its files by path.",
  facts: Object.freeze({
    survives: "Yes · the files are already yours",
    offline: "Yes",
    reach: "No · this browser profile only",
    supply: "A folder, and permission each session",
    keep: "Everything — Airship keeps no copy",
    lose: "Revoking permission · moving the folder",
  }),
} as const);

export const LOCAL_FOLDER_FACT_ROWS: readonly (readonly [keyof typeof LOCAL_FOLDER_TIER.facts, string])[] = Object.freeze([
  ["survives", "Survives closing the tab"],
  ["offline", "Works offline"],
  ["reach", "Reaches other devices"],
  ["supply", "You supply"],
  ["keep", "You keep"],
  ["lose", "What can lose it"],
] as const);

/** What Airship does with an attached folder, in the words the route uses. */
export function localFolderAttachedSummary(name: string, mountPath: string): string {
  return `“${name}” is open at ${mountPath}. The Explorer, the editor, the terminal and the agent read and write it `
    + "through the permission you granted this browser. Every agent write still goes through approvals, exactly as a workspace write does.";
}

export const LOCAL_FOLDER_FORGET_NOTE =
  "Forgetting removes the folder from Airship and drops the stored permission. Nothing on your device is deleted or moved.";

/* The number is read from the bound it describes, so the two cannot drift. */
export const LOCAL_FOLDER_BOUNDS_NOTE =
  `Airship lists up to ${LOCAL_FOLDER_MAX_ENTRIES.toLocaleString("en-US")} files from a folder and skips its .git directory. `
  + "A larger folder is refused rather than shown in part — open a subfolder instead.";

/** The sentence a failed verb leaves on the panel. Never a code, never silence. */
export function localFolderFailureNotice(error: unknown): string {
  if (error instanceof LocalFolderAccessError) return error.message;
  return error instanceof Error
    ? `Airship could not complete that: ${error.message}`
    : "Airship could not complete that, and the browser gave no reason.";
}

export type LocalFolderPanelProps = Readonly<{
  /**
   * Publishes the folder to the shell, which rebinds the workspace authority
   * every consumer reads — Explorer, editor, terminal and the agent's tools.
   * `undefined` detaches it.
   */
  onFolderChanged(folder: LocalFolderWorkspacePort | undefined): void | Promise<void>;
}>;

/**
 * The Workspace route's storage-tier panel for a folder on this device.
 *
 * Every verb here runs inside the click that asked for it, because Chromium
 * shows the directory picker and the permission prompt only during a user
 * gesture. Restoring a remembered folder deliberately does not prompt: it
 * reports what the grant already is, and the person presses one button.
 */
export function LocalFolderPanel({ onFolderChanged }: LocalFolderPanelProps) {
  const [state, setState] = useState<LocalFolderState>(() =>
    localFolderPickerAvailable() ? { kind: "absent" } : { kind: "unsupported" });
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef<string>("");
  const headingId = useId();
  const noticeId = useId();

  useEffect(() => {
    if (!localFolderPickerAvailable() || !localFolderAttachmentRecorded()) return;
    let current = true;
    void (async () => {
      try {
        const restored = await restoreLocalFolder();
        if (!current) return;
        if (restored.state === "attached") {
          await restored.port.list();
          if (!current) return;
          setState({ kind: "attached", name: restored.record.name, mountPath: restored.record.mountPath });
          await onFolderChanged(restored.port);
        } else if (restored.state === "blocked") {
          setState({
            kind: "blocked",
            name: restored.record.name,
            record: restored.record,
            reason: restored.reason.message,
          });
        }
      } catch (error) {
        if (current) setNotice(localFolderFailureNotice(error));
      }
    })();
    return () => { current = false; };
  }, []);

  async function run(verb: () => Promise<void>): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      await verb();
    } catch (error) {
      setNotice(localFolderFailureNotice(error));
    } finally {
      setBusy(false);
    }
  }

  const attach = (port: LocalFolderWorkspacePort) => async () => {
    /*
     * List once before anything binds to it.
     *
     * A folder past the listing bound, or one whose grant died between the
     * pick and the first read, must be refused here — where the refusal is a
     * sentence beside the button that caused it. Bound later, the same failure
     * would surface as the whole Explorer refusing to draw, including the
     * workspace files that have nothing to do with the folder.
     */
    await port.list();
    setState({ kind: "attached", name: port.folderName, mountPath: port.mountPath });
    live.current = `${port.folderName} is open at ${port.mountPath}.`;
    await onFolderChanged(port);
  };

  if (state.kind === "unsupported") {
    return <section class="local-folder" aria-labelledby={headingId}>
      <h3 class="local-folder__title" id={headingId}>{LOCAL_FOLDER_TIER.title}</h3>
      <p class="local-folder__note">{LOCAL_FOLDER_UNSUPPORTED_NOTICE}</p>
    </section>;
  }

  return <section class="local-folder" aria-labelledby={headingId}>
    <h3 class="local-folder__title" id={headingId}>{LOCAL_FOLDER_TIER.title}</h3>
    <p class="local-folder__note">{LOCAL_FOLDER_TIER.note}</p>
    <p class="local-folder__status" role="status" aria-live="polite" id={noticeId}>
      {state.kind === "attached"
        ? localFolderAttachedSummary(state.name, state.mountPath)
        : state.kind === "blocked"
          ? state.reason
          : "No folder is open. Nothing on this device is readable by Airship until you open one."}
    </p>
    {notice ? <p class="local-folder__notice" role="alert">{notice}</p> : null}
    <div class="local-folder__actions">
      {state.kind === "absent" ? <button
        type="button"
        class="primary"
        disabled={busy}
        data-local-folder-open
        onClick={() => run(async () => {
          const port = await openLocalFolder();
          await attach(port)();
        })}
      >Open a folder…</button> : null}
      {state.kind === "blocked" ? <button
        type="button"
        class="primary"
        disabled={busy}
        data-local-folder-reconnect
        onClick={() => run(async () => {
          const port = await reconnectLocalFolder(state.record);
          await attach(port)();
        })}
      >Reconnect folder</button> : null}
      {state.kind === "attached" ? <button
        type="button"
        disabled={busy}
        data-local-folder-change
        onClick={() => run(async () => {
          const port = await openLocalFolder();
          await attach(port)();
        })}
      >Open a different folder…</button> : null}
      {state.kind === "absent" ? null : <button
        type="button"
        disabled={busy}
        data-local-folder-forget
        onClick={() => run(async () => {
          await forgetLocalFolder();
          setState({ kind: "absent" });
          live.current = "The folder was forgotten. Nothing on this device was changed.";
          await onFolderChanged(undefined);
        })}
      >Forget folder</button>}
    </div>
    <p class="local-folder__note">{state.kind === "absent" ? LOCAL_FOLDER_BOUNDS_NOTE : LOCAL_FOLDER_FORGET_NOTE}</p>
    <dl class="local-folder__facts">
      {LOCAL_FOLDER_FACT_ROWS.map(([key, label]) => <div class="local-folder__fact" key={key}>
        <dt>{label}</dt>
        <dd>{LOCAL_FOLDER_TIER.facts[key]}</dd>
      </div>)}
    </dl>
  </section>;
}
