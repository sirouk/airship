/**
 * Does Chutes accept this key — asked before anything is shown that implies it
 * does.
 *
 * Measured on this build with `cpk_notarealkey000000`: pressing "Discover
 * models with key" produced a green "13 encrypted-inference candidates found",
 * a model card headed "✦ privacy-first recommendation", "AVAILABILITY hot" and
 * "$0.104 / $0.416 USD per million tokens" — a whole priced connection screen
 * for a credential nobody had offered to Chutes. The catalog reads are
 * unauthenticated, so they succeed for any string; the key was not checked until
 * "Finish: verify & connect" ten seconds later. Every state must tell the truth,
 * and a priced picker is a claim that the key works.
 *
 * The check is one request and it is cheap: an unauthenticated `/users/me`
 * answers 401 in about 100ms, against the ~10s the leased-endpoint verification
 * at Finish takes. It does not replace that verification — Finish still proves
 * `chutes:invoke` for the *selected model*, which this cannot know — it only
 * stops a key Chutes has already rejected from reaching a screen that looks
 * like a connection.
 *
 * The URL is a literal rather than an import of `CHUTES_API_BASE`
 * (src/models/types.ts) for the reason `egress-preflight.ts` documents: that
 * import makes Rollup emit a shared chunk and the release gate refuses the
 * unclassified artifact. `chutes-key-authorization.test.ts` imports the real
 * constant and fails the build if the two ever drift.
 */

/** The account endpoint, which exists to answer exactly "whose key is this". */
export const CHUTES_KEY_CHECK_URL = "https://api.chutes.ai/users/me";

export type ChutesKeyVerdict =
  /** Chutes answered about this key. Not a claim about any particular model. */
  | Readonly<{ state: "accepted" }>
  /** Chutes refused it. `providerResponse` is the provider's own words. */
  | Readonly<{ state: "refused"; providerResponse: string }>
  /** Nobody answered, so nothing may be concluded about the key either way. */
  | Readonly<{ state: "unreachable"; detail: string }>;

/**
 * How many characters of a provider error body are worth repeating.
 *
 * The body is shown verbatim under a disclosure, so it is bounded here rather
 * than trusted: an endpoint that answers with a megabyte of HTML must not be
 * able to push it into the page.
 */
const MAX_PROVIDER_RESPONSE = 512;

export async function verifyChutesKey(
  key: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChutesKeyVerdict> {
  let response: Response;
  try {
    response = await fetchImpl(CHUTES_KEY_CHECK_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch (caught) {
    // An abort is the caller's own decision and is re-raised, not reported as
    // an unreachable provider: the two lead to opposite next actions.
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    return Object.freeze({
      state: "unreachable",
      detail: caught instanceof Error ? caught.message : "The key check did not complete.",
    });
  }
  if (response.status === 401 || response.status === 403) {
    return Object.freeze({
      state: "refused",
      providerResponse: await providerWords(response, response.status),
    });
  }
  // Any other answer — including a 5xx — is Chutes failing to answer the
  // question, not Chutes answering "no". Only a refusal may be reported as one.
  if (!response.ok) {
    return Object.freeze({
      state: "unreachable",
      detail: `Chutes answered HTTP ${String(response.status)} to the key check, which is not a verdict about the key.`,
    });
  }
  return Object.freeze({ state: "accepted" });
}

/** The provider's own words, bounded and verbatim — never re-worded. */
async function providerWords(response: Response, status: number): Promise<string> {
  const body = await response.text().catch(() => "");
  const prefix = `HTTP ${String(status)} · `;
  // Bounded on the whole sentence, not on the body alone: the prefix is part of
  // what gets rendered, so a bound that excluded it would not be one.
  return `${prefix}${body.trim() || "no message"}`.slice(0, MAX_PROVIDER_RESPONSE);
}
