import { describe, expect, it } from "vitest";
import type { JsonValue } from "./contracts";
import {
  sealContextSelection,
  verifyContextSelection,
  type CanonicalContextHit,
  type CanonicalContextSelection,
} from "./context-selection";
import { sha256, stableStringify } from "./hash";

const QUERY_DIGEST = "sha256:jjXCzTv2ZBvbDiBQt2kyy7LmA0oN2swdm-qCprpX988";
const GENERATION_DIGEST = "sha256:zQqphWFHtsW0_yt9_uXaIKo4JTCZ7xtKZKztIzya_ik";
const WORKSPACE_DIGEST = "sha256:UOch5JwBPwDGLPWfIWNUKp2N8CRk7-thXTEFGw_dwyY";

function selectionInput(hits: CanonicalContextHit[] = []) {
  return {
    version: 1 as const,
    queryDigest: QUERY_DIGEST,
    generationDigest: GENERATION_DIGEST,
    workspaceSnapshotDigest: WORKSPACE_DIGEST,
    selectedAt: "2026-08-20T00:00:00.000Z",
    maxHits: 8,
    maxBytes: 32_768,
    selectedBytes: hits.reduce(
      (bytes, hit) => bytes + new TextEncoder().encode(hit.text).byteLength,
      0,
    ),
    truncated: false,
    hits,
  };
}

async function contextHit(text: string, textDigest = ""): Promise<CanonicalContextHit> {
  return {
    path: "/workspace/context.txt",
    revision: "revision-1",
    contentDigest: await sha256("content"),
    chunkId: await sha256("chunk"),
    chunkIndex: 0,
    score: 1,
    text,
    textDigest: textDigest || await sha256(text),
  };
}

describe("context-selection snapshots", () => {
  it("preserves the existing selection commitment vector", async () => {
    const selection = await sealContextSelection(selectionInput());

    expect(selection.selectionDigest).toBe(
      "sha256:23SDEgHU79FwJSnMtu-Opqz9Jh13WpA8kI0DyaVY854",
    );
    expect(await verifyContextSelection(selection)).toBe(true);
  });

  it("materializes accessors once before sealing yields", async () => {
    const input = selectionInput();
    let reads = 0;
    Object.defineProperty(input, "hits", {
      enumerable: true,
      configurable: true,
      get(): CanonicalContextHit[] {
        reads += 1;
        if (reads > 1) throw new Error("sealing reread caller-owned hits");
        return [];
      },
    });

    const sealing = sealContextSelection(input);
    expect(reads).toBe(1);
    const selection = await sealing;

    expect(reads).toBe(1);
    expect(await verifyContextSelection(selection)).toBe(true);
  });

  it("captures sibling descriptors before an accessor can replace later authority", async () => {
    const safeHit = await contextHit("safe");
    const poisonedHit = await contextHit("poisoned");
    const input = selectionInput([safeHit]);
    let reads = 0;
    Object.defineProperty(input, "selectedAt", {
      enumerable: true,
      configurable: true,
      get(): string {
        reads += 1;
        input.hits = [poisonedHit];
        return "2026-08-20T00:00:00.000Z";
      },
    });

    const selection = await sealContextSelection(input);
    expect(reads).toBe(1);
    expect(selection.hits.map((hit) => hit.text)).toEqual(["safe"]);
    expect(await verifyContextSelection(selection)).toBe(true);
  });

  it.each([
    ["undefined", (input: Record<PropertyKey, unknown>) => { input.extra = undefined; }],
    ["a non-finite number", (input: Record<PropertyKey, unknown>) => { input.extra = Number.NaN; }],
    ["a symbol property", (input: Record<PropertyKey, unknown>) => { input[Symbol("hidden")] = "value"; }],
    ["a non-plain object", (input: Record<PropertyKey, unknown>) => { input.extra = new Date(0); }],
    ["a cycle", (input: Record<PropertyKey, unknown>) => { input.extra = input; }],
  ] as const)("rejects %s instead of hashing a non-JSON graph", async (_label, poison) => {
    const input = selectionInput() as unknown as Record<PropertyKey, unknown>;
    poison(input);
    await expect(sealContextSelection(
      input as unknown as Omit<CanonicalContextSelection, "selectionDigest">,
    )).rejects.toBeInstanceOf(TypeError);
  });

  it("seals an immediate deep snapshot and deeply freezes the result", async () => {
    const originalHit = await contextHit("good");
    const mutatedTextDigest = await sha256("evil");
    const input = selectionInput([originalHit]);
    const sealing = sealContextSelection(input);

    // Do not yield between invoking the seal and mutating the nested hit.
    (originalHit as { text: string }).text = "evil";
    (originalHit as { textDigest: string }).textDigest = mutatedTextDigest;
    const selection = await sealing;

    expect(selection.hits[0]?.text).toBe("good");
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.hits)).toBe(true);
    expect(Object.isFrozen(selection.hits[0])).toBe(true);
    expect(await verifyContextSelection(selection)).toBe(true);
  });

  it("materializes verification accessors once and never rereads the caller", async () => {
    const sealed = await sealContextSelection(selectionInput());
    const selection = { ...sealed };
    let reads = 0;
    Object.defineProperty(selection, "hits", {
      enumerable: true,
      configurable: true,
      get(): readonly CanonicalContextHit[] {
        reads += 1;
        if (reads > 1) throw new Error("verification reread caller-owned hits");
        return [];
      },
    });

    const verification = verifyContextSelection(selection as CanonicalContextSelection);
    expect(reads).toBe(1);

    expect(await verification).toBe(true);
    expect(reads).toBe(1);
  });

  it("checks the selection commitment and hit digests against one immediate snapshot", async () => {
    const expectedTextDigest = await sha256("good");
    const incoherentHit = await contextHit("evil", expectedTextDigest);
    const commitment = selectionInput([incoherentHit]);
    const selection: CanonicalContextSelection = {
      ...commitment,
      selectionDigest: await sha256(stableStringify(commitment as unknown as JsonValue)),
    };

    const verification = verifyContextSelection(selection);
    // Do not yield between invoking verification and mutating the nested hit.
    (incoherentHit as { text: string }).text = "good";

    expect(await verification).toBe(false);
  });
});
