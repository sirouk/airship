import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { credentialReading } from "./access-view";
import { SIGN_IN_UNAVAILABLE } from "./connect/connect-lanes";

const source = await readFile(new URL("./access-view.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./access-view.css", import.meta.url), "utf8");
const readiness = await readFile(new URL("./connect/chutes-signin-readiness.ts", import.meta.url), "utf8");
const connectSurface = await readFile(new URL("./connect/connect-surface.tsx", import.meta.url), "utf8");

describe("the Local check names the bind it performs", () => {
  it("tells the person that an answering server is connected, not merely listed", () => {
    /*
     * "Check this machine" commits a fabric connection for every loopback
     * server that answers (`checkLocalModelServers` → `fabric.connectLocal`).
     * The panel used to promise it only "renders what came back", which is a
     * check that silently binds — the sentence now states the consequence.
     */
    expect(connectSurface).toMatch(/connects anything\s+that answers/u);
    expect(connectSurface).not.toContain("renders only what came back");
  });
});

describe("Chutes connection method copy", () => {
  it("pins the connection to the transport's actual security posture", () => {
    expect(source).toContain("posture: transport.posture");
    expect(source).not.toContain('posture: "encrypted-unattested"');
  });

  it("names scoped sign-in without presenting cak_ as a manual credential", () => {
    expect(source).toContain("Chutes sign-in · scoped user session");
    expect(source).toContain('prefix="cpk_"');
    expect(source).not.toContain('prefix="cak_"');
    expect(source).not.toContain("cak_ · OAuth user token");
  });

  it("describes both OAuth boundaries without claiming the extension holds a secret", () => {
    expect(source).toContain('exchangeMode: "local-confidential-bridge" | "public-pkce"');
    expect(source).toContain('oauthDiagnostic?.exchangeMode === "local-confidential-bridge"');
    expect(source).toContain("The app secret stays in the localhost process, outside browser JavaScript.");
    expect(source).toContain("no client secret is used.");
    expect(source).toContain("only the same-origin handler performs token operations");
    /*
     * AMENDED — the handler check moved, and gained a second caller.
     *
     * The endpoint and its three operator sentences used to be spelled out
     * inline here and consulted only *after* the primary button was pressed,
     * which is how the lane came to advertise a route only the press could
     * discover was closed. They live in `connect/chutes-signin-readiness.ts`
     * now, pinned verbatim by that module's own test, and both the load-time
     * probe and the press-time check read them through one function so the two
     * cannot say different things about one handler.
     */
    expect(source).toContain('from "./connect/chutes-signin-readiness"');
    expect(source).toContain("const readiness = await probeChutesSignInHandler();");
    expect(readiness).toContain('fetchImpl(CHUTES_OAUTH_HANDLER_URL');
    expect(readiness).toContain("The local Chutes OAuth handler is not configured.");
    expect(source).not.toContain("extension adds the client secret");
  });

  it("uses capability names instead of credential prefixes as table headers", () => {
    expect(source).toContain('<th scope="col">Sign-in eligible</th><th scope="col">Key eligible</th><th scope="col">Active method</th>');
    expect(source).toContain("These are credential-class eligibility rules, not observed grants");
    expect(source).not.toContain('<th scope="col">cak_</th>');
    expect(source).not.toContain('<th scope="col">cpk_</th>');
  });

  it("describes the advanced key action as model discovery", () => {
    expect(source).toContain("Discovering encrypted-inference models available to this connection…");
    expect(source).toContain("Discover models with key");
    expect(source).toContain("read models, inference, profile, and account when Chutes authorizes them");
    expect(source).not.toContain("Checking the credential and discovering models");
    expect(source).not.toContain("validated by prefix");
    expect(source).not.toContain("Check API key and models");
  });

  it("retains connected model selection and the disconnected key branch", () => {
    expect(source).toContain("onSelectModel");
    expect(source).toContain("selectActiveModel");
    expect(source).toContain('role="tablist" aria-label="Chutes connection method"');
    expect(source).toContain('<section class="api-key-alternative"');
    // The three-way branch is unchanged; it is now preceded inside the same
    // panel by the OAuth notice, which used to have its only all-tone home on
    // the page-level boundary aside that moved into the lane's disclosure.
    expect(source).toContain("{isChutesConnected(connection) ? (");
    expect(source).toContain('<p class={`oauth-boundary-status ${oauthNotice.tone}`}');
  });

  it("gives a cold visitor a route when the sign-in exchange is unconfigured", () => {
    // The measured terminal drop-off: a gold "Recommended" button that returned
    // an operator-addressed error, with the working path collapsed beneath it
    // behind the word "Advanced".
    expect(source).toContain('export const CHUTES_ACCOUNT_URL = "https://chutes.ai/app";');
    expect(source).toContain("Create a key at chutes.ai → API keys ↗");
    expect(source).toContain("Chutes personal keys start with cpk_.");
    expect(source).not.toContain("Advanced: use a Chutes API key instead");
    expect(source).not.toContain("Continue to Chutes");
    expect(source).not.toContain("Recommended for this local lab");
    expect(source).not.toContain("Recommended. Connect profile, billing, and inference");
    // The operator sentence survives, one rung down, in the deployment detail.
    expect(source).toContain("Deployment detail: {signInBlockedReason}");
  });

  it("keeps in-page movement off the hash router", () => {
    // The two jump buttons are gone with the sections they pointed at, but the
    // rule they existed to satisfy is not: nothing on this route may navigate
    // by hash, because the hash is the router and `href="#section"` resolved to
    // an unknown route and ejected people to Chat. This is the stronger form —
    // it forbids the anchors outright rather than checking two call sites, and
    // it pins the remaining programmatic move to the panel a person just
    // filled in rather than to a 589px jump down the document.
    expect(source).not.toContain('<a href="#');
    expect(source).toContain('document.getElementById("connect-surface-card")');
    expect(source).toContain("requestAnimationFrame(() => focusConnectSurface())");
  });

  it("consumes a live extension observation and never manufactures one", () => {
    // The bridge package's probe is the only source of presence: no compiled-in
    // record, and no "present" literal anywhere in this view.
    expect(source).toContain("observeExtensionBridge = probeExtensionBridge");
    expect(source).toContain("void observeExtensionBridge().then(");
    expect(source).toContain("bridge,");
    expect(source).not.toContain('state: "present"');
    expect(source).not.toContain('state: "available"');
    expect(source).toContain("observeHostExtensionSupport(typeof navigator === \"undefined\" ? \"\" : navigator.userAgent)");
  });

  it("offers one honest extension install route and provider-specific key fallback", () => {
    expect(source).toContain("VITE_AIRSHIP_EXTENSION_INSTALL_URL");
    expect(source).toContain('role="tablist" aria-label="Chutes connection method"');
    expect(source).toContain("focusDirectProviders(provider?");
    expect(source).toContain("`provider-setup-${provider}`");
  });

  it("keeps the whole connect surface reachable once Chutes is connected", () => {
    // A connected person must still be able to add a second provider, so the
    // surface may not sit inside the connected branch — only the Chutes lane's
    // own panel may.
    const surface = source.indexOf("<ConnectSurface");
    expect(surface).toBeGreaterThan(0);
    expect(source.match(/<ConnectSurface/gu)).toHaveLength(1);
    expect(surface).toBeLessThan(source.indexOf("{isChutesConnected(connection) ? ("));
  });

  it("admits only source-declared text generation models to agent sessions", () => {
    expect(source.match(/inputModalities: \["text"\]/gu)).toHaveLength(2);
    expect(source.match(/outputModalities: \["text"\]/gu)).toHaveLength(2);
    expect(source).toContain("no text-in/text-out models explicitly eligible");
  });

  it("collects proof without breaking encrypted chat and does not offer an impossible strict policy", () => {
    expect(source).toContain('attestationMode: "optional"');
    expect(source).toContain('attestationMode: "required"');
    expect(source).toContain("attestationGate: createChutesAttestationGate");
    expect(source).toContain("Verify &amp; record");
    expect(source).toContain("Strict fail-closed · unavailable");
    expect(source).toContain("disabled={!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available}");
  });

  it("makes OAuth completion and the proof-policy finish step explicit without requiring a waiver", () => {
    expect(source).toContain("Chutes sign-in complete · finish connection");
    expect(source).toContain("No second credential or attestation waiver is required");
    expect(source).toContain("This policy is not proof");
    expect(source).toContain("Finish: verify &amp; connect");
    expect(source).not.toContain("I understand this endpoint is not independently attested");
    expect(source).not.toContain("Encrypted · TEE unverified");
  });

  it("presents Chutes as one inference connection and mounts additional providers accessibly", () => {
    /*
     * Six levels of page chrome became one `<RouteHeader>`. The title is still
     * a real `<h1>` carrying the id the section's `aria-labelledby` points at —
     * but it is no longer this file's word to choose. AMENDED: the `<h1>` read
     * `Connect models` while the rail row, the palette entry, the Trust hub tab
     * and the More sheet that all lead here read `Connection`, so it now comes
     * from `destinationLabel`. Not one word is dropped — `Connect models` moved
     * into the eyebrow, which the ⓘ panel renders as its heading, and the
     * eyebrow's own two words are still there beside it.
     */
    expect(source).toContain('title={destinationLabel("access")}');
    expect(source).toContain('const CONNECT_ROUTE_EYEBROW = "Connect models · inference connections";');
    expect(source).toContain('headingId="access-connection-title"');
    expect(source).toContain("<span>Chutes connection</span>");
    expect(source).toContain('aria-label="Additional cloud and local inference providers"');
  });

  it("keeps every sentence the collapsed page chrome carried", () => {
    // The information-fate line for the heading collapse, asserted rather than
    // asserted-by-hand: both paragraphs and the eyebrow's own claim survive
    // verbatim, one rung down, and the count chip's sentence is the thing its
    // number now demonstrates.
    expect(source).toContain("Use Chutes for application-encrypted inference, or connect browser-direct cloud and local models here. Credentials remain in page memory.");
    expect(source).toContain("Everything else in Airship — workspace, editor, terminal and Git — already works without this. Only chat needs a model, and connecting one never closes the others.");
    expect(source).toContain("Connect one, or several at once.");
    /*
     * AMENDED, and strengthened: the count chip's own eyebrow sentence still
     * has to survive, but the clause it had grown — the never-closes-the-others
     * promise — is a verbatim clause of the paragraph asserted one line above.
     * Two disclosures on the same 44px row stating one promise in one wording
     * is how a reader learns to skip both, so this now pins that the promise is
     * rendered exactly once. Deleting it from both places fails this assertion,
     * which is what the old `toContain` could not catch.
     */
    expect(source.match(/onnecting one never closes the others\./gu) ?? []).toHaveLength(1);
  });

  it("keeps the whole OAuth boundary aside, verbatim, inside the flow it describes", () => {
    expect(source).toContain("How this works · what the handler can see");
    expect(source).toContain("Local token-handler boundary");
    expect(source).toContain("Public-client OAuth boundary");
    expect(source).toContain("The localhost handler receives only the one-time code, PKCE verifier, and memory-only token requests.");
    expect(source).toContain("The client ID is public. A one-time PKCE verifier survives only the authorization redirect");
    expect(source).toContain("<summary>Registration details</summary>");
    expect(source).toContain("Start sign-in again");
    // An error is never behind a closed triangle: the diagnostic alert is a
    // sibling of the Sign in button, and the notice is the first thing in the
    // Chutes panel, above the branch that decides which control renders.
    expect(source.indexOf('role="alert">{oauthDiagnosticError}')).toBeGreaterThan(source.indexOf("Sign in to Chutes\n"));
    expect(source.indexOf('<p class={`oauth-boundary-status ${oauthNotice.tone}`}')).toBeLessThan(source.indexOf("{isChutesConnected(connection) ? ("));
  });

  it("retires the sign-in notice on the one state that falsifies it, and never instructs from it", () => {
    /*
     * AMENDED, and strengthened.
     *
     * The previous shape kept "Choose a model, then finish the connection." in
     * the completion copy and tried to make it true by gating the whole notice
     * on `Boolean(candidate)`. That gate is unsatisfiable at the moment it is
     * needed: `candidate` is only set once model discovery returns, which
     * happens after the exchange and can fail outright, so the single
     * confirmation a returning redirect produces was suppressed for the entire
     * discovery window and for good whenever discovery failed — the case where
     * it matters most, because it is what places the failure downstream of the
     * sign-in. (e2e/connect-inference.spec.ts:148 caught exactly this.)
     *
     * The instruction is now deleted from the notice rather than guarded, so
     * the assertions below are stronger than the ones they replace: the old
     * test permitted the false sentence in one state and policed when it
     * showed; this one forbids the notice from containing an instruction about
     * the chooser in every state, and still asserts the terminal transition on
     * a committed connection that the finding asked for. `.oauth-finish-banner`
     * remains the one place that names the next step, and it renders only
     * inside the `candidate` branch that owns the chooser.
     */
    expect(source).toContain("const oauthNoticeVisible = oauthNotice !== undefined && !isChutesConnected(connection);");
    expect(source).toContain("{oauthNotice && oauthNoticeVisible ? <p class={`oauth-boundary-status ${oauthNotice.tone}`}");
    // The exchange is reported as a fact, with no trailing instruction.
    expect(source).toContain('return "Chutes sign-in complete with S256 PKCE through the localhost handler.";');
    expect(source).toContain('return "Chutes sign-in complete with S256 PKCE.";');
    expect(source).not.toContain("Choose a model, then finish the connection.");
    // …and the next step is still stated exactly once, beside the chooser.
    expect(source).toContain('<div class="oauth-finish-banner" role="status" aria-live="polite">');
    expect(source.match(/Choose the session model and finish\./gu) ?? []).toHaveLength(1);
    expect(source.indexOf('<div class="oauth-finish-banner"')).toBeGreaterThan(source.indexOf(") : candidate ? ("));
  });

  it("keys the proof-policy disclosure on the capability and keeps both descriptions", () => {
    // The 465×108px tile for a permanently disabled option collapses, but only
    // while `available === false`, and both option descriptions plus the
    // capability's own reason stay verbatim inside a summary that says what it
    // contains. The honesty line never enters a disclosure.
    expect(source).toContain("if (!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available)");
    expect(source).toContain("Strict fail-closed is unavailable in this build. Why, and what each policy does");
    expect(source).toContain("CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason");
    expect(source).toContain("Recommended. Evaluate still-current endpoint evidence before every turn");
    expect(source).toContain('<p class="proof-policy__caveat">This policy is not proof.');
  });
});

