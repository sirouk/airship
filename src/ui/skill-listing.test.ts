import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinnedSkillListing } from "./app";

const PINNED_REVISION = `sha256:${"P".repeat(43)}`;
const RESEARCH_DIGEST = `sha256:${"R".repeat(43)}`;
const REVIEW_DIGEST = `sha256:${"V".repeat(43)}`;
const SET_DIGEST = `sha256:${"S".repeat(43)}`;

const pin = {
  profileRevision: PINNED_REVISION,
  skillSetDigest: SET_DIGEST,
  resolvedSkills: [
    { skillId: "review", digest: REVIEW_DIGEST, promptOrder: 20 },
    { skillId: "research", digest: RESEARCH_DIGEST, promptOrder: 10 },
  ],
} as const;

const profile = {
  name: "Researcher",
  revision: PINNED_REVISION,
  skillModes: { review: "on" } as const,
} as const;

const catalogSkills = [
  { skillId: "research", name: "Deep research" },
  { skillId: "review", name: "Code review" },
] as const;

/*
 * Skills were invisible to the slash registry: they composed every reply while
 * `/help` listed sessions, models and every workspace tool and never named one.
 * The listing that closes the hole has to be about *this* conversation, because
 * a skill is only ever pinned — reading it off the live catalog would describe
 * a prompt no transcript was answered against.
 */
describe("what /skills prints", () => {
  it("names every pinned skill, in prompt order, with its source and digest", () => {
    const listing = pinnedSkillListing({ pin, profile, catalogSkills });
    const rows = listing.split("\n").filter((line) => line.startsWith("•"));

    expect(rows).toEqual([
      `• Deep research · global · sha256:RRRRRRR…RRRRRRR`,
      `• Code review · Researcher override · sha256:VVVVVVV…VVVVVVV`,
    ]);
    // `promptOrder`, not the order the manifest happened to store them in: the
    // list is the composition order of the prompt it describes.
    expect(listing.indexOf("Deep research")).toBeLessThan(listing.indexOf("Code review"));
    expect(listing).toContain("2 skills compose this conversation's prompt");
  });

  it("carries the conversation's own set digest, not the catalog's current one", () => {
    expect(pinnedSkillListing({ pin, profile, catalogSkills })).toContain("sha256:SSSSSSS…SSSSSSS");
    // A skill added to the catalog after this conversation opened must not
    // appear, and must not move the printed set digest.
    const listing = pinnedSkillListing({
      pin,
      profile,
      catalogSkills: [...catalogSkills, { skillId: "writing", name: "Longform writing" }],
    });
    expect(listing).not.toContain("Longform writing");
    expect(listing).toContain("sha256:SSSSSSS…SSSSSSS");
  });

  it("refuses to name a source it would have to read off a later profile revision", () => {
    // `skillModes` belongs to a revision. Once the active revision has moved
    // past the pinned one, "global" and "override" are claims about a profile
    // this conversation is not running.
    const listing = pinnedSkillListing({
      pin,
      profile: { ...profile, revision: `sha256:${"L".repeat(43)}` },
      catalogSkills,
    });
    expect(listing).toContain(`pinned at Researcher revision sha256:PPPPPPP…PPPPPPP`);
    expect(listing).not.toContain("· global ·");
    expect(listing).not.toContain("· Researcher override ·");
  });

  it("states an empty set as an empty set, and always says where to change it", () => {
    const listing = pinnedSkillListing({
      pin: { ...pin, resolvedSkills: [] },
      profile,
      catalogSkills,
    });
    expect(listing).toContain("No skill composes this conversation's prompt");
    expect(listing).toContain("A change applies to the next conversation, never this one.");
  });

  it("is reached from the composer through the registry's own builtin", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(app).toContain('if (action.type === "skills.list") {');
    // The pin off the open conversation's manifest, never the live catalog.
    expect(app).toContain("const pin = activeSessionRecord.manifest.profile;");
    expect(readFileSync(new URL("../commands/registry.ts", import.meta.url), "utf8"))
      .toContain('name: "skills",');
  });

  it("keeps the Skills route scoped and names every global switch", () => {
    const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    const skillsRoute = readFileSync(new URL("./skills-manager-view.tsx", import.meta.url), "utf8");
    expect(app).toContain('setProfileHubScope("global")');
    expect(skillsRoute).toContain('aria-label={`Global default for ${skill.name}`}');
    /*
     * "Apply … in a new conversation" promised a fresh conversation, but the
     * button runs the same switch the Profiles route's "Switch to this
     * profile" does: `compatibleProfileSession` resumes the profile's durable
     * conversation pointer when it still matches. The label names the switch,
     * which is the behavior.
     */
    expect(skillsRoute).toContain("Switch to {profile.name}");
    expect(skillsRoute).not.toContain("in a new conversation</button>");
    expect(app).toContain("Skill policy changed in this new pinned conversation");
  });
});
