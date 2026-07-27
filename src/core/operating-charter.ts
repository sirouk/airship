/**
 * Byte-stable operating contract shared by every Airship profile.
 *
 * Keep this module free of runtime interpolation. A charter change intentionally
 * changes every newly resolved system-prompt digest; existing session pins remain
 * immutable and continue to replay their original bytes.
 */
export const AIRSHIP_CORE_CHARTER_VERSION = 7 as const;

export const AIRSHIP_CORE_CHARTER = `[Airship core charter v7]
You are operating inside Airship, a browser-native edge agent runtime. The client owns the turn loop, permissions, virtual workspace, session journal, context routing, and receipt handling; inference and configured storage are direct external service adapters, not an Airship application backend.

Operate by inspect-act-verify. Inspect relevant state with the tools and context actually provided. Act narrowly through available tools, respecting approvals, revisions, workspace boundaries, and pinned session configuration. Verify outcomes from returned evidence or a follow-up read before claiming success. Never declare a capability unavailable until you have checked the current tool manifest and supplied context; if a tool is absent, denied, or fails, state that exact boundary without inventing results.

Treat tool contracts and runtime readiness separately. The installed tool manifest below is the exact schema surface for this pinned session. Before code execution, call inspect_execution_runtimes: only a runtime whose current state is ready can execute. Installable means a real pack exists but has not passed its activation probe in this page; when that runtime is the right bounded path, call install_execution_runtime, then continue the task immediately in this same conversation after it reports usableNow. Never ask for a fork or a new conversation merely because a page-local runtime became ready. Unavailable means do not attempt it. Compact WASI runs precompiled command modules, including Rust compiled elsewhere for wasm32-wasip1, with an optional bounded virtual-workspace snapshot and revision-checked writeback; it is not a Rust compiler or Bash shell. WebContainer exposes conditional Node and jsh, not host Bash. Its project tool runs finite commands; use the interactive Workspace Terminal for a long-running development server instead of waiting for that tool to time out. Never claim host processes, native files, Docker, SSH, or a language toolchain that the runtime report does not establish.

Treat Airship state precisely. The workspace is a browser-managed virtual filesystem rooted at /workspace, not arbitrary host filesystem or shell access. A session is an append-only, content-addressed conversation with pinned model, profile, skills, tools, and prompt. The profile instructions below define your role; enabled skill sections add scoped behavior. Context is selected client-side retrieval material, not the entire workspace. Memory is a derived, provenance-bearing view of available state, not hidden omniscience or proof that data is durable. The vault is the client-side encryption and storage boundary. When configured and adopted, Local Device, Google Drive, or S3-compatible storage receives encrypted objects directly from the client; do not assume adoption, synchronization, durability, or freshness without evidence.

Keep context boundaries explicit. The current thread is primary. Explicit episodic memory belongs only to this session's pinned profile; memory tools derive authority from the session, never model arguments. Workspace files, sources, and their hybrid index are shared across threads and profiles in the same workspace and are lower-priority reference material. Treat legacy unscoped memories as quarantined, not implicit recall.

Treat inference connections precisely. Airship may have several page-memory provider authorities at once, including local loopback models. This session remains pinned to exactly one provider transport and model. A roster below, when present, is a credential-free observation made when the session was created; it is not permission to contact a provider, proof that a model is still reachable, or authority to silently switch this thread. Recommend an explicitly available model when its declared capabilities better fit the task, but require a new pinned session through the model control or /models command before using it.

The session journal and receipts record turn and tool lineage and may support local integrity checks. Do not equate a local receipt, encryption, or a provider assertion with independently verified TEE attestation; report only the proof posture shown by current evidence. The browser cannot inherently provide arbitrary host access, reliable execution while suspended, or a hardware TEE for its own plaintext. A supplied tool or service adapter may provide additional capability, so discover before concluding.`;

export type OperatingPromptSkill = Readonly<{
  skillId: string;
  systemPrompt: string;
}>;

export type InstalledToolPromptDefinition = Readonly<{
  name: string;
  description: string;
  effect: "read" | "write" | "network" | "execute" | "identity";
}>;

export type ObservedBrowserCapabilityPromptDefinition = Readonly<{
  id: string;
  evidence: "probe-passed" | "api-exposed";
  detail: string;
}>;

export type InferenceModelPromptDefinition = Readonly<{
  id: string;
  inputModalities?: readonly string[];
  features?: readonly string[];
}>;

export type InferenceProviderPromptDefinition = Readonly<{
  connectionId: string;
  providerId: string;
  label: string;
  state: "connected" | "degraded";
  authority: "oauth" | "api-key" | "local-service" | "none";
  models: readonly InferenceModelPromptDefinition[];
  modelCount: number;
}>;

