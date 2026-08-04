import {
  CUSTOM_SKILL_ID_PREFIX,
  MAX_CATALOG_SKILLS,
  createGlobalSkillSettings,
  createProfileRevision,
  createSkillRevision,
  createThemeManifest,
  isCustomSkillId,
  type GlobalSkillSettings,
  type ProfileRevision,
  type SkillMode,
  type SkillRevision,
  type ThemeManifest,
  type ThemeManifestDraft,
} from "./domain";

/**
 * Presentation a profile owns but no session has to resolve.
 *
 * The editor's syntax palette is carried by the agent — switching profiles
 * switches the sheet — and it is saved the instant it is changed, with no Save
 * button anywhere near it. Neither of those is compatible with
 * `ProfileRevision`, which is immutable, content-addressed and pinned into
 * every conversation started under it: a theme click would mint one revision
 * per click, and each one would have to be resolvable forever to answer a
 * question no transcript ever asks.
 *
 * So it sits beside the revisions in the same catalog, exactly as
 * `globalSkills` does — mutable, keyed by `profileId` rather than by revision,
 * written through the one conditional-write catalog transaction, and durable
 * in the Vault when a Vault has been adopted.
 */
export type ProfileEditorSettings = Readonly<{ codeThemeId: string }>;

export type ProfileCatalog = Readonly<{
  themes: readonly ThemeManifest[];
  skills: readonly SkillRevision[];
  profiles: readonly ProfileRevision[];
  /** Revisions retained for historical conversation resolution but hidden from new work. */
  archivedProfileIds?: readonly string[];
  globalSkills: GlobalSkillSettings;
  /** Keyed by `profileId`. An absent entry reads as the shipped default. */
  editorSettings?: Readonly<Record<string, ProfileEditorSettings>>;
}>;

/**
 * The id this profile stored, or nothing.
 *
 * Deliberately *not* resolved against the shipped palette table. This module
 * is on the boot path — `app.tsx` reads the catalog before first paint — and
 * the palettes are six full colour tables nobody needs until the editor opens.
 * Naming the table here would have hoisted it into the eager bundle for a
 * string comparison. The editor resolves the id, including the fallback for an
 * id a later release wrote and this build does not ship.
 */
export function profileCodeThemeId(catalog: ProfileCatalog, profileId: string): string | undefined {
  return catalog.editorSettings?.[profileId]?.codeThemeId;
}

/**
 * Identity is returned when the choice is already the stored one, so a menu
 * that re-selects the current theme costs no catalog generation and no write.
 *
 * The id is checked for shape, not for membership — same reason as above, and
 * the same forward-compatibility rule the persistence validator follows: a
 * palette this build does not know is stored intact and rendered as the
 * default, never discarded.
 */
export function setProfileCodeTheme(catalog: ProfileCatalog, profileId: string, codeThemeId: string): ProfileCatalog {
  if (codeThemeId.length === 0 || codeThemeId.length > 64 || !/^[a-z0-9][a-z0-9-]*$/u.test(codeThemeId)) {
    throw new Error(`${codeThemeId} is not a usable editor theme id.`);
  }
  if (catalog.editorSettings?.[profileId]?.codeThemeId === codeThemeId) return catalog;
  return Object.freeze({
    ...catalog,
    editorSettings: Object.freeze({
      ...catalog.editorSettings,
      [profileId]: Object.freeze({ codeThemeId }),
    }),
  });
}

export function managedProfileRevisions(catalog: ProfileCatalog): readonly ProfileRevision[] {
  const archived = new Set(catalog.archivedProfileIds ?? []);
  return catalog.profiles.filter((profile) => !archived.has(profile.profileId));
}

export function archiveProfileRevision(catalog: ProfileCatalog, profileId: string): ProfileCatalog {
  const managed = managedProfileRevisions(catalog);
  if (managed.length <= 1) throw new Error("Airship must retain at least one profile.");
  if (!managed.some((profile) => profile.profileId === profileId)) throw new Error("The selected profile is already archived or no longer exists.");
  return Object.freeze({
    ...catalog,
    archivedProfileIds: Object.freeze([...new Set([...(catalog.archivedProfileIds ?? []), profileId])]),
  });
}

