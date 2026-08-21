import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  ToolCall,
} from "../core/contracts";
import { randomUuid } from "../core/id";

function call(name: string, argumentsValue: JsonValue): ToolCall {
  return { id: randomUuid(), name, arguments: argumentsValue };
}

function commandFor(content: string): ToolCall | undefined {
  const trimmed = content.trim();
  if (trimmed === "/ls" || trimmed.startsWith("/ls ")) {
    return call("list_files", { path: trimmed.slice(3).trim() || "/workspace" });
  }
  if (trimmed.startsWith("/read ")) {
    return call("read_file", { path: trimmed.slice(6).trim() });
  }
  if (trimmed.startsWith("/write ")) {
    const body = trimmed.slice(7);
    const newline = body.indexOf("\n");
    const firstSpace = body.indexOf(" ");
    const split = newline >= 0 ? newline : firstSpace;
    if (split > 0) {
      return call("write_file", {
        path: body.slice(0, split).trim(),
        content: body.slice(split + 1),
      });
    }
  }
  return undefined;
}

async function* textEvents(text: string, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
  const chunks = text.match(/\S+\s*/gu) ?? [text];
  for (const textChunk of chunks) {
    if (signal.aborted) throw signal.reason;
    yield { type: "text-delta", text: textChunk };
    await Promise.resolve();
  }
}

export class DemoInferenceTransport implements InferenceTransport {
  readonly id = "airship-demo";
  readonly posture = "local" as const;

  async *stream(request: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    if (signal.aborted) throw signal.reason;
    const last = request.messages.at(-1);
    if (!last) throw new Error("The demo transport requires at least one message.");

    if (last.role === "tool") {
      yield* textEvents(`The workspace operation completed. ${last.content}`, signal);
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    const reasoningRequest = last.role === "user" ? last.content.trim() : "";
    if (reasoningRequest.startsWith("/reason ")) {
      const thought = reasoningRequest.slice(8).trim() || "reasoning demo";
      yield { type: "progress", phase: "reasoning" };
      const lineOne = `First I decide what "${thought}" asks for. `;
      const lineTwo = `\nThen I answer briefly, in the voice the profile set.`;
      yield { type: "reasoning-delta", text: lineOne };
      await Promise.resolve();
      yield { type: "reasoning-delta", text: lineTwo };
      const answer = `Considered "${thought}" out loud for ${String((lineOne + lineTwo).length)} characters, per your request.`;
      yield* textEvents(answer, signal);
      yield { type: "usage", inputTokens: Math.ceil(last.content.length / 4), outputTokens: Math.ceil(answer.length / 4) };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const requestedCall = last.role === "user" ? commandFor(last.content) : undefined;
    if (requestedCall) {
      yield { type: "tool-call", call: requestedCall };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }

    const answer =
      "Airship is running this turn entirely on your device with the deterministic demo provider. " +
      // Typed verbatim, the old wording failed: unquoted words after the path
      // bind positionally to the next parameter, so `/write notes/hello.md
      // hello world` reported a revision conflict that had not happened.
      "Try /write notes/hello.md \"hello there\", /read notes/hello.md, /reason followed by a thought, or /ls.";
    yield* textEvents(answer, signal);
    yield { type: "usage", inputTokens: Math.ceil(last.content.length / 4), outputTokens: Math.ceil(answer.length / 4) };
    yield { type: "completed", finishReason: "stop" };
  }
}
