import { AssistantMessageEventStream } from "./event-stream";
import { resolveApiProvider } from "./registry";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "./types";

/**
 * Port of prime-agent packages/ai/src/stream.ts with a browser-native twist:
 * provider resolution is lazy, so stream() awaits an explicitly installed
 * provider loader and surfaces loader failures through the stream protocol.
 * The web product does not install the ported built-ins; stock turns use the
 * admitted Airship InferenceTransport instead.
 */
export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function pushStreamError(
  out: AssistantMessageEventStream,
  model: Model<Api> | undefined,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model?.api ?? "unknown",
    provider: model?.provider ?? "unknown",
    model: model?.id ?? "unknown",
    usage: emptyUsage(),
    stopReason: reason,
    errorMessage: message,
    timestamp: Date.now(),
  };
  out.push({ type: "error", reason, error });
}

export function streamLazy(
  load: () => Promise<AssistantMessageEventStream>,
  model?: Model<Api>,
): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  load()
    .then(async (inner) => {
      try {
        for await (const event of inner) out.push(event);
      } catch (err) {
        pushStreamError(out, model, err instanceof Error ? err.message : String(err));
      }
    })
    .catch((err) => {
      pushStreamError(out, model, err instanceof Error ? err.message : String(err));
    });
  return out;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  return streamLazy(async () => {
    const provider = await resolveApiProvider(model.api);
    if (!provider) throw new Error(`No API provider registered for api: ${model.api}`);
    return provider.stream(model, context, options);
  }, model as Model<Api>);
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamLazy(async () => {
    const provider = await resolveApiProvider(model.api);
    if (!provider) throw new Error(`No API provider registered for api: ${model.api}`);
    return provider.streamSimple(model, context, options);
  }, model as Model<Api>);
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return streamSimple(model, context, options).result();
}
