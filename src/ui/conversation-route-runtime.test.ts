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
    providerId: "provider-remote-v1",
    model,
    inferenceBinding: {
      version: 1,
      connectionId: "remote-account-1",
      connectionGeneration: 4,
      providerId: "provider-remote",
      providerLabel: "Remote provider",
      providerRevision: 1,
      authMethod: "oauth-pkce",
      transportBoundary: "provider-tls",
      modelId: model,
      boundAt: "2026-08-13T00:00:00.000Z",
    },
    workspaceId: "workspace-1",
    capabilityTier: "web-baseline",
    systemPromptDigest: DIGEST,
    toolManifestDigest,
    tools: [],
    securityPosture: "plaintext-remote",
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
    const sourceManifest = manifest("profile/default-model", "b".repeat(64));
    const binding = sourceManifest.inferenceBinding;
    if (!binding) throw new Error("missing inference binding");
    const transport: InferenceTransport = {
      id: "provider-remote-v1",
      posture: "plaintext-remote",
      async *stream() {
        throw new Error("not used in this test");
      },
    };
    const runtime: Parameters<typeof activeSessionRuntime>[0] = {
      transport,
      model: "profile/default-model",
      inferenceBinding: binding,
      workspaceId: "workspace-1",
    };
    const authority = session("currently-visible", sourceManifest);
    const target = session("thread-being-opened", manifest("thread/birth-model", "c".repeat(64)), "thread/current-model");

    const routed = activeSessionRuntime(runtime, authority, target);

    expect(routed.model).toBe("thread/current-model");
    expect(routed.inferenceBinding).toMatchObject({
      connectionId: "remote-account-1",
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
