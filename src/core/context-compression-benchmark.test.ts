import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages } from "./agent";
import type { CanonicalMessage, JsonValue } from "./contracts";
import { planContextCompression } from "./context-compressor";
import { sha256, stableStringify } from "./hash";
import { EventJournal, type DurableEvent } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

/**
 * Measures what this repository's compression path actually achieves. It
 * publishes no number it did not measure: the reduction printed here is the
 * deterministic extractive summarizer's, on this corpus, at this window — not a
 * universal claim.
 *
 * The corpus is pinned in this file rather than read from live repository files.
 * A corpus built from live sources changes whenever any of those files is
 * edited, so the published digest stops reproducing and the published table
 * silently starts describing a corpus nobody measured. Pinned units make the
 * digest a real anchor: it can only move when this fixture moves, and then the
 * table must be re-measured in the same commit.
 */
const WINDOW_TOKENS = 8_192;
const TURNS_PER_FAMILY = 12;

type Family = Readonly<{ name: string; units: readonly string[]; excerptCharacters: number }>;

/** `{i}` is substituted with the repetition index so no unit is byte-identical. */
const CODE_UNIT = `export async function planStep{i}(args: Readonly<{ events: readonly DurableEvent[]; budget: number }>): Promise<StepPlan | undefined> {
  // The budget is pinned by the session manifest, because a step that re-reads a
  // mutable catalogue could widen its own bound while replaying an old session.
  const bounded = Math.min(args.budget, MAX_STEP_BYTES);
  if (!Number.isSafeInteger(bounded) || bounded <= 0) throw new Error("Step {i} budget is invalid.");
  const covered = args.events.filter((event) => event.sequence > lastCovered{i} && event.type === "turn.completed");
  if (covered.length <= PRESERVE_RECENT_TURNS) return undefined;
  const digest = await sha256(stableStringify({ step: {i}, covered: covered.map((event) => event.digest) }));
  return Object.freeze({ step: {i}, coveredThrough: covered.at(-1)!.sequence, bounded, digest });
}`;

const DOC_UNIT = `### Boundary {i}

Airship pins boundary {i} in the session manifest when the session is created and
never re-reads a mutable source while replaying an old conversation. The bound is
enforced at the type level, so a caller cannot widen it by passing a larger
number; an out-of-range value fails closed and the turn is refused with a
specific message rather than silently degraded. Replay re-derives the digest for
boundary {i} from the journal and rejects any commitment whose recorded digest
does not match, because a commitment that cannot be re-derived is evidence of
nothing at all.`;

const JSON_UNIT = `{"tool":"read_file","call":"call-{i}","result":{"path":"src/module-{i}.ts","bytes":{i}84,"revision":"rev-{i}","digest":"sha256:pinned-fixture-digest-{i}","truncated":false,"metadata":{"encoding":"utf-8","lineCount":{i}2,"lastModified":"2026-07-22T00:00:00.000Z"}}}`;

const FAMILIES: readonly Family[] = Object.freeze([
  Object.freeze({
    name: "code-editing",
    units: Object.freeze([CODE_UNIT]),
    excerptCharacters: 3_000,
  }),
  Object.freeze({
    name: "doc-qa",
    units: Object.freeze([DOC_UNIT]),
    excerptCharacters: 3_000,
  }),
  Object.freeze({
    name: "tool-output-json",
    units: Object.freeze([JSON_UNIT]),
    excerptCharacters: 2_000,
  }),
]);

/** Deterministic, bounded expansion of a pinned unit to the family excerpt size. */
function excerpt(unit: string, characters: number, offset: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let index = 0; size < characters && index < 512; index += 1) {
    const part = unit.replaceAll("{i}", String(offset * 512 + index));
    parts.push(part);
    size += part.length + 1;
  }
  return parts.join("\n").slice(0, characters);
}

function familyExcerpts(family: Family): readonly string[] {
  // Four distinct excerpts per family so consecutive turns are not identical
  // text, which would make the summarizer's job unrealistically easy.
  return Object.freeze(Array.from({ length: 4 }, (_, offset) =>
    excerpt(family.units[offset % family.units.length]!, family.excerptCharacters, offset)));
}