describe("the Chutes lane says when it cannot work, and why, where a person is standing", () => {
  it("keeps the OAuth tab selectable so its reason is reachable at all", () => {
    /*
     * The tab was `disabled` whenever sign-in was unavailable and the panel was
     * never mounted, so `oauthOrigin.reason` — the one string naming the cause —
     * rendered in no deployment that had a cause. The tab is the default only
     * where it works; it is selectable everywhere, which is the shape
     * `initialConnectMethod()` already uses for the cloud lanes.
     */
    expect(source).toContain('const activeChutesMethod = chutesMethod ?? (chutesSignInAvailable ? "oauth" : "api-key");');
    expect(source).not.toContain("disabled={!chutesSignInAvailable}");
  });

  it("leads with the consequence and keeps the operator sentence one rung down", () => {
    /*
     * AMENDED, and this is a decision rather than a relaxation.
     *
     * The previous shape put the operator's restart instruction at lane
     * altitude because it was the only place it had ever been reachable. It is
     * reachable, and it is still the wrong headline: it is addressed to whoever
     * runs the lab, and a person who has just arrived gets no consequence and
     * no route from it. So the consequence and the working alternative are the
     * lane-altitude sentence, outside every disclosure, and the operator
     * sentence is one rung down inside a disclosure that names what it holds —
     * not nested inside the closed `.oauth-mechanism`, which is the burial the
     * previous fix was undoing.
     */
    const blocked = source.indexOf('<div class="connect-method__blocked" role="alert">');
    const cause = source.indexOf('<details class="connect-method__cause">');
    const mechanism = source.indexOf('<details class="oauth-mechanism">');
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(cause);
    expect(cause).toBeLessThan(mechanism);
    /*
     * The sentence itself is asserted through the import, not through a copy of
     * the literal: it used to be declared here *and* retyped in
     * connect-lanes.ts, which is the lane row a person reads 40px above this
     * panel on a phone. The panel now takes the lane's constant, so this test
     * fails if either the constant or the import is unpicked.
     */
    expect(SIGN_IN_UNAVAILABLE).toBe("Chutes sign-in is not available in this build.");
    expect(source).toContain("  SIGN_IN_UNAVAILABLE,\n");
    expect(source).not.toContain("const SIGN_IN_UNAVAILABLE =");
    expect(source).toContain("<strong>{SIGN_IN_UNAVAILABLE}</strong> Paste a Chutes API key instead — it works now and stays in page memory.");
    expect(source).toContain("<summary>Why this build cannot sign in</summary>");
    expect(source).toContain("Deployment detail: {signInBlockedReason}");
    expect(source).toContain('<button type="button" onClick={() => setChutesMethod("api-key")}>Use an API key</button>');
    // The consequence is above the cause in the rendered order, not merely
    // present somewhere in the file.
    expect(source.indexOf("{SIGN_IN_UNAVAILABLE}")).toBeLessThan(cause);
  });

  it("stops calling the OAuth tab Primary before the exchange has answered", () => {
    // `Primary` is a promise. It was printed from the registration alone, so a
    // build whose localhost handler holds no client secret still led with it.
    expect(source).toContain('<small>{chutesSignInAvailable ? "Primary" : signInChecking ? "Checking" : "Unavailable in this build"}</small>');
    expect(source).not.toContain('{chutesSignInAvailable ? "Primary" : "Unavailable"}');
  });

  it("keeps the control that cannot run explicitly disabled, beside one that can", () => {
    // A gold "Recommended" button returning a developer-facing error is the
    // measured cold-visitor drop-off. It stays gated — and it is no longer the
    // only thing in the panel, because the blocked block above it carries both
    // the cause and a control that works.
    expect(source).toContain("disabled={busy || !online || !chutesSignInAvailable}");
    expect(source.indexOf('<div class="connect-method__blocked">'))
      .toBeLessThan(source.indexOf("Sign in to Chutes\n"));
  });
});

