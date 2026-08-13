import type { SecurityPosture, ToolDefinition } from "../core/contracts";

export type AgentProfile = {
  version: 1;
  profileId: string;
  revision: string;
  name: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  minimumPosture: SecurityPosture;
  tools: ToolDefinition[];
  skillDigests: string[];
  memoryScope: "session" | "profile" | "workspace";
  workspaceId: string;
  receiptPolicyId: string;
  createdAt: string;
};

export type ProfileSummary = Pick<
  AgentProfile,
  "profileId" | "revision" | "name" | "description" | "providerId" | "model" | "minimumPosture"
>;

export interface ProfileStore {
  list(): Promise<ProfileSummary[]>;
  get(profileId: string, revision?: string): Promise<AgentProfile | undefined>;
  put(profile: AgentProfile, expectedRevision?: string): Promise<void>;
}

export function defaultProfile(tools: ToolDefinition[]): AgentProfile {
  return {
    version: 1,
    profileId: "default",
    revision: "builtin-1",
    name: "Airship",
    description: "Private general-purpose workspace agent",
    systemPrompt:
      "Complete the operator's task directly. Use the installed tools, preserve the workspace, verify consequential work, and report uncertainty without inventing restrictions.",
    providerId: "airship-demo",
    model: "deterministic-demo-v1",
    minimumPosture: "local",
    tools,
    skillDigests: [],
    memoryScope: "profile",
    workspaceId: "default",
    receiptPolicyId: "honest-default-v1",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}
