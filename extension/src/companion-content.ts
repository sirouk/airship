import {
  COMPANION_PORT_NAME,
  COMPANION_PROTOCOL_VERSION,
  type CompanionPort,
  type CompanionReply,
  isCompanionReply,
} from "./companion";
import { type CallerOrigin, checkCallerUrl } from "./policy";

type RuntimeConnector = Readonly<{ connect(info: Readonly<{ name: string }>): CompanionPort }>;

export function installCompanionContentBridge(options: Readonly<{
  runtime: RuntimeConnector;
  self: Window;
  documentUrl: string;
  callers: readonly CallerOrigin[];
}>): () => void {
  const caller = checkCallerUrl(options.documentUrl, options.callers);
  if (!caller.ok || options.self.top !== options.self) return () => undefined;
  let port: CompanionPort | undefined;
  const outstanding = new Set<string>();

  const post = (message: CompanionReply) => {
    options.self.postMessage(message, caller.origin);
  };
  const ensurePort = (): CompanionPort | undefined => {
    if (port) return port;
    try {
      const next = options.runtime.connect({ name: COMPANION_PORT_NAME });
      next.onMessage.addListener((message) => {
        if (!isCompanionReply(message)) return;
        outstanding.delete(message.id);
        post(message);
      });
      next.onDisconnect.addListener(() => {
        port = undefined;
        for (const id of outstanding) {
          post(Object.freeze({
            airshipCompanion: COMPANION_PROTOCOL_VERSION,
            from: "extension",
            id,
            kind: "error",
            code: "companion-disconnected",
            message: "The Airship Companion background context stopped before answering.",
          }));
        }
        outstanding.clear();
      });
      port = next;
      return next;
    } catch {
      return undefined;
    }
  };
  const listener = (event: MessageEvent<unknown>) => {
    if (event.source !== options.self || event.origin !== caller.origin) return;
    const value = event.data;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (
      record.airshipCompanion !== COMPANION_PROTOCOL_VERSION
      || record.from !== "page"
      || typeof record.id !== "string"
      || typeof record.kind !== "string"
    ) return;
    if (outstanding.size >= 16) {
      post(Object.freeze({
        airshipCompanion: COMPANION_PROTOCOL_VERSION,
        from: "extension",
        id: record.id,
        kind: "error",
        code: "companion-busy",
        message: "The Airship Companion has reached its per-page request limit.",
      }));
      return;
    }
    const active = ensurePort();
    if (!active) return;
    outstanding.add(record.id);
    try {
      active.postMessage(record);
    } catch {
      outstanding.delete(record.id);
      port = undefined;
    }
  };
  options.self.addEventListener("message", listener);
  return () => options.self.removeEventListener("message", listener);
}
