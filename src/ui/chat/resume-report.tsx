import { Icon } from "../icons";
import { formatInstant } from "../instant-format";
import type { UnrecoveredWork } from "./return-ledger";
import "./resume-report.css";

/**
 * What Airship owes a person who comes back and finds their work gone.
 *
 * The Atlas's loudest verdict was that Airship reopens rather than resumes, and
 * the sharpest half of it was silence: "Cold reopen of the same browser
 * profile … composer notice = null, 'All conversations' reads '1 conversation'".
 * The return screen was byte-identical to a first-ever visit, so a person could
 * not distinguish "I am new here" from "I lost two days of work".
 *
 * The product knew. The journal that did not load, the posture that could not
 * hold it and the clock are all facts Airship had. This states them where the
 * person is standing, with the remedy attached — the Vault route's four-way
 * comparison is already good enough to carry the decision, it was simply only
 * ever reachable *after* the loss.
 *
 * Nothing here claims more than the ledger holds. There is no title, because
 * the ledger never stored one; the report says so rather than leaving the
 * absence to be read as Airship being coy about content it still has.
 */
export type ResumeReportProps = Readonly<{
  work: UnrecoveredWork;
  /** True once a Vault is adopted, which changes the remedy from "start" to "check". */
  durableAuthorityAdopted: boolean;
  onOpenVault: () => void;
  onDismiss: () => void;
}>;

export function ResumeReport({
  work,
  durableAuthorityAdopted,
  onOpenVault,
  onDismiss,
}: ResumeReportProps) {
  const conversations = `${work.conversations} conversation${work.conversations === 1 ? "" : "s"}`;
  const messages = `${work.messages} message${work.messages === 1 ? "" : "s"}`;
  return (
    <div class="resume-report" role="status">
      <Icon name="warning" size={16} />
      <div class="resume-report__body">
        <strong>{work.includesDurable ? "Work from your last visit is missing" : "Your last visit was not kept"}</strong>
        <p>
          {`${conversations} · ${messages} · last active ${formatInstant(work.lastActiveAt, "minute")}.`}
          {work.includesPageMemory
            ? " That work was held in page memory, which the browser releases when the page closes."
            : ""}
          {work.includesDurable
            ? " At least one of them was written to an encrypted Vault and is no longer in this journal — this browser's storage may have been cleared or evicted."
            : ""}
        </p>
        {/* The boundary, stated rather than implied. A count that appears from
            nowhere reads like Airship kept the conversation and is withholding
            it, which is a worse claim than the loss itself. */}
        <p class="resume-report__scope">Airship recorded only this count and time on this device. The conversations themselves were never written down.</p>
      </div>
      <div class="resume-report__actions">
        <button class="small-button" type="button" onClick={onOpenVault}>
          {durableAuthorityAdopted ? "Check the Vault" : "Keep future conversations"}
        </button>
        <button
          class="small-button"
          type="button"
          onClick={onDismiss}
          title="Removes this record. Airship holds no other copy of it."
          aria-label="Dismiss the report of work that was not kept"
        >Dismiss</button>
      </div>
    </div>
  );
}
