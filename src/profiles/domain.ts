import { deepFreeze } from "../core/freeze";
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
/**
 * One skill-count ceiling for the whole product.
 *
 * There were two, and they disagreed: this module refused above 512 while
 * `persistence.ts` admitted 1_024. A catalog of 600 skills therefore passed
 * `validateProfileCatalog`, was sealed into the encrypted head, and then threw
 * "Skill catalog exceeds the supported limit." out of `resolveProfileForSession`
 * on every subsequent boot — durable state the product had accepted and could
 * no longer open. That gap was unreachable while the shipped set was the only
 * source of a skill (6 built-ins). Authoring makes it reachable one skill at a
 * time, so the two constants become one and the value that refuses is the value
 * that admits.
 */
export const MAX_CATALOG_SKILLS = 512;
const MAX_TOOLS_PER_SKILL = 128;

/**
 * The namespace an authored skill lives in, and the only namespace this product
 * will edit or delete.
 *
 * A built-in's text is release-owned: `reconcileBuiltInSkills` replaces any
 * persisted copy whose digest drifts from the shipped one, so letting authoring
 * write a built-in id would mean the next release silently overwrites the
 * person's words with no record that they existed. The prefix is what makes
 * "this is yours" and "this is ours" a decidable question at every seam that
 * has to answer it.
 */
export const CUSTOM_SKILL_ID_PREFIX = "custom.";

export function isCustomSkillId(skillId: string): boolean {
  return skillId.startsWith(CUSTOM_SKILL_ID_PREFIX);
}

export type ContentDigest = `sha256:${string}`;
export type SkillMode = "inherit" | "on" | "off";
/** Which client route owns this Agent Profile's ordinary web requests. */
export type ProfileWebEgress = "node-first" | "browser-only";
/**
 * What `fetch_url` is allowed to bring back.
 *
 * `any` is the default and the intent: an agent asked for an address, the
 * origin answered, and deciding on the agent's behalf that a PDF or an image
 * or a mislabelled JSON body is not worth having is the client overreaching.
 * Text arrives as text, everything else arrives as a workspace file, and the
 * agent decides what it is for.
 *
 * `text-only` is the opt-out for a profile that wants a narrower blast radius —
 * no binary ever lands in its workspace from the network. It is a deliberate
 * restriction, never a default, and it is the only setting that can make a
 * successful response fail.
 */
export type ProfileWebBodies = "any" | "text-only";
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
  /** Node's reviewed client-side http/https relay is the default when absent. */
  webEgress?: ProfileWebEgress;
  /** Any format the origin answers with is the default when absent. */
  webBodies?: ProfileWebBodies;
  theme: Readonly<{
    themeId: string;
    digest: ContentDigest;
  }>;
  /** Missing entries are equivalent to `inherit`. */
  skillModes: Readonly<Record<string, SkillMode>>;
  /**
   * Display-only presentation choices made on this profile. They change what
   * Preact renders and how deeply information begins expanded — never
   * capabilities, permissions, context, storage, evidence, agent behavior,
   * or the audit trail. Absent means the ordinary default.
   */
  presentation?: Readonly<{
    /**
     * Whether a turn's provider-exposed reasoning opens expanded or behind
     * one deliberate action. `collapsed` is the ordinary default: the part is
     * a summary line that expands on demand.
     */
    reasoningVisibility?: "collapsed" | "expanded";
    /**
     * How much commentary, telemetry, proof echo, suggestion, and raw detail
     * Preact renders. Retired surfaces are unmounted rather than hidden —
     * capability, evidence, and agent behavior never change, only the cost
     * and calm of the view. Absent means the house default: minimal.
     */
    density?: "minimal" | "balanced" | "instrumented";
  }>;
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

/**
 * The stylesheet's own value for every theme role, per color scheme.
 *
 * Mirrors `ui/tokens.css` `:root` (dark) and the `[data-mode="light"]` block in
 * `ui/platform-shell.css` (light). `ui/css-variable-contract.test.ts` parses
 * both sheets and fails if this table drifts from them.
 */
