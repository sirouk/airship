import type { JsonValue, SecurityPosture, ToolDefinition } from "../core/contracts";
import { sha256 } from "../core/hash";
import {
  composeAirshipOperatingPrompt,
  type InferenceDirectoryPromptDefinition,
  type ObservedBrowserCapabilityPromptDefinition,
} from "../core/operating-charter";
import type { ApprovalMode } from "../approvals/modes";

const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 128 * 1_024;
const MAX_SKILLS = 512;
const MAX_TOOLS_PER_SKILL = 128;

export type ContentDigest = `sha256:${string}`;
export type SkillMode = "inherit" | "on" | "off";
/** The memory corpus a profile is allowed to prioritize for new work. */
export type ProfileMemoryScope = "session" | "profile" | "workspace";
/**
 * A profile never receives an ambient host path. It either follows the runtime
 * workspace selected by the person, or requires one exact runtime workspace ID.
 */
export type ProfileWorkspaceBinding = Readonly<
  | { kind: "active-workspace" }
  | { kind: "workspace-id"; workspaceId: string }
>;

/** The complete non-prompt profile boundary copied into a new session pin. */
export type ResolvedProfileSilo = Readonly<{
  workspaceBinding: ProfileWorkspaceBinding;
  memoryScope: ProfileMemoryScope;
  approvalMode: ApprovalMode;
}>;
export type ThemeColorScheme = "dark" | "light";
export type ThemeFontFamily = "system-sans" | "system-serif";
export type ThemeTypeScale = "compact" | "standard" | "large";
export type ThemeDensity = "compact" | "comfortable";
export type ThemeCorners = "square" | "subtle" | "rounded";