describe("context compression benchmark", () => {
  it("reduces the projected prompt on a pinned, reproducible corpus", async () => {
    const measured: Record<string, number> = {};
    for (const family of FAMILIES) {
      const result = await replayFamily(family);
      expect(result.compressions).toBeGreaterThan(0);
      measured[family.name] = result.reduction;
      // Regression floor only. The published figure is whatever this prints.
      expect(result.reduction).toBeGreaterThan(0.2);
      expect(result.reduction).toBeLessThan(1);
    }
    // The digest tells a reader whether a published number still describes the
    // corpus that was measured.
    // eslint-disable-next-line no-console
    console.log("context compression, deterministic extractive summarizer,", JSON.stringify({
      corpusDigest: await corpusDigest(),
      windowTokens: WINDOW_TOKENS,
      turnsPerFamily: TURNS_PER_FAMILY,
      promptByteReduction: Object.fromEntries(
        Object.entries(measured).map(([name, value]) => [name, `${(value * 100).toFixed(1)}%`]),
      ),
    }));
  });

  it("keeps every summarized turn reachable through the projection", async () => {
    const result = await replayFamily(FAMILIES[0]!);
    // Compression substitutes a reference chain; it never deletes journal history.
    expect(result.journalTurns).toBe(TURNS_PER_FAMILY);
    expect(result.compressedMessages[0]?.content).toContain("iterative conversation summary");
    expect(result.compressedMessages.length).toBeLessThan(result.fullMessages.length);
  });
});

async function replayFamily(family: Family) {
  const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
  const manifest = await createSessionManifest({
    systemPrompt: "Benchmark session.", providerId: "bench", model: "bench", tools: [],
    workspaceId: `memory://bench-${family.name}`, now: "2026-07-22T00:00:00.000Z",
  });
  const session = await journal.createSession(family.name, manifest);
  const excerpts = familyExcerpts(family);
  let compressions = 0;

  for (let turn = 0; turn < TURNS_PER_FAMILY; turn += 1) {
    const excerpt = excerpts[turn % excerpts.length]!;
    await journal.append(session.id, [
      { type: "turn.requested", turnId: `turn-${turn}`, payload: { content: `Review this excerpt:\n${excerpt}` } },
      {
        type: "assistant.completed",
        turnId: `turn-${turn}`,
        operationId: `op-${turn}`,
        payload: {
          message: { role: "assistant", content: `Reviewed excerpt ${turn}. ${excerpt.slice(0, 600)}` },
          finishReason: "stop",
        },
      },
      { type: "turn.completed", turnId: `turn-${turn}`, payload: { responseDigest: `sha-${turn}`, receiptId: null } },
    ]);
    const events = await journal.readEvents(session.id);
    const summary = await planContextCompression({
      events,
      messages: materializeMessages(events, { injectLatestContext: false }),
      projectedUserContent: `Review this excerpt:\n${excerpts[(turn + 1) % excerpts.length]!}`,
      systemPrompt: manifest.systemPrompt,
      tools: [],
      options: { contextWindowTokens: WINDOW_TOKENS, threshold: 0.8, preserveRecentTurns: 2 },
    });
    if (summary) {
      compressions += 1;
      await journal.append(session.id, [{ type: "context.summary.updated", payload: summary as never }]);
    }
  }

  const events = await journal.readEvents(session.id);
  const compressedMessages = materializeMessages(events, { injectLatestContext: false });
  const fullMessages = materializeMessages(
    events.filter((event) => event.type !== "context.summary.updated") as DurableEvent[],
    { injectLatestContext: false },
  );
  const compressedBytes = promptBytes(manifest.systemPrompt, compressedMessages);
  const fullBytes = promptBytes(manifest.systemPrompt, fullMessages);
  return {
    compressions,
    compressedMessages,
    fullMessages,
    journalTurns: events.filter((event) => event.type === "turn.completed").length,
    reduction: 1 - compressedBytes / fullBytes,
  };
}

async function corpusDigest(): Promise<string> {
  return sha256(FAMILIES.map((family) => familyExcerpts(family).join("\u0000")).join("\u0000"));
}

function promptBytes(systemPrompt: string, messages: readonly CanonicalMessage[]): number {
  return new TextEncoder().encode(stableStringify({
    systemPrompt,
    messages,
    tools: [],
  } as unknown as JsonValue)).byteLength;
}
