import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { durabilityLabel } from "../durability-indicator";
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
    expect(sessionStatusShort("Ephemeral · this page only", "Not checked")).toBe("Ephemeral");
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

  it("states how many claims the chip stands in front of", () => {
    const name = sessionStatusName(
      [fact({ id: "posture", state: "none" }), fact({ id: "attestation", state: "none" }), fact({ id: "durability", state: "none" })],
      "Ephemeral · this page only",
    );

    expect(name).toContain("3 facts.");
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
    expect(durabilityLabel("ephemeral")).toBe("Ephemeral · this page only");
    expect(app).toContain("durabilityLabel(sessionDurability.state)");
  });
});
