import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { describeAttestationSeal } from "../app";
import { durabilityLabel } from "../durability-indicator";
import { SEAL_LABELS } from "../seal";
import {
  SESSION_STATUS_SHORT_MAX,
  sessionStatusName,
  sessionStatusShort,
  worstSessionFact,
  type SessionStatusFact,
} from "./session-status-chip";

function fact(over: Partial<SessionStatusFact> & Pick<SessionStatusFact, "id" | "state">): SessionStatusFact {
  return Object.freeze({
    label: "Label",
    detail: "Detail.",
    short: "Short",
    ...over,
  });
}

describe("sessionStatusShort", () => {
  it("keeps the leading clause of a claim when it fits the chip", () => {
    expect(sessionStatusShort("E2EE · evidence recorded", "Asserted")).toBe("E2EE");
    expect(sessionStatusShort("Ephemeral · content not saved", "Not checked")).toBe("Ephemeral");
    expect(sessionStatusShort("Ready", "Ready")).toBe("Ready");
  });

  it("falls back to the state's own word rather than truncating a verdict", () => {
    // The exact string the topbar used to render as `Secure hardware not c…`.
    expect(sessionStatusShort("Secure hardware not checked", "Not checked")).toBe("Not checked");
    expect(sessionStatusShort("Turn in progress", "Working")).toBe("Working");
    expect(sessionStatusShort("Last turn cancelled", "Cancelled")).toBe("Cancelled");
  });

  it("never returns a string longer than the chip can render", () => {
    const claims = [
      "Secure hardware not checked · this session",
      "Evidence checked per turn",
      "Proof required next turn",
      "Encrypted state synced",
      "Connect a model",
    ];
    for (const claim of claims) {
      expect(sessionStatusShort(claim, "Not checked").length).toBeLessThanOrEqual(SESSION_STATUS_SHORT_MAX);
    }
  });

  it("falls back rather than returning an empty word for a claim that leads with a separator", () => {
    expect(sessionStatusShort(" · this session", "Not checked")).toBe("Not checked");
  });
});

describe("worstSessionFact", () => {
  const posture = fact({ id: "posture", state: "asserted" });
  const attestation = fact({ id: "attestation", state: "none" });
  const durability = fact({ id: "durability", state: "none" });

  it("ranks an alarming claim above everything, including a turn in flight", () => {
    const running = fact({ id: "lifecycle", state: "checking" });
    const failedDurability = fact({ id: "durability", state: "failed" });

    expect(worstSessionFact([posture, attestation, running, failedDurability])).toBe(failedDurability);
  });

  it("ranks a turn in flight above a resting posture, because it is the only fact still changing", () => {
    const running = fact({ id: "lifecycle", state: "checking" });

    expect(worstSessionFact([posture, attestation, durability, running])).toBe(running);
  });

  it("ranks the weaker of the two evidence claims, and never speaks for durability or lifecycle at rest", () => {
    const ready = fact({ id: "lifecycle", state: "none" });

    // `asserted` — evidence exists but was not independently verified — is the
    // weaker claim on the shared severity table, so the posture wins. The
    // durability and lifecycle rows are never candidates at rest: they are one
    // gesture away in the popover, which is where they belong.
    expect(worstSessionFact([posture, attestation, durability, ready])).toBe(posture);
  });

  it("breaks a tie toward attestation, the claim a user is least able to infer", () => {
    const tied = fact({ id: "posture", state: "none" });

    expect(worstSessionFact([tied, attestation])).toBe(attestation);
  });

  it("returns nothing for an empty set rather than inventing a verdict", () => {
    expect(worstSessionFact([])).toBeUndefined();
  });

  /*
   * The shipped consequence of taking a proof *policy* off the verdict ladder,
   * pinned here rather than discovered by the next audit.
   *
   * Before the fix the attestation fact arrived as `asserted` on a connected
   * session with zero turns, tied with the posture fact, and won the tie — so
   * the highest-traffic trust surface in the product rested on the word
   * "Asserted" at the exact moment it held no receipt, no evidence record and
   * nothing fetched. The attestation claim now arrives as `none`, so the chip
   * speaks for the posture instead: a provider-served E2EE endpoint key really
   * is a party's statement, which is a rung the code can stand on.
   *
   * The attestation claim is not lost — it is the second row of the popover,
   * verbatim, which the assertions below hold.
   */
  it("rests on the posture, not on an attestation policy, before the first turn", () => {
    const seal = describeAttestationSeal({
      connected: true,
      proofPolicy: "record",
      records: [],
      now: Date.parse("2026-07-19T12:00:00.000Z"),
    });
    const attestationFact = fact({
      id: "attestation",
      state: seal.state,
      label: `${seal.label} · this session`,
      detail: seal.detail,
      short: sessionStatusShort(seal.label, SEAL_LABELS[seal.state]),
    });
    const e2ee = fact({
      id: "posture",
      state: "asserted",
      label: "E2EE · no proof gate",
      short: sessionStatusShort("E2EE · no proof gate", SEAL_LABELS.asserted),
    });
    const ready = fact({ id: "lifecycle", state: "none", label: "Ready" });
    const facts = [e2ee, attestationFact, fact({ id: "durability", state: "none" }), ready];

    expect(worstSessionFact(facts)).toBe(e2ee);
    expect(worstSessionFact(facts)?.short).toBe("E2EE");
    expect(worstSessionFact(facts)?.short).not.toBe(SEAL_LABELS.asserted);
    // The policy sentence still renders in full, one gesture away.
    expect(attestationFact.label).toBe("Evidence checked per turn · this session");
    expect(attestationFact.detail).toContain("No turn receipt currently establishes a hardware claim.");
  });
});