/**
 * Union the shipped skills into a catalog written by an earlier release.
 *
 * The skill set is a build-time constant, and the catalog is durable state, so
 * the two drift the moment a Vault is adopted: the persisted catalog wins for
 * every later boot and the release's new skills are unreachable forever.
 *
 * The join is therefore deliberately narrow and one-directional:
 *
 * - a built-in absent from the persisted catalog is added;
 * - a built-in whose content changed between releases is replaced, because a
 *   built-in's text is release-owned and past conversations carry their own
 *   pinned copy of the revision they ran under;
 * - anything else in `persisted.skills` is left exactly as it is, including
 *   skills this build has never heard of and every skill the person authored;
 * - `globalSkills`, `skillModes`, profiles, themes and archive state are never
 *   touched — an absent entry already reads as off/inherit downstream.
 *
 * The second bullet is why the namespace assertion below exists. "Replaced"
 * means the persisted text is discarded with no record it was ever there, which
 * is the correct answer for release-owned words and the wrong answer for a
 * person's. Before authoring, a missing skill was unambiguous absence and a
 * present one could only have come from a release, so no id could be contested.
 * Now one can, and the only thing standing between an authored skill and a
 * future release quietly overwriting it is that the shipped set never claims the
 * `custom.` namespace. That is a build-time property of this file's own drafts,
 * so it is asserted here rather than hoped for.
 *
 * Identity is returned when nothing changed, which is what lets callers skip a
 * pointless generation bump and keep the digest chain still.
 */
export function reconcileBuiltInSkills(persisted: ProfileCatalog, builtIn: ProfileCatalog): ProfileCatalog {
  for (const shipped of builtIn.skills) {
    if (isCustomSkillId(shipped.skillId)) {
      throw new Error(`Built-in skill ${shipped.skillId} claims the authored ${CUSTOM_SKILL_ID_PREFIX} namespace.`);
    }
  }
  const shippedById = new Map(builtIn.skills.map((skill) => [skill.skillId, skill]));
  const persistedIds = new Set(persisted.skills.map((skill) => skill.skillId));
  let changed = false;
  const skills = persisted.skills.map((skill) => {
    const shipped = shippedById.get(skill.skillId);
    if (!shipped || shipped.digest === skill.digest) return skill;
    changed = true;
    return shipped;
  });
  for (const shipped of builtIn.skills) {
    if (persistedIds.has(shipped.skillId)) continue;
    skills.push(shipped);
    changed = true;
  }
  if (!changed) return persisted;
  return Object.freeze({ ...persisted, skills: Object.freeze(skills) });
}

/**
 * Which profiles would resolve differently if this skill disappeared.
 *
 * Deliberately NOT `Object.hasOwn(profile.skillModes, skillId)`. An explicit
 * `"inherit"` is byte-identical to absence everywhere the value is read —
 * `resolveSkillDecisions` reads `skillModes[id] ?? "inherit"` (domain.ts) — so
 * it changes no decision, no `skillSetDigest` and no composed prompt. Counting
 * it as a reference is what made an authored skill permanently undeletable
 * after one ordinary click: the per-profile control wrote `"inherit"` on the
 * way back from "on", nothing in the tree ever deleted a `skillModes` key, and
 * Remove then refused forever with a sentence naming a profile that does not
 * use the skill. `validateProfileCatalog` rejects an orphan key, so there was
 * no way out of that state from inside the product.
 *
 * With `profileSkillModes` in the UI deleting rather than storing `"inherit"`,
 * such a key can only be legacy state, and `removeAuthoredSkill` strips it.
 *
 * Managed profiles only, for the same reason. An archived revision governs no
 * new work — the Skills route's own scope selector is built from
 * `managedProfileRevisions`, so it cannot be listed, opened, or set back to
 * Inherit — and naming one in a refusal would be the identical dead end wearing
 * different clothes: a sentence telling someone to change a control that is not
 * on any surface. `removeAuthoredSkill` strips the key from archived revisions
 * instead, which costs nothing observable because every conversation that ran
 * under one carries its own pinned copy of the skill set it resolved.
 */
export function skillReferences(catalog: ProfileCatalog, skillId: string): readonly string[] {
  return Object.freeze(
    managedProfileRevisions(catalog)
      .filter((profile) => (profile.skillModes[skillId] ?? "inherit") !== "inherit")
      .map((profile) => profile.name),
  );
}

