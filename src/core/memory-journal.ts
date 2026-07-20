import {
  JournalConflictError,
  type DurableEvent,
  type JournalBackend,
  type SessionRecord,
} from "./journal";

export class MemoryJournalBackend implements JournalBackend {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new Map<string, DurableEvent[]>();

  async createSession(session: SessionRecord): Promise<void> {
    if (this.sessions.has(session.id)) throw new Error(`Session already exists: ${session.id}`);
    this.sessions.set(session.id, structuredClone(session));
    this.events.set(session.id, []);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .map((session) => structuredClone(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readEvents(sessionId: string, afterSequence = 0): Promise<DurableEvent[]> {
    return (this.events.get(sessionId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  async append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
  ): Promise<SessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.headSequence !== expectedHead.sequence || session.headDigest !== expectedHead.digest) {
      throw new JournalConflictError();
    }
    if (!events.length) return structuredClone(session);

    const first = events[0];
    const last = events.at(-1)!;
    if (first.sequence !== session.headSequence + 1 || first.previousDigest !== session.headDigest) {
      throw new JournalConflictError("The append does not extend the current digest chain.");
    }
    for (let index = 1; index < events.length; index += 1) {
      if (
        events[index].sequence !== events[index - 1].sequence + 1 ||
        events[index].previousDigest !== events[index - 1].digest
      ) {
        throw new Error("The append contains a broken digest chain.");
      }
    }

    this.events.get(sessionId)!.push(...structuredClone(events));
    const updated: SessionRecord = {
      ...session,
      title: renamedTitle(events) ?? session.title,
      updatedAt: last.recordedAt,
      headSequence: last.sequence,
      headDigest: last.digest,
    };
    this.sessions.set(sessionId, updated);
    return structuredClone(updated);
  }
}

function renamedTitle(events: readonly DurableEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]!; if (event.type === "session.renamed" && event.payload && !Array.isArray(event.payload) && typeof event.payload === "object" && typeof event.payload.title === "string") return event.payload.title; }
  return undefined;
}