export const THEME_COLOR_ROLES = [
  "ground",
  "surface",
  "surfaceRaised",
  "surfaceSoft",
  "ink",
  "inkMuted",
  "inkFaint",
  "accent",
  "accentBright",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type HexColor = `#${string}`;
export type SemanticThemeColors = Readonly<Record<ThemeColorRole, HexColor>>;

/**
 * The only CSS properties a theme manifest can influence.
 *
 * Verdict/truth colors are deliberately absent. Profiles can change the
 * instrument's material and personality, never the meaning of evidence,
 * warnings, failures, or cost state.
 */
export const THEME_CSS_VARIABLES = Object.freeze({
  ground: "--ground",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  surfaceSoft: "--surface-soft",
  ink: "--ink",
  inkMuted: "--ink-muted",
  inkFaint: "--ink-faint",
  accent: "--accent",
  accentBright: "--accent-bright",
} satisfies Readonly<Record<ThemeColorRole, `--${string}`>>);

export type ThemeManifestDraft = Readonly<{
  themeId: string;
  name: string;
  description: string;
  colorScheme: ThemeColorScheme;
  colors: SemanticThemeColors;
  typography: Readonly<{
    body: ThemeFontFamily;
    scale: ThemeTypeScale;
  }>;
  layout: Readonly<{
    density: ThemeDensity;
    corners: ThemeCorners;
  }>;
}>;

/** A semantic-only theme: no selectors, URLs, arbitrary CSS, or executable assets. */
export type ThemeManifest = Readonly<ThemeManifestDraft & {
  version: 1;
  digest: ContentDigest;
}>;

export type SkillRevisionDraft = Readonly<{
  skillId: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Lower values are composed first. Ties are resolved by skill ID. */
  promptOrder?: number;
  requiredTools?: readonly string[];
}>;

export type SkillRevision = Readonly<{
  version: 1;
  skillId: string;
  name: string;
  description: string;
  systemPrompt: string;
  promptOrder: number;
  requiredTools: readonly string[];
  digest: ContentDigest;
}>;

export type GlobalSkillSettings = Readonly<Record<string, boolean>>;

export type ProfileRevisionDraft = Readonly<{
  /** Version 1 revisions remain valid historical objects. New revisions are version 2. */
  version?: 1 | 2;
  profileId: string;
  parentRevision?: ContentDigest;
  name: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  minimumPosture: SecurityPosture;
  /** Profile-owned workspace boundary. Omitted only by legacy version-1 profiles. */
  workspaceBinding?: ProfileWorkspaceBinding;
  /** Profile-owned recall lane. Omitted only by legacy version-1 profiles. */
  memoryScope?: ProfileMemoryScope;
  /** Profile-owned default for effectful browser actions. */
  approvalMode?: ApprovalMode;
  theme: Readonly<{
    themeId: string;
    digest: ContentDigest;
  }>;
  /** Missing entries are equivalent to `inherit`. */
  skillModes: Readonly<Record<string, SkillMode>>;
  createdAt: string;
}>;

export type ProfileRevision = Readonly<ProfileRevisionDraft & {
  version: 1 | 2;
  revision: ContentDigest;
}>;

export type ResolvedSkillDecision = Readonly<{
  skillId: string;
  digest: ContentDigest;
  mode: SkillMode;
  globallyEnabled: boolean;
  enabled: boolean;
  source: "global" | "profile";
}>;

export type ResolvedSkillPin = Readonly<{
  skillId: string;
  digest: ContentDigest;
  promptOrder: number;
}>;

/** Fully resolved, content-addressed material to copy into a new session manifest. */
export type SessionProfilePin = Readonly<{
  version: 2;
  profile: Readonly<{
    profileId: string;
    revision: ContentDigest;
  }>;
  theme: Readonly<{
    themeId: string;
    digest: ContentDigest;
  }>;
  providerId: string;
  model: string;
  minimumPosture: SecurityPosture;
  workspaceBinding: ProfileWorkspaceBinding;
  memoryScope: ProfileMemoryScope;
  approvalMode: ApprovalMode;
  skillDecisions: readonly ResolvedSkillDecision[];
  resolvedSkills: readonly ResolvedSkillPin[];
  resolvedSkillDigests: readonly ContentDigest[];
  skillSetDigest: ContentDigest;
  systemPrompt: string;
  systemPromptDigest: ContentDigest;
  resolutionDigest: ContentDigest;
}>;

export async function createThemeManifest(draft: ThemeManifestDraft): Promise<ThemeManifest> {
  const payload = themePayload(draft);
  const digest = await digestJson(payload);
  return deepFreeze({ ...payload, digest }) as ThemeManifest;
}

export function themeCssVariables(theme: ThemeManifest): Readonly<Record<string, HexColor>> {
  const properties: Record<string, HexColor> = {};
  for (const role of THEME_COLOR_ROLES) properties[THEME_CSS_VARIABLES[role]] = theme.colors[role];
  return deepFreeze(properties);
}

export async function createSkillRevision(draft: SkillRevisionDraft): Promise<SkillRevision> {
  const payload = skillPayload(draft);
  const digest = await digestJson(payload);
  return deepFreeze({ ...payload, digest }) as SkillRevision;
}

/** Copies and freezes UI-owned toggle state; this is not a persistence adapter. */
export function createGlobalSkillSettings(settings: Readonly<Record<string, boolean>>): GlobalSkillSettings {
  const entries = Object.entries(settings);
  if (entries.length > MAX_SKILLS) throw new Error("Global skill settings exceed the supported limit.");
  const normalized: Record<string, boolean> = {};
  for (const [rawSkillId, enabled] of entries.sort(([left], [right]) => asciiCompare(left, right))) {
    const skillId = identifier(rawSkillId, "skill ID");
    if (typeof enabled !== "boolean") throw new Error(`Global setting for ${skillId} must be boolean.`);
    normalized[skillId] = enabled;
  }
  return deepFreeze(normalized);
}

export async function createProfileRevision(draft: ProfileRevisionDraft): Promise<ProfileRevision> {
  const payload = profilePayload(draft);
  const revision = await digestJson(payload);
  return deepFreeze({ ...payload, revision }) as ProfileRevision;
}

/**
 * Resolves the implicit defaults of a historical v1 profile without rewriting
 * its digest. Callers should pin this result, never mutate the legacy object.
 */
export function resolveProfileSilo(profile: Pick<ProfileRevisionDraft,
  "workspaceBinding" | "memoryScope" | "approvalMode"
>): ResolvedProfileSilo {
  return deepFreeze({
    workspaceBinding: normalizeWorkspaceBinding(profile.workspaceBinding),
    memoryScope: oneOf(profile.memoryScope ?? "profile", ["session", "profile", "workspace"] as const, "memory scope"),
    approvalMode: oneOf(profile.approvalMode ?? "ask-first", ["ask-first", "auto-approve", "full-access"] as const, "approval mode"),
  }) as ResolvedProfileSilo;
}

export async function resolveProfileForSession(args: Readonly<{
  profile: ProfileRevision;
  theme: ThemeManifest;
  skills: readonly SkillRevision[];
  globalSkills: GlobalSkillSettings;
  /** Exact tool contracts installed in the runtime that will own this immutable session. */
  installedTools?: readonly ToolDefinition[];
  /** Successful device observations copied into this immutable session prompt. */
  browserCapabilities?: readonly ObservedBrowserCapabilityPromptDefinition[];
  /** Credential-free provider/model availability copied into this immutable session prompt. */
  inferenceDirectory?: InferenceDirectoryPromptDefinition;
}>): Promise<SessionProfilePin> {
  await verifyProfileRevision(args.profile);
  await verifyThemeManifest(args.theme);
  if (args.profile.theme.themeId !== args.theme.themeId || args.profile.theme.digest !== args.theme.digest) {
    throw new Error("Profile theme reference does not match the supplied theme revision.");
  }
  if (args.skills.length > MAX_SKILLS) throw new Error("Skill catalog exceeds the supported limit.");

  const skillsById = new Map<string, SkillRevision>();
  for (const skill of args.skills) {
    await verifySkillRevision(skill);
    if (skillsById.has(skill.skillId)) throw new Error(`Duplicate skill revision for ${skill.skillId}.`);
    skillsById.set(skill.skillId, skill);
  }

  const globalSkills = createGlobalSkillSettings(args.globalSkills);
  assertKnownSkillIds(Object.keys(globalSkills), skillsById, "Global settings");
  assertKnownSkillIds(Object.keys(args.profile.skillModes), skillsById, "Profile settings");

  const orderedSkills = [...skillsById.values()].sort(
    (left, right) => left.promptOrder - right.promptOrder || asciiCompare(left.skillId, right.skillId),
  );
  const decisions: ResolvedSkillDecision[] = [];
  const enabledSkills: SkillRevision[] = [];
  for (const skill of orderedSkills) {
    const mode = args.profile.skillModes[skill.skillId] ?? "inherit";
    const globallyEnabled = globalSkills[skill.skillId] ?? false;
    const enabled = mode === "on" || (mode === "inherit" && globallyEnabled);
    decisions.push({
      skillId: skill.skillId,
      digest: skill.digest,
      mode,
      globallyEnabled,
      enabled,
      source: mode === "inherit" ? "global" : "profile",
    });
    if (enabled) enabledSkills.push(skill);
  }

  const resolvedSkills: ResolvedSkillPin[] = enabledSkills.map((skill) => ({
    skillId: skill.skillId,
    digest: skill.digest,
    promptOrder: skill.promptOrder,
  }));
  const resolvedSkillDigests = resolvedSkills.map((skill) => skill.digest);
  const skillSetDigest = await digestJson(resolvedSkills.map((skill) => ({
    skillId: skill.skillId,
    digest: skill.digest,
    promptOrder: skill.promptOrder,
  })));
  const systemPrompt = composeSystemPrompt(
    args.profile.systemPrompt,
    enabledSkills,
    args.installedTools ?? [],
    args.browserCapabilities ?? [],
    args.inferenceDirectory,
  );
  const systemPromptDigest = asContentDigest(await sha256(systemPrompt));
  const silo = resolveProfileSilo(args.profile);
  const resolutionDigest = await digestJson({
    version: 2,
    profile: { profileId: args.profile.profileId, revision: args.profile.revision },
    theme: { themeId: args.theme.themeId, digest: args.theme.digest },
    providerId: args.profile.providerId,
    model: args.profile.model,
    minimumPosture: args.profile.minimumPosture,
    workspaceBinding: silo.workspaceBinding,
    memoryScope: silo.memoryScope,
    approvalMode: silo.approvalMode,
    resolvedSkills: resolvedSkills.map((skill) => ({
      skillId: skill.skillId,
      digest: skill.digest,
      promptOrder: skill.promptOrder,
    })),
    skillSetDigest,
    systemPromptDigest,
  });

  return deepFreeze({
    version: 2,
    profile: { profileId: args.profile.profileId, revision: args.profile.revision },
    theme: { themeId: args.theme.themeId, digest: args.theme.digest },
    providerId: args.profile.providerId,
    model: args.profile.model,
    minimumPosture: args.profile.minimumPosture,
    workspaceBinding: silo.workspaceBinding,
    memoryScope: silo.memoryScope,
    approvalMode: silo.approvalMode,
    skillDecisions: decisions,
    resolvedSkills,
    resolvedSkillDigests,
    skillSetDigest,
    systemPrompt,
    systemPromptDigest,
    resolutionDigest,
  }) as SessionProfilePin;
}

function composeSystemPrompt(
  basePrompt: string,
  skills: readonly SkillRevision[],
  installedTools: readonly ToolDefinition[],
  browserCapabilities: readonly ObservedBrowserCapabilityPromptDefinition[],
  inferenceDirectory?: InferenceDirectoryPromptDefinition,
): string {
  return composeAirshipOperatingPrompt(basePrompt, skills, installedTools, browserCapabilities, inferenceDirectory);
}

async function verifyThemeManifest(theme: ThemeManifest): Promise<void> {
  const expected = await createThemeManifest(theme);
  if (expected.digest !== theme.digest) throw new Error(`Theme ${theme.themeId} failed its content-digest check.`);
}

async function verifySkillRevision(skill: SkillRevision): Promise<void> {
  const expected = await createSkillRevision(skill);
  if (expected.digest !== skill.digest) throw new Error(`Skill ${skill.skillId} failed its content-digest check.`);
}

async function verifyProfileRevision(profile: ProfileRevision): Promise<void> {
  const expected = await createProfileRevision(profile);
  if (expected.revision !== profile.revision) {
    throw new Error(`Profile ${profile.profileId} failed its revision check.`);
  }
}

function themePayload(draft: ThemeManifestDraft): Omit<ThemeManifest, "digest"> {
  const themeId = identifier(draft.themeId, "theme ID");
  const colorKeys = Object.keys(draft.colors);
  const unknownColors = colorKeys.filter((key) => !THEME_COLOR_ROLES.includes(key as ThemeColorRole));
  if (unknownColors.length > 0 || colorKeys.length !== THEME_COLOR_ROLES.length) {
    throw new Error("Theme colors must contain exactly the supported semantic roles.");
  }
  const colors = Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => [role, color(draft.colors[role], role)]),
  ) as Record<ThemeColorRole, HexColor>;
  const colorScheme = oneOf(draft.colorScheme, ["dark", "light"] as const, "theme color scheme");
  const body = oneOf(draft.typography.body, ["system-sans", "system-serif"] as const, "theme body font");
  const scale = oneOf(draft.typography.scale, ["compact", "standard", "large"] as const, "theme type scale");
  const density = oneOf(draft.layout.density, ["compact", "comfortable"] as const, "theme density");
  const corners = oneOf(draft.layout.corners, ["square", "subtle", "rounded"] as const, "theme corners");
  return {
    version: 1,
    themeId,
    name: boundedText(draft.name, "theme name", MAX_NAME_LENGTH),
    description: boundedText(draft.description, "theme description", MAX_DESCRIPTION_LENGTH, true),
    colorScheme,
    colors,
    typography: { body, scale },
    layout: { density, corners },
  };
}

