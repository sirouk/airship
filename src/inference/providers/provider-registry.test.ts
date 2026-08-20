import { describe, expect, it } from "vitest";
import { InferenceConnectionRegistry } from "./connection-registry";
import { InspectInferenceConnectionsTool } from "./availability-tool";
import type {
  InferenceAvailabilitySnapshot,
  InferenceModelDescriptor,
  InferenceProviderDescriptor,
  PublicPkceAuthMethod,
} from "./contracts";
import { InferenceModelCatalog } from "./model-catalog";
import {
  ANTHROPIC_PROVIDER,
  CHUTES_PROVIDER,
  OFFICIAL_CLOUD_PROVIDERS,
  OPENAI_PROVIDER,
  XAI_PROVIDER,
} from "./official-providers";
import { InferenceProviderCatalog } from "./provider-catalog";
import {
  createInferenceAvailabilitySnapshot,
  pinInferenceRoute,
  renderInferenceAvailabilityForPrompt,
  resolvePinnedInferenceRoute,
} from "./session-route";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const CHECKED_AT = "2026-07-24T12:00:01.000Z";
const OBSERVED_AT = "2026-07-24T12:00:02.000Z";

describe("provider-neutral inference catalog", () => {
  it("keeps the built-in browser auth surface explicit", () => {
    expect(OPENAI_PROVIDER.oauth).toMatchObject({
      state: "configuration-required",
      detail: "No account sign-in flow is wired into this static build.",
    });
    expect(ANTHROPIC_PROVIDER.oauth.state).toBe("first-party-only");
    expect(XAI_PROVIDER.oauth.state).toBe("not-documented");
    expect(OFFICIAL_CLOUD_PROVIDERS.flatMap((provider) =>
      provider.authMethods.filter((method) => method.kind === "oauth-public-pkce")
    )).toEqual([]);
    expect(OPENAI_PROVIDER.authMethods[0]).toMatchObject({
      kind: "api-key",
      browserUse: "dangerous-user-opt-in",
    });
    expect(ANTHROPIC_PROVIDER.authMethods[0]).toMatchObject({
      kind: "api-key",
      browserUse: "dangerous-user-opt-in",
    });
    expect(XAI_PROVIDER.authMethods[0]).toMatchObject({
      kind: "api-key",
      browserUse: "direct-contract-unpublished",
    });
    expect(CHUTES_PROVIDER).toMatchObject({
      protocol: "openai-compatible",
      oauth: { state: "not-documented" },
    });
    expect(CHUTES_PROVIDER.authMethods[0]).toMatchObject({
      kind: "api-key",
      browserUse: "direct-contract-unpublished",
    });
    expect(OFFICIAL_CLOUD_PROVIDERS.flatMap((provider) =>
      provider.authMethods.flatMap((method) => method.kind === "api-key" ? [method.warning] : [])
    )).toEqual(Array.from(
      { length: 4 },
      () => "This screen uses a browser-direct API key. It remains in this tab and is sent to the configured provider endpoint.",
    ));
  });

  it("registers frozen metadata with provider-local revisions", () => {
    const catalog = new InferenceProviderCatalog([OPENAI_PROVIDER, ANTHROPIC_PROVIDER]);
    const before = catalog.require("openai");
    catalog.register({ ...OPENAI_PROVIDER, label: "OpenAI updated" });
    const after = catalog.require("openai");

    expect(before.revision).toBe(1);
    expect(after.revision).toBe(2);
    expect(catalog.require("anthropic").revision).toBe(1);
    expect(Object.isFrozen(catalog.snapshot())).toBe(true);
    expect(Object.isFrozen(after.provider.authMethods)).toBe(true);
  });

  it("removes only the exact provider revision requested", () => {
    const catalog = new InferenceProviderCatalog([OPENAI_PROVIDER]);
    const first = catalog.require("openai");
    expect(catalog.unregister("openai", first.revision + 1)).toBe(false);
    expect(catalog.require("openai")).toBe(first);
    expect(catalog.unregister("openai", first.revision)).toBe(true);
    expect(catalog.get("openai")).toBeUndefined();
    expect(catalog.unregister("openai", first.revision)).toBe(false);
  });

  it("accepts only the configured S256 public-PKCE record shape", () => {
    const oauth = pkce();
    const provider = providerWithReviewedPkce(oauth);
    const catalog = new InferenceProviderCatalog([provider]);
    expect(catalog.require("openai").provider.oauth).toMatchObject({
      state: "configured-public-pkce",
      authMethodId: "airship-browser-pkce",
    });

    const withSecret = {
      ...oauth,
      clientSecret: "must-never-enter-browser-metadata",
    } as PublicPkceAuthMethod;
    expect(() => new InferenceProviderCatalog([
      providerWithReviewedPkce(withSecret),
    ])).toThrow("client secret");
    expect(() => new InferenceProviderCatalog([
      providerWithReviewedPkce({
        ...oauth,
        tokenEndpointAuthMethod: "client_secret_post",
      } as unknown as PublicPkceAuthMethod),
    ])).toThrow("public S256 PKCE");
    expect(() => new InferenceProviderCatalog([
      providerWithReviewedPkce({
        ...oauth,
        codeChallengeMethod: "plain",
      } as unknown as PublicPkceAuthMethod),
    ])).toThrow("public S256 PKCE");
  });

  it("restricts unauthenticated providers and HTTP endpoints to loopback", () => {
    expect(() => new InferenceProviderCatalog([{
      ...localProvider(),
      baseUrl: "http://192.168.1.10:11434/v1/",
    }])).toThrow("loopback");
    expect(() => new InferenceProviderCatalog([{
      ...OPENAI_PROVIDER,
      authMethods: [{
        id: "none",
        kind: "local-none",
        label: "None",
        browserUse: "loopback-only",
      }],
    }])).toThrow("loopback");
    expect(() => new InferenceProviderCatalog([localProvider()])).not.toThrow();
  });
});

