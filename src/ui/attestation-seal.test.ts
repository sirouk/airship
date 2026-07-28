import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  encryptedReceiptFixture as encryptedReceipt,
  endpointRecordFixture as endpointRecord,
} from "./attestation-seal.fixtures";
import { describeAttestationSeal } from "./app";
import { SEAL_LABELS } from "./seal";
import { sessionStatusShort } from "./chat/session-status-chip";
import { TURN_EVIDENCE_COPY } from "./turn-evidence";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

describe("session attestation seal", () => {
  /*
   * A proof policy is not a verdict.
   *
   * This case used to pin `asserted` on both arms, and its own title admitted
   * what they were: *policies*. Both are reached with no receipt, no evidence
   * record and no acquisition failure — the only inputs are "is a provider
   * connected" and "what should Airship do on the NEXT turn". A setting about
   * future turns is nobody's statement about this session, so the rung it can
   * stand on is absence. Every word of both labels and both sentences is
   * unchanged; only the rung moved, and it moved down.
   */
  it("keeps a proof policy off the verdict ladder, because a setting is not a claim", () => {
    expect(describeAttestationSeal({ connected: true, proofPolicy: "strict", records: [], now: NOW })).toEqual({
      state: "none",
      label: "Proof required next turn",
      detail: "The fail-closed endpoint-proof policy is armed, but no active turn receipt currently establishes a hardware claim.",
    });
    expect(describeAttestationSeal({ connected: true, proofPolicy: "record", records: [], now: NOW })).toEqual({
      state: "none",
      label: "Evidence checked per turn",
      // The strict arm always carried the emptiness clause; the record arm now
      // carries it too, so the grey glyph and the forward-tense label agree.
      detail: "Verify & record will collect fresh endpoint evidence on the next turn and keep every incomplete claim explicit without blocking encrypted inference. No turn receipt currently establishes a hardware claim.",
    });
  });

  /*
   * The mechanism, pinned separately from the state.
   *
   * `state` is not merely a DOM attribute here: the session bar shortens a
   * label longer than 14 characters by falling back to that state's own word,
   * so a wrong `state` becomes the *printed* resting verdict on the highest
   * traffic trust surface in the product. Both policy labels are longer than
   * the chip, so both of them go through that fallback.
   */
  it("never lets a policy print the word Asserted in the resting session chip", () => {
    for (const proofPolicy of ["record", "strict"] as const) {
      const seal = describeAttestationSeal({ connected: true, proofPolicy, records: [], now: NOW });
      expect(sessionStatusShort(seal.label, SEAL_LABELS[seal.state]), proofPolicy)
        .not.toBe(SEAL_LABELS.asserted);
      expect(sessionStatusShort(seal.label, SEAL_LABELS[seal.state]), proofPolicy)
        .toBe(SEAL_LABELS.none);
    }
  });

  it("states the disconnected fallback in plain language without inventing a provider", () => {
    const seal = describeAttestationSeal({ connected: false, records: [], now: NOW });
    expect(seal.state).toBe("none");
    expect(seal.label).toBe("Secure hardware not checked");
    // P11: the acronym is allowed in the expansion, never in the primary label.
    expect(seal.label).not.toContain("TEE");
    expect(seal.detail).toContain("TEE");
    // There is no demo provider in this product; the old copy asserted one.
    expect(seal.detail).not.toContain("Demo");
  });

  it("labels post-turn endpoint evidence as a separate local match without upgrading the receipt", () => {
    const receipt = encryptedReceipt();
    const seal = describeAttestationSeal({
      connected: true,
      receipt,
      records: [endpointRecord()],
      now: NOW,
    });

    expect(receipt.claims.endpointKey.status).toBe("unavailable");
    expect(receipt.claims.freshness.status).toBe("unavailable");
    expect(seal).toMatchObject({ state: "asserted", label: "Local key match" });
    expect(seal.detail).toContain("separate current endpoint record");
    expect(seal.detail).toContain("does not upgrade this immutable turn receipt");
  });

  it("does not infer a key match from subject correlation alone", () => {
    const record = endpointRecord();
    const seal = describeAttestationSeal({
      connected: true,
      receipt: encryptedReceipt(),
      records: [{
        ...record,
        claims: {
          ...record.claims,
          endpointKey: { ...record.claims.endpointKey, state: "unavailable" },
        },
      }],
      now: NOW,
    });

    expect(seal).toMatchObject({ state: "attention", label: "Separate evidence collected" });
    expect(seal.detail).toContain("did not establish both");
  });

  /*
   * The session band and the turn band used to be two functions with the same
   * five branches and different words for each, so one turn read "Evidence
   * unavailable" in the session bar and "Evidence not pulled" under its own
   * answer. They share one describer now; this is what stops them drifting
   * apart again.
   */
  it("speaks an acquisition failure in the canonical word, with the reason kept verbatim", () => {
    const seal = describeAttestationSeal({
      connected: true,
      records: [],
      failure: { label: "Evidence unavailable", code: "evidence-unavailable" } as never,
      now: NOW,
    });

    expect(seal.label).toBe(TURN_EVIDENCE_COPY["evidence-blocked"].chip);
    expect(seal.state).toBe(TURN_EVIDENCE_COPY["evidence-blocked"].seal);
    // The specific reason is not deleted by the canonical headline; it leads
    // the sentence, which is visible body text in the session status popover.
    expect(seal.detail).toContain("Evidence unavailable");
    expect(seal.detail).toContain("This provider/acquisition state is not a TEE verdict.");
  });

  it("keeps the one branch that genuinely differs by scope, and only that one", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

    // A live session has a *next* turn its policy can speak about; a settled
    // receipt does not. Every other branch is shared, so the two bands cannot
    // describe the same endpoint record in two vocabularies.
    expect(source).toContain('if (args.scope === "turn") {');
    expect(source.match(/args\.scope === "turn"/gu)?.length).toBe(1);
    expect(source).toContain('describeEndpointEvidence({ ...args, scope: "session" })');
    expect(source).toContain('describeEndpointEvidence({ scope: "turn", receipt, records, failure, now })');
  });
});