function skillPayload(draft: SkillRevisionDraft): Omit<SkillRevision, "digest"> {
  const promptOrder = draft.promptOrder ?? 100;
  if (!Number.isSafeInteger(promptOrder) || promptOrder < -10_000 || promptOrder > 10_000) {
    throw new Error("Skill prompt order must be an integer between -10000 and 10000.");
  }
  const requiredTools = [...(draft.requiredTools ?? [])].map((tool) => toolName(tool));
  if (requiredTools.length > MAX_TOOLS_PER_SKILL) throw new Error("Skill requires too many tools.");
  if (new Set(requiredTools).size !== requiredTools.length) throw new Error("Skill required tools must be unique.");
  requiredTools.sort(asciiCompare);
  return {
    version: 1,
    skillId: identifier(draft.skillId, "skill ID"),
    name: boundedText(draft.name, "skill name", MAX_NAME_LENGTH),
    description: boundedText(draft.description, "skill description", MAX_DESCRIPTION_LENGTH, true),
    systemPrompt: prompt(draft.systemPrompt, "skill system prompt"),
    promptOrder,
    requiredTools,
  };
}

function profilePayload(draft: ProfileRevisionDraft): Omit<ProfileRevision, "revision"> {
  const skillEntries = Object.entries(draft.skillModes);
  if (skillEntries.length > MAX_SKILLS) throw new Error("Profile skill settings exceed the supported limit.");
  const skillModes: Record<string, SkillMode> = {};
  for (const [rawSkillId, rawMode] of skillEntries.sort(([left], [right]) => asciiCompare(left, right))) {
    const skillId = identifier(rawSkillId, "skill ID");
    skillModes[skillId] = oneOf(rawMode, ["inherit", "on", "off"] as const, `mode for ${skillId}`);
  }
  const parentRevision = draft.parentRevision ? contentDigest(draft.parentRevision, "parent profile revision") : undefined;
  const version = draft.version ?? 2;
  if (version !== 1 && version !== 2) throw new Error("Profile version is invalid.");
  const base = {
    version,
    profileId: identifier(draft.profileId, "profile ID"),
    name: boundedText(draft.name, "profile name", MAX_NAME_LENGTH),
    description: boundedText(draft.description, "profile description", MAX_DESCRIPTION_LENGTH, true),
    systemPrompt: prompt(draft.systemPrompt, "profile system prompt"),
    providerId: identifier(draft.providerId, "provider ID"),
    model: boundedText(draft.model, "model", 256),
    minimumPosture: oneOf(
      draft.minimumPosture,
      ["local", "plaintext-remote", "encrypted-unattested", "encrypted-attested"] as const,
      "minimum posture",
    ),
    theme: {
      themeId: identifier(draft.theme.themeId, "theme ID"),
      digest: contentDigest(draft.theme.digest, "theme digest"),
    },
    skillModes,
    createdAt: isoTimestamp(draft.createdAt),
  };
  if (version === 1) {
    if (draft.workspaceBinding !== undefined || draft.memoryScope !== undefined || draft.approvalMode !== undefined) {
      throw new Error("Version 1 profiles cannot carry silo settings; create a new revision instead.");
    }
    return parentRevision ? { ...base, parentRevision } : base;
  }
  const silo = resolveProfileSilo(draft);
  const v2 = { ...base, ...silo };
  return parentRevision ? { ...v2, parentRevision } : v2;
}

