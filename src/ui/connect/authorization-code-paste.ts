/**
 * Reading a vendor authorization code that a person carried back by hand.
 *
 * Codex (OpenAI) and Claude both finish their sign-in by redirecting to a
 * loopback address. Airship is a static page with nothing listening there, so
 * the browser lands on a "can't connect" error and the one-time code survives
 * only in that failed page's address bar. The person has to copy it back.
 *
 * That paste step is the whole risk of the feature feeling broken, so every
 * shape a person might paste is read here, in one pure place, and the field can
 * answer while they type instead of failing after they submit. Nothing in this
 * module performs a network call or touches a credential store.
 */

/** Ceiling on the raw pasted value. A pasted address is far below this. */
export const MAX_PASTED_INPUT_CHARS = 8_192;

/**
 * Ceiling on the extracted code itself, matching `MAX_CODE_LENGTH` in
 * `src/auth/provider-oauth/authorization-code.ts`. A lower value here would
 * disable the button on a code the exchange would accept.
 */
export const MAX_AUTHORIZATION_CODE_CHARS = 4_096;

/** Ceiling on vendor-supplied error text echoed back to the person. */
const MAX_VENDOR_MESSAGE_CHARS = 200;

/**
 * Printable ASCII, minus the three characters that delimit a code from the
 * fields around it.
 *
 * This deliberately matches `parsePastedAuthorizationCode` in
 * `src/auth/provider-oauth`, which is the authority that binds a code to its
 * PKCE attempt. A stricter rule here would disable the submit button on a value
 * the exchange would have accepted; a looser one would enable it on a value the
 * exchange refuses. `authorization-code-paste.conformance.test.ts` pins the
 * agreement.
 */
const CODE_CHARACTERS = /^[!-~]+$/u;
const CODE_DELIMITERS = /[#&?]/u;
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f]", "u");

/**
 * Prefixes that identify a long-lived API key rather than a one-time code.
 * Pasting one here would put a durable secret in the wrong field, so it is
 * refused by name rather than reported as an invalid code.
 */
const API_KEY_PREFIXES: readonly string[] = Object.freeze([
  "sk-",
  "sk_",
  "cpk_",
  "cak_",
  "xai-",
  "ghp_",
  "AIza",
]);

export type AuthorizationCodeRejection =
  | "input-too-long"
  | "code-too-long"
  | "vendor-reported-error"
  | "address-has-no-code"
  | "unsupported-characters"
  | "looks-like-an-api-key";

export type AuthorizationCodeReading =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
    kind: "accepted";
    code: string;
    /** Present only when the vendor round-tripped one; never invented here. */
    state?: string;
    source: "pasted-address" | "bare-code";
    /** What the field says back, so the person can confirm the right copy. */
    confirmation: string;
    preview: string;
  }>
  | Readonly<{
    kind: "rejected";
    reason: AuthorizationCodeRejection;
    message: string;
  }>;

const EMPTY: AuthorizationCodeReading = Object.freeze({ kind: "empty" });

/**
 * Reads whatever is currently in the paste field.
 *
 * Accepts a full address copied out of the browser's address bar, the same
 * address with the code in its fragment, a bare code, and the `code#state`
 * shape Claude hands back. Every other outcome is an explicit rejection that
 * names what to do next.
 */
