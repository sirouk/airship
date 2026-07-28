/**
 * Content-script framing, as pure decisions plus one injectable channel.
 *
 * The content script is the only part of the extension the page can address,
 * so it filters before it forwards: same window, same origin, allowlisted
 * page, request-shaped envelope. The background worker re-checks everything
 * that matters — this layer exists so a hostile frame cannot even make the
 * worker look at its message, and so a page never waits forever on a reply
 * that will not come.
 */

import { BRIDGE_PROTOCOL_VERSION, type CallerOrigin, checkCallerUrl } from "./policy";
import {
  type BridgeReply,
  errorReply,
  isBridgeReply,
  isTerminalReply,
} from "./protocol";

export type PageMessageEvent = Readonly<{
  data: unknown;
  origin: string;
  source: unknown;
}>;

export type PageContext = Readonly<{
  /** The content script's own `window`; messages from any other source are dropped. */
  self: unknown;
  /** The document URL the content script is running in. */
  url: string;
  callers: readonly CallerOrigin[];
}>;

export type PageMessageDecision =
  | Readonly<{
    action: "relay";
    message: Readonly<Record<string, unknown>>;
    id: string;
    kind: string;
    origin: string;
  }>
  | Readonly<{ action: "ignore"; reason: string }>;

function ignore(reason: string): PageMessageDecision {
  return Object.freeze({ action: "ignore", reason });
}

export function classifyPageMessage(
  event: PageMessageEvent,
  context: PageContext,
): PageMessageDecision {
  if (event.source !== context.self) return ignore("The message did not come from this window.");
  // The URL-only check: a content script has no frame id to offer. Its own
  // `window.top === window` guard (content-script.ts) is the frame evidence
  // here, and the worker re-checks the frame from the sender it is given.
  const caller = checkCallerUrl(context.url, context.callers);
  if (!caller.ok) return ignore(caller.reason);
  if (event.origin !== caller.origin) return ignore("The message origin is not this page's origin.");
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ignore("The message is not an object.");
  }
  const record = data as Record<string, unknown>;
  if (record.airshipBridge !== BRIDGE_PROTOCOL_VERSION) return ignore("Not a bridge envelope.");
  // `window.postMessage` delivers a page's own message back to the page, so
  // every reply this content script posts arrives here too. The direction
  // marker is what stops a reply from being relayed back in as a request.
  if (record.from === "extension") return ignore("A reply is not a request.");
  if (typeof record.kind !== "string") return ignore("The envelope names no request kind.");
  if (typeof record.id !== "string" || record.id.length === 0) {
    return ignore("The envelope carries no request id.");
  }
  return Object.freeze({
    action: "relay",
    message: record,
    id: record.id,
    kind: record.kind,
    origin: caller.origin,
  });
}

export type ChannelListener<T> = Readonly<{ addListener(listener: T): void }>;

export type ChannelPort = Readonly<{
  postMessage(message: unknown): void;
  onMessage: ChannelListener<(message: unknown) => void>;
  onDisconnect: ChannelListener<() => void>;
}>;

export type PageChannelOptions = Readonly<{
  context: PageContext;
  /** Opens the port to the background worker. May throw if the worker is gone. */
  connect: () => ChannelPort;
  postToPage: (message: BridgeReply, targetOrigin: string) => void;
  maxOutstanding?: number;
}>;

export type PageChannel = Readonly<{
  receive(event: PageMessageEvent): void;
  outstanding(): number;
}>;

const DEFAULT_MAX_OUTSTANDING = 32;

/**
 * Multiplex every request from one page over a single port.
 *
 * A background worker can be torn down at any moment. When the port drops,
 * every request still waiting on it is answered with an explicit
 * `bridge-disconnected` error, because a page that is never answered would
 * have to guess, and guessing is what this extension exists to avoid.
 */
export function createPageChannel(options: PageChannelOptions): PageChannel {
  const maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING;
  const outstanding = new Map<string, string>();
  let port: ChannelPort | undefined;

  function deliver(message: BridgeReply, origin: string): void {
    // Replies carry provider payloads, so the target origin is always the
    // exact page origin and never "*".
    options.postToPage(message, origin);
  }

  function settle(id: string): void {
    outstanding.delete(id);
  }

  function ensurePort(origin: string): ChannelPort | undefined {
    if (port) return port;
    let opened: ChannelPort;
    try {
      opened = options.connect();
    } catch {
      return undefined;
    }
    opened.onMessage.addListener((message) => {
      if (!isBridgeReply(message)) return;
      if (isTerminalReply(message)) settle(message.id);
      deliver(message, origin);
    });
    opened.onDisconnect.addListener(() => {
      port = undefined;
      const abandoned = [...outstanding.keys()];
      outstanding.clear();
      for (const id of abandoned) {
        deliver(
          errorReply(id, "bridge-disconnected", "The extension background worker went away."),
          origin,
        );
      }
    });
    port = opened;
    return opened;
  }

  return Object.freeze({
    receive(event: PageMessageEvent): void {
      const decision = classifyPageMessage(event, options.context);
      if (decision.action !== "relay") return;
      if (outstanding.size >= maxOutstanding) {
        deliver(
          errorReply(decision.id, "too-many-requests", `At most ${maxOutstanding} requests may be outstanding.`),
          decision.origin,
        );
        return;
      }
      const active = ensurePort(decision.origin);
      if (!active) {
        deliver(
          errorReply(decision.id, "bridge-disconnected", "The extension background worker is unreachable."),
          decision.origin,
        );
        return;
      }
      // A cancel carries the id of the exchange it ends, and the page has
      // already stopped listening for it, so it is never awaited.
      if (decision.kind !== "cancel") outstanding.set(decision.id, decision.origin);
      try {
        active.postMessage(decision.message);
      } catch {
        settle(decision.id);
        port = undefined;
        deliver(
          errorReply(decision.id, "bridge-disconnected", "The extension background worker is unreachable."),
          decision.origin,
        );
      }
    },
    outstanding(): number {
      return outstanding.size;
    },
  });
}