/**
 * Insert or replace an authored skill revision.
 *
 * Only the `custom.` namespace, in both directions: a caller may not author over
 * a built-in id (the next release would replace the text — see
 * `reconcileBuiltInSkills`), and may not turn a persisted built-in into an
 * authored one by handing in a revision that reuses its id. The count ceiling is
 * checked on insert rather than left to `validateProfileCatalog`, so the refusal
 * names the skill being added instead of the whole catalog being rejected after
 * the commit path has already begun.
 */
export function upsertAuthoredSkill(catalog: ProfileCatalog, revision: SkillRevision): ProfileCatalog {
  if (!isCustomSkillId(revision.skillId)) {
    throw new Error(`Authored skills live in the ${CUSTOM_SKILL_ID_PREFIX} namespace; ${revision.skillId} does not.`);
  }
  const index = catalog.skills.findIndex((skill) => skill.skillId === revision.skillId);
  if (index < 0 && catalog.skills.length >= MAX_CATALOG_SKILLS) {
    throw new Error(`This catalog already holds the maximum of ${String(MAX_CATALOG_SKILLS)} skills.`);
  }
  if (index >= 0 && catalog.skills[index]!.digest === revision.digest) return catalog;
  const skills = index < 0
    ? [...catalog.skills, revision]
    : catalog.skills.map((skill, position) => (position === index ? revision : skill));
  return Object.freeze({ ...catalog, skills: Object.freeze(skills) });
}

/**
 * Remove an authored skill, and every inert trace of it.
 *
 * Three states have to be cleared together or the resulting catalog is one
 * `validateProfileCatalog` will refuse — which, on the commit path, means the
 * skill stays and the person is told the catalog is invalid rather than what to
 * do about it:
 *
 * - the revision itself;
 * - its `globalSkills` key, because "Global settings reference missing skill"
 *   is a rejection, not a default;
 * - any leftover `skillModes` key, on a managed or an archived revision alike.
 *   On a managed one it can only be a legacy `"inherit"` — `skillReferences`
 *   above has already refused anything that decides — and on an archived one it
 *   may be any mode, because an archived revision starts no new conversation and
 *   has no control anywhere that could return it to Inherit. Dropping the key
 *   re-mints the profile revision, which is why this is async, and costs a
 *   digest that changes nothing observable: every conversation carries its own
 *   pinned copy of the skill set it resolved.
 */
export async function removeAuthoredSkill(catalog: ProfileCatalog, skillId: string): Promise<ProfileCatalog> {
  if (!isCustomSkillId(skillId)) {
    throw new Error(`${skillId} is a built-in skill. Built-in skills are owned by the release and can only be turned off.`);
  }
  if (!catalog.skills.some((skill) => skill.skillId === skillId)) {
    throw new Error(`Skill ${skillId} is no longer in this catalog.`);
  }
  const referencing = skillReferences(catalog, skillId);
  if (referencing.length > 0) {
    throw new Error(`${referencing.join(", ")} still refer to this skill. Set each of them back to Inherit global before removing it.`);
  }
  const profiles = await Promise.all(catalog.profiles.map(async (profile) => {
    if (!Object.hasOwn(profile.skillModes, skillId)) return profile;
    const skillModes = { ...profile.skillModes };
    delete skillModes[skillId];
    return createProfileRevision({
      ...profile,
      parentRevision: profile.revision,
      skillModes,
      createdAt: new Date().toISOString(),
    });
  }));
  const globalSkills = { ...catalog.globalSkills };
  delete globalSkills[skillId];
  return Object.freeze({
    ...catalog,
    skills: Object.freeze(catalog.skills.filter((skill) => skill.skillId !== skillId)),
    profiles: Object.freeze(profiles),
    globalSkills: createGlobalSkillSettings(globalSkills),
  });
}

/**
 * The theme-half of the same policy as `reconcileBuiltInSkills`.
 *
 * A Vault written by an older release froze the shipped theme set, so a
 * palette repaired after adoption (the Verdigris refresh) never reached the
 * route that previews it, and a scheme added later could never be chosen.
 * Shipped themes own their ids: the same digest is position-stable, a drifted
 * one reads as "older release" and is replaced, a new one is inserted.
 * Themes whose ids this build did not ship are user work and survive in place
 * after the shipped run, in the order they were saved.
 */