export const STYLESHEET_THEME_BASELINE = Object.freeze({
  dark: Object.freeze({
    ground: "#101417",
    surface: "#171c20",
    surfaceRaised: "#1c2226",
    surfaceSoft: "#14191c",
    ink: "#ece8de",
    inkMuted: "#b0b6b3",
    inkFaint: "#949c99",
    accent: "#c19a58",
    accentBright: "#dfba72",
  }),
  light: Object.freeze({
    ground: "#f3efe5",
    surface: "#efe9dc",
    surfaceRaised: "#fbf7ee",
    surfaceSoft: "#eae3d4",
    ink: "#1a1d1f",
    inkMuted: "#454b49",
    inkFaint: "#5c635f",
    accent: "#644d25",
    accentBright: "#4b3711",
  }),
} satisfies Readonly<Record<ThemeColorScheme, SemanticThemeColors>>);

/**
 * A theme is a *diff* against the shipped palette, not a copy of it.
 *
 * These properties are written inline on `<html>`, so they outrank every
 * stylesheet including the one a colour-mode preference selects. A role the
 * theme has not actually changed therefore has to be written as the empty
 * string — CSSOM treats that as `removeProperty`, so the declaration is
 * cleared rather than pinned, the cascade answers for it, and switching away
 * from a theme cannot strand the previous theme's colour on the element.
 *
 * This is the mechanism behind "Paper mode makes every divider invisible":
 * `--line` is not a theme role, so the light stylesheet flipped it to a dark
 * ink while the nine inline roles held the dark surfaces underneath it —
 * 1.259:1 down to 1.007:1, a divider darker than the panel it divides. The
 * default profile now writes no inline properties at all, so the mode owns
 * the whole palette, and a theme that genuinely recolours the instrument
 * still writes only the roles it genuinely recolours.
 *
 * The diff is taken against the cascade that is *actually in force*, which is
 * the global colour-mode preference — not the manifest's own `colorScheme`.
 * Getting that backwards is what broke Paper mode on the Research and
 * Developer profiles: a dark-scheme theme diffed against the dark sheet, so
 * all nine roles read as "changed" relative to a light sheet nobody consulted,
 * and a full dark palette was pinned inline on top of the light stylesheet.
 * The theme layer has no light expression of a dark palette to substitute, so
 * when the mode disagrees with the manifest the only truthful answer is to
 * write nothing and let the mode own the instrument entirely.
 */