function normalizeWorkspaceBinding(value: ProfileWorkspaceBinding | undefined): ProfileWorkspaceBinding {
  if (value === undefined) return Object.freeze({ kind: "active-workspace" });
  if (value.kind === "active-workspace") {
    if (Object.keys(value).length !== 1) throw new Error("Active workspace binding cannot include a workspace ID.");
    return Object.freeze({ kind: "active-workspace" });
  }
  if (value.kind !== "workspace-id") throw new Error("Workspace binding is invalid.");
  const workspaceId = boundedText(value.workspaceId, "workspace ID", 512);
  if (/^[\u0000-\u001f\u007f]/u.test(workspaceId)) throw new Error("Workspace ID is invalid.");
  return Object.freeze({ kind: "workspace-id", workspaceId });
}

function assertKnownSkillIds(
  skillIds: readonly string[],
  catalog: ReadonlyMap<string, SkillRevision>,
  label: string,
): void {
  for (const skillId of skillIds) {
    if (!catalog.has(skillId)) throw new Error(`${label} reference missing skill ${skillId}.`);
  }
}

async function digestJson(value: unknown): Promise<ContentDigest> {
  return asContentDigest(await sha256(canonicalStringify(toJsonValue(value))));
}

function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => asciiCompare(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`).join(",")}}`;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Content-addressed values must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) throw new Error("Content-addressed values cannot contain undefined.");
      output[key] = toJsonValue(child);
    }
    return output;
  }
  throw new Error("Content-addressed values must be JSON-compatible.");
}