export function readAuthorizationCode(raw: string): AuthorizationCodeReading {
  if (raw.length > MAX_PASTED_INPUT_CHARS) {
    return rejected(
      "input-too-long",
      `That is longer than ${MAX_PASTED_INPUT_CHARS.toLocaleString()} characters. Paste just the address of the page that failed to load.`,
    );
  }
  const value = stripWrapping(raw);
  if (!value) return EMPTY;
  if (CONTROL_CHARACTERS.test(value)) {
    return rejected(
      "unsupported-characters",
      "That carries invisible characters, so part of the copy went wrong. Select the whole address and copy it again.",
    );
  }

  const address = readHttpAddress(value);
  if (address) return readFromAddress(address);

  // A person may copy only the query part of the failed address. The authority
  // in src/auth accepts that shape, so this must too or the button would be
  // disabled on a value the exchange would take.
  if (/(?:^|[?#&])code=/u.test(value)) {
    return readFromFields(new URLSearchParams(value.replace(/^[?#]/u, "")), "pasted-address");
  }

  return readBareCode(value);
}

/** True when the reading can be submitted. Keeps callers from re-deriving it. */
export function isSubmittableCode(reading: AuthorizationCodeReading): reading is Extract<AuthorizationCodeReading, { kind: "accepted" }> {
  return reading.kind === "accepted";
}

function readFromAddress(address: URL): AuthorizationCodeReading {
  const fields = new URLSearchParams(address.search);
  for (const [key, value] of new URLSearchParams(address.hash.replace(/^#/u, ""))) {
    if (!fields.has(key)) fields.append(key, value);
  }
  return readFromFields(fields, "pasted-address");
}

function readFromFields(
  fields: URLSearchParams,
  source: "pasted-address" | "bare-code",
): AuthorizationCodeReading {
  const vendorError = fields.get("error");
  if (vendorError) {
    const description = fields.get("error_description") ?? fields.get("error_reason") ?? "";
    const detail = boundedVendorText(description || vendorError);
    return rejected(
      "vendor-reported-error",
      vendorError === "access_denied"
        ? `The request was declined at the vendor, so no code was issued (${detail}). Start the sign-in again when you are ready.`
        : `The vendor refused this sign-in and issued no code: ${detail}. Start the sign-in again.`,
    );
  }

  const code = fields.get("code");
  if (!code) {
    return rejected(
      "address-has-no-code",
      "That address has no code in it. Copy the whole address from the page that failed to load — the part after code= is what Airship needs.",
    );
  }

  return acceptCode(code, fields.get("state") ?? undefined, source);
}

function readBareCode(value: string): AuthorizationCodeReading {
  /*
   * Any `scheme:` prefix — not only `https:`. The flat grammar below accepts
   * every printable character, so `javascript:alert(1)` previously parsed as a
   * bare code and flowed to the token exchange, where only the vendor's own
   * refusal stood between it and the wire. A scheme can never be the code of
   * one of these providers, and the only exception the exchange grammar carries
   * (`sk-…` API keys) is named separately below, so a scheme-shaped value is
   * refused now.
   */
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    return rejected(
      "address-has-no-code",
      "That looks like an address, not the one-time code. API keys belong in the key field, and addresses belong here whole.",
    );
  }
  if (/^(?:localhost|127\.0\.0\.1)[:/]/u.test(value)) {
    return rejected(
      "address-has-no-code",
      "That looks like a partial address. Paste the whole address from the page that failed to load, starting at http.",
    );
  }

  const apiKeyPrefix = API_KEY_PREFIXES.find((prefix) => value.startsWith(prefix));
  if (apiKeyPrefix) {
    return rejected(
      "looks-like-an-api-key",
      `That looks like an API key (it starts with ${apiKeyPrefix}), not the one-time code. API keys belong in the key field, not here.`,
    );
  }

  // Claude hands back `code#state` as a single string. Splitting on the first
  // separator keeps that flow working without asking the person to edit it.
  const separator = value.indexOf("#");
  const code = separator === -1 ? value : value.slice(0, separator);
  const state = separator === -1 ? undefined : value.slice(separator + 1) || undefined;
  return acceptCode(code, state, "bare-code");
}

function acceptCode(
  rawCode: string,
  rawState: string | undefined,
  source: "pasted-address" | "bare-code",
): AuthorizationCodeReading {
  const code = rawCode.trim();
  if (!code) {
    return rejected(
      "address-has-no-code",
      "That address carries an empty code. Copy the whole address again from the page that failed to load.",
    );
  }
  if (code.length > MAX_AUTHORIZATION_CODE_CHARS) {
    return rejected(
      "code-too-long",
      `That code is longer than ${MAX_AUTHORIZATION_CODE_CHARS.toLocaleString()} characters, so it is not the one-time code. Copy the address again.`,
    );
  }
  if (!CODE_CHARACTERS.test(code) || CODE_DELIMITERS.test(code)) {
    return rejected(
      "unsupported-characters",
      "That contains characters a one-time code never has, so some of the copy is probably missing. Select the whole address and copy it again.",
    );
  }
  const state = rawState?.trim();
  return Object.freeze({
    kind: "accepted" as const,
    code,
    ...(state ? { state } : {}),
    source,
    confirmation: source === "pasted-address"
      ? "Code read from the address you pasted."
      : "That looks like a one-time code.",
    preview: codePreview(code),
  });
}

/**
 * A short, non-reversible glance at the code so the person can confirm they
 * copied the right thing without the whole value sitting on screen.
 */
export function codePreview(code: string): string {
  if (code.length <= 8) return `${code.slice(0, 2)}…`;
  return `${code.slice(0, 4)}…${code.slice(-4)}`;
}

function readHttpAddress(value: string): URL | undefined {
  if (!/^https?:\/\//iu.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Removes the punctuation a mail or chat client wraps around a pasted value.
 *
 * A one-time code never begins and ends with a quote, so this can only recover
 * a paste that would otherwise fail. It is exported because it is the exact
 * point where this reading and the exchange's reading of the same raw string
 * legitimately differ, and the conformance test normalises through it.
 */
export function normalizePastedValue(raw: string): string {
  return stripWrapping(raw);
}

function stripWrapping(raw: string): string {
  return raw
    .trim()
    .replace(/^[<"'`]+/u, "")
    .replace(/[>"'`]+$/u, "")
    .trim();
}

function boundedVendorText(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return "no reason given";
  return cleaned.length > MAX_VENDOR_MESSAGE_CHARS
    ? `${cleaned.slice(0, MAX_VENDOR_MESSAGE_CHARS - 1)}…`
    : cleaned;
}

function rejected(reason: AuthorizationCodeRejection, message: string): AuthorizationCodeReading {
  return Object.freeze({ kind: "rejected" as const, reason, message });
}