export function themeCssVariables(
  theme: ThemeManifest,
  mode: ThemeColorScheme = theme.colorScheme,
): Readonly<Record<string, HexColor | "">> {
  const baseline = STYLESHEET_THEME_BASELINE[mode];
  const deferToStylesheet = mode !== theme.colorScheme;
  const properties: Record<string, HexColor | ""> = {};
  for (const role of THEME_COLOR_ROLES) {
    const value = theme.colors[role];
    properties[THEME_CSS_VARIABLES[role]] = deferToStylesheet || value === baseline[role] ? "" : value;
  }
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
  if (entries.length > MAX_CATALOG_SKILLS) throw new Error("Global skill settings exceed the supported limit.");
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

/** Verify a stored revision against one synchronously owned caller snapshot. */
export async function validateProfileRevision(value: ProfileRevision): Promise<ProfileRevision> {
  const snapshot = snapshotCallerOwned(value);
  const expectedRevision = snapshot.revision;
  const payload = profilePayload(snapshot);
  const revision = await digestJson(payload);
  if (revision !== expectedRevision) {
    throw new Error(`Profile ${payload.profileId} failed its revision check.`);
  }
  return deepFreeze({ ...payload, revision }) as ProfileRevision;
}

/**
 * Resolves the implicit defaults of a historical v1 profile without rewriting
 * its digest. Callers should pin this result, never mutate the legacy object.
 *
 * This is also the payload normalizer every revision digest is derived from, so
 * it must stay byte-stable for values already stored: it validates the enum, it
 * does not withdraw members of it. Withdrawal happens at the seams that *use* a
 * scope — see `enforcedMemoryScope`.
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

export function resolveProfileWebEgress(
  profile: Pick<ProfileRevisionDraft, "webEgress">,
): ProfileWebEgress {
  return oneOf(profile.webEgress ?? "node-first", ["node-first", "browser-only"] as const, "web egress");
}

export function resolveProfileWebBodies(
  profile: Pick<ProfileRevisionDraft, "webBodies">,
): ProfileWebBodies {
  return oneOf(profile.webBodies ?? "any", ["any", "text-only"] as const, "web bodies");
}

/**
 * The memory boundary a pin will actually enforce.
 *
 * `workspace` reads as `profile`, because it has never been anything else:
 * memory records are per-workspace by file location but per-profile by scope
 * stamp, and every reader — the turn seam, `recall_memory`, `search_memory` —
 * narrows on `profileId` equality, so a `workspace` pin returned exactly the
 * records a `profile` pin returns. Widening it to mean what it says would be a
 * deliberate silo change, not a bug fix, so the honest value to pin and to
 * display is the one that was enforced.
 *
 * The member stays in the schema, and stored revisions keep it, so no persisted
 * profile fails its revision check and no manifest or audit validator has to
 * reject a value it previously accepted.
 */
export function enforcedMemoryScope(scope: ProfileMemoryScope): EnforcedProfileMemoryScope {
  return scope === "workspace" ? "profile" : scope;
}

/**
 * What the scope resolves to, with `workspace` removed by construction.
 *
 * The return type used to be the whole `ProfileMemoryScope`, which made every
 * caller carry a `workspace` case the function has already eliminated — so a
 * label map keyed on the two real scopes could not be indexed without a cast,
 * and a cast is exactly how a third scope would slip past a display surface
 * unlabelled. Narrowing here means the type system enforces the resolution the
 * body performs.
 */
export type EnforcedProfileMemoryScope = Exclude<ProfileMemoryScope, "workspace">;

/**
 * Which skills a profile resolves ON — the one loop, answered synchronously.
 *
 * `resolveProfileForSession` below owns this precedence, but it is async and
 * re-verifies every revision digest, so the three UI surfaces that only need
 * the boolean restated `on` / `inherit` / global-default inline instead: the
 * Skills grid, its "effective set" counter, and `effectiveSkillIds`. Two of
 * those sorted with `localeCompare` where the pin uses `asciiCompare`, so a
 * catalog whose skill IDs collate differently under the host locale would have
 * shown an order no manifest was ever composed in. Exported so a display can
 * ask the same question the pin answers instead of re-deriving it.
 *
 * Digest verification stays with the pin: this is a read of already-loaded
 * catalog state, not an admission path.
 */
export function resolveSkillDecisions(args: Readonly<{
  skillModes: Readonly<Record<string, SkillMode>>;
  skills: readonly SkillRevision[];
  globalSkills: GlobalSkillSettings;
}>): readonly ResolvedSkillDecision[] {
  return [...args.skills]
    .sort((left, right) => left.promptOrder - right.promptOrder || asciiCompare(left.skillId, right.skillId))
    .map((skill): ResolvedSkillDecision => {
      const mode = args.skillModes[skill.skillId] ?? "inherit";
      const globallyEnabled = args.globalSkills[skill.skillId] ?? false;
      return {
        skillId: skill.skillId,
        digest: skill.digest,
        mode,
        globallyEnabled,
        enabled: mode === "on" || (mode === "inherit" && globallyEnabled),
        source: mode === "inherit" ? "global" : "profile",
      };
    });
}

type ProfileResolutionArgs = Readonly<{
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
}>;

export async function resolveProfileForSession(args: ProfileResolutionArgs): Promise<SessionProfilePin> {
  /*
   * This is the admission boundary. Read each supported top-level field once,
   * then clone the whole reachable graph in one synchronous operation so shared
   * nested objects are copied once too. Nothing below this line may consult the
   * caller's mutable objects after SHA-256 yields control.
   */
  const snapshot = snapshotProfileResolutionArgs(args);

  await verifyProfileRevision(snapshot.profile);
  await verifyThemeManifest(snapshot.theme);
  if (
    snapshot.profile.theme.themeId !== snapshot.theme.themeId
    || snapshot.profile.theme.digest !== snapshot.theme.digest
  ) {
    throw new Error("Profile theme reference does not match the supplied theme revision.");
  }
  if (snapshot.skills.length > MAX_CATALOG_SKILLS) throw new Error("Skill catalog exceeds the supported limit.");

  const skillsById = new Map<string, SkillRevision>();
  for (const skill of snapshot.skills) {
    await verifySkillRevision(skill);
    if (skillsById.has(skill.skillId)) throw new Error(`Duplicate skill revision for ${skill.skillId}.`);
    skillsById.set(skill.skillId, skill);
  }

  const globalSkills = createGlobalSkillSettings(snapshot.globalSkills);
  assertKnownSkillIds(Object.keys(globalSkills), skillsById, "Global settings");
  assertKnownSkillIds(Object.keys(snapshot.profile.skillModes), skillsById, "Profile settings");

  const orderedSkills = [...skillsById.values()].sort(
    (left, right) => left.promptOrder - right.promptOrder || asciiCompare(left.skillId, right.skillId),
  );
  const decisions = resolveSkillDecisions({
    skillModes: snapshot.profile.skillModes,
    skills: orderedSkills,
    globalSkills,
  });
  const enabledSkillIds = new Set(decisions.filter((decision) => decision.enabled).map((decision) => decision.skillId));
  const enabledSkills = orderedSkills.filter((skill) => enabledSkillIds.has(skill.skillId));

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
    snapshot.profile.systemPrompt,
    enabledSkills,
    snapshot.installedTools ?? [],
    snapshot.browserCapabilities ?? [],
    snapshot.inferenceDirectory,
  );
  const systemPromptDigest = asContentDigest(await sha256(systemPrompt));
  const stored = resolveProfileSilo(snapshot.profile);
  // The pin carries the boundary the session will be governed by, not the one
  // the revision was written with, so a withdrawn scope is resolved here rather
  // than left for each reader to reinterpret.
  const silo: ResolvedProfileSilo = Object.freeze({
    ...stored,
    memoryScope: enforcedMemoryScope(stored.memoryScope),
  });
  const resolutionDigest = await digestJson({
    version: 2,
    profile: { profileId: snapshot.profile.profileId, revision: snapshot.profile.revision },
    theme: { themeId: snapshot.theme.themeId, digest: snapshot.theme.digest },
    providerId: snapshot.profile.providerId,
    model: snapshot.profile.model,
    minimumPosture: snapshot.profile.minimumPosture,
    workspaceBinding: silo.workspaceBinding,
    /*
     * The STORED scope, deliberately, where the pin field above carries the
     * enforced one.
     *
     * This digest identifies the resolution's *inputs*, and it is compared for
     * equality against digests already written into other people's manifests —
     * `compareProfiles` downgrades any difference to "Fork required". Digesting
     * the enforced scope instead changed the digest of an unchanged profile
     * revision the moment `workspace` was withdrawn, which would have stranded
     * every conversation pinned under it (the shipped Research profile pinned
     * `workspace`) behind a mismatch about a boundary that never differed. So:
     * the digest stays byte-stable for values already stored, and the visible
     * field states what is enforced.
     */
    memoryScope: stored.memoryScope,
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
    profile: { profileId: snapshot.profile.profileId, revision: snapshot.profile.revision },
    theme: { themeId: snapshot.theme.themeId, digest: snapshot.theme.digest },
    providerId: snapshot.profile.providerId,
    model: snapshot.profile.model,
    minimumPosture: snapshot.profile.minimumPosture,
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

function snapshotProfileResolutionArgs(args: ProfileResolutionArgs): ProfileResolutionArgs {
  // Capture only supported fields. This avoids invoking unrelated accessors on
  // an object supplied by an embedding caller while still reading each field
  // in this contract exactly once.
  const profile = args.profile;
  const theme = args.theme;
  const skills = args.skills;
  const globalSkills = args.globalSkills;
  const installedTools = args.installedTools;
  const browserCapabilities = args.browserCapabilities;
  const inferenceDirectory = args.inferenceDirectory;

  /*
   * Clone the whole supported graph at once. This preserves aliases and means
   * a nested accessor shared by two fields is invoked once, not once per field.
   */
  return snapshotCallerOwned({
    profile,
    theme,
    skills,
    globalSkills,
    installedTools,
    browserCapabilities,
    inferenceDirectory,
  });
}

/**
 * Takes one synchronous, deeply owned snapshot of a caller graph.
 *
 * `structuredClone` reads each enumerable accessor once and preserves aliases.
 * Freezing the clone, rather than the source, keeps caller state untouched and
 * makes every later await safe to cross.
 */
function snapshotCallerOwned<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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
  const snapshot = snapshotCallerOwned(theme);
  const expectedDigest = snapshot.digest;
  const themeId = snapshot.themeId;
  const expected = await createThemeManifest(snapshot);
  if (expected.digest !== expectedDigest) throw new Error(`Theme ${themeId} failed its content-digest check.`);
}

async function verifySkillRevision(skill: SkillRevision): Promise<void> {
  const snapshot = snapshotCallerOwned(skill);
  const expectedDigest = snapshot.digest;
  const skillId = snapshot.skillId;
  const expected = await createSkillRevision(snapshot);
  if (expected.digest !== expectedDigest) throw new Error(`Skill ${skillId} failed its content-digest check.`);
}

async function verifyProfileRevision(profile: ProfileRevision): Promise<void> {
  await validateProfileRevision(profile);
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
  if (skillEntries.length > MAX_CATALOG_SKILLS) throw new Error("Profile skill settings exceed the supported limit.");
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
    if (
      draft.workspaceBinding !== undefined || draft.memoryScope !== undefined || draft.approvalMode !== undefined
      || draft.webEgress !== undefined || draft.webBodies !== undefined || draft.presentation !== undefined
    ) {
      throw new Error("Version 1 profiles cannot carry silo settings; create a new revision instead.");
    }
    return parentRevision ? { ...base, parentRevision } : base;
  }
  const silo = resolveProfileSilo(draft);
  const webEgress = draft.webEgress === undefined ? undefined : resolveProfileWebEgress(draft);
  const webBodies = draft.webBodies === undefined ? undefined : resolveProfileWebBodies(draft);
  const presentation = normalizeProfilePresentation(draft.presentation);
  const v2 = {
    ...base,
    ...silo,
    ...(webEgress === undefined ? {} : { webEgress }),
    ...(webBodies === undefined ? {} : { webBodies }),
    ...(presentation ? { presentation } : {}),
  };
  return parentRevision ? { ...v2, parentRevision } : v2;
}

/**
 * The presentation payload a revision may carry: every member validated, and
 * nothing when nothing is set. Byte stability is the rule — a revision that
 * stored no presentation must digest identically before and after this field
 * existed, and an all-default presentation object must never materialize as
 * an empty key that changes that digest.
 */
function normalizeProfilePresentation(
  value: ProfileRevisionDraft["presentation"],
): ProfileRevisionDraft["presentation"] | undefined {
  if (value === undefined) return undefined;
  const reasoningVisibility = value.reasoningVisibility === undefined
    ? undefined
    : oneOf(value.reasoningVisibility, ["collapsed", "expanded"] as const, "reasoning visibility");
  const density = value.density === undefined
    ? undefined
    : oneOf(value.density, ["minimal", "balanced", "instrumented"] as const, "presentation density");
  if (reasoningVisibility === undefined && density === undefined) return undefined;
  return deepFreeze({
    ...(reasoningVisibility === undefined ? {} : { reasoningVisibility }),
    ...(density === undefined ? {} : { density }),
  });
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