export function reconcileBuiltInThemes(persisted: ProfileCatalog, builtIn: ProfileCatalog): ProfileCatalog {
  const persistedById = new Map(persisted.themes.map((theme) => [theme.themeId, theme]));
  const shippedIds = new Set(builtIn.themes.map((theme) => theme.themeId));
  let changed = false;
  const themes = builtIn.themes.map((shipped) => {
    const held = persistedById.get(shipped.themeId);
    if (held && held.digest === shipped.digest) return held;
    changed = true;
    return shipped;
  });
  for (const held of persisted.themes) {
    if (shippedIds.has(held.themeId)) continue;
    themes.push(held);
    changed = true;
  }
  if (!changed) return persisted;
  return Object.freeze({ ...persisted, themes: Object.freeze(themes) });
}

export async function createBuiltInProfileCatalog(): Promise<ProfileCatalog> {
  const themes = await Promise.all(themeDrafts.map(createThemeManifest));
  const themeById = new Map(themes.map((theme) => [theme.themeId, theme]));
  const skills = await Promise.all([
    createSkillRevision({
      skillId: "evidence-first",
      name: "Evidence first",
      description: "Separate established facts, inference, and missing evidence in every substantive answer.",
      systemPrompt: "Make claims proportional to evidence. Distinguish observed facts from inference, preserve provenance, and name important uncertainty.",
      promptOrder: 10,
    }),
    createSkillRevision({
      skillId: "workspace-steward",
      name: "Workspace steward",
      description: "Inspect revisions, keep writes narrow, and report the concrete file state after changes.",
      systemPrompt: "Before changing workspace files, inspect relevant state and search for all affected call sites. Prefer targeted revision-safe replacements over whole-file rewrites; re-read or search after mutation, preserve unrelated work, and report exact resulting paths and validation evidence.",
      promptOrder: 20,
      requiredTools: ["list_files", "read_file", "stat_path", "search_text", "replace_text", "write_file"],
    }),
    createSkillRevision({
      skillId: "memory-gardener",
      name: "Memory gardener",
      description: "Notice durable concepts and relationships without turning guesses into remembered facts.",
      systemPrompt: "Surface durable concepts, decisions, and relationships that may be useful later. Never promote speculation to memory, and preserve the source boundary for remembered claims.",
      promptOrder: 30,
    }),
    createSkillRevision({
      skillId: "source-reviewer",
      name: "Source reviewer",
      description: "Review source changes with lineage, failure modes, and verification in view.",
      systemPrompt: "When discussing source changes, preserve repository and revision context, identify concrete failure modes, and ask for verification appropriate to the risk.",
      promptOrder: 40,
    }),
    createSkillRevision({
      skillId: "concise-handoff",
      name: "Concise handoff",
      description: "Lead with the outcome and leave a compact, verifiable handoff.",
      systemPrompt: "Lead with the outcome. Keep handoffs compact, name validation performed, and call out remaining blockers without ceremony.",
      promptOrder: 50,
    }),
    createSkillRevision({
      skillId: "delivery-loop",
      name: "Delivery loop",
      description: "Drive multi-step work from discovery through verification and a concrete handoff.",
      systemPrompt: "For non-trivial work, establish a short task plan, keep exactly one task in progress, inspect before acting, continue through recoverable tool failures, and verify the result before answering. Use the browser-native substitute that fits the job—workspace search and patching, on-device context retrieval, Git state, or direct CORS-enabled network access—instead of stopping merely because an ambient shell is absent.",
      promptOrder: 15,
      requiredTools: ["list_tasks", "update_tasks", "search_context", "git_inspect", "fetch_url"],
    }),
  ]);

  const profileDrafts: Array<{
    profileId: string;
    name: string;
    description: string;
    systemPrompt: string;
    themeId: string;
    skillModes: Readonly<Record<string, SkillMode>>;
  }> = [
    {
      profileId: "general",
      name: "General",
      description: "A capable everyday agent for clear, useful work.",
      systemPrompt: "You are a capable, outcome-owning general agent operating the Airship edge workspace. Turn user intent into useful, inspectable work: understand the request, inspect relevant state, use available tools decisively, and verify consequential changes. Be clear, calm, and explicit about the difference between this browser workspace, its browser-owned Git adapter, imported source snapshots, and an unrestricted host shell.",
      themeId: "foundry",
      skillModes: { "delivery-loop": "on", "workspace-steward": "inherit" },
    },
    {
      profileId: "research",
      name: "Research",
      description: "Find, compare, and synthesize with sources in view.",
      systemPrompt: "You are a rigorous research agent working from inspectable Airship sources. Search local context first, retrieve direct CORS-enabled sources when needed, distinguish repository snapshots from live upstream state, synthesize across evidence, and preserve provenance, uncertainty, dates, and source boundaries. Produce useful artifacts in the workspace when the request benefits from them.",
      themeId: "verdigris",
      skillModes: { "memory-gardener": "on", "workspace-steward": "off" },
    },
    {
      profileId: "builder-systems",
      // Keep the shipped ID so pinned sessions and persisted profile history
      // continue to resolve while the user-facing built-in identity evolves.
      name: "Developer",
      description: "Build, test, and operate systems with disciplined follow-through.",
      systemPrompt: "You are an outcome-owning systems engineer operating the Airship edge workspace. Turn user intent into working artifacts: discover the relevant state, plan only when the work merits it, use the provided tools decisively, follow dependencies across files, handle conflicts and recoverable failures, and verify what you changed. Do not retreat into advice when you can act. Be exact about the difference between this browser workspace, its browser-owned Git adapter, imported source snapshots, and an unrestricted host shell.",
      themeId: "blue-ledger",
      skillModes: { "delivery-loop": "on", "workspace-steward": "on", "source-reviewer": "inherit" },
    },
  ];

  const profiles = await Promise.all(profileDrafts.map((profile, index) => {
    const theme = themeById.get(profile.themeId);
    if (!theme) throw new Error(`Missing built-in theme ${profile.themeId}.`);
    return createProfileRevision({
      profileId: profile.profileId,
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      providerId: "airship-demo",
      model: "airship/demo-v1",
      minimumPosture: "local",
      workspaceBinding: { kind: "active-workspace" },
      // Research shipped as `workspace`, which never widened anything: every
      // memory reader narrows on the pinned profile ID, so it resolved exactly
      // as `profile` did. Seeding the scope that is actually enforced keeps the
      // built-in catalog from advertising a boundary the runtime does not have.
      memoryScope: "profile",
      approvalMode: profile.profileId === "builder-systems" ? "auto-approve" : "ask-first",
      theme: { themeId: theme.themeId, digest: theme.digest },
      skillModes: profile.skillModes,
      createdAt: `2026-07-18T00:0${index}:00.000Z`,
    });
  }));

  return Object.freeze({
    themes: Object.freeze(themes),
    skills: Object.freeze(skills),
    profiles: Object.freeze(profiles),
    archivedProfileIds: Object.freeze([]),
    globalSkills: createGlobalSkillSettings({
      "evidence-first": true,
      "workspace-steward": false,
      "memory-gardener": true,
      "source-reviewer": false,
      "concise-handoff": false,
    }),
  });
}

