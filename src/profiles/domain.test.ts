import { describe, expect, it } from "vitest";
import { AIRSHIP_CORE_CHARTER } from "../core/operating-charter";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  createSkillRevision,
  createThemeManifest,
  resolveProfileForSession,
  themeCssVariables,
  type ProfileRevisionDraft,
  type SemanticThemeColors,
  type ThemeManifest,
} from "./domain";

const colors: SemanticThemeColors = {
  ground: "#101415",
  surface: "#171c1d",
  surfaceRaised: "#202627",
  surfaceSoft: "#252c2d",
  ink: "#f2eee5",
  inkMuted: "#9ca5a3",
  inkFaint: "#788280",
  accent: "#c9914b",
  accentBright: "#e3b36e",
};

describe("profile domain", () => {
  it("creates semantic, content-addressed, deeply immutable themes", async () => {
    const sourceColors = { ...colors };
    const left = await createThemeManifest(themeDraft(sourceColors));
    const right = await createThemeManifest(themeDraft({ ...colors }));

    sourceColors.accent = "#ffffff";

    expect(left.digest).toBe(right.digest);
    expect(left.colors.accent).toBe("#c9914b");
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.colors)).toBe(true);
    expect(Object.isFrozen(left.typography)).toBe(true);
    expect(themeCssVariables(left)).toMatchObject({
      "--ground": "#101415",
      "--surface-raised": "#202627",
      "--ink-muted": "#9ca5a3",
      "--accent-bright": "#e3b36e",
    });
    expect(themeCssVariables(left)).not.toHaveProperty("--signal");
    expect(themeCssVariables(left)).not.toHaveProperty("--danger");
    expect(Object.isFrozen(themeCssVariables(left))).toBe(true);

    const changed = await createThemeManifest(themeDraft({ ...colors, accent: "#ffffff" }));
    expect(changed.digest).not.toBe(left.digest);
  });

  it("rejects arbitrary CSS and incomplete semantic palettes", async () => {
    await expect(createThemeManifest(themeDraft({ ...colors, accent: "url(https://bad.example)" as `#${string}` })))
      .rejects.toThrow("hex color");
    const incomplete = { ...colors } as Record<string, string>;
    delete incomplete.accent;
    await expect(createThemeManifest(themeDraft(incomplete as SemanticThemeColors))).rejects.toThrow("exactly");
  });

  it("content-addresses immutable profile revisions and their ancestry", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const draft = profileDraft(theme, { research: "inherit" });
    const first = await createProfileRevision(draft);
    const replay = await createProfileRevision(draft);
    const child = await createProfileRevision({
      ...draft,
      parentRevision: first.revision,
      systemPrompt: "Investigate carefully and cite evidence.",
      createdAt: "2026-07-18T00:01:00.000Z",
    });

    expect(replay.revision).toBe(first.revision);
    expect(child.revision).not.toBe(first.revision);
    expect(child.parentRevision).toBe(first.revision);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.skillModes)).toBe(true);
  });

  it("applies inherit/on/off precedence and produces deterministic session pins", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const research = await createSkillRevision({
      skillId: "research",
      name: "Research",
      description: "Evidence-led research",
      systemPrompt: "Find primary evidence and distinguish inference from fact.",
      promptOrder: 20,
      requiredTools: ["web.search"],
    });
    const review = await createSkillRevision({
      skillId: "review",
      name: "Review",
      description: "Adversarial review",
      systemPrompt: "Review claims and surface concrete failure modes.",
      promptOrder: 10,
    });
    const writing = await createSkillRevision({
      skillId: "writing",
      name: "Writing",
      description: "Clear technical writing",
      systemPrompt: "Write plainly and preserve technical precision.",
      promptOrder: 30,
    });
    const profile = await createProfileRevision(profileDraft(theme, {
      research: "inherit",
      review: "on",
      writing: "off",
    }));
    const globalSkills = createGlobalSkillSettings({ research: true, review: false, writing: true });

    const left = await resolveProfileForSession({
      profile,
      theme,
      skills: [writing, research, review],
      globalSkills,
    });
    const right = await resolveProfileForSession({
      profile,
      theme,
      skills: [review, writing, research],
      globalSkills: createGlobalSkillSettings({ writing: true, review: false, research: true }),
    });

    expect(left.skillDecisions).toEqual([
      expect.objectContaining({ skillId: "review", mode: "on", enabled: true, source: "profile" }),
      expect.objectContaining({ skillId: "research", mode: "inherit", enabled: true, source: "global" }),
      expect.objectContaining({ skillId: "writing", mode: "off", enabled: false, source: "profile" }),
    ]);
    expect(left.resolvedSkills.map((skill) => skill.skillId)).toEqual(["review", "research"]);
    expect(left.resolvedSkillDigests).toEqual([review.digest, research.digest]);
    expect(left.systemPrompt).toBe(
      `${AIRSHIP_CORE_CHARTER}\n\n` +
      "[Airship profile]\nBe careful and useful.\n\n" +
      "[Airship skill: review]\nReview claims and surface concrete failure modes.\n\n" +
      "[Airship skill: research]\nFind primary evidence and distinguish inference from fact.",
    );
    expect(right).toEqual(left);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.resolvedSkills)).toBe(true);
    expect(left.systemPromptDigest).toMatch(/^sha256:/u);
    expect(left.skillSetDigest).toMatch(/^sha256:/u);
    expect(left.resolutionDigest).toMatch(/^sha256:/u);
  });

  it("treats omitted global and profile settings as disabled inheritance", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const skill = await createSkillRevision({
      skillId: "quiet",
      name: "Quiet",
      description: "Not globally enabled",
      systemPrompt: "Remain concise.",
    });
    const profile = await createProfileRevision(profileDraft(theme, {}));
    const pin = await resolveProfileForSession({
      profile,
      theme,
      skills: [skill],
      globalSkills: createGlobalSkillSettings({}),
    });

    expect(pin.skillDecisions).toEqual([
      expect.objectContaining({ skillId: "quiet", mode: "inherit", globallyEnabled: false, enabled: false }),
    ]);
    expect(pin.resolvedSkillDigests).toEqual([]);
    expect(pin.systemPrompt).toBe(
      `${AIRSHIP_CORE_CHARTER}\n\n[Airship profile]\nBe careful and useful.`,
    );
  });

  it("fails closed on missing skill revisions, theme mismatches, and tampered revisions", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const otherTheme = await createThemeManifest({ ...themeDraft(colors), themeId: "other-theme" });
    const profile = await createProfileRevision(profileDraft(theme, { missing: "on" }));

    await expect(resolveProfileForSession({
      profile,
      theme,
      skills: [],
      globalSkills: createGlobalSkillSettings({}),
    })).rejects.toThrow("missing skill");

    await expect(resolveProfileForSession({
      profile,
      theme: otherTheme,
      skills: [],
      globalSkills: createGlobalSkillSettings({}),
    })).rejects.toThrow("theme reference");

    const tampered = { ...profile, systemPrompt: "Changed after hashing." };
    await expect(resolveProfileForSession({
      profile: tampered,
      theme,
      skills: [],
      globalSkills: createGlobalSkillSettings({}),
    })).rejects.toThrow("revision check");
  });
});

function themeDraft(themeColors: SemanticThemeColors) {
  return {
    themeId: "foundry",
    name: "Foundry",
    description: "A restrained semantic theme",
    colorScheme: "dark" as const,
    colors: themeColors,
    typography: { body: "system-sans" as const, scale: "standard" as const },
    layout: { density: "comfortable" as const, corners: "subtle" as const },
  };
}

function profileDraft(
  theme: ThemeManifest,
  skillModes: ProfileRevisionDraft["skillModes"],
): ProfileRevisionDraft {
  return {
    profileId: "investigator",
    name: "Investigator",
    description: "Research and review agent",
    systemPrompt: "Be careful and useful.",
    providerId: "chutes",
    model: "example/model",
    minimumPosture: "encrypted-attested",
    theme: { themeId: theme.themeId, digest: theme.digest },
    skillModes,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}