describe("simultaneous inference connections", () => {
  it("holds several provider credentials only inside the page-memory authority", async () => {
    const providers = providersWithChutes();
    const registry = new InferenceConnectionRegistry(providers, () => NOW);
    registry.connectApiKey({
      id: "chutes-main",
      providerId: "chutes",
      authMethodId: "chutes-api-key",
      label: "Chutes main",
      apiKey: "cpk_secret-never-in-metadata",
    });
    registry.connectApiKey({
      id: "anthropic-review",
      providerId: "anthropic",
      authMethodId: "anthropic-api-key",
      label: "Claude review",
      apiKey: "sk-ant-secret-never-in-metadata",
    });
    registry.connectLocal({
      id: "ollama-local",
      providerId: "ollama",
      authMethodId: "ollama-loopback",
      label: "Local Ollama",
    });

    const snapshot = registry.snapshot();
    expect(snapshot.connections.map((connection) => connection.providerId)).toEqual([
      "anthropic",
      "chutes",
      "ollama",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/cpk_|sk-ant|secret-never/u);
    await expect(registry.useCredential("anthropic-review", {}, (lease) => lease))
      .resolves.toEqual({ kind: "api-key", value: "sk-ant-secret-never-in-metadata" });
    await expect(registry.useCredential("ollama-local", {}, (lease) => lease))
      .resolves.toEqual({ kind: "local-none" });
  });

  it("does not infer authorization from key shape or provider declarations", async () => {
    const providers = providersWithChutes();
    const registry = new InferenceConnectionRegistry(providers, () => NOW);
    registry.connectApiKey({
      id: "chutes-main",
      providerId: "chutes",
      authMethodId: "chutes-api-key",
      label: "Chutes",
      apiKey: "cpk_opaque",
    });
    expect(registry.require("chutes-main").health.state).toBe("unchecked");
    expect(registry.require("chutes-main").capabilities.invoke.state).toBe("unknown");
    await expect(registry.useCredential(
      "chutes-main",
      { requiredCapabilities: ["invoke"] },
      () => "must-not-run",
    )).rejects.toThrow("has not proved invoke");

    registry.updateHealth("chutes-main", { state: "ready", checkedAt: CHECKED_AT, latencyMs: 12 });
    registry.updateCapabilities("chutes-main", {
      invoke: { state: "available", source: "live-probe", checkedAt: CHECKED_AT },
    });
    await expect(registry.useCredential(
      "chutes-main",
      { requiredCapabilities: ["invoke"] },
      () => "invocation-authorized",
    )).resolves.toBe("invocation-authorized");
  });

  it("installs OAuth only against the matching configured registration and scopes", () => {
    const providers = providersWithChutes(pkce());
    const registry = new InferenceConnectionRegistry(providers, () => NOW);
    expect(() => registry.connectOAuth({
      id: "chutes-oauth",
      providerId: "openai",
      authMethodId: "airship-browser-pkce",
      label: "OpenAI sign-in",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-07-24T13:00:00.000Z",
      scopes: ["openid", "profile", "inference:invoke"],
    })).not.toThrow();
    expect(registry.require("chutes-oauth")).toMatchObject({
      authKind: "oauth-public-pkce",
      refreshable: true,
      scopes: ["openid", "profile", "inference:invoke"],
    });
    expect(() => registry.connectOAuth({
      id: "bad-scope",
      providerId: "openai",
      authMethodId: "airship-browser-pkce",
      label: "Bad scope",
      accessToken: "access-token",
      expiresAt: "2026-07-24T13:00:00.000Z",
      scopes: ["admin"],
    })).toThrow("unregistered scope");
    expect(() => registry.connectOAuth({
      id: "openai-oauth",
      providerId: "openai",
      authMethodId: "openai-api-key",
      label: "Not real",
      accessToken: "access-token",
      expiresAt: "2026-07-24T13:00:00.000Z",
      scopes: [],
    })).toThrow("does not expose oauth-public-pkce");
  });

  it("marks expiring OAuth unavailable without exporting or refreshing credentials", async () => {
    let now = NOW;
    const registry = new InferenceConnectionRegistry(providersWithChutes(pkce()), () => now);
    registry.connectOAuth({
      id: "oauth",
      providerId: "openai",
      authMethodId: "airship-browser-pkce",
      label: "OAuth",
      accessToken: "access-token",
      expiresAt: "2026-07-24T12:05:00.000Z",
      scopes: ["openid"],
    });
    now = Date.parse("2026-07-24T12:06:00.000Z");
    expect(registry.require("oauth").health).toMatchObject({
      state: "expired",
      code: "oauth-token-expired",
    });
    await expect(registry.useCredential("oauth", {}, () => "must-not-run"))
      .rejects.toThrow("expired");
  });

  it("rotates the same OAuth grant without retargeting a pinned connection generation", async () => {
    const registry = new InferenceConnectionRegistry(providersWithChutes(pkce()), () => NOW);
    const connected = registry.connectOAuth({
      id: "oauth",
      providerId: "openai",
      authMethodId: "airship-browser-pkce",
      label: "OAuth",
      accessToken: "old-access-token",
      refreshToken: "rotating-refresh-token",
      expiresAt: "2026-07-24T12:05:00.000Z",
      scopes: ["openid", "inference:invoke"],
    });
    const rotated = registry.rotateOAuth({
      connectionId: "oauth",
      expectedGeneration: connected.generation,
      accessToken: "new-access-token",
      expiresAt: "2026-07-24T13:00:00.000Z",
      scopes: ["openid", "inference:invoke"],
    });

    expect(rotated.generation).toBe(connected.generation);
    expect(rotated.health.state).toBe("unchecked");
    expect(rotated.refreshable).toBe(true);
    await expect(registry.useCredential("oauth", {}, (lease) => lease))
      .resolves.toEqual({ kind: "oauth-access-token", value: "new-access-token" });
    expect(JSON.stringify(registry.snapshot())).not.toMatch(/old-access|new-access|rotating-refresh/u);
    expect(() => registry.rotateOAuth({
      connectionId: "oauth",
      expectedGeneration: connected.generation + 1,
      accessToken: "stale-access-token",
      expiresAt: "2026-07-24T13:00:00.000Z",
      scopes: ["openid"],
    })).toThrow("stale");
  });

  it("increments the connection generation whenever an ID is reconnected", () => {
    const registry = new InferenceConnectionRegistry(providersWithChutes(), () => NOW);
    const first = registry.connectApiKey({
      id: "main",
      providerId: "chutes",
      authMethodId: "chutes-api-key",
      label: "First",
      apiKey: "first-key",
    });
    const second = registry.connectApiKey({
      id: "main",
      providerId: "anthropic",
      authMethodId: "anthropic-api-key",
      label: "Second",
      apiKey: "second-key",
    });
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
  });
});

describe("model catalog, session pins, and agent awareness", () => {
  it("replaces a connection model directory atomically with frozen evidence", () => {
    const providers = providersWithChutes();
    const models = new InferenceModelCatalog(providers);
    models.replaceConnectionModels("chutes-main", 1, "chutes", [
      model("chutes", "org/text", ["text-input", "text-output", "tool-calling"]),
      model("chutes", "org/vision", ["text-input", "text-output", "image-input"]),
    ]);
    expect(models.forConnection("chutes-main", 1).map((item) => item.id)).toEqual(["org/text", "org/vision"]);
    expect(Object.isFrozen(models.require("chutes-main", 1, "org/text").capabilities)).toBe(true);
    expect(() => models.replaceConnectionModels("chutes-main", 1, "chutes", [
      model("anthropic", "wrong/provider", ["text-input"]),
    ])).toThrow("another provider");
  });

  it("keeps credential-dependent model rosters isolated between same-provider connections", () => {
    const models = new InferenceModelCatalog(providersWithChutes());
    models.replaceConnectionModels("chutes-main", 1, "chutes", [
      model("chutes", "org/main-only", ["text-input"], "chutes-main"),
    ]);
    models.replaceConnectionModels("chutes-review", 1, "chutes", [
      model("chutes", "org/review-only", ["text-input"], "chutes-review"),
    ]);

    expect(models.forConnection("chutes-main", 1).map((item) => item.id)).toEqual(["org/main-only"]);
    expect(models.forConnection("chutes-review", 1).map((item) => item.id)).toEqual(["org/review-only"]);
  });

  it("does not expose a prior account roster after a connection ID advances generation", () => {
    const models = new InferenceModelCatalog(providersWithChutes());
    models.replaceConnectionModels("chutes-main", 1, "chutes", [
      model("chutes", "org/account-one", ["text-input"]),
    ]);

    expect(models.forConnection("chutes-main", 2)).toEqual([]);
    expect(models.get("chutes-main", 2, "org/account-one")).toBeUndefined();
  });

  it("states missing connection and model observations without claiming proof", () => {
    const { providers, connections, models } = readyRuntime();
    connections.updateCapabilities("chutes-main", {
      invoke: { state: "unknown", source: "live-probe", checkedAt: CHECKED_AT },
    });
    expect(() => pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    })).toThrow("The inference connection does not currently report invocation access required for session pinning.");

    connections.updateCapabilities("chutes-main", {
      invoke: { state: "available", source: "live-probe", checkedAt: CHECKED_AT },
    });
    models.replaceConnectionModels("chutes-main", 1, "chutes", [{
      ...model("chutes", "org/model", ["text-input", "text-output", "tool-calling"]),
      availability: {
        state: "unavailable",
        source: "provider-directory",
        observedAt: OBSERVED_AT,
      },
    }]);
    expect(() => pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    })).toThrow("The selected model is currently reported unavailable by the model catalog.");
  });

  it("pins provider, connection generation, and model semantics immutably", () => {
    const { providers, connections, models } = readyRuntime();
    const pin = pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    });
    expect(pin).toMatchObject({
      provider: { id: "chutes", revision: 1, protocol: "openai-compatible" },
      connection: { id: "chutes-main", generation: 1 },
      model: { id: "org/model", contextWindowTokens: 128_000 },
    });
    expect(Object.isFrozen(pin.model.capabilities)).toBe(true);
    expect(resolvePinnedInferenceRoute(providers, connections, models, pin).state).toBe("ready");

    models.replaceConnectionModels("chutes-main", 1, "chutes", [{
      ...model("chutes", "org/model", ["text-input", "text-output", "tool-calling"]),
      contextWindowTokens: 256_000,
    }]);
    const changed = resolvePinnedInferenceRoute(providers, connections, models, pin);
    expect(changed).toMatchObject({ state: "ready", modelMetadataChanged: true });
    expect(pin.model.contextWindowTokens).toBe(128_000);
  });

  it("never silently adopts a reconnected credential or changed provider route", () => {
    const { providers, connections, models } = readyRuntime();
    const pin = pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    });
    connections.connectApiKey({
      id: "chutes-main",
      providerId: "chutes",
      authMethodId: "chutes-api-key",
      label: "Replacement",
      apiKey: "replacement-key",
    });
    expect(resolvePinnedInferenceRoute(providers, connections, models, pin).state)
      .toBe("connection-replaced");

    const second = readyRuntime();
    const secondPin = pinInferenceRoute(second.providers, second.connections, second.models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    });
    second.providers.register({
      ...CHUTES_PROVIDER,
      label: "Chutes changed",
    });
    expect(resolvePinnedInferenceRoute(
      second.providers,
      second.connections,
      second.models,
      secondPin,
    ).state).toBe("provider-changed");
  });

  it("creates a bounded credential-free snapshot for tools and prompts", () => {
    const { providers, connections, models } = readyRuntime();
    connections.connectApiKey({
      id: "anthropic-review",
      providerId: "anthropic",
      authMethodId: "anthropic-api-key",
      label: "Review lane",
      apiKey: "sk-ant-never-surface",
    });
    const pin = pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    });
    const snapshot = createInferenceAvailabilitySnapshot({
      providers,
      connections,
      models,
      activeSession: pin,
      capturedAt: OBSERVED_AT,
      limits: { maxConnections: 1, maxModelsPerConnection: 1 },
    });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.omittedConnections).toBe(1);
    expect(snapshot.activeSession).toEqual({
      providerId: "chutes",
      connectionId: "chutes-main",
      modelId: "org/model",
      immutable: true,
      resolution: "ready",
    });
    expect(serialized).not.toMatch(/sk-ant|cpk_|token|scope|baseUrl/u);
    const prompt = renderInferenceAvailabilityForPrompt(snapshot);
    expect(prompt).toContain("credential-free");
    expect(prompt).toContain("Do not silently switch");
    expect(prompt).not.toContain("sk-ant-never-surface");
    expect(renderInferenceAvailabilityForPrompt(snapshot, 160)).toContain("truncated");
  });

  it("carries catalog model limits to the agent and omits the ones nobody observed", async () => {
    const { providers, connections, models } = readyRuntime();
    const declared = model("chutes", "org/model", ["text-input", "text-output", "tool-calling"]);
    const { contextWindowTokens, maxOutputTokens, ...undeclared } = model(
      "chutes",
      "org/undeclared",
      ["text-input"],
    );
    expect(contextWindowTokens).toBe(128_000);
    expect(maxOutputTokens).toBe(16_384);
    models.replaceConnectionModels("chutes-main", 1, "chutes", [declared, undeclared]);

    const snapshot = createInferenceAvailabilitySnapshot({
      providers,
      connections,
      models,
      capturedAt: OBSERVED_AT,
    });
    const rows = snapshot.connections[0]!.models;
    expect(rows.find((row) => row.id === "org/model")).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    const unknownRow = rows.find((row) => row.id === "org/undeclared")!;
    expect(unknownRow).not.toHaveProperty("contextWindowTokens");
    expect(unknownRow).not.toHaveProperty("maxOutputTokens");

    const prompt = renderInferenceAvailabilityForPrompt(snapshot);
    expect(prompt).toContain(
      "org/model[available;text-input,text-output,tool-calling;ctx=128000;out=16384]",
    );
    expect(prompt).toContain("org/undeclared[available;text-input]");

    // The agent's actual read surface is the tool result, not the renderer.
    const tool = new InspectInferenceConnectionsTool({
      providers,
      connections,
      models,
      now: () => Date.parse(OBSERVED_AT),
    });
    const result = await tool.execute({}, {
      sessionId: "session-1",
      turnId: "turn-1",
      operationId: "operation-1",
      signal: new AbortController().signal,
    });
    const toolRows = (JSON.parse(result.content) as InferenceAvailabilitySnapshot)
      .connections[0]!.models;
    expect(toolRows.find((row) => row.id === "org/model")).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(toolRows.find((row) => row.id === "org/undeclared"))
      .not.toHaveProperty("contextWindowTokens");
  });

  it("exposes the snapshot as a governed read-only inspection tool", async () => {
    const { providers, connections, models } = readyRuntime();
    const pin = pinInferenceRoute(providers, connections, models, {
      connectionId: "chutes-main",
      modelId: "org/model",
      pinnedAt: OBSERVED_AT,
    });
    const tool = new InspectInferenceConnectionsTool({
      providers,
      connections,
      models,
      activeSession: () => pin,
      now: () => Date.parse(OBSERVED_AT),
      limits: { maxConnections: 4, maxModelsPerConnection: 4 },
    });
    const result = await tool.execute({}, {
      sessionId: "session-1",
      turnId: "turn-1",
      operationId: "operation-1",
      signal: new AbortController().signal,
    });
    expect(tool.definition.effect).toBe("read");
    expect(tool.definition.description).toContain("observed availability");
    expect(tool.definition.description).not.toContain("proved");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      version: 1,
      activeSession: {
        providerId: "chutes",
        connectionId: "chutes-main",
        modelId: "org/model",
        immutable: true,
      },
    });
    expect(result.content).not.toContain("cpk_page-memory");
    await expect(tool.execute({ unexpected: true }, {
      sessionId: "session-1",
      turnId: "turn-1",
      operationId: "operation-2",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true });
  });
});