/*
 * A theme manifest is written inline on <html>, so it beats every stylesheet.
 * Two consequences bind this table:
 *
 * 1. `foundry` is the shipped default and must be byte-identical to the `:root`
 *    palette in `ui/tokens.css`. Where it agreed, the inline write was a no-op;
 *    where it drifted, the theme silently reverted the stylesheet — which is
 *    how `--ink-faint` shipped at 4.73:1 for a year while tokens.css carried
 *    the 5.72:1 fix and a comment predicting exactly this. `themeCssVariables`
 *    now omits any role that already agrees, so agreement is also what lets a
 *    colour-mode preference reach the surfaces at all.
 * 2. Every palette's `inkFaint` must clear AA on its own `surfaceRaised` and
 *    its `inkMuted` 7:1 on its own `surface`; a caption is where provenance
 *    lives. `ui/css-variable-contract.test.ts` enforces both, per theme.
 */
/*
 * Curated first, in-house second.
 *
 * The top six are well-known dark schemes, translated into this product's
 * nine roles rather than re-typed from their dotfiles: each keeps its own
 * accent pair and surface ladder but answers the same questions (ground,
 * surface, raised, soft, ink, muted, faint, accent, bright) with the same
 * constraints the house themes answer — inkFaint clears AA on surfaceRaised,
 * inkMuted clears 7:1 on surface, verified by `css-variable-contract.test.ts`
 * like everything else. They lead the library because a person choosing a look
 * deserves proven options before house experiments.
 */
