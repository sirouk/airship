/**
 * Which chutes can embed, asked rather than assumed.
 *
 * The previous provider named one host and one model as constants. Both were
 * true on the day they were written and neither is a property of Airship: a
 * second embedding chute, a renamed slug, or a wider model would have made the
 * product quietly wrong with no signal anywhere. Chutes publishes the answer —
 * `standard_template === "embedding"` on the management catalog identifies an
 * embedding deployment, and the chute's own cord list says which path inside it
 * speaks the OpenAI embeddings shape — so Airship asks.
 *
 * The request is anonymous, like every other management read in this codebase
 * (`docs/MODEL_DISCOVERY.md`, "Public `/chutes` reads … also work anonymously,
 * so Airship deliberately omits credentials"). Discovering *what exists* must
 * not spend a credential; only the sealed invocation does.
 */

/** `ChuteResponse.standard_template` for an embedding deployment. */
export const CHUTES_EMBEDDING_TEMPLATE = "embedding";

/**
 * How an embeddings cord is recognized inside a chute's cord list.
 *
 * Matched on the OpenAI-compatible path the cord publishes rather than on its
 * Python function name, because the path is the contract the request body is
 * written against and the function name is the chute author's private choice.
 */
const EMBEDDINGS_PATH_PATTERN = /\/embeddings$/u;

const MAX_ITEMS = 500;
const MAX_STRING = 512;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ChutesEmbeddingDiscoveryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ChutesEmbeddingDiscoveryError";
  }
}

/**
 * One embedding deployment Airship is willing to send a corpus to.
 *
 * `chuteId` and `path` are exactly what `/e2e/invoke` needs in `X-Chute-Id` and
 * `X-E2E-Path`; `id` is what goes in the request body's `model`. Nothing else
 * about the deployment is remembered, because nothing else is used.
 */
export type ChutesEmbeddingModel = Readonly<{
  /** The chute's `name`, which is the model identifier the endpoint answers to. */
  id: string;
  chuteId: string;
  slug: string;
  /** The OpenAI-compatible embeddings path published by the chute's cords. */
  path: string;
  /** Live at discovery time: at least one active and verified instance. */
  hot: boolean;
}>;

export type ChutesEmbeddingCatalog = Readonly<{
  models: readonly ChutesEmbeddingModel[];
  /** How many embedding deployments Airship can actually use. */
  count: number;
  /**
   * Embedding deployments Chutes listed that this build declined: not confidential
   * compute, or publishing no OpenAI-compatible embeddings path. Reported rather
   * than dropped so "one model" and "one usable model of four" are different
   * sentences on screen.
   */
  declined: number;
}>;

export type ChutesEmbeddingDiscoveryOptions = Readonly<{
  /** Defaults to the Chutes management API. */
  apiBase?: string;
  limit?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}>;

const DEFAULT_API_BASE = "https://api.chutes.ai";

/**
 * Ask Chutes which chutes embed.
 *
 * Fails loudly rather than returning an empty catalog on a transport or shape
 * problem: "Chutes lists no embedding models" and "Airship could not ask" are
 * different facts, and a caller about to disable a control needs to know which
 * one it is looking at.
 */
export async function discoverChutesEmbeddingModels(
  options: ChutesEmbeddingDiscoveryOptions = {},
): Promise<ChutesEmbeddingCatalog> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new ChutesEmbeddingDiscoveryError("No fetch implementation is available.");
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, "");
  const limit = Math.min(MAX_ITEMS, Math.max(1, Math.trunc(options.limit ?? 50)));

  const url = new URL(`${apiBase}/chutes/`);
  url.searchParams.set("include_public", "true");
  url.searchParams.set("template", CHUTES_EMBEDDING_TEMPLATE);
  url.searchParams.set("page", "0");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("include_schemas", "false");

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: { Accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new ChutesEmbeddingDiscoveryError(
      "The Chutes management catalog could not be reached, so Airship does not know which chutes embed.",
      cause,
    );
  }
  if (!response.ok) {
    throw new ChutesEmbeddingDiscoveryError(
      `The Chutes management catalog answered ${response.status}, so Airship does not know which chutes embed.`,
    );
  }

  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new ChutesEmbeddingDiscoveryError("The Chutes management catalog response was too large to read.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ChutesEmbeddingDiscoveryError("The Chutes management catalog was not readable JSON.", cause);
  }
  return readCatalog(payload);
}

/** Exported for tests and for any caller holding an already-fetched payload. */
export function readCatalog(payload: unknown): ChutesEmbeddingCatalog {
  const body = payload as { items?: unknown; cord_refs?: unknown } | null;
  const items = body?.items;
  if (!Array.isArray(items)) {
    throw new ChutesEmbeddingDiscoveryError("The Chutes management catalog carried no `items` array.");
  }
  if (items.length > MAX_ITEMS) {
    throw new ChutesEmbeddingDiscoveryError("The Chutes management catalog returned more chutes than Airship reads.");
  }
  const cordRefs = isRecord(body?.cord_refs) ? body.cord_refs : {};

  const models: ChutesEmbeddingModel[] = [];
  const seen = new Set<string>();
  let declined = 0;

  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.standard_template !== CHUTES_EMBEDDING_TEMPLATE) continue;

    const chuteId = shortString(item.chute_id);
    const id = shortString(item.name);
    if (!chuteId || !id || seen.has(chuteId)) continue;

    /*
     * Confidential compute is not a preference here, it is the admission rule.
     * `EmbeddingProvider.posture` may only say `confidential-remote` of a
     * provider whose compute is attested, and `/e2e/invoke` needs an instance
     * public key to seal against — a non-TEE chute has neither. Counted as
     * declined rather than skipped silently.
     */
    if (item.tee !== true) {
      declined += 1;
      continue;
    }

    const path = embeddingsPath(cordRefs[shortString(item.cord_ref_id) ?? ""]);
    if (!path) {
      declined += 1;
      continue;
    }

    seen.add(chuteId);
    models.push(Object.freeze({
      id,
      chuteId,
      slug: shortString(item.slug) ?? chuteId,
      path,
      hot: item.hot === true,
    }));
  }

  models.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({ models: Object.freeze(models), count: models.length, declined });
}

/** The chute's own OpenAI-compatible embeddings path, or nothing if it has none. */
function embeddingsPath(cords: unknown): string | undefined {
  if (!Array.isArray(cords)) return undefined;
  for (const cord of cords) {
    if (!isRecord(cord)) continue;
    // Streaming is not a shape an embeddings response takes; a cord that claims
    // it is not the one this provider knows how to read.
    if (cord.stream === true) continue;
    if (typeof cord.public_api_method === "string" && cord.public_api_method.toUpperCase() !== "POST") continue;
    const path = shortString(cord.public_api_path);
    if (path && path.startsWith("/") && EMBEDDINGS_PATH_PATTERN.test(path)) return path;
  }
  return undefined;
}

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