function providersWithChutes(oauth?: PublicPkceAuthMethod): InferenceProviderCatalog {
  return new InferenceProviderCatalog([
    oauth ? providerWithReviewedPkce(oauth) : OPENAI_PROVIDER,
    ...OFFICIAL_CLOUD_PROVIDERS.filter((provider) => provider.id !== "openai"),
    localProvider(),
  ]);
}

function providerWithReviewedPkce(oauth: PublicPkceAuthMethod): InferenceProviderDescriptor {
  return {
    ...OPENAI_PROVIDER,
    oauth: {
      state: "configured-public-pkce",
      authMethodId: oauth.id,
      detail: "Configured browser PKCE metadata for the provider registry tests.",
    },
    authMethods: [oauth, ...OPENAI_PROVIDER.authMethods.filter((method) => method.kind !== "oauth-public-pkce")],
  };
}

function localProvider(): InferenceProviderDescriptor {
  return {
    version: 1,
    id: "ollama",
    label: "Ollama",
    protocol: "openai-compatible",
    transportBoundary: "loopback-local",
    baseUrl: "http://127.0.0.1:11434/v1/",
    modelsUrl: "http://127.0.0.1:11434/v1/models",
    oauth: {
      state: "not-documented",
      detail: "Loopback model service uses no remote account.",
    },
    authMethods: [{
      id: "ollama-loopback",
      kind: "local-none",
      label: "Loopback",
      browserUse: "loopback-only",
    }],
    capabilities: ["invoke", "models:list"],
    documentationUrl: "https://ollama.com/",
  };
}

