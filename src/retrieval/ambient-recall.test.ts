import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { excerptsFromEvent, refreshRecallIndex, selectRecalledLines } from "./ambient-recall";
import {
  RECALL_DOCUMENT_BYTES,
  RECALL_EXCERPT_CHARACTERS,
  RECALL_PATH,
  RECALL_TURN_BYTES,
  boundRecallDocument,
  emptyRecallDocument,
  parseRecallDocument,
  serializeRecallDocument,
  type RecallExcerpt,
} from "./recall-document";

const encoder = new TextEncoder();

async function profileBinding(profileId: string) {
  const digest = await sha256(profileId);
  return {
    version: 2 as const,
    profileId,
    profileRevision: digest,
    themeId: "plain",
    themeDigest: digest,
    resolvedSkills: [],
    skillSetDigest: digest,
    resolutionDigest: digest,
    workspaceBinding: { kind: "active-workspace" as const },
    memoryScope: "profile" as const,
    approvalMode: "ask-first" as const,
  };
}

async function conversation(journal: EventJournal, title: string, profileId: string, said: readonly string[]) {
  const manifest = await createSessionManifest({
    systemPrompt: "Be useful.", providerId: "test", model: "test", tools: [],
    workspaceId: "memory://ambient", profile: await profileBinding(profileId),
  });
  const session = await journal.createSession(title, manifest);
  for (const content of said) {
    await journal.append(session.id, [{ type: "turn.requested", turnId: `turn-${content.length}`, payload: { content } }]);
  }
  return session;
}

describe("ambient recall index", () => {
  it("distils what was said into verbatim excerpts carrying their conversation and turn", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const drinks = await conversation(journal, "Drinks", "general", ["I like unicorn milk and I want it to be blue"]);
    await journal.append(drinks.id, [{
      type: "assistant.completed",
      turnId: "turn-1",
      payload: { message: { role: "assistant", content: "Blue it is." }, finishReason: "stop" },
    }]);

    const state = await refreshRecallIndex(workspace, journal, "general");

    expect(state.document.excerpts.map((excerpt) => excerpt.text)).toEqual([
      "I like unicorn milk and I want it to be blue",
      "Blue it is.",
    ]);
    expect(state.document.excerpts.map((excerpt) => excerpt.who)).toEqual(["you", "the agent"]);
    expect(state.document.excerpts.every((excerpt) => excerpt.sessionId === drinks.id)).toBe(true);
    expect(state.document.excerpts.every((excerpt) => excerpt.title === "Drinks")).toBe(true);
    expect(state.document.excerpts.every((excerpt) => excerpt.sequence > 0)).toBe(true);
    // The document is an ordinary workspace object, so it inherits whatever
    // port the Profile is bound to — page memory here, encrypted in a Vault.
    const file = await workspace.read(RECALL_PATH);
    expect(parseRecallDocument(file?.content).excerpts).toEqual(state.document.excerpts);
  });

  it("never indexes a conversation belonging to another profile", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    await conversation(journal, "Theirs", "other-profile", ["I like unicorn milk and I want it to be blue"]);
    await conversation(journal, "Mine", "general", ["hello"]);

    const state = await refreshRecallIndex(workspace, journal, "general");

    expect(state.document.excerpts.map((excerpt) => excerpt.text)).toEqual(["hello"]);
    expect(JSON.stringify(state.document)).not.toContain("unicorn");
  });

  it("reads a conversation once: a head that has not moved is not re-read", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await conversation(journal, "Drinks", "general", ["blue unicorn milk"]);
    await refreshRecallIndex(workspace, journal, "general");

    let reads = 0;
    const readEvents = journal.readEvents.bind(journal);
    journal.readEvents = async (...args: Parameters<typeof readEvents>) => { reads += 1; return readEvents(...args); };
    const unchanged = await refreshRecallIndex(workspace, journal, "general");
    expect(reads).toBe(0);
    expect(unchanged.document.excerpts).toHaveLength(1);

    await journal.append(session.id, [{ type: "turn.requested", turnId: "t2", payload: { content: "and cake" } }]);
    const grown = await refreshRecallIndex(workspace, journal, "general");
    expect(reads).toBe(1);
    expect(grown.document.excerpts.map((excerpt) => excerpt.text)).toEqual(["blue unicorn milk", "and cake"]);
  });

  it("forgets a deleted conversation in the same pass", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await conversation(journal, "Drinks", "general", ["blue unicorn milk"]);
    await refreshRecallIndex(workspace, journal, "general");
    const head = await journal.getSession(session.id);
    await journal.deleteSession(session.id, { sequence: head!.headSequence, digest: head!.headDigest });

    const state = await refreshRecallIndex(workspace, journal, "general");

    expect(state.document.excerpts).toEqual([]);
    expect(state.document.cursors).toEqual({});
  });

  it("indexes nothing while the switch is off, and writes nothing", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    await conversation(journal, "Drinks", "general", ["blue unicorn milk"]);
    const off = await workspace.write(RECALL_PATH, serializeRecallDocument(emptyRecallDocument(false)));

    const state = await refreshRecallIndex(workspace, journal, "general");

    expect(state.document.excerpts).toEqual([]);
    expect((await workspace.read(RECALL_PATH))?.revision).toBe(off.revision);
    expect(selectRecalledLines(state.document, "unicorn milk", "another-session")).toEqual([]);
  });

  it("keeps a long message inside its windows and its characters intact", () => {
    const long = `${"blue milk ".repeat(200)}end`;
    const windows = excerptsFromEvent({
      version: 1, eventId: "e", sessionId: "s", sequence: 4, recordedAt: "2026-08-01T00:00:00.000Z",
      previousDigest: "p", digest: "d", type: "turn.requested", payload: { content: long },
    }, "Long");
    expect(windows).toHaveLength(3);
    expect(windows.every((window) => window.text.length <= RECALL_EXCERPT_CHARACTERS)).toBe(true);
    expect(windows.map((window) => window.text).join("")).toBe(long.slice(0, 3 * RECALL_EXCERPT_CHARACTERS));
  });

  it("bounds the document a Vault has to rewrite on every turn", () => {
    const excerpts: RecallExcerpt[] = [];
    for (let index = 0; index < 512; index += 1) {
      excerpts.push(Object.freeze({
        sessionId: "s", title: "Long conversation", sequence: index, who: "you" as const,
        at: "2026-08-01T00:00:00.000Z", text: "x".repeat(RECALL_EXCERPT_CHARACTERS),
      }));
    }
    const bounded = boundRecallDocument(Object.freeze({
      version: 1, enabled: true, cursors: Object.freeze({}), excerpts: Object.freeze(excerpts),
    }));
    expect(encoder.encode(serializeRecallDocument(bounded)).byteLength).toBeLessThanOrEqual(RECALL_DOCUMENT_BYTES);
    // Oldest first out, so what a turn is most likely to want is what survives.
    expect(bounded.excerpts[bounded.excerpts.length - 1]?.sequence).toBe(511);
  });
});

