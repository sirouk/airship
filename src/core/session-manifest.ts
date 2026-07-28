import type { JsonValue, SessionManifest, ToolDefinition } from "./contracts";
import { sha256, stableStringify } from "./hash";
import { canonicalSessionContextPolicy } from "./context-policy";

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
  const tools = structuredClone(args.tools).sort((left, right) => left.name.localeCompare(right.name));
  const contextPolicy = args.contextPolicy === undefined
    ? undefined
    : canonicalSessionContextPolicy(args.contextPolicy);
  if (args.contextPolicy !== undefined && !contextPolicy) {
    throw new TypeError("Session context policy is invalid.");
  }
  return {
    protocolVersion: 2,
    systemPrompt: args.systemPrompt,
    systemPromptDigest: await sha256(args.systemPrompt),
    providerId: args.providerId,
    model: args.model,
    ...(args.inferenceBinding ? { inferenceBinding: structuredClone(args.inferenceBinding) } : {}),
    toolManifestDigest: await sha256(stableStringify(tools as unknown as JsonValue)),
    tools,
    workspaceId: args.workspaceId,
    capabilityTier: args.capabilityTier ?? "web-baseline",
    ...(args.securityPosture ? { securityPosture: args.securityPosture } : {}),
    ...(args.profile ? { profile: structuredClone(args.profile) } : {}),
    ...(args.lineage ? { lineage: structuredClone(args.lineage) } : {}),
    ...(contextPolicy ? { contextPolicy } : {}),
    turnContext: args.turnContext ?? "disabled",
    createdAt: args.now ?? new Date().toISOString(),
  };
}
