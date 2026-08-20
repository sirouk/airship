import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AIRSHIP_CORE_CHARTER } from "../core/operating-charter";
import {
  createGlobalSkillSettings,
  createProfileRevision,
  enforcedMemoryScope,
  resolveProfileSilo,
  resolveProfileWebEgress,
  createSkillRevision,
  createThemeManifest,
  resolveProfileForSession,
  themeCssVariables,
  validateProfileRevision,
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

  it("pins profile-owned workspace, memory, approvals, and proof posture into a v2 resolution", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const profile = await createProfileRevision({
      ...profileDraft(theme, {}),
      workspaceBinding: { kind: "workspace-id", workspaceId: "vault+gdrive://workspace/root" },
      memoryScope: "session",
      approvalMode: "auto-approve",
    });
    const pin = await resolveProfileForSession({ profile, theme, skills: [], globalSkills: {} });

    expect(profile.version).toBe(2);
    expect(pin.workspaceBinding).toEqual({ kind: "workspace-id", workspaceId: "vault+gdrive://workspace/root" });
    expect(pin.memoryScope).toBe("session");
    expect(pin.approvalMode).toBe("auto-approve");
    expect(pin.minimumPosture).toBe("encrypted-attested");
    expect(pin.resolutionDigest).toMatch(/^sha256:/u);
  });

  it("defaults web requests to Node-first and content-addresses the profile opt-out", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const inheritedDefault = await createProfileRevision(profileDraft(theme, {}));
    const optedOut = await createProfileRevision({
      ...profileDraft(theme, {}),
      webEgress: "browser-only",
    });
    expect(resolveProfileWebEgress(inheritedDefault)).toBe("node-first");
    expect(resolveProfileWebEgress(optedOut)).toBe("browser-only");
    expect(optedOut.revision).not.toBe(inheritedDefault.revision);
  });

  it("pins a stored workspace memory scope as the profile scope every reader enforces", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const stored = await createProfileRevision({ ...profileDraft(theme, {}), memoryScope: "workspace" });

    // The stored revision keeps the value it was digested with, so a profile
    // written before the widening was withdrawn still passes its revision check
    // and stays loadable; only what the pin enforces changes.
    expect(stored.memoryScope).toBe("workspace");
    expect(resolveProfileSilo(stored).memoryScope).toBe("workspace");
    expect(enforcedMemoryScope(stored.memoryScope ?? "profile")).toBe("profile");
    const pin = await resolveProfileForSession({ profile: stored, theme, skills: [], globalSkills: {} });
    expect(pin.memoryScope).toBe("profile");

    /*
     * …while the resolution digest still follows the STORED scope.
     *
     * That digest is compared for equality against digests already written into
     * existing manifests — `compareProfiles` turns any difference into "Fork
     * required" — so resolving the withdrawal into it would change the digest an
     * unchanged profile revision mints, and stranding every conversation of the
     * shipped `workspace`-scoped Research profile over a boundary that never
     * differed. It cannot be asserted through the API: the revision digest
     * itself covers `memoryScope`, so no two loadable revisions differ in the
     * scope alone (`resolveProfileForSession` verifies the revision), which is
     * why the payload is read here instead.
     */
    const source = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
    const digested = source.slice(
      source.indexOf("const resolutionDigest = await digestJson({"),
      source.indexOf("    skillSetDigest,\n    systemPromptDigest,\n  });"),
    );
    expect(digested).toContain("memoryScope: stored.memoryScope,");
    expect(digested).not.toContain("memoryScope: silo.memoryScope,");
  });

  it("resolves legacy v1 profiles with explicit safe silo defaults without changing their digest", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const legacy = await createProfileRevision({ ...profileDraft(theme, {}), version: 1 });

    expect(legacy.version).toBe(1);
    expect(resolveProfileSilo(legacy)).toEqual({
      workspaceBinding: { kind: "active-workspace" },
      memoryScope: "profile",
      approvalMode: "ask-first",
    });
    const pin = await resolveProfileForSession({ profile: legacy, theme, skills: [], globalSkills: {} });
    expect(pin.version).toBe(2);
    expect(pin.approvalMode).toBe("ask-first");
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

  it("snapshots nested caller-owned resolution material before the first digest await", async () => {
    const source = await resolutionFixture();
    const input = structuredClone(source) as DeepMutable<typeof source>;

    const pending = resolveProfileForSession(input);
    input.profile.revision = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    input.profile.model = "MUTATED_MODEL";
    input.profile.systemPrompt = "MUTATED_PROFILE_PROMPT";
    input.profile.theme.digest = "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    if (input.profile.workspaceBinding?.kind !== "workspace-id") throw new Error("expected workspace fixture");
    input.profile.workspaceBinding.workspaceId = "mutated-workspace";
    input.profile.skillModes["snapshot-skill"] = "off";
    input.theme.digest = "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    input.theme.colors.accent = "#ffffff";
    input.skills[0].digest = "sha256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    input.skills[0].systemPrompt = "MUTATED_SKILL_PROMPT";
    input.skills.splice(0);
    input.globalSkills["snapshot-skill"] = false;
    input.installedTools[0].description = "MUTATED_TOOL_DESCRIPTION";
    input.installedTools[0].inputSchema.properties.query.type = "number";
    input.browserCapabilities[0].detail = "MUTATED_CAPABILITY_DETAIL";
    input.inferenceDirectory.active.modelId = "mutated-active-model";
    input.inferenceDirectory.providers[0].models[0].id = "mutated-roster-model";

    const pin = await pending;
    expect(pin.profile).toEqual({
      profileId: source.profile.profileId,
      revision: source.profile.revision,
    });
    expect(pin.theme).toEqual({ themeId: source.theme.themeId, digest: source.theme.digest });
    expect(pin.model).toBe("snapshot/model");
    expect(pin.workspaceBinding).toEqual({ kind: "workspace-id", workspaceId: "snapshot-workspace" });
    expect(pin.skillDecisions).toEqual([
      expect.objectContaining({ skillId: "snapshot-skill", enabled: true }),
    ]);
    expect(pin.resolvedSkills).toEqual([{
      skillId: "snapshot-skill",
      digest: source.skills[0].digest,
      promptOrder: 12,
    }]);
    expect(pin.systemPrompt).toContain("ORIGINAL_PROFILE_PROMPT");
    expect(pin.systemPrompt).toContain("ORIGINAL_SKILL_PROMPT");
    expect(pin.systemPrompt).toContain("ORIGINAL_TOOL_DESCRIPTION");
    expect(pin.systemPrompt).toContain("ORIGINAL_CAPABILITY_DETAIL");
    expect(pin.systemPrompt).toContain("original-roster-model");
    expect(pin.systemPrompt).not.toContain("MUTATED_");
    expect([
      pin,
      pin.profile,
      pin.theme,
      pin.workspaceBinding,
      pin.skillDecisions,
      pin.skillDecisions[0],
      pin.resolvedSkills,
      pin.resolvedSkills[0],
      pin.resolvedSkillDigests,
    ].every(Object.isFrozen)).toBe(true);
  });

  it("reads every accessor-backed resolution field once and pins the verified snapshot", async () => {
    const source = await resolutionFixture();
    const expected = await resolveProfileForSession(source);
    const reads = new Map<string, number>();
    const input = accessorBacked(source, "$", reads);

    const pending = resolveProfileForSession(input);
    expect(reads.size).toBeGreaterThan(50);
    expect(new Set(reads.values())).toEqual(new Set([1]));

    const pin = await pending;
    expect(pin).toEqual(expected);
    expect(pin.profile.revision).toBe(source.profile.revision);
    expect(pin.model).toBe(source.profile.model);
    expect(new Set(reads.values())).toEqual(new Set([1]));
  });

  it("captures the claimed profile revision synchronously before validation yields", async () => {
    const source = await resolutionFixture();
    let revisionReads = 0;
    const candidate = Object.defineProperty({ ...source.profile }, "revision", {
      enumerable: true,
      get: () => {
        revisionReads += 1;
        if (revisionReads > 1) throw new Error("profile revision was reread");
        return source.profile.revision;
      },
    }) as typeof source.profile;

    const pending = validateProfileRevision(candidate);
    expect(revisionReads).toBe(1);
    await expect(pending).resolves.toEqual(source.profile);
    expect(revisionReads).toBe(1);
  });

  it("deep-snapshots every profile validation accessor exactly once before hashing", async () => {
    const source = (await resolutionFixture()).profile;
    const reads = new Map<string, number>();
    const candidate = accessorBacked(source, "$profile", reads);

    const pending = validateProfileRevision(candidate);
    expect(reads.size).toBeGreaterThan(20);
    expect(new Set(reads.values())).toEqual(new Set([1]));

    const validated = await pending;
    expect(validated).toEqual(source);
    expect(new Set(reads.values())).toEqual(new Set([1]));
    expect([
      validated,
      validated.theme,
      validated.skillModes,
      validated.workspaceBinding,
      validated.presentation,
    ].every(Object.isFrozen)).toBe(true);
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

  it("binds observed browser capabilities into the session prompt digest", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const profile = await createProfileRevision(profileDraft(theme, {}));
    const baseline = await resolveProfileForSession({ profile, theme, skills: [], globalSkills: {} });
    const accelerated = await resolveProfileForSession({
      profile,
      theme,
      skills: [],
      globalSkills: {},
      installedTools: [{
        name: "inspect_browser_capabilities",
        description: "Report current browser observations.",
        effect: "read",
        inputSchema: { type: "object" },
      }],
      browserCapabilities: [{
        id: "wasm-simd",
        evidence: "probe-passed",
        detail: "The minimal SIMD module validated.",
      }],
    });

    expect(accelerated.systemPrompt).toContain("[Airship observed browser capability pin]");
    expect(accelerated.systemPrompt).toContain("- wasm-simd [probe-passed]");
    expect(accelerated.systemPromptDigest).not.toBe(baseline.systemPromptDigest);
    expect(accelerated.resolutionDigest).not.toBe(baseline.resolutionDigest);
  });

  it("pins a credential-free multi-provider model roster into new sessions", async () => {
    const theme = await createThemeManifest(themeDraft(colors));
    const profile = await createProfileRevision(profileDraft(theme, {}));
    const pin = await resolveProfileForSession({
      profile,
      theme,
      skills: [],
      globalSkills: {},
      inferenceDirectory: {
        active: {
          connectionId: "chutes-primary",
          providerId: "chutes",
          modelId: "moonshotai/Kimi-K2.6-TEE",
        },
        providers: [{
          connectionId: "chutes-primary",
          providerId: "chutes",
          label: "Chutes",
          state: "connected",
          authority: "oauth",
          modelCount: 2,
          models: [
            { id: "moonshotai/Kimi-K2.6-TEE", inputModalities: ["text", "image"], features: ["tools"] },
            { id: "zai-org/GLM-5.2-TEE", inputModalities: ["text"] },
          ],
        }, {
          connectionId: "ollama-local",
          providerId: "ollama",
          label: "Ollama on this device",
          state: "connected",
          authority: "local-service",
          modelCount: 1,
          models: [{ id: "qwen3:8b", inputModalities: ["text"] }],
        }],
      },
    });

    expect(pin.systemPrompt).toContain("[Airship inference roster pin]");
    expect(pin.systemPrompt).toContain("Active: chutes-primary :: chutes :: moonshotai/Kimi-K2.6-TEE");
    expect(pin.systemPrompt).toContain("ollama-local | Ollama on this device");
    expect(pin.systemPrompt).not.toContain("sk-test-secret");
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

async function resolutionFixture() {
  const theme = await createThemeManifest(themeDraft(colors));
  const skill = await createSkillRevision({
    skillId: "snapshot-skill",
    name: "Snapshot skill",
    description: "Exercises immutable profile resolution",
    systemPrompt: "ORIGINAL_SKILL_PROMPT",
    promptOrder: 12,
    requiredTools: ["snapshot_tool"],
  });
  const profile = await createProfileRevision({
    ...profileDraft(theme, { "snapshot-skill": "inherit" }),
    systemPrompt: "ORIGINAL_PROFILE_PROMPT",
    model: "snapshot/model",
    workspaceBinding: { kind: "workspace-id", workspaceId: "snapshot-workspace" },
    memoryScope: "session",
    approvalMode: "ask-first",
    webEgress: "browser-only",
    webBodies: "text-only",
    presentation: { reasoningVisibility: "expanded", density: "instrumented" },
  });
  return {
    profile,
    theme,
    skills: [skill],
    globalSkills: createGlobalSkillSettings({ "snapshot-skill": true }),
    installedTools: [{
      name: "snapshot_tool",
      description: "ORIGINAL_TOOL_DESCRIPTION",
      effect: "read" as const,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    }],
    browserCapabilities: [{
      id: "snapshot-capability",
      evidence: "probe-passed" as const,
      detail: "ORIGINAL_CAPABILITY_DETAIL",
    }],
    inferenceDirectory: {
      active: {
        connectionId: "snapshot-connection",
        providerId: "snapshot-provider",
        modelId: "original-roster-model",
      },
      providers: [{
        connectionId: "snapshot-connection",
        providerId: "snapshot-provider",
        label: "Snapshot provider",
        state: "connected" as const,
        authority: "none" as const,
        modelCount: 1,
        models: [{
          id: "original-roster-model",
          inputModalities: ["text"],
          features: ["tools"],
        }],
      }],
    },
  };
}

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function accessorBacked<T>(
  value: T,
  path: string,
  reads: Map<string, number>,
): T {
  if (value === null || typeof value !== "object") return value;
  const target: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const childSnapshot = accessorBacked(child, childPath, reads);
    reads.set(childPath, 0);
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const count = (reads.get(childPath) ?? 0) + 1;
        reads.set(childPath, count);
        if (count > 1) throw new Error(`${childPath} was read more than once`);
        return childSnapshot;
      },
    });
  }
  return target as unknown as T;
}