describe("what stands between the tab and the field", () => {
  it("stops rendering a heading that is the tab beside it and the label under it", () => {
    // `Connect with a Chutes API key` was the fourth rendering of the same
    // three words inside one open lane. It survives as this region's accessible
    // name, so the region is still announced.
    // Open-ended: the same region now also carries the `tabpanel` half of the
    // method switch's tablist contract. What is asserted is the accessible
    // name surviving, not the full attribute list.
    expect(source).toContain('<section class="api-key-alternative" aria-label="Connect with a Chutes API key"');
    expect(source).not.toContain('<strong id="chutes-api-key-title">');
  });

  it("puts the field before the class that describes it, and keeps every word of that class", () => {
    expect(source.indexOf('id="chutes-credential-input"')).toBeLessThan(source.indexOf('<div class="credential-types"'));
    expect(source).toContain("Chutes personal keys start with cpk_.");
    expect(source).toContain("read models, inference, profile, and account when Chutes authorizes them");
    expect(source).toContain('prefix="cpk_"');
  });

  it("states the negative arm of credential recognition instead of implying it", () => {
    // The only previous signal for "this is not a Chutes credential" was an
    // absent highlight, which is a claim nobody can see being made.
    expect(credentialReading("inference-api-key")).toBe("Read as a Chutes personal key (cpk_). Nothing has been sent yet.");
    expect(credentialReading("oauth-user-token")).toBe("Read as a Chutes sign-in token (cak_). Nothing has been sent yet.");
    expect(credentialReading(undefined)).toContain("Not read as a Chutes credential.");
    // Only the prefix is inspected here, so nothing may read as accepted.
    for (const kind of ["inference-api-key", "oauth-user-token", undefined] as const) {
      expect(credentialReading(kind)).not.toMatch(/valid|accepted|verified/iu);
    }
  });

  it("keeps the credential class on a phone instead of deleting it at 640px", () => {
    // The override that hid it existed because it was an 88px bordered tile
    // above the input; it is now two lines beneath the input, so a phone reads
    // the same sentence a desktop does.
    expect(styles).not.toMatch(/\.api-key-alternative \.credential-types \{\s*display: none/u);
    expect(styles).not.toMatch(/\.credential-types \{\s*display: none/u);
  });
});

describe("a refused key is reported as a refused key", () => {
  it("names the key rather than an unrelated networking noun", () => {
    // The shipped banner said "Endpoint discovery denied. Reconnect with
    // chutes:invoke or an API key." to a person who had just pasted an API key,
    // naming an OAuth scope that appears nowhere else in the product.
    expect(source).toContain("<strong>Chutes did not accept this key.</strong> The catalog is readable without a key, so listing models succeeded; authorization is checked when you connect, and it failed. Check the key at <a href={CHUTES_API_KEYS_URL} target=\"_blank\" rel=\"noreferrer\">chutes.ai → API keys ↗</a>, or paste a different one.");
    expect(source).toContain('failure.kind === "credential" && credential.kind === "inference-api-key"');
  });

  it("keeps the provider's own words, verbatim, under a disclosure that says so", () => {
    // Relocation, not removal: `chutes:invoke` and the rest of the mapped
    // provider sentence remain in the DOM, one rung down.
    expect(source).toContain("<summary>Provider response</summary>");
    expect(source).toContain("{keyRefusal.providerResponse}");
    expect(source).toContain("setKeyRefusal(Object.freeze({ providerResponse: failure.message }))");
    const banner = source.indexOf("Chutes did not accept this key.");
    expect(banner).toBeLessThan(source.indexOf("<summary>Provider response</summary>"));
  });

  it("leaves the field masked and filled so the key can be corrected", () => {
    // The field emptied itself on refusal, so the only way to fix one wrong
    // character was to fetch and paste the whole key again.
    expect(source).toContain("field.value = credential.value;");
    expect(source).toContain('type="password"');
    // …and the refusal is dropped the moment the value it was about changes.
    expect(source).toContain("setKeyRefusal(undefined);");
  });

  it("suppresses the at-rest format hint while a refusal is showing", () => {
    // "Chutes personal keys start with cpk_" beside a well-formed cpk_ that
    // Chutes refused describes a problem the person does not have.
    expect(source).toContain("{keyRefusal ? null : (");
    const suppression = source.indexOf("{keyRefusal ? null : (");
    expect(suppression).toBeLessThan(source.indexOf('<div class="credential-types"'));
    // The hint itself is not deleted — it is still in the file, for every
    // state that is not a refusal.
    expect(source).toContain("Chutes personal keys start with cpk_.");
  });
});

describe("the catalog enrichment retry is offered in the state it is a retry for", () => {
  it("gates the control on 'not fresh' rather than on the state this route cannot produce", () => {
    // Both catalog reads here pass `includeManagement: true`, so the client
    // never returns `disabled` for management on this route: the old gate named
    // the one member of the union that a failed read can never land in, which
    // left a failed management read with no recovery at all.
    expect(source).toContain('{candidate.managementState !== "fresh" ? <button type="button" onClick={() => void enrichCatalog()} disabled={busy || !online}>Load live availability metadata</button> : null}');
    expect(source).not.toContain('candidate.managementState === "disabled" ?');
    expect(source.match(/new ModelCatalogClient\(\{ includeManagement: true/gu)).toHaveLength(2);
    // A second failure keeps the panel: the candidate is replaced only after
    // the enriched catalog has produced a usable model list.
    expect(source).toContain("if (models.length === 0) throw new Error(");
    expect(source.indexOf("if (models.length === 0) throw new Error("))
      .toBeLessThan(source.indexOf("setCandidate(Object.freeze({\n        ...prior,"));
  });

  it("gives the capability marks a name ARIA will not discard", () => {
    // `aria-label` on a bare span is dropped — its computed role is generic —
    // and a tick was the cell's only text, so the matrix announced "✓" and "—".
    expect(source).toContain('<span class={available ? "capability-mark available" : "capability-mark"} role="img" aria-label={available ? "Available" : "Unavailable"}>');
    expect(source).toContain('<span aria-hidden="true">{available ? "✓" : "—"}</span>');
  });
});

describe("the model metadata is inside the picker, not beside it", () => {
  it("hands the picker the facts instead of restating them in a parallel grid", () => {
    expect(source).toContain("attachFacts");
    expect(source).not.toContain("ModelCandidateSummary");
    expect(source).not.toContain("model-candidate-summary");
    expect(styles).not.toContain("model-candidate-summary");
  });
});
