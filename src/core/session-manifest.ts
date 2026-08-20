import type { JsonValue, SessionManifest, ToolDefinition } from "./contracts";
import { sha256, stableStringify } from "./hash";
import { canonicalSessionContextPolicy } from "./context-policy";
import { assertValidSessionInferenceBinding } from "./inference-binding";

/**
 * Build the immutable session pin without loading the turn executor. Session
 * creation is part of shell boot; inference, retrieval, compression, and tool
 * orchestration are deliberately not.
 */
export async function createSessionManifest(args: {
  systemPrompt: string;
  providerId: string;
  model: string;
  inferenceBinding?: SessionManifest["inferenceBinding"];
  tools: ToolDefinition[];
  workspaceId: string;
  profile?: SessionManifest["profile"];
  securityPosture?: SessionManifest["securityPosture"];
  lineage?: SessionManifest["lineage"];
  contextPolicy?: SessionManifest["contextPolicy"];
  turnContext?: SessionManifest["turnContext"];
  capabilityTier?: SessionManifest["capabilityTier"];
  now?: string;
}): Promise<SessionManifest> {
  // Snapshot every caller-owned field once, synchronously. Validation, cloning,
  // hashing, and the returned manifest must all describe the same authority
  // even when an embedding caller supplied accessors or later mutates input.
  const systemPrompt = args.systemPrompt;
  const providerId = args.providerId;
  const model = args.model;
  const inferenceBinding = args.inferenceBinding;
  const rawTools = args.tools;
  const workspaceId = args.workspaceId;
  const rawProfile = args.profile;
  const securityPosture = args.securityPosture;
  const rawLineage = args.lineage;
  const rawContextPolicy = args.contextPolicy;
  const turnContext = args.turnContext;
  const capabilityTier = args.capabilityTier;
  const createdAt = args.now ?? new Date().toISOString();

  assertValidSessionInferenceBinding({
    providerId,
    model,
    ...(inferenceBinding !== undefined ? { inferenceBinding } : {}),
  });
  const binding = inferenceBinding === undefined ? undefined : structuredClone(inferenceBinding);
  const tools = structuredClone(rawTools).sort((left, right) => left.name.localeCompare(right.name));
  const profile = rawProfile === undefined ? undefined : structuredClone(rawProfile);
  const lineage = rawLineage === undefined ? undefined : structuredClone(rawLineage);
  const contextPolicy = rawContextPolicy === undefined
    ? undefined
    : canonicalSessionContextPolicy(rawContextPolicy);
  if (rawContextPolicy !== undefined && !contextPolicy) {
    throw new TypeError("Session context policy is invalid.");
  }
  return {
    protocolVersion: 2,
    systemPrompt,
    systemPromptDigest: await sha256(systemPrompt),
    providerId,
    model,
    ...(binding !== undefined ? { inferenceBinding: binding } : {}),
    toolManifestDigest: await sha256(stableStringify(tools as unknown as JsonValue)),
    tools,
    workspaceId,
    capabilityTier: capabilityTier ?? "web-baseline",
    ...(securityPosture ? { securityPosture } : {}),
    ...(profile ? { profile } : {}),
    ...(lineage ? { lineage } : {}),
    ...(contextPolicy ? { contextPolicy } : {}),
    turnContext: turnContext ?? "disabled",
    createdAt,
  };
}
