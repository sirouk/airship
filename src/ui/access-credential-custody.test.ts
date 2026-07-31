import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { credentialReading, NO_CREDENTIAL_ATTEMPT } from "./access-view";

const source = readFileSync(new URL("./access-view.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./access-view.css", import.meta.url), "utf8");

/** Code only: a defect quoted in the comment that records it is prose. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/*
 * Driven at 1440x900 and 390x844 with **chutes.ai aborted, a 37-character key
 * pasted, "Discover models with key" tapped:
 *
 *   BEFORE  value "cpk_myrealkeypastedcarefully000000000" · "Read as a Chutes
 *           personal key (cpk_). Nothing has been sent yet."
 *   AFTER   value "" · "Not read as a Chutes credential. Chutes personal keys
 *           start with cpk_." · "Request failed. Local state was kept; no
 *           remote success is assumed."
 *
 * Three sentences on one screen, two of them false about the same key: it was
 * destroyed, and then diagnosed as malformed. On a phone the cost of the first
 * is an app switch to a password manager for every network dropout, and the
 * cost of the second is a person revoking a key that was never wrong.
 */
describe("a pasted secret survives the request it was pasted for", () => {
  it("does not empty the field when discovery fails", () => {
    const discovery = code(source.slice(source.indexOf("async function discoverCredential"), source.indexOf("async function discover()")));
    const failure = discovery.slice(discovery.indexOf("} catch (caught) {"));
    expect(failure).not.toContain('input.value = ""');
    // Clearing the *kind* is the other half of the same defect: it made the
    // caption describe an empty field as a malformed credential.
    expect(failure).not.toContain("setDetectedKind(undefined)");
  });

  it("returns the key to the field on every failed verification, through one implementation", () => {
    // Both branches of `activate`'s catch — a refusal and a network failure —
    // hand the value back. The refusal branch used to do it by hand while the
    // other silently dropped it.
    expect(source).toContain("function returnCredentialToField(credential: EphemeralChutesCredential)");
    expect(source.match(/returnCredentialToField\(credential\)/gu)).toHaveLength(2);
    expect(source).toContain("field.value = credential.value;");
  });

  it("stops claiming a reading of a field it emptied itself", () => {
    /*
     * `credentialTyped` is what renders the reading, and only an input event
     * cleared it — which a programmatic `input.value = ""` does not fire. So
     * "Use a different credential" remounted an empty field under "Not read as
     * a Chutes credential. Chutes personal keys start with cpk_.": the same
     * verdict about nothing that the failure path produced. The flag now moves
     * wherever the value does.
     */
    const discovery = code(source.slice(source.indexOf("async function discoverCredential"), source.indexOf("async function discover()")));
    const clear = discovery.indexOf('input.value = ""');
    expect(clear).toBeGreaterThan(-1);
    expect(discovery.slice(clear, clear + 200)).toContain("setCredentialTyped(false)");
  });

  it("keeps the field above the size that zooms iOS Safari and never zooms back", () => {
    const rule = styles.slice(styles.indexOf(".credential-entry input,"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("var(--fs-field)");
  });
});

describe("the reading under the field says what happened to the key", () => {
  it("is unchanged before anything is pressed", () => {
    expect(credentialReading("inference-api-key")).toBe("Read as a Chutes personal key (cpk_). Nothing has been sent yet.");
    expect(credentialReading("inference-api-key", false, NO_CREDENTIAL_ATTEMPT)).toBe("Read as a Chutes personal key (cpk_). Nothing has been sent yet.");
  });

  it("states both halves of the in-flight truth: something left, and it was not the key", () => {
    /*
     * Measured on this build, one press of "Discover models with key":
     *   +28ms GET llm.chutes.ai/v1/models        auth=no
     *   +28ms GET api.chutes.ai/chutes/          auth=no
     *   +28ms GET api.chutes.ai/chutes/utilization auth=no
     * The key rides only on the Finish leg (auth=YES to api.chutes.ai). So the
     * in-flight arm may not say "Nothing has been sent yet." and may not say
     * the key was sent either — under-claiming and over-claiming egress are the
     * same defect.
     */
    for (const kind of ["inference-api-key", "oauth-user-token"] as const) {
      const reading = credentialReading(kind, true);
      expect(reading, kind).not.toContain("Nothing has been sent");
      expect(reading, kind).toContain("not attached");
      expect(reading, kind).toMatch(/waiting/iu);
      expect(reading, kind).not.toMatch(/valid|accepted|connected|verified/iu);
    }
  });

  it("never diagnoses a well-formed key as the wrong kind of credential after a failure", () => {
    const reading = credentialReading("inference-api-key", false, { state: "failed" });
    expect(reading).toContain("Read as a Chutes personal key (cpk_).");
    expect(reading).not.toContain("Not read as a Chutes credential");
    // The two facts a person needs before they go and revoke a working key.
    expect(reading).toContain("has not left this device");
    expect(reading).toContain("still in this field");
  });

  it("names the host when the key really did leave, and does not when it did not", () => {
    const sent = credentialReading("inference-api-key", false, { state: "failed", sentTo: "api.chutes.ai" });
    expect(sent).toContain("It was sent to api.chutes.ai and that attempt failed.");
    expect(sent).not.toContain("has not left this device");
    expect(credentialReading("inference-api-key", false, { state: "failed" })).not.toContain("api.chutes.ai");
  });

  it("keeps the negative arm for a field that genuinely holds no Chutes credential", () => {
    // A value that never parsed has no custody story, and inventing one would
    // be the same over-claim in the opposite direction.
    expect(credentialReading(undefined, false, { state: "failed" }))
      .toBe("Not read as a Chutes credential. Chutes personal keys start with cpk_.");
  });

  it("goes stale the moment the field is edited", () => {
    const inspect = source.slice(source.indexOf("function inspectInput()"), source.indexOf("function returnCredentialToField"));
    expect(inspect).toContain("setLastAttempt(NO_CREDENTIAL_ATTEMPT)");
  });

  it("reads the host it names from the egress record rather than assuming it", () => {
    expect(source).toContain("function attemptOutcome(since: number): CredentialAttempt");
    expect(source).toContain("lastCredentialEgress(egressRecorder()?.read() ?? [], since)");
  });
});

/*
 * Driven with `cpk_notarealkey00000000000000000000000`: discovery returned 13
 * priced candidates and the chooser wore "🔒 Chutes API key · direct session" —
 * the *connected* summary's own sentence — ten seconds before Chutes answered
 * 401 to the first request that carried the key. The catalog is readable
 * without a credential, so nothing on that screen had been authorized at all.
 */
describe("an unproven key never wears a proven credential's sentence", () => {
  it("keeps 'direct session' for the connection and not for the candidate", () => {
    expect(source).toContain('<Seal state="asserted" density="chip" label={candidateCredentialLabel(candidate.credentialKind)} />');
    expect(source).toContain('"Chutes API key · not authorized yet"');
    const candidateBlock = source.slice(source.indexOf('<div class="candidate-identity">'), source.indexOf('class="candidate-model"'));
    // No padlock: a lock glyph is a security claim, and this row has no
    // security fact to report yet.
    expect(candidateBlock).not.toContain('name="lock"');
    expect(candidateBlock).not.toContain("credentialKindLabel(candidate.credentialKind)}</strong>");
  });

  it("leaves the sign-in arm's wording alone, because that exchange did happen", () => {
    const label = source.slice(source.indexOf("function candidateCredentialLabel"));
    expect(label.slice(0, label.indexOf("\n}"))).toContain('kind === "oauth-user-token"');
    expect(label.slice(0, label.indexOf("\n}"))).toContain("credentialKindLabel(kind)");
  });
});

describe("the hosts a control reaches are named before it is pressed", () => {
  it("puts the pre-flight sentence in the button's own description", () => {
    expect(source).toContain('<p class="credential-preflight" id="chutes-discovery-preflight">');
    expect(source).toContain('aria-describedby="chutes-discovery-preflight"');
    expect(source).toContain("{CHUTES_DISCOVERY_PREFLIGHT}");
  });

  it("mounts the egress record on the route that causes most of the egress", () => {
    expect(source).toContain("<EgressPanel />");
  });
});
