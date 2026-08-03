import { describe, expect, it } from "vitest";
import {
  FORK_RETRY_TOOLTIP,
  branchTitleFor,
  forkBranchNotice,
  forkContextClause,
  forkLibraryAnnouncement,
  type ForkContextCounts,
} from "./fork-notice";

const complete: ForkContextCounts = {
  contextMessageCount: 12,
  omittedContextMessages: 0,
  omittedContextImages: 0,
};

const bounded: ForkContextCounts = {
  contextMessageCount: 40,
  omittedContextMessages: 13,
  omittedContextImages: 2,
};

describe("the sentence a branch announces", () => {
  it("states the carried count and says nothing was omitted when nothing was", () => {
    const clause = forkContextClause(complete);
    expect(clause).toContain("12 ancestor messages");
    expect(clause).toContain("none omitted");
    // "0 omitted" makes the reader spot a zero to learn they have a complete
    // continuation. The two facts get two different words.
    expect(clause).not.toContain("0 omitted");
  });

  it("names both the carried count and everything the bound dropped", () => {
    const clause = forkContextClause(bounded);
    expect(clause).toContain("40 ancestor messages");
    expect(clause).toContain("13 earlier messages");
    expect(clause).toContain("2 images");
    expect(clause).toContain("not in this branch's context");
  });

  it("omits the image clause entirely when no image was dropped", () => {
    const clause = forkContextClause({ ...bounded, omittedContextImages: 0 });
    expect(clause).toContain("13 earlier messages");
    expect(clause).not.toContain("image");
  });

  it("agrees in number for a single carried, omitted or dropped item", () => {
    const clause = forkContextClause({
      contextMessageCount: 1,
      omittedContextMessages: 1,
      omittedContextImages: 1,
    });
    expect(clause).toContain("1 ancestor message;");
    expect(clause).toContain("1 earlier message and 1 image");
  });
});

describe("every branch kind carries the reach of its seed", () => {
  it("drops the completeness claim the bounded seed cannot back", () => {
    const notice = forkBranchNotice("fork-after-answer", bounded);
    expect(notice).not.toContain("audited context through this answer");
    expect(notice).toContain("40 ancestor messages");
    expect(notice).toContain("13 earlier messages");
  });

  it("states the counts on edit and retry branches too", () => {
    for (const kind of ["edit", "retry", "fork-before-prompt"] as const) {
      const notice = forkBranchNotice(kind, bounded);
      expect(notice, kind).toContain("40 ancestor messages");
      expect(notice, kind).toContain("13 earlier messages");
    }
  });

  /*
   * The pre-click sentence has to survive the click.
   *
   * Retry's tooltip is the only branch claim a reader gets *before* anything
   * exists, and it was a button-local literal saying "clean fork". The retry
   * path forks at the pre-turn boundary and seeds bounded ancestor context, so
   * the tooltip promised a blank slate that the very next sentence — the
   * post-fork notice, which names a carried ancestor count — contradicts.
   */
  it("promises the same seeded branch before the click that the notice reports after it", () => {
    expect(FORK_RETRY_TOOLTIP).not.toMatch(/clean fork|empty transcript|blank/iu);
    expect(FORK_RETRY_TOOLTIP).toContain("bounded, digest-sealed copy");
    expect(FORK_RETRY_TOOLTIP).toContain("up to just before this turn");
    // It may not quote a reach: the counts do not exist until the fork does,
    // and this module's whole point is refusing unbacked completeness claims.
    expect(FORK_RETRY_TOOLTIP).not.toMatch(/\d/u);
  });

  it("gives the library route the same clause it gives the composer", () => {
    const announcement = forkLibraryAnnouncement("Source · fork", bounded);
    expect(announcement).toContain("Source history was not rewritten.");
    expect(announcement).toContain(forkContextClause(bounded));
  });
});

/**
 * Measured: two Edit & branch operations on different turns of one conversation
 * both produced "Q1 about retrieval · edit", and one line of thought became
 * "Base question", "Base question · retry", "Base question · retry · retry",
 * "Base question · retry · retry · edit" — with the library column rendering
 * 119px of 353px, so the distinguishing suffix was exactly what was clipped.
 */
describe("what a branch is called", () => {
  it("names the turn it changed, so two branches of one conversation differ", () => {
    const first = branchTitleFor("edit", "Q1 about retrieval", "Q1 about retrieval");
    const second = branchTitleFor("edit", "Q3 about evaluation", "Q1 about retrieval");
    expect(first).toBe("Q1 about retrieval · edit");
    expect(second).toBe("Q3 about evaluation · edit");
    expect(first).not.toBe(second);
    // The distinguishing text leads, because the tail is what truncation eats.
    expect(second.startsWith("Q3")).toBe(true);
  });

  it("does not grow a word per operation", () => {
    const once = branchTitleFor("retry", undefined, "Base question");
    const twice = branchTitleFor("retry", undefined, once);
    const thrice = branchTitleFor("edit", undefined, twice);
    expect(once).toBe("Base question · retry");
    expect(twice).toBe("Base question · retry");
    expect(thrice).toBe("Base question · edit");
  });

  it("bounds a long prompt at a word boundary and stays inside the journal's cap", () => {
    const long = `${"retrieval quality ".repeat(20)}end`;
    const title = branchTitleFor("fork-after-answer", long, "Source");
    expect(title.endsWith("… · fork")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(240);
    expect(title).not.toContain("end");
  });

  it("falls back to the source name rather than producing an unnamed row", () => {
    expect(branchTitleFor("fork-before-prompt", "   ", "Source thread")).toBe("Source thread · fork");
    expect(branchTitleFor("fork-before-prompt", undefined, "   ")).toBe("Branch · fork");
  });
});