function pkce(): PublicPkceAuthMethod {
  return {
    id: "airship-browser-pkce",
    kind: "oauth-public-pkce",
    label: "Airship browser PKCE",
    authorizationEndpoint: "https://auth.example.test/authorize",
    tokenEndpoint: "https://auth.example.test/token",
    clientId: "cid_airship-browser",
    redirectUris: [
      "https://airship.example/auth/callback",
      "http://127.0.0.1:4173/auth/callback",
    ],
    scopes: ["openid", "profile", "inference:invoke"],
    tokenEndpointAuthMethod: "none",
    codeChallengeMethod: "S256",
    browserUse: "reviewed-direct",
    review: {
      id: "airship-public-pkce",
      reviewedAt: "2026-07-24T00:00:00.000Z",
      sourceUrl: "https://auth.example.test/clients/cid_airship-browser",
    },
  };
}

function model(
  providerId: string,
  id: string,
  supported: readonly ("text-input" | "text-output" | "image-input" | "tool-calling")[],
  connectionId = "chutes-main",
): InferenceModelDescriptor {
  return {
    version: 1,
    connectionId,
    connectionGeneration: 1,
    providerId,
    id,
    label: id,
    capabilities: Object.fromEntries(
      supported.map((capability) => [
        capability,
        { state: "supported", source: "provider-directory", observedAt: OBSERVED_AT },
      ]),
    ),
    availability: {
      state: "available",
      source: "provider-directory",
      observedAt: OBSERVED_AT,
    },
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    source: {
      kind: "provider-directory",
      observedAt: OBSERVED_AT,
      sourceUrl: "https://llm.chutes.ai/v1/models",
    },
  };
}

function readyRuntime() {
  const providers = providersWithChutes();
  const connections = new InferenceConnectionRegistry(providers, () => NOW);
  const models = new InferenceModelCatalog(providers);
  connections.connectApiKey({
    id: "chutes-main",
    providerId: "chutes",
    authMethodId: "chutes-api-key",
    label: "Chutes main",
    apiKey: "cpk_page-memory",
  });
  connections.updateHealth("chutes-main", {
    state: "ready",
    checkedAt: CHECKED_AT,
    latencyMs: 18,
  });
  connections.updateCapabilities("chutes-main", {
    invoke: { state: "available", source: "live-probe", checkedAt: CHECKED_AT },
    "models:list": { state: "available", source: "live-probe", checkedAt: CHECKED_AT },
  });
  models.replaceConnectionModels("chutes-main", 1, "chutes", [
    model("chutes", "org/model", ["text-input", "text-output", "tool-calling"]),
  ]);
  return { providers, connections, models };
}
