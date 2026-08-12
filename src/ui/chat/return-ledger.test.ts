import { describe, expect, it } from "vitest";
import {
  EPHEMERAL_RETENTION_DISCLOSURE,
  RETURN_LEDGER_FIELDS,
  RETURN_LEDGER_KEY,
  forgetReturnLedgerEntries,
  readReturnLedger,
  reconcileReturnLedger,
  recordReturnLedgerEntry,
  summarizeUnrecoveredWork,
  type ReturnLedgerEntry,
} from "./return-ledger";

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const TUESDAY = "2026-07-28T18:45:00.000Z";

function entry(overrides: Partial<ReturnLedgerEntry> = {}): ReturnLedgerEntry {
  return Object.freeze({
    sessionId: "session-a",
    profileId: "general",
    messageCount: 4,
    lastActiveAt: TUESDAY,
    posture: "page-memory" as const,
    pageSession: "page-1",
    ...overrides,
  });
}

describe("the return ledger", () => {
  /*
   * Deliberate removal is not lost work.
   *
   * The ledger learns a conversation is gone by finding its entry absent from
   * the journal, and a conversation the person deleted is absent in exactly the
   * same way as one that was never durable. Before `deleteSelected` forgot the
   * entry, deleting a thread and coming back the next day was reported as loss:
   * a count, a timestamp, and an offer to set up a Vault to protect work that
   * had been thrown away on purpose.
   */
  it("does not mourn a conversation the person deleted in an earlier page session", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry({ sessionId: "deleted-on-purpose" }));
    recordReturnLedgerEntry(storage, entry({ sessionId: "genuinely-lost" }));

    // The deletion path forgets the entry at the moment of the decision, which
    // is the only moment anything knows it was a decision.
    forgetReturnLedgerEntries(storage, ["deleted-on-purpose"]);

    // A later visit: a different page session, and the journal produces neither.
    const reconciled = reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" });
    const work = summarizeUnrecoveredWork(reconciled);
    expect(work?.sessionIds).toEqual(["genuinely-lost"]);
    expect(work?.conversations).toBe(1);
  });

  /*
   * The measured defect: two turns on Tuesday, browser closed, browser
   * reopened, and the return screen was byte-identical to a first-ever visit
   * because `localStorage` held only `airship.display-preferences.v1`. The
   * ledger's whole job is to survive that gap with a count and a clock.
   */
  it("reports work from a previous page session that the journal no longer holds", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    const lost = reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" });
    expect(lost.map((item) => item.sessionId)).toEqual(["session-a"]);
    const summary = summarizeUnrecoveredWork(lost);
    expect(summary).toMatchObject({ conversations: 1, messages: 4, includesPageMemory: true, includesDurable: false });
  });

  /*
   * `first-run-truth.spec.ts` pins the browser half of this. A conversation
   * nobody has typed into never enters the ledger, so a first visit has nothing
   * to reconcile and nothing to claim.
   */
  it("never records a conversation that holds no turn", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry({ messageCount: 0 }));
    expect(readReturnLedger(storage)).toEqual([]);
    expect(reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" })).toEqual([]);
  });

  it("says nothing about a conversation the journal produced", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    expect(reconcileReturnLedger(storage, { present: new Set(["session-a"]), pageSession: "page-2" })).toEqual([]);
    // Still tracked: a Vault that is evicted next month is still news.
    expect(readReturnLedger(storage).map((item) => item.sessionId)).toEqual(["session-a"]);
  });

  /*
   * Adoption publishes the runtime before the journal, so a verdict can be
   * reached against a page-memory library a second before the Vault's arrives.
   * Re-testing a tombstone is the only thing that can withdraw a claim already
   * written down, and leaving one standing would be exactly the false-loss
   * notice this pass exists to remove.
   */
  it("withdraws a tombstone when a later journal produces the conversation", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    expect(reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" })).toHaveLength(1);
    expect(reconcileReturnLedger(storage, { present: new Set(["session-a"]), pageSession: "page-2" })).toEqual([]);
    expect(readReturnLedger(storage)[0]?.lost).toBeUndefined();
  });

  /*
   * A conversation that leaves the journal while its own page is open was
   * deleted by the person who is standing there. Mourning it on the next open
   * would be a loss claim about a deliberate act.
   */
  it("forgets a conversation that vanished inside the page that wrote it", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    expect(reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-1" })).toEqual([]);
    expect(readReturnLedger(storage)).toEqual([]);
  });

  it("keeps reporting until the person dismisses it", () => {
    /*
     * The shared entry() fixture dates itself 2026-07-28, past the ledger's
     * 14-day tombstone life once the calendar crosses 2026-08-11 — a lifecycle
     * assertion must not age into an expiry one. Fresh-timestamp the entry.
     */
    const fresh = new Date().toISOString();
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry({ lastActiveAt: fresh }));
    reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" });
    expect(reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-3" })).toHaveLength(1);
    forgetReturnLedgerEntries(storage, ["session-a"]);
    expect(reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-4" })).toEqual([]);
    expect(storage.values.get(RETURN_LEDGER_KEY)).toBeUndefined();
  });

  /*
   * A missing page-memory conversation and a missing Vault conversation are not
   * the same event, and the report says different things about them.
   */
  it("distinguishes the two durability postures in one summary", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry({ sessionId: "page-only", messageCount: 2 }));
    recordReturnLedgerEntry(storage, entry({
      sessionId: "vaulted",
      messageCount: 6,
      posture: "durable",
      lastActiveAt: "2026-07-29T09:00:00.000Z",
    }));
    const summary = summarizeUnrecoveredWork(
      reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" }),
    );
    expect(summary).toMatchObject({
      conversations: 2,
      messages: 8,
      includesDurable: true,
      includesPageMemory: true,
      lastActiveAt: "2026-07-29T09:00:00.000Z",
    });
  });

  /*
   * The boundary the Vault route's "What can lose it: Closing the page" depends
   * on. A ledger that quietly kept titles would make that sentence false in
   * order to report on it, so this pins the stored shape exactly.
   */
  it("holds only a count, a clock and a posture — never a word of the conversation", () => {
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    const written = storage.values.get(RETURN_LEDGER_KEY) ?? "";
    expect(Object.keys(JSON.parse(written)[0] as object).sort()).toEqual([
      "lastActiveAt", "messageCount", "pageSession", "posture", "profileId", "sessionId",
    ]);
  });

  /*
   * The same boundary, under the pressure that would actually break it.
   *
   * The shape assertion above passes on a well-formed entry, and the read path
   * drops undeclared fields — but `writeLedger` serialized the caller's own
   * object, so the guarantee held only for as long as every call site happened
   * to construct a clean literal. One future call passing the `SessionRecord`
   * it already has in hand would have put a conversation's title into
   * `localStorage` under a route that promises "released with the page", and
   * nothing in the suite would have noticed. This drives that case.
   */
  it("refuses to persist a field the ephemeral policy does not name", () => {
    const storage = memoryStorage();
    const contraband = {
      ...entry(),
      title: "My dog is named Biscuit and my flight is Tuesday.",
      preview: "Airship is running this turn entirely on your device",
      headDigest: "sha256:VUd6Uqu7",
      messages: ["Draft the Q3 pricing memo intro paragraph."],
    } as unknown as ReturnLedgerEntry;

    recordReturnLedgerEntry(storage, contraband);

    const written = storage.values.get(RETURN_LEDGER_KEY) ?? "";
    expect(Object.keys(JSON.parse(written)[0] as object).sort())
      .toEqual([...RETURN_LEDGER_FIELDS].filter((field) => field !== "lost").sort());
    for (const secret of ["Biscuit", "pricing memo", "entirely on your device", "VUd6Uqu7"]) {
      expect(written, secret).not.toContain(secret);
    }
    // Reconciliation rewrites every surviving row; a tombstone must not be the
    // hole the write gate just closed.
    reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" });
    expect(storage.values.get(RETURN_LEDGER_KEY) ?? "").not.toContain("Biscuit");
  });

  it("states the policy in words the routes can render, and names every field it keeps", () => {
    // The Vault route and the resume report both render this sentence, so the
    // claim a person reads at the moment of choosing cannot drift from the
    // module that implements it.
    expect(EPHEMERAL_RETENTION_DISCLOSURE).toContain("no title");
    expect(EPHEMERAL_RETENTION_DISCLOSURE).toContain("how many messages");
    expect(RETURN_LEDGER_FIELDS).toContain("messageCount");
    expect(RETURN_LEDGER_FIELDS).toContain("lastActiveAt");
    // Nothing content-shaped may enter the declared set without this failing.
    for (const field of RETURN_LEDGER_FIELDS) {
      expect(/title|preview|content|message$|digest|prompt|reply/iu.test(field), field).toBe(false);
    }
  });

  it("lets a tombstone expire rather than standing forever", () => {
    const stale = Date.parse(TUESDAY) + 15 * 24 * 60 * 60 * 1000;
    const storage = memoryStorage();
    recordReturnLedgerEntry(storage, entry());
    reconcileReturnLedger(storage, { present: new Set(), pageSession: "page-2" });
    expect(readReturnLedger(storage, stale)).toEqual([]);
  });

  it("survives storage that is absent, refusing or corrupt", () => {
    expect(readReturnLedger({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
      removeItem: () => undefined,
    })).toEqual([]);
    expect(readReturnLedger(memoryStorage({ [RETURN_LEDGER_KEY]: "not json" }))).toEqual([]);
    expect(readReturnLedger(memoryStorage({ [RETURN_LEDGER_KEY]: '[{"sessionId":1}]' }))).toEqual([]);
    // A refusing writer must not throw into the composer effect that called it.
    expect(() => recordReturnLedgerEntry({
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => undefined,
    }, entry())).not.toThrow();
  });
});
