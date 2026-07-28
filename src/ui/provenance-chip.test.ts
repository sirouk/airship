import { describe, expect, it } from "vitest";
import {
  PROVENANCE_TAIL,
  provenanceDigest,
  provenanceFact,
  provenanceInherited,
  provenanceLabel,
  provenanceNote,
  provenanceTail,
  type ProvenanceRow,
} from "./provenance-chip";

describe("provenance tails", () => {
  it("keeps the tail, because two digests can share a head", () => {
    const left = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaeA3WGuvU";
    const right = "sha256:aaaaaaaaaaaaaaaaaaaaaaaabH9mYq3w";
    expect(provenanceTail(left)).toBe("eA3WGuvU");
    expect(provenanceTail(right)).toBe("bH9mYq3w");
    expect(provenanceTail(left)).not.toBe(provenanceTail(right));
    expect(provenanceTail(left)).toHaveLength(PROVENANCE_TAIL);
  });

  it("returns a short value whole rather than padding or cutting it", () => {
    expect(provenanceTail("chunk-1")).toBe("chunk-1");
    expect(provenanceTail("  spaced  ")).toBe("spaced");
  });

  it("honours an explicit length", () => {
    expect(provenanceTail("abcdefghij", 4)).toBe("ghij");
  });
});

describe("provenance rows", () => {
  it("freezes every constructed row so a caller cannot mutate a rendered claim", () => {
    const rows: readonly ProvenanceRow[] = [
      provenanceFact("Path", "/workspace/readme.md"),
      provenanceDigest("Revision", "rev-0001"),
      provenanceInherited("Generation", "gen-0001", "this index generation"),
      provenanceNote("Never comparable across groups.", "caution"),
    ];
    for (const row of rows) expect(Object.isFrozen(row)).toBe(true);
  });

  it("distinguishes an inherited value from an asserted one", () => {
    const inherited = provenanceInherited("Generation", "gen-0001", "the Workspace & sources scope");
    expect(inherited.kind).toBe("inherited");
    // The dedup rule may not lose the value: "same as" has to be checkable.
    expect(inherited).toMatchObject({ value: "gen-0001", scope: "the Workspace & sources scope" });
  });
});

describe("provenance chip label", () => {
  it("states how much it is holding, so the affordance declares its own cost", () => {
    const label = provenanceLabel("this journal event", [
      provenanceNote("reverse-chronological lexical matches"),
      provenanceFact("Event type", "assistant.completed"),
      provenanceDigest("Event digest", "abcdefgh"),
    ]);
    expect(label).toBe("Provenance for this journal event. 2 recorded fields and 1 contract note.");
  });

  it("counts one field in the singular and omits an absent note clause", () => {
    expect(provenanceLabel("README.md", [provenanceFact("Path", "/workspace/README.md")]))
      .toBe("Provenance for README.md. 1 recorded field.");
  });

  it("pluralises several contract notes", () => {
    const label = provenanceLabel("Workspace & sources", [
      provenanceNote("hybrid score within this corpus only; never comparable across groups"),
      provenanceNote("2 duplicate chunks were suppressed."),
      provenanceDigest("Generation", "gen-0001"),
      provenanceDigest("Workspace snapshot", "snap-0001"),
    ]);
    expect(label).toBe("Provenance for Workspace & sources. 2 recorded fields and 2 contract notes.");
  });
});