function asContentDigest(value: string): ContentDigest {
  return contentDigest(value, "content digest");
}

function contentDigest(value: string, label: string): ContentDigest {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value as ContentDigest;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(normalized)) {
    throw new Error(`${label} must be a lowercase, path-free identifier.`);
  }
  return normalized;
}

function toolName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.:/-]{0,254}[A-Za-z0-9])?$/u.test(normalized)) {
    throw new Error("Skill tool name is invalid.");
  }
  return normalized;
}

function color(value: string, role: ThemeColorRole): HexColor {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(normalized)) {
    throw new Error(`Theme color ${role} must be a six- or eight-digit hex color.`);
  }
  return normalized as HexColor;
}

function boundedText(value: string, label: string, maximum: number, allowEmpty = false): string {
  const normalized = normalizeNewlines(value).trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum) {
    throw new Error(`${label} must contain ${allowEmpty ? "at most" : "between 1 and"} ${maximum} characters.`);
  }
  return normalized;
}

function prompt(value: string, label: string): string {
  return boundedText(value, label, MAX_PROMPT_LENGTH);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function isoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Profile creation time is invalid.");
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== value) throw new Error("Profile creation time must be a canonical ISO timestamp.");
  return canonical;
}

function oneOf<const T extends string>(value: string, choices: readonly T[], label: string): T {
  if (!choices.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
