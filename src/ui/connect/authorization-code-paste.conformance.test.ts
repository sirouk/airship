import { describe, expect, it } from "vitest";
import {
  OPENAI_CODEX_OAUTH,
  parsePastedAuthorizationCode,
} from "../../auth/provider-oauth";
import { normalizePastedValue, readAuthorizationCode } from "./authorization-code-paste";

/**
 * The paste field answers while a person types; the exchange in
 * `src/auth/provider-oauth` decides whether a code is real. Two readings of one
 * pasted value is exactly how a submit button ends up enabled on a value the
 * exchange refuses — or disabled on one it would have taken.
 *
 * This pins them together on a shared corpus. It is not a mock: both sides run
 * their real implementations over the same inputs.
 */
const CORPUS: readonly string[] = Object.freeze([
  "",
  "   ",
  "http://localhost:1455/auth/callback?code=ac_1a2b3c&state=st_9",
  "http://localhost:1455/auth/callback?code=ac_only",
  "http://localhost:1455/auth/callback",
  "http://localhost:1455/cb?error=access_denied&error_description=declined",
  "https://airship.example/#code=frag_code&state=frag_state",
  "?code=query_only_code&state=qs",
  "code=no_leading_delimiter&state=x",
  "bare_code_value",
  "code_part#state_part",
  "  padded_code  ",
  '"quoted_code"',
  "code with spaces",
  "localhost:1455/auth/callback?code",
  "a".repeat(9_000),
  "b".repeat(4_097),
  "c".repeat(4_096),
]);

/**
 * The one place the surface is deliberately stricter than the exchange: a
 * long-lived API key is printable ASCII and would parse, but pasting one here
 * puts a durable secret in a one-time field.
 */
const UI_ONLY_REFUSALS: readonly string[] = Object.freeze([
  "sk-proj-abcdefghijklmnop",
  "cpk_abcdefghijklmnop",
  "xai-abcdefghijklmn",
]);

function authorityReading(raw: string): Readonly<{ code: string; state?: string }> | "refused" {
  try {
    const parsed = parsePastedAuthorizationCode(raw, OPENAI_CODEX_OAUTH.provider);
    return parsed.state === undefined ? { code: parsed.code } : { code: parsed.code, state: parsed.state };
  } catch {
    return "refused";
  }
}

describe("paste field agrees with the authorization-code authority", () => {
  /*
   * The surface hands the *extracted* code onward, not the raw paste, so the
   * binding property is that the extracted value survives the authority
   * unchanged. This is what fails if the field ever enables submit on something
   * the exchange would refuse.
   */
  it.each(CORPUS)("hands the exchange a value it accepts unchanged, for %j", (raw) => {
    const reading = readAuthorizationCode(raw);
    if (reading.kind !== "accepted") return;
    expect(authorityReading(reading.code)).toEqual({ code: reading.code });
  });

  /*
   * And the converse: the field must not refuse a raw value the exchange would
   * have taken, because that is a route silently closed.
   */
  it.each(CORPUS)("refuses %j only when the exchange refuses it too", (raw) => {
    const reading = readAuthorizationCode(raw);
    if (reading.kind === "accepted") return;
    expect(authorityReading(raw), "the surface blocked submit on a value the exchange accepts").toBe("refused");
  });

  it.each(CORPUS)("agrees on the code and state when both read %j", (raw) => {
    const reading = readAuthorizationCode(raw);
    // Normalised, because unwrapping a quoted paste is the one recovery the
    // surface performs that the exchange does not.
    const authority = authorityReading(normalizePastedValue(raw));
    if (reading.kind !== "accepted" || authority === "refused") return;
    expect(authority.code).toBe(reading.code);
    expect(authority.state).toBe(reading.state);
  });

  it.each(UI_ONLY_REFUSALS)("refuses %j even though the exchange would parse it", (raw) => {
    const reading = readAuthorizationCode(raw);
    expect(reading).toMatchObject({ kind: "rejected", reason: "looks-like-an-api-key" });
    expect(authorityReading(raw)).not.toBe("refused");
  });
});
