import {
  createGlobalSkillSettings,
  createProfileRevision,
  createSkillRevision,
  createThemeManifest,
  type GlobalSkillSettings,
  type ProfileRevision,
  type SkillMode,
  type SkillRevision,
  type ThemeManifest,
  type ThemeManifestDraft,
} from "./domain";

export type ProfileCatalog = Readonly<{
  themes: readonly ThemeManifest[];
  skills: readonly SkillRevision[];
  profiles: readonly ProfileRevision[];
  /** Revisions retained for historical conversation resolution but hidden from new work. */
  archivedProfileIds?: readonly string[];
  globalSkills: GlobalSkillSettings;
}>;

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
 * every later boot and the release's new skills are unreachable forever. There
 * is no authoring path yet either, so the shipped set is the only source a
 * skill can come from and a missing one is unambiguous absence, not a deletion
 * the reader chose.
 *
 * The join is therefore deliberately narrow and one-directional:
 *
 * - a built-in absent from the persisted catalog is added;
 * - a built-in whose content changed between releases is replaced, because a
 *   built-in's text is release-owned and past conversations carry their own
 *   pinned copy of the revision they ran under;
 * - anything else in `persisted.skills` is left exactly as it is, including
 *   skills this build has never heard of;
 * - `globalSkills`, `skillModes`, profiles, themes and archive state are never
 *   touched — an absent entry already reads as off/inherit downstream.
 *
 * Identity is returned when nothing changed, which is what lets callers skip a
 * pointless generation bump and keep the digest chain still.
 */
export function reconcileBuiltInSkills(persisted: ProfileCatalog, builtIn: ProfileCatalog): ProfileCatalog {
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
