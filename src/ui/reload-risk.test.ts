import { beforeEach, describe, expect, it } from "vitest";
import { publishReloadRisk, readReloadRisk, reloadWouldDiscardWork, resetReloadRisk } from "./reload-risk";

/**
 * The fence that decides whether the service-worker takeover may reload.
 *
 * The previous fence asked only whether a trusted input gesture had been seen,
 * and a conversation exists before anyone types. Measured on a fresh context —
 * a real first visit — the takeover reload landed during the Vault hand-off and
 * took the page-memory conversation with it.
 */
describe("reloadWouldDiscardWork", () => {
  it("lets a first-paint page reload, because there is nothing to lose", () => {
    expect(reloadWouldDiscardWork({ durableAuthority: false, recordedTurns: 0, unsentDraft: false })).toBe(false);
  });

  it("refuses once a page-memory conversation has anything in it", () => {
    // The case that was measured losing work: a turn had been recorded and the
    // journal was still page memory, so the reload was unrecoverable.
    expect(reloadWouldDiscardWork({ durableAuthority: false, recordedTurns: 1, unsentDraft: false })).toBe(true);
  });

  it("refuses for an unsent draft alone", () => {
    // A half-typed sentence is the person's, and page memory does not keep it
    // across a document the shell replaced on its own initiative.
    expect(reloadWouldDiscardWork({ durableAuthority: false, recordedTurns: 0, unsentDraft: true })).toBe(true);
  });

  it("allows the reload under a durable authority however much has been said", () => {
    // The point of adopting a Vault is that the journal is readable on the far
    // side, so the reload costs a repaint. Refusing here would strand the page
    // on an old worker forever for no gain.
    expect(reloadWouldDiscardWork({ durableAuthority: true, recordedTurns: 40, unsentDraft: true })).toBe(false);
  });
});

describe("the published risk", () => {
  beforeEach(resetReloadRisk);

  it("reads as nothing-at-risk before the shell has published anything", () => {
    expect(reloadWouldDiscardWork(readReloadRisk())).toBe(false);
  });

  it("carries the shell's latest reading to the listener that has to choose", () => {
    publishReloadRisk({ durableAuthority: false, recordedTurns: 2, unsentDraft: false });
    expect(reloadWouldDiscardWork(readReloadRisk())).toBe(true);
    // And withdraws it: adopting a Vault makes the same page safe to reload.
    publishReloadRisk({ durableAuthority: true, recordedTurns: 2, unsentDraft: false });
    expect(reloadWouldDiscardWork(readReloadRisk())).toBe(false);
  });

  it("is frozen, so a caller cannot mutate the shell's reading in place", () => {
    publishReloadRisk({ durableAuthority: false, recordedTurns: 1, unsentDraft: false });
    expect(Object.isFrozen(readReloadRisk())).toBe(true);
  });
});