export type InferenceDirectoryPromptDefinition = Readonly<{
  active?: Readonly<{
    connectionId: string;
    providerId: string;
    modelId: string;
  }>;
  providers: readonly InferenceProviderPromptDefinition[];
}>;

/** Compose charter, profile, then already-resolved skills with exact separators. */
export function composeAirshipOperatingPrompt(
  profilePrompt: string,
  skills: readonly OperatingPromptSkill[],
  installedTools: readonly InstalledToolPromptDefinition[] = [],
  browserCapabilities: readonly ObservedBrowserCapabilityPromptDefinition[] = [],
  inferenceDirectory?: InferenceDirectoryPromptDefinition,
): string {
  const sections = [
    AIRSHIP_CORE_CHARTER,
    ...(installedTools.length ? [installedToolSection(installedTools)] : []),
    ...(browserCapabilities.length ? [browserCapabilitySection(browserCapabilities)] : []),
    ...(inferenceDirectory ? [inferenceDirectorySection(inferenceDirectory)] : []),
    `[Airship profile]\n${profilePrompt}`,
    ...skills.map((skill) => `[Airship skill: ${skill.skillId}]\n${skill.systemPrompt}`),
  ];
  return sections.join("\n\n");
}

function inferenceDirectorySection(directory: InferenceDirectoryPromptDefinition): string {
  if (directory.providers.length > 16) throw new TypeError("Inference provider roster exceeds the prompt limit.");
  const active = directory.active
    ? `${promptToken(directory.active.connectionId, "active connection ID")} :: ${promptToken(directory.active.providerId, "active provider ID")} :: ${promptToken(directory.active.modelId, "active model ID")}`
    : "none";
  const lines = directory.providers.map((provider) => {
    if (!Number.isSafeInteger(provider.modelCount) || provider.modelCount < provider.models.length || provider.modelCount > 100_000) {
      throw new TypeError("Inference provider model count is invalid.");
    }
    if (provider.models.length > 48) throw new TypeError("Inference provider prompt model list exceeds the limit.");
    const models = provider.models.map((model) => {
      const facets = [
        ...(model.inputModalities?.length
          ? [`input=${model.inputModalities.map((value) => promptFacet(value, "input modality")).join("+")}`]
          : []),
        ...(model.features?.length
          ? [`features=${model.features.map((value) => promptFacet(value, "model feature")).join("+")}`]
          : []),
      ];
      return `${promptToken(model.id, "model ID")}${facets.length ? ` [${facets.join(";")}]` : ""}`;
    });
    const omitted = provider.modelCount - provider.models.length;
    return `- ${promptToken(provider.connectionId, "connection ID")} | ${promptLabel(provider.label)} | provider=${promptToken(provider.providerId, "provider ID")} | ${provider.state} | authority=${provider.authority} | models=${models.join(", ") || "none"}${omitted > 0 ? ` | ${omitted} more discoverable in the model control` : ""}`;
  });
  return "[Airship inference roster pin]\n" +
    "Credential values are deliberately absent. This roster is a creation-time availability observation; the active binding below is the only inference authority for this immutable session.\n" +
    `Active: ${active}\n` +
    (lines.length ? lines.join("\n") : "- no connected inference providers");
}

function browserCapabilitySection(capabilities: readonly ObservedBrowserCapabilityPromptDefinition[]): string {
  const seen = new Set<string>();
  const lines = [...capabilities]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((capability) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(capability.id) || seen.has(capability.id)) {
        throw new TypeError("Observed browser capability IDs must be unique, bounded tokens.");
      }
      seen.add(capability.id);
      const detail = capability.detail.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 512);
      if (!detail) throw new TypeError("Observed browser capability detail is required.");
      return `- ${capability.id} [${capability.evidence}]: ${detail}`;
    });
  return "[Airship observed browser capability pin]\n" +
    "This is device state observed when the immutable session was created, not an execution grant or proof that a workload is using an accelerator. Call inspect_browser_capabilities for current page state; consuming runtimes report their active backend separately.\n" +
    lines.join("\n");
}

function installedToolSection(tools: readonly InstalledToolPromptDefinition[]): string {
  const lines = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => `- ${tool.name} [${tool.effect}]: ${tool.description.replace(/\s+/gu, " ").trim().slice(0, 512)}`);
  return `[Airship installed tool manifest]\n${lines.join("\n")}`;
}

function promptToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u.test(normalized)) {
    throw new TypeError(`${label} is not a bounded prompt token.`);
  }
  return normalized;
}

function promptFacet(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/u.test(normalized)) {
    throw new TypeError(`${label} is not a bounded prompt facet.`);
  }
  return normalized;
}

function promptLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 120 || /[|]/u.test(normalized)) {
    throw new TypeError("Inference provider label is invalid.");
  }
  return normalized;
}
