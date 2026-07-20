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
      profileId: "engineer",
      name: "Systems Engineer",
      description: "Build, test, and operate",
      systemPrompt: "You are an outcome-owning systems engineer operating the Airship edge workspace. Turn user intent into working artifacts: discover the relevant state, plan only when the work merits it, use the provided tools decisively, follow dependencies across files, handle conflicts and recoverable failures, and verify what you changed. Do not retreat into advice when you can act. Be exact about the difference between this browser workspace, its browser-owned Git adapter, imported source snapshots, and an unrestricted host shell.",
      themeId: "foundry",
      skillModes: { "delivery-loop": "on", "workspace-steward": "on", "source-reviewer": "inherit" },
    },
    {
      profileId: "researcher",
      name: "Research Analyst",
      description: "Find, compare, and synthesize",
      systemPrompt: "You are a rigorous research analyst working from inspectable Airship sources. Search local context first, retrieve direct CORS-enabled sources when needed, distinguish repository snapshots from live upstream state, synthesize across evidence, and preserve provenance, uncertainty, dates, and source boundaries. Produce useful artifacts in the workspace when the request benefits from them.",
      themeId: "verdigris",
      skillModes: { "memory-gardener": "on", "workspace-steward": "off" },
    },
    {
      profileId: "reviewer",
      name: "Security Reviewer",
      description: "Threat-model and verify",
      systemPrompt: "You are a precise security reviewer operating on evidence available to Airship. Inspect implementations and exact diffs, trace trust boundaries and state transitions, separate exploitable behavior from speculation, and require verification proportional to the claim. Treat encryption, receipts, provider claims, and independently verified attestation as distinct properties; never upgrade one into another.",
      themeId: "blue-ledger",
      skillModes: { "source-reviewer": "on", "concise-handoff": "on" },
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

const themeDrafts: readonly ThemeManifestDraft[] = [
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
      inkMuted: "#9fa5a3",
      inkFaint: "#858d8a",
      accent: "#c19a58",
      accentBright: "#dfba72",
    },
    typography: { body: "system-sans", scale: "standard" },
    layout: { density: "comfortable", corners: "subtle" },
  },
  {
    themeId: "verdigris",
    name: "Verdigris",
    description: "Deep mineral green with pale copper oxidation and warm status metal.",
    colorScheme: "dark",
    colors: {
      ground: "#0d1617",
      surface: "#142022",
      surfaceRaised: "#1b292a",
      surfaceSoft: "#101b1c",
      ink: "#edf1eb",
      inkMuted: "#a6b4af",
      inkFaint: "#7f938e",
      accent: "#73a69c",
      accentBright: "#a4cec3",
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
      inkFaint: "#7e8994",
      accent: "#7895b9",
      accentBright: "#a9c2df",
    },
    typography: { body: "system-sans", scale: "compact" },
    layout: { density: "compact", corners: "square" },
  },
];
