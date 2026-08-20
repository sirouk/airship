import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_MODEL_ORIGINS,
  LM_STUDIO_DEFAULT_ENDPOINT,
  OLLAMA_DEFAULT_ENDPOINT,
  resolveLocalEndpoint,
} from "../inference/local";
import type { InferenceModelDescriptor } from "../inference/providers";
import {
  customProviderErrorRoute,
  modelOptionDescription,
  providerBoundaryLabel,
  providerConnectionCountLabel,
  providerFabricReconnectIntent,
  safeProviderErrorMessage,
  supportedModelCapabilityLabels,
} from "./provider-connections-view";

const source = await readFile(new URL("./provider-connections-view.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./provider-connections-view.css", import.meta.url), "utf8");
const declarations = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
const customProviderCardSource = source.slice(
  source.indexOf("function OpenAiCompatibleProviderCard"),
  source.indexOf("function CloudProviderCard"),
);

describe("provider connection presentation", () => {
  it("handles Chutes through the same provider-fabric return path as other providers", () => {
    const intent = {
      providerId: "chutes",
      method: "api-key",
      model: "deepseek",
      connectionId: "chutes-1",
      connectionGeneration: 1,
      returnSessionId: "session-1",
    } as const;
    expect(providerFabricReconnectIntent(intent)).toBe(intent);
    expect(providerFabricReconnectIntent({ ...intent, providerId: "openai", connectionId: "openai-1" })).toEqual({
      ...intent,
      providerId: "openai",
      connectionId: "openai-1",
    });
  });

  it("pluralizes the connected count without ambiguous shorthand", () => {
    expect(providerConnectionCountLabel(0)).toBe("0 connections");
    expect(providerConnectionCountLabel(1)).toBe("1 connection");
    expect(providerConnectionCountLabel(3)).toBe("3 connections");
  });

  it("shows only capabilities carrying supported source evidence", () => {
    const model = fixtureModel({
      "image-input": { state: "supported", source: "provider-directory" },
      reasoning: { state: "unknown", source: "provider-directory" },
      embeddings: { state: "unsupported", source: "provider-directory" },
      "tool-calling": { state: "supported", source: "live-probe" },
    });
    expect(supportedModelCapabilityLabels(model)).toEqual(["Vision", "Tools"]);
    expect(modelOptionDescription(model)).toBe(
      "Provider catalog · available · Vision · Tools",
    );
  });

  it("does not infer capabilities from a model name", () => {
    const model = fixtureModel({}, "definitely-vision-reasoning-model");
    expect(supportedModelCapabilityLabels(model)).toEqual([]);
    expect(modelOptionDescription(model)).toContain("capabilities not reported");
  });

  it("names transport boundaries without promoting them to proof", () => {
    expect(providerBoundaryLabel("provider-tls")).toBe("Provider TLS · browser direct");
    expect(providerBoundaryLabel("loopback-local")).toBe("This machine · loopback");
    expect(providerBoundaryLabel("provider-tls")).not.toMatch(/\bverified\b/iu);
  });

  it("redacts credential-shaped material and bounds raw provider failures", () => {
    const secret = "cpk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example";
    const message = safeProviderErrorMessage(
      new Error(`Bearer abcdefgh rejected ${secret} ${"x".repeat(500)}`),
      true,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("abcdefgh");
    expect(message).toContain("[credential]");
    expect(message.length).toBeLessThanOrEqual(320);
    expect(safeProviderErrorMessage(new Error("network"), false)).toContain("Offline");
  });

  it("routes each local custom-provider refusal to its owning field", () => {
    expect(customProviderErrorRoute(new TypeError("Provider name is invalid."))).toEqual({
      field: "providerName",
      alertSummary: false,
    });
    expect(customProviderErrorRoute(new TypeError("Provider base URL must use HTTPS."))).toEqual({
      field: "baseUrl",
      alertSummary: false,
    });
    expect(customProviderErrorRoute(new TypeError("Provider models URL must not contain a query."))).toEqual({
      field: "modelsUrl",
      alertSummary: false,
    });
    expect(customProviderErrorRoute(new TypeError("The API-key header name is invalid."))).toEqual({
      field: "apiKeyHeader",
      alertSummary: false,
    });
    expect(customProviderErrorRoute(new TypeError("The API-key format is invalid."))).toEqual({
      field: "apiKeyScheme",
      alertSummary: false,
    });
    expect(customProviderErrorRoute(new TypeError("Inference API key is invalid."))).toEqual({
      field: "apiKey",
      alertSummary: false,
    });
  });

  it("keeps network and unmatched custom-provider refusals in an alert summary", () => {
    const network = Object.assign(new Error("Gateway could not be reached from this browser."), {
      code: "network-or-cors",
    });
    expect(customProviderErrorRoute(network)).toEqual({ field: "baseUrl", alertSummary: true });
    expect(customProviderErrorRoute(network, { modelsUrl: "https://catalog.example/models" })).toEqual({
      field: "modelsUrl",
      alertSummary: true,
    });
    expect(customProviderErrorRoute(Object.assign(new Error("Gateway rejected the request with HTTP 401."), {
      code: "http",
      status: 401,
    }))).toEqual({ field: "apiKey", alertSummary: true });
    expect(customProviderErrorRoute(new Error("Web Crypto SHA-256 is unavailable."))).toEqual({
      alertSummary: true,
    });
  });
});

describe("provider connection component contract", () => {
  it("keeps API keys DOM-only and clears them only after a successful connection", () => {
    expect(source).toContain("keyInput.current?.value");
    expect(source).toContain('keyInput.current.value = ""');
    expect(source).toContain("onConnect(key).then((succeeded)");
    expect(source).toContain("if (!succeeded)");
    expect(source.indexOf("if (!succeeded)")).toBeLessThan(source.indexOf('keyInput.current.value = ""'));
    expect(source).not.toMatch(/const \[apiKey,\s*setApiKey\]/u);
    expect(source).not.toContain("value={apiKey}");
  });

  it("offers a provider-neutral OpenAI-compatible endpoint form without storing the key in component state", () => {
    expect(source).toContain("<OpenAiCompatibleProviderCard");
    expect(source).toContain("browserInferenceFabric.connectOpenAiCompatible");
    expect(source).toContain("API base URL · HTTPS");
    expect(source).toContain("Model catalog URL · optional");
    expect(source).toContain("API-key header");
    expect(source).toContain('apiKeyScheme: rawKey ? "raw" : "bearer"');
    expect(source).not.toMatch(/useState\([^)]*(?:apiKey|credential)/iu);
    expect(source).toContain("access is checked on the first turn");
    expect(source).toContain("Saved conversations retain the provider ID, model, and old connection generation, but never the URL or key");
  });

  it("submits the custom endpoint as an accessible form and focuses only the implicated field", () => {
    expect(customProviderCardSource).toContain("<form");
    expect(customProviderCardSource).toContain("onSubmit={(event) => {");
    expect(customProviderCardSource).toContain("event.preventDefault()");
    expect(customProviderCardSource).toContain('type="submit"');
    expect(customProviderCardSource).not.toContain("onClick={() =>");
    expect(customProviderCardSource).toContain("aria-labelledby={titleId}");
    for (const field of [
      "providerName",
      "baseUrl",
      "modelsUrl",
      "apiKeyHeader",
      "apiKeyScheme",
      "apiKey",
    ]) {
      expect(customProviderCardSource).toContain(`aria-invalid={connectionErrorField === "${field}" ? "true" : undefined}`);
    }
    expect(customProviderCardSource).toContain('aria-describedby={connectionErrorField === "providerName" ? errorId : undefined}');
    expect(customProviderCardSource).toContain("advancedSettings.current.open = true");
    expect(customProviderCardSource).toContain("requestAnimationFrame(() => target?.focus())");
    expect(customProviderCardSource).toContain('case "apiKey": target = keyInput.current; break;');
    expect(customProviderCardSource).not.toContain(": keyInput.current;");
    expect(customProviderCardSource).toContain('role={connectionErrorAlert ? "alert" : undefined}');
    expect(customProviderCardSource).not.toContain("keyInput.current?.focus()");
    expect(customProviderCardSource).not.toMatch(/<input[^>]+name=/u);
  });

  it("keeps a failed cloud credential and its recovery message in the provider card", () => {
    expect(source).toContain('}, true, "setup")');
    expect(source).toContain('error?.placement === "setup"');
    expect(source).toContain('class="provider-fabric__error provider-setup-card__error" role="alert"');
    expect(source).toContain("Your credential and acknowledgement were kept");
    expect(source).toContain("keyInput.current?.focus()");
    expect(source).toContain("aria-describedby={connectionError ? errorId : undefined}");
  });

  it("derives the API-key warning from the provider registry without advertising a dead OAuth path", () => {
    expect(source).toContain("apiKeyMethod.warning");
    expect(source).not.toContain("provider.oauth.detail");
    expect(source).not.toContain('provider.oauth.state === "configured-public-pkce"');
    expect(source).not.toContain("const CLOUD =");
  });

  it("states the only sign-in path this build actually wires", () => {
    expect(source).toContain("Why a page-memory API key?");
    expect(source).toContain("No account sign-in flow is wired into this build for {provider.label}.");
    expect(source).toContain("keeps it only in this page, and sends it directly to the provider when needed");
    expect(source).not.toContain("reviewed public-PKCE client");
    expect(source).not.toContain("connectOAuth");
  });

  it("requires confirmation for the active route and protects an exact return pin even when inactive", () => {
    expect(source).toContain("Confirm disconnect");
    expect(source).toContain("if (activeModel && !disconnectArmed)");
    expect(source).toContain('const protectsReturn = reconnectDisposition === "exact"');
    expect(source).toContain("disabled={disabled || protectsReturn}");
    expect(source).toContain("Connection held for requested return");
    expect(source).toContain("This exact connection is held for the requested conversation");
    expect(source).toContain("This conversation remains readable");
    expect(source).toContain("focusNoticeAfterRemoval.current = true");
    expect(source).toContain("tabIndex={-1}");
  });

  it("delegates disconnect to the app-level route authority", () => {
    expect(source).toContain("await onDisconnect(entry.connection.id)");
    expect(source).not.toContain("browserInferenceFabric.disconnect(");
  });

  it("admits only one provider/session transaction at a time", () => {
    expect(source).toContain("if (abort.current) return");
    expect(source).toContain("disabled={Boolean(busyConnection)}");
    expect(source).not.toContain("A newer connection operation started.");
  });

  it("offers continuation only to the exact pinned connection generation", () => {
    expect(source).toContain("const fabricReconnectIntent = providerFabricReconnectIntent(reconnectIntent)");
    expect(source).toContain("const reconnectDispositions = reconnectIntent");
    expect(source).toContain("{fabricReconnectIntent ? (");
    expect(source).toContain("providerReconnectDisposition(reconnectIntent, entry)");
    expect(source).toContain('reconnectDisposition === "exact"');
    expect(source).toContain('reconnectDisposition !== "exact"');
    expect(source).toContain("disabled={disabled || reconnectDisposition !== undefined || entry.models.length === 0}");
    expect(source).toContain("Exact connection no longer held");
    expect(source).toContain("onClick={onAbandonReconnect}");
    expect(source).toContain("Abandon return request");
  });

  it("cannot abandon a return request while its connection transaction is still running", () => {
    expect(source).toContain("{busyConnection");
    expect(source).toContain('aria-disabled="true">Connection change in progress');
  });

  it("distinguishes an exact return from a blocked return without using verified green for both", () => {
    expect(source).toContain('provider-fabric__return--${exactReconnectHeld ? "exact" : "blocked"}');
    expect(declarations).toMatch(/\.provider-fabric__return--exact\s*\{[^}]*--v-info/gu);
    expect(declarations).toMatch(/\.provider-fabric__return--blocked\s*\{[^}]*--v-caution/gu);
    expect(declarations).toMatch(/\.provider-fabric__return--blocked > span\[aria-hidden="true"\]\s*\{[^}]*--v-caution/gu);
  });

  it("sizes only the hidden status marker as a dot", () => {
    expect(declarations).toMatch(
      /\.provider-fabric__notice > span\[aria-hidden="true"\]\s*\{[^}]*width:\s*7px;[^}]*flex:\s*0 0 7px;/u,
    );
    expect(declarations).not.toMatch(/\.provider-fabric__notice > span\s*\{/u);
    expect(declarations).not.toMatch(/\.provider-fabric\[aria-busy="true"\] \.provider-fabric__notice > span\s*\{/u);
  });

  it("keeps a failed return check beside and associated with its continuation control", () => {
    expect(source).toContain('reconnects ? "connection" : "surface"');
    expect(source).toContain('error?.placement === "connection"');
    expect(source).toContain('aria-describedby={activationError ? activationErrorId : undefined}');
    expect(source).toContain('class="provider-fabric__error provider-connection__activation-error" role="alert"');
    expect(source).toContain('error?.placement === "surface"');
  });

  it("keeps reconnect progress in the prose column on narrow screens", () => {
    const phone = styles.slice(styles.indexOf("@media (max-width: 520px)"));
    expect(phone).toMatch(
      /\.provider-fabric__notice button,\s*\.provider-fabric__return-pending \{[^}]*grid-column: 2;[^}]*white-space: normal;/u,
    );
  });

  it("exposes accessible live state and compact mobile layout", () => {
    expect(source).toContain('aria-busy={Boolean(busyConnection)}');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('class="provider-fabric__cloud-disclosure"');
    expect(source).toContain('placement="down"');
    expect(source).toContain("cardId={`provider-setup-${provider.id}`}");
    expect(source).toContain("tabIndex={-1}");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain(":focus-visible");
  });

  /*
   * The card printed one origin in a `<code>` and dialled it, so the connection
   * was hard-pinned to 2 of the 12 loopback origins this build ships and lists
   * as exact `connect-src` sources. A developer on `OLLAMA_HOST=:11435` — the
   * configuration `DEFAULT_LOCAL_MODEL_ORIGINS` names as its own reason for
   * enumerating ports — had no field, no slash command and no preference
   * anywhere in the product to reach it, under a sentence claiming Airship
   * checks only the defaults shown.
   */
  it("dials the endpoint the person typed, not a literal in this file", () => {
    expect(source).toContain("options: { endpoint }");
    expect(source).toContain("browserInferenceFabric.connectLocal({ kind: provider.kind, options: { endpoint }, signal })");
    expect(source).toContain("const [endpoint, setEndpoint] = useState(defaultEndpoint)");
    expect(source).toContain("onInput={(event) => setEndpoint(event.currentTarget.value)}");
    expect(source).toContain("onConnect(endpoint.trim())");
    // The defaults are the adapters', not retyped here.
    expect(source).not.toContain("http://127.0.0.1:");
    expect(source).toContain("defaultEndpoint: OLLAMA_DEFAULT_ENDPOINT");
    expect(source).toContain("defaultEndpoint: LM_STUDIO_DEFAULT_ENDPOINT");
    expect(OLLAMA_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:11434");
    expect(LM_STUDIO_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:1234");
  });

  it("never chooses a local model by response order", () => {
    expect(source).not.toContain("connected.models[0]");
    expect(source).not.toContain("entry.models[0]");
    expect(source).not.toContain("selectSingleTextGenerationModel");
    expect(source).toContain("advertised models");
    expect(source).toContain("Choose a text model in Chat or below");
  });

  it("never invokes a local model as part of catalog discovery", () => {
    const localSetup = source.slice(source.indexOf("<section aria-labelledby=\"local-provider-setup-title\">"));
    expect(localSetup).not.toContain("browserInferenceFabric.activate(");
    expect(localSetup).toContain("browserInferenceFabric.connectLocal");
  });

  it("offers every permitted origin and refuses the rest with the policy's own diagnostic", () => {
    // The suggestion list and the requirements sentence both render the
    // allowlist itself. A prose copy of an allowlist is a copy that goes stale
    // silently, and this one is duplicated into index.html and public/_headers
    // already.
    expect(source).toContain("DEFAULT_LOCAL_MODEL_ORIGINS.map((origin) => <option key={origin} value={origin} />)");
    expect(source).toContain('DEFAULT_LOCAL_MODEL_ORIGINS.join(" · ")');
    expect(source).not.toContain("Airship checks only the exact loopback defaults shown here");
    // The moved-instance port the card could not reach is reachable now, and a
    // private-LAN host still fails closed with the origin it refused named.
    expect(DEFAULT_LOCAL_MODEL_ORIGINS).toContain("http://127.0.0.1:11435");
    expect(resolveLocalEndpoint("http://127.0.0.1:11435").url.origin).toBe("http://127.0.0.1:11435");
    expect(() => resolveLocalEndpoint("http://192.168.1.5:11434")).toThrowError(/192\.168\.1\.5:11434/u);
  });

  it("uses the live theme token vocabulary", () => {
    expect(styles).toContain("var(--ink-muted)");
    expect(styles).toContain("var(--surface-soft)");
    expect(styles).toContain("var(--v-verified)");
    expect(styles).not.toContain("var(--muted)");
    expect(styles).not.toContain("var(--surface-2)");
    expect(styles).not.toContain("var(--surface-3)");
    expect(styles).not.toContain("var(--verified)");
    expect(styles).not.toContain("var(--failed)");
    expect(styles).not.toContain("var(--radius-pill)");
  });
});

describe("the lock beside the loopback sentence", () => {
  it("keeps a gap between the glyph and the word it sits against", () => {
    /*
     * This paragraph was deliberately taken out of the `.provider-fabric__notice`
     * flex group, because flex made every `<strong>` and `<code>` in the
     * sentence an unwrappable flex item. That was right, but the group's
     * `gap: 9px` was also the only thing separating the lock from the text, and
     * prose has no gap — so the icon has been welded to the "A" of "Airship
     * connects only to the loopback origins" at every width since.
     */
    const rule = /\.provider-fabric__local-requirements p > svg\s*\{([^}]+)\}/u.exec(declarations)?.[1] ?? "";
    expect(rule).toContain("margin-right: 6px");
    expect(rule).toContain("vertical-align: text-bottom");
  });

  it("does not buy the gap by making the sentence a flex row again", () => {
    // The regression this paragraph's own comment exists to record: 455px of
    // unwrappable row inside a 294px column at 320px.
    const paragraph = [...declarations.matchAll(/\.provider-fabric__local-requirements p\s*\{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "");
    expect(paragraph.length).toBeGreaterThan(0);
    for (const rule of paragraph) expect(rule).not.toContain("display: flex");
    expect(source).toContain('<p><Icon name="lock" size={15} />Airship connects only to the loopback origins');
  });
});


describe("the card's call to action is sized for the finger that presses it", () => {
  it("floors the setup button on a coarse pointer, and does so by height alone", async () => {
    /*
     * These buttons carry no class of their own, which is why the campaign's
     * touch-floor pass missed them: they are bare `<button>`s inside
     * `.provider-setup-card` taking the generic 40px control height. Measured
     * at 768x1024 with a touch pointer once every other floor had landed,
     * `Connect OpenAI` / `Connect Anthropic` / `Connect xAI` were 272x40 and
     * `Check Ollama` / `Check LM Studio` were 285x40 — five of the six
     * remaining sub-floor controls anywhere in the product.
     *
     * Keyed on the pointer rather than on a width, because that is what the
     * floor is for; and `min-height` only, because these are already 272-285px
     * wide and a declared `min-width` on a flex item replaces the min-content
     * floor that keeps a label inside its own box.
     */
    const sheet = await readFile(new URL("./provider-connections-view.css", import.meta.url), "utf8");
    const coarse = sheet.slice(sheet.lastIndexOf("@media (pointer: coarse) {"));
    expect(coarse).toContain(".provider-setup-card button");
    expect(coarse).toContain("min-height: var(--touch-target)");
    expect(coarse).not.toContain("min-width:");
  });
});


function fixtureModel(
  capabilities: InferenceModelDescriptor["capabilities"],
  id = "model-1",
): InferenceModelDescriptor {
  return {
    version: 1,
    connectionId: "connection-1",
    connectionGeneration: 1,
    providerId: "provider-1",
    id,
    label: id,
    capabilities,
    availability: {
      state: "available",
      source: "provider-directory",
      observedAt: "2026-07-24T00:00:00.000Z",
    },
    source: {
      kind: "provider-directory",
      observedAt: "2026-07-24T00:00:00.000Z",
    },
  };
}