const themeDrafts: readonly ThemeManifestDraft[] = [
  {
    themeId: "nord",
    name: "Nord",
    description: "Curated · arctic blues on a calm polar-night grey.",
    colorScheme: "dark",
    colors: {
      ground: "#1f232c",
      surface: "#232937",
      surfaceRaised: "#272d39",
      surfaceSoft: "#20242e",
      ink: "#d8dee9",
      inkMuted: "#bfcad8",
      inkFaint: "#a6b4c4",
      accent: "#81a1c1",
      accentBright: "#8fbcbb",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "tokyo-night",
    name: "Tokyo Night",
    description: "Curated · midnight violet inks with electric blue signals.",
    colorScheme: "dark",
    colors: {
      ground: "#16161e",
      surface: "#191a25",
      surfaceRaised: "#20232f",
      surfaceSoft: "#171723",
      ink: "#c0caf5",
      inkMuted: "#a9b2da",
      inkFaint: "#929ac2",
      accent: "#7aa2f7",
      accentBright: "#9cbeff",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    description: "Curated · warm cocoa surfaces with a soft mauve accent.",
    colorScheme: "dark",
    colors: {
      ground: "#171724",
      surface: "#1c1c29",
      surfaceRaised: "#242433",
      surfaceSoft: "#181826",
      ink: "#cdd6f4",
      inkMuted: "#b6c1e6",
      inkFaint: "#a0a8cf",
      accent: "#cba6f7",
      accentBright: "#d3bdfa",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "rounded" },
  },
  {
    themeId: "gruvbox-dark",
    name: "Gruvbox Dark",
    description: "Curated · warm amber paper tones on deep retro brown.",
    colorScheme: "dark",
    colors: {
      ground: "#1d2021",
      surface: "#252626",
      surfaceRaised: "#282726",
      surfaceSoft: "#202324",
      ink: "#ebdbb2",
      inkMuted: "#d5c4a1",
      inkFaint: "#b3a190",
      accent: "#8ec07c",
      accentBright: "#b8bb26",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "solarized-dark",
    name: "Solarized Dark",
    description: "Curated · deep cyan slate with measured blue-green accents.",
    colorScheme: "dark",
    colors: {
      ground: "#00232c",
      surface: "#00252f",
      surfaceRaised: "#062e39",
      surfaceSoft: "#002631",
      ink: "#eee8d5",
      inkMuted: "#b9c4ba",
      inkFaint: "#93a8a4",
      accent: "#268bd2",
      accentBright: "#2fae9f",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "one-dark",
    name: "One Dark",
    description: "Curated · graphite greys with clear sky-blue signals.",
    colorScheme: "dark",
    colors: {
      ground: "#1c2026",
      surface: "#232831",
      surfaceRaised: "#282d36",
      surfaceSoft: "#1f232a",
      ink: "#d7dae0",
      inkMuted: "#b5bdc9",
      inkFaint: "#9aa1ad",
      accent: "#61afef",
      accentBright: "#8fc6f2",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "square" },
  },
  {
    themeId: "foundry",
    name: "Foundry",
    description: "Graphite surfaces with restrained brass and verdigris signals.",
    colorScheme: "dark",
    colors: {
      ground: "#101417",
      surface: "#171c20",
      surfaceRaised: "#1c2226",
      surfaceSoft: "#14191c",
      ink: "#ece8de",
      inkMuted: "#b0b6b3",
      inkFaint: "#949c99",
      accent: "#c19a58",
      accentBright: "#dfba72",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "verdigris",
    name: "Verdigris",
    description: "Deep spruce green with sage accents and warm paper ink.",
    colorScheme: "dark",
    colors: {
      ground: "#0c110f",
      surface: "#131a15",
      surfaceRaised: "#1b251e",
      surfaceSoft: "#101711",
      ink: "#e9ede3",
      inkMuted: "#adbba9",
      inkFaint: "#91a58b",
      accent: "#68a37b",
      accentBright: "#95d1a6",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "rounded" },
  },
  {
    themeId: "blue-ledger",
    name: "Blue Ledger",
    description: "Inky blue-black surfaces with blued steel and cool archival marks.",
    colorScheme: "dark",
    colors: {
      ground: "#0e131a",
      surface: "#151c25",
      surfaceRaised: "#1b2530",
      surfaceSoft: "#111821",
      ink: "#e9edf0",
      inkMuted: "#a0aab3",
      inkFaint: "#8a95a1",
      accent: "#7895b9",
      accentBright: "#a9c2df",
    },
    typography: { body: "system-sans", scale: "compact" },
    layout: { density: "compact", corners: "square" },
  },
];
