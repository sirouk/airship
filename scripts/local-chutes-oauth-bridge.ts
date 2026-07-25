import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const ROUTE = "/__airship/chutes/oauth/token";
const UPSTREAM = "https://api.chutes.ai/idp/token";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const ALLOWED_FIELDS = new Set([
  "grant_type",
  "code",
  "client_id",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
]);

type BridgeConfiguration = Readonly<{
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetch?: typeof globalThis.fetch;
}>;

export function localChutesOAuthBridge(configuration: BridgeConfiguration = {}): Plugin {
  const clientId = configuration.clientId ?? process.env.AIRSHIP_CHUTES_OAUTH_CLIENT_ID;
  const clientSecret = configuration.clientSecret ?? process.env.AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET;
  const redirectUri = configuration.redirectUri ?? "http://localhost:4173/auth/chutes/callback";
  const fetchImpl = configuration.fetch ?? globalThis.fetch;
  return {
    name: "airship-local-chutes-oauth-bridge",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== ROUTE) return next();
        setResponsePolicy(response);
        if (request.method === "GET") {
          if (!clientId || !clientSecret) return sendJson(response, 503, { error: "local_bridge_unconfigured" });
          response.statusCode = 204;
          return response.end();
        }
        await handleTokenExchange(request, response, { clientId, clientSecret, redirectUri, fetch: fetchImpl });
      });
    },
  };
}

export function confidentialTokenForm(
  body: string,
  clientId: string,
  clientSecret: string,
  redirectUri = "http://localhost:4173/auth/chutes/callback",
): URLSearchParams {
  const incoming = new URLSearchParams(body);
  if (incoming.has("client_secret")) throw new Error("The browser must not submit a client secret.");
  for (const field of incoming.keys()) {
    if (!ALLOWED_FIELDS.has(field)) throw new Error("The token request contains an unsupported field.");
  }
  if (incoming.get("client_id") !== clientId) throw new Error("The token request client does not match this bridge.");
  const grantType = incoming.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    throw new Error("The token request grant is unsupported.");
  }
  if (grantType === "authorization_code" && incoming.get("redirect_uri") !== redirectUri) {
    throw new Error("The token request redirect does not match this bridge.");
  }
  incoming.set("client_secret", clientSecret);
  return incoming;
}

async function handleTokenExchange(
  request: IncomingMessage,
  response: ServerResponse,
  configuration: Required<Pick<BridgeConfiguration, "fetch">> & Omit<BridgeConfiguration, "fetch">,
): Promise<void> {
  setResponsePolicy(response);
  if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
  if (request.headers.origin !== "http://localhost:4173") {
    return sendJson(response, 403, { error: "invalid_origin" });
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return sendJson(response, 415, { error: "unsupported_media_type" });
  }
  if (!configuration.clientId || !configuration.clientSecret) {
    return sendJson(response, 503, { error: "local_bridge_unconfigured" });
  }
  try {
    const body = await readRequest(request);
    const form = confidentialTokenForm(
      body,
      configuration.clientId,
      configuration.clientSecret,
      configuration.redirectUri,
    );
    const deadline = AbortSignal.timeout(20_000);
    const upstream = await configuration.fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
    const bytes = await readUpstreamResponse(upstream, deadline);
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type")?.includes("json") ? "application/json" : "application/octet-stream");
    response.end(bytes);
  } catch {
    sendJson(response, 502, { error: "local_bridge_exchange_failed" });
  }
}

async function readUpstreamResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (
    !/^\d+$/u.test(declared) ||
    !Number.isSafeInteger(Number(declared)) ||
    Number(declared) > MAX_RESPONSE_BYTES
  )) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Chutes token response exceeded the bridge limit.");
  }
  if (!response.body) throw new Error("Chutes token response had no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("Chutes token response exceeded the bridge limit.").catch(() => undefined);
        throw new Error("Chutes token response exceeded the bridge limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an aborted body may retain its reader */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Chutes token exchange was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Chutes token exchange was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error("Token request too large.");
    chunks.push(bytes);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function setResponsePolicy(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, payload: Readonly<Record<string, string>>): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}
