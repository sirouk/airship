import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { InferenceTransport, SessionManifest } from "../core/contracts";
import type { SessionRecord } from "../core/journal";
import { activeSessionRuntime } from "./app";

const DIGEST = "a".repeat(64);

function manifest(model: string, toolManifestDigest: string): SessionManifest {
  return {
    protocolVersion: 1,
    systemPrompt: "Test prompt",
    providerId: "chutes-e2ee-v1",
    model,
    inferenceBinding: {
      version: 1,
      connectionId: "chutes-account-1",
      connectionGeneration: 4,
      providerId: "chutes",
      providerLabel: "Chutes",
      providerRevision: 1,
      authMethod: "oauth-pkce",
      transportBoundary: "e2ee-attestable",
      modelId: model,
      boundAt: "2026-08-13T00:00:00.000Z",
    },
    workspaceId: "workspace-1",
    capabilityTier: "web-baseline",
    systemPromptDigest: DIGEST,
    toolManifestDigest,
    tools: [],
    securityPosture: "encrypted-attested",
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function session(id: string, sessionManifest: SessionManifest, modelOverride?: string): SessionRecord {
  return {
    id,
    title: id,
    manifest: sessionManifest,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z",
    headSequence: 2,
    headDigest: DIGEST,
    ...(modelOverride ? { modelOverride } : {}),
  };
}

describe("conversation navigation runtime", () => {
  it("restores the target thread model while retaining the live authority boundaries", () => {
    const binding = manifest("profile/default-model", "b".repeat(64)).inferenceBinding!;
    const transport = {
      id: "chutes-e2ee-v1",
      posture: "encrypted-attested",
    } as InferenceTransport;
    const runtime = {
      transport,
      model: "profile/default-model",
      inferenceBinding: binding,
      workspaceId: "workspace-1",
    } as Parameters<typeof activeSessionRuntime>[0];
    const authority = session("currently-visible", manifest("profile/default-model", "b".repeat(64)));
    const target = session("thread-being-opened", manifest("thread/birth-model", "c".repeat(64)), "thread/current-model");

    const routed = activeSessionRuntime(runtime, authority, target);

    expect(routed.model).toBe("thread/current-model");
    expect(routed.inferenceBinding).toMatchObject({
      connectionId: "chutes-account-1",
      connectionGeneration: 4,
      modelId: "thread/current-model",
    });
    // Tool/Profile governance still comes from the current live authority,
    // rather than being trusted from the row that was clicked.
    expect(routed.toolManifestDigest).toBe("b".repeat(64));
  });
  it("treats selecting the already-active conversation as navigation before inspection", () => {
    const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    const start = source.indexOf("async function openPaletteSession");
    const end = source.indexOf("async function activateExternalInference", start);
    const opener = source.slice(start, end);
    const fastPath = opener.indexOf("targetSessionId === ownerSessionId");
    const firstRead = opener.indexOf("journal.getSession");

    expect(fastPath).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(fastPath);
    expect(opener.slice(fastPath, firstRead)).toContain('navigate("chat", chatHash(targetSessionId))');
  });

});