describe("sessionStatusName", () => {
  /*
   * `e2e/responsive-breakpoints.spec.ts` reads
   * `/Session\. Ephemeral · this page only\./` on this control. The durability
   * clause leads for the same reason the sighted layout gives it a chip: it
   * decides whether closing the tab loses the conversation.
   */
  it("begins with the durability claim, so the shipped selector keeps matching", () => {
    const name = sessionStatusName(
      [fact({ id: "attestation", state: "none", label: "Secure hardware not checked · this session", detail: "No TEE evidence has been requested." })],
      "Ephemeral · this page only",
    );

    expect(name.startsWith("Session. Ephemeral · this page only.")).toBe(true);
    expect(name).toContain("Secure hardware not checked · this session");
    expect(name).toContain("No TEE evidence has been requested.");
  });

  it("does not read the durability claim twice when durability is also the weakest", () => {
    /*
     * Page memory is `attention` in the durability vocabulary, so it wins the
     * ranking on every un-vaulted cold open — and the leading clause and the
     * weakest-claim clause became the same sentence back to back: "Session.
     * Ephemeral · this page only. Ephemeral · this page only. This session
     * journal exists only in page memory." A screen-reader user cannot skim
     * past a repeat the way an eye can.
     */
    const name = sessionStatusName(
      [fact({
        id: "durability",
        state: "attention",
        label: "Ephemeral · this page only",
        detail: "This session journal exists only in page memory. Nothing is synced.",
      })],
      "Ephemeral · this page only",
    );

    expect(name.startsWith("Session. Ephemeral · this page only. This session journal")).toBe(true);
    expect(name.match(/Ephemeral · this page only/gu)).toHaveLength(1);
  });

  it("states how many claims the chip stands in front of", () => {
    const name = sessionStatusName(
      [fact({ id: "posture", state: "none" }), fact({ id: "attestation", state: "none" }), fact({ id: "durability", state: "none" })],
      "Ephemeral · this page only",
    );

    // The visible count renders "3 claims"; the accessible name says the same
    // noun. It used to say "facts", which is the eye/ear split this asserts is
    // gone.
    expect(name).toContain("3 claims.");
  });
});

/*
 * The two counted chips sit next to each other in one 40px row, and both used
 * to render a bare integer with the unit hidden in `title`/`aria-label`. Two
 * adjacent numbers of unstated kind — beside a model name — are not labelled
 * by a tooltip nobody on a touch screen can open. Asserted against the source
 * because there is no DOM in this suite; the visible-text form is what the
 * browser journey checks.
 */
const sessionBarSource = await readFile(new URL("./session-bar.tsx", import.meta.url), "utf8");
const statusChipSource = await readFile(new URL("./session-status-chip.tsx", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../chat.css", import.meta.url), "utf8");

describe("the counted chips state their own unit", () => {
  it("renders the journal count's unit as text beside the number", () => {
    expect(sessionBarSource).toContain('<span class="journal-chip__unit">{journal.eventCount === 1 ? "event" : "events"}</span>');
  });

  it("renders the claim count's unit as text beside the number", () => {
    expect(statusChipSource).toContain('<span class="session-status-chip__unit">{facts.length === 1 ? "claim" : "claims"}</span>');
  });

  it("clips the units with the other shed labels rather than dropping them from the markup", () => {
    const scrolled = chatStyles.match(/@media \(pointer: fine\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(scrolled).toContain('.chat-stage[data-scrolled="true"] .journal-chip__unit');
    expect(scrolled).toContain('.chat-stage[data-scrolled="true"] .session-status-chip__unit');
    // Clipped, not display:none — the words stay in the accessible name.
    expect(scrolled).toContain("clip-path: inset(50%)");
  });
});

/*
 * The two durability claims.
 *
 * "Ephemeral" printed twice on one screen because two components had access to
 * two different variables that happened to be empty at the same time: the
 * topbar axis answers "is a vault backend adopted in this tab", the session
 * chip answers "where does this conversation's journal live". They are pinned
 * apart here because the day a vault is adopted mid-session is exactly when a
 * reader needs to know which one changed.
 */
const app = await readFile(new URL("../app.tsx", import.meta.url), "utf8");

describe("the vault axis and the session durability claim", () => {
  it("names the tab-scoped vault axis for the adoption it measures", () => {
    expect(app).toContain('vaultSnapshot.phase === "degraded" ? "Vault blocked" : "No vault adopted"');
    expect(app).not.toMatch(/\?\s*"Ephemeral",?\n/u);
  });

  it("leaves the session's own durability claim untouched", () => {
    expect(durabilityLabel("ephemeral")).toBe("Ephemeral · content not saved");
    expect(app).toContain("durabilityLabel(sessionDurability.state)");
  });
});