describe("what one turn is entitled to", () => {
  const corpus = Object.freeze({
    version: 1 as const,
    enabled: true,
    cursors: Object.freeze({}),
    excerpts: Object.freeze([
      Object.freeze({
        sessionId: "drinks", title: "Drinks", sequence: 2, who: "you" as const,
        at: "2026-08-01T00:00:00.000Z", text: "I like unicorn milk and I want it to be blue",
      }),
      Object.freeze({
        sessionId: "drinks", title: "Drinks", sequence: 3, who: "the agent" as const,
        at: "2026-08-01T00:00:01.000Z", text: "Blue it is.",
      }),
    ]),
  });

  it("answers the milk question with the line that said it, and its provenance", () => {
    const lines = selectRecalledLines(corpus, "what kind of milk do I like most?", "kitchen");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(
      'You said, in "Drinks" (turn 2, 2026-08-01): I like unicorn milk and I want it to be blue',
    );
    expect(lines[0]?.score).toBeGreaterThan(0.25);
  });

  it("contributes exactly zero bytes when nothing in the corpus is relevant", () => {
    const lines = selectRecalledLines(corpus, "how do I rotate a private key?", "kitchen");
    expect(lines).toEqual([]);
    expect(lines.reduce((total, line) => total + encoder.encode(line.text).byteLength, 0)).toBe(0);
  });

  it("never recalls the conversation the person is already reading", () => {
    expect(selectRecalledLines(corpus, "what kind of milk do I like most?", "drinks")).toEqual([]);
  });

  it("spends no more than the per-turn byte budget", () => {
    const wide = Object.freeze({
      ...corpus,
      excerpts: Object.freeze([0, 1, 2, 3].map((index) => Object.freeze({
        sessionId: `s${index}`, title: "Recipes", sequence: index, who: "you" as const,
        at: `2026-08-0${index + 1}T00:00:00.000Z`, text: `unicorn milk recipe ${index} ${"m".repeat(600)}`,
      }))),
    });
    const lines = selectRecalledLines(wide, "unicorn milk recipe", "kitchen");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.reduce((total, line) => total + encoder.encode(line.text).byteLength, 0))
      .toBeLessThanOrEqual(RECALL_TURN_BYTES);
  });
});
