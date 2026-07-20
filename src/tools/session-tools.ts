import type { JsonValue, Tool } from "../core/contracts";
import type { DurableEvent, EventJournal } from "../core/journal";
import type { ToolRegistry } from "./registry";

const MAX_RESULTS = 50;

export function registerSessionTools(registry: ToolRegistry, journal: EventJournal): void {
  const searchSessions: Tool = {
    definition: {
      name: "search_sessions",
      description: "List or search durable sessions belonging to this session's pinned profile. The current thread remains inference history; cross-profile transcripts are never exposed.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 2_048 },
          sessionId: { type: "string", maxLength: 512 },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        },
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const args = objectArguments(argumentsValue);
      const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const requestedSession = typeof args.sessionId === "string" && args.sessionId.trim()
        ? args.sessionId.trim()
        : undefined;
      const caller = await journal.getSession(context.sessionId, context.signal);
      if (!caller) throw new Error(`Session search authority was not found: ${context.sessionId}.`);
      const profileId = caller.manifest.profile?.profileId;
      if (context.signal.aborted) throw context.signal.reason;
      const authorized = (await journal.listSessions()).filter((session) =>
        profileId ? session.manifest.profile?.profileId === profileId : session.id === caller.id,
      );
      const sessions = requestedSession
        ? authorized.filter((session) => session.id === requestedSession)
        : authorized;
      if (requestedSession && sessions.length === 0) {
        throw new Error("Requested session is outside the caller's pinned profile scope.");
      }
      if (!query) {
        return {
          content: JSON.stringify(sessions.slice(0, limit).map((session) => ({
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            headSequence: session.headSequence,
            providerId: session.manifest.providerId,
            model: session.manifest.model,
            profileId: session.manifest.profile?.profileId ?? null,
          })), null, 2),
          metadata: {
            count: Math.min(sessions.length, limit),
            limit,
            scope: requestedSession ?? (profileId ? `profile:${profileId}` : `session:${caller.id}`),
            truncated: sessions.length > limit,
          },
        };
      }

      const matches: Array<Record<string, JsonValue>> = [];
      for (const session of sessions) {
        if (context.signal.aborted) throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
        const events = await journal.readEvents(session.id);
        for (const event of events) {
          const text = searchableEventText(event);
          if (!text || !text.toLocaleLowerCase().includes(query)) continue;
          matches.push({
            sessionId: session.id,
            sessionTitle: session.title,
            sequence: event.sequence,
            eventType: event.type,
            recordedAt: event.recordedAt,
            text: boundedSnippet(text, query),
            digest: event.digest,
          });
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      return {
        content: JSON.stringify(matches, null, 2),
        metadata: {
          count: matches.length,
          limit,
          scope: requestedSession ?? (profileId ? `profile:${profileId}` : `session:${caller.id}`),
          truncated: matches.length >= limit,
        },
      };
    },
  };
  registry.register(searchSessions);
}

function searchableEventText(event: DurableEvent): string | undefined {
  const payload = objectValue(event.payload);
  if (event.type === "turn.requested" && typeof payload?.content === "string") return payload.content;
  if (event.type === "assistant.completed") {
    const message = objectValue(payload?.message);
    return typeof message?.content === "string" ? message.content : undefined;
  }
  if (["tool.resulted", "tool.failed", "tool.denied"].includes(event.type) && typeof payload?.content === "string") {
    return payload.content;
  }
  return undefined;
}

function boundedSnippet(text: string, normalizedQuery: string): string {
  if (text.length <= 1_200) return text;
  const at = text.toLocaleLowerCase().indexOf(normalizedQuery);
  const start = Math.max(0, at - 300);
  const end = Math.min(text.length, start + 1_200);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
