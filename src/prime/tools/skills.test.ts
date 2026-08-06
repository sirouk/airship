/**
 * PrimeSkillRegistry tests: registration from skill-md sources and
 * harness entries, upstream first-wins name collisions, python import
 * sharing, the import-error ledger (the _PRIME_AGENT_SKILL_IMPORT_ERRORS
 * analogue), and byte-exact mirroring of upstream formatSkillsForPrompt
 * in renderPrimeSkillsPrompt.
 */
import { describe, expect, it } from "vitest";
import type { HarnessEntry } from "../harness/types";
import {
  PRIME_SKILL_UNAVAILABLE_REMEDY,
  PRIME_SKILLS_PROMPT_INTRO,
  PrimeSkillRegistry,
  deriveModuleFilePath,
  renderPrimeSkillsPrompt,
} from "./skills";

const WEB_SEARCH_MD = [
  "---",
  "name: web-search",
  "description: Search the web. Use when the task needs current facts.",
  "---",
  "",
  "# Web Search",
  "",
  "Run the search and read the snippets.",
].join("\n");

const STYLE_MD = [
  "---",
  "name: style-guide",
  "description: Enforce the house style on written answers.",
  "---",
  "",
  "# Style Guide",
  "",
  "Prefer short sentences.",
].join("\n");

function registerWebSearch(registry: PrimeSkillRegistry) {
  return registry.register({
    type: "skill-md",
    skillMd: WEB_SEARCH_MD,
    baseDir: "skills/web-search",
    source: "workspace",
    python: { codeOrigin: { type: "workspace-file", path: "/workspace/skills/web_search.py" } },
  });
}

function harnessSkillEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    id: "sys-stats",
    kind: "skill",
    title: "System statistics",
    content: "Collect CPU and memory statistics.",
    scope: "local",
    source: "agent",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...overrides,
  };
}

describe("PrimeSkillRegistry registration", () => {
  it("registers a markdown skill from SKILL.md content with frontmatter applied", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({ type: "skill-md", skillMd: STYLE_MD, baseDir: "skills/style-guide", source: "workspace" });
    expect(skill).toBeDefined();
    expect(skill).toMatchObject({
      name: "style-guide",
      kind: "markdown",
      description: "Enforce the house style on written answers.",
      location: "skills/style-guide/SKILL.md",
      disableModelInvocation: false,
      allowedTools: [],
      loadContext: [],
    });
    expect(skill?.body).toBe("# Style Guide\n\nPrefer short sentences.");
    expect(registry.diagnostics()).toEqual([]);
  });

  it("registers a python skill with derived import name and default run reference", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registerWebSearch(registry);
    expect(skill?.kind).toBe("python");
    expect(skill?.python?.importName).toBe("web_search");
    expect(skill?.python?.reference).toEqual({ type: "python", import: "web_search", callable: "run" });
    expect(skill?.python?.codeOrigin).toEqual({ type: "workspace-file", path: "/workspace/skills/web_search.py" });
  });

  it("keeps an explicit import name and reference, and refuses an import/reference mismatch", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({
      type: "skill-md",
      skillMd: WEB_SEARCH_MD,
      python: {
        importName: "pkg.web",
        codeOrigin: { type: "pack", pack: "web-pack" },
        reference: { type: "python", import: "pkg.web", callable: "search.run" },
      },
    });
    expect(skill?.python?.importName).toBe("pkg.web");
    expect(skill?.python?.reference).toEqual({ type: "python", import: "pkg.web", callable: "search.run" });

    const refused = registry.register({
      type: "skill-md",
      skillMd: STYLE_MD,
      python: {
        importName: "other",
        codeOrigin: { type: "pack", pack: "p" },
        reference: { type: "python", import: "not-other", callable: "run" },
      },
    });
    expect(refused).toBeUndefined();
    expect(registry.diagnostics().some((diagnostic) => diagnostic.code === "invalid_skill" && diagnostic.message.includes("ambiguous"))).toBe(true);
  });

  it("rejects malformed SKILL.md with the parser issues in the diagnostic", () => {
    const registry = new PrimeSkillRegistry();
    const refused = registry.register({ type: "skill-md", skillMd: "---\nname: BAD NAME\ndescription: ok\n---\nbody" });
    expect(refused).toBeUndefined();
    const diagnostic = registry.diagnostics().find((entry) => entry.code === "invalid_skill");
    expect(diagnostic?.message).toContain("name_invalid_characters");
  });

  it("first registered wins on name collision and names the loser", () => {
    const registry = new PrimeSkillRegistry();
    const first = registry.register({ type: "skill-md", skillMd: STYLE_MD, baseDir: "a/style-guide", location: "skills/a/SKILL.md" });
    const second = registry.register({ type: "skill-md", skillMd: STYLE_MD, baseDir: "b/style-guide", location: "skills/b/SKILL.md" });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(registry.list().map((skill) => skill.name)).toEqual(["style-guide"]);
    const collision = registry.diagnostics().find((diagnostic) => diagnostic.code === "name_collision");
    expect(collision?.severity).toBe("warning");
    expect(collision?.message).toContain("skills/a/SKILL.md");
    expect(collision?.message).toContain("skills/b/SKILL.md");
  });

  it("keeps both skills when two names share a python import, with a warning (upstream parity)", () => {
    const registry = new PrimeSkillRegistry();
    const one = registerWebSearch(registry);
    const two = registry.register({
      type: "skill-md",
      skillMd: STYLE_MD,
      python: { importName: "web_search", codeOrigin: { type: "pack", pack: "p" } },
    });
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(registry.list().map((skill) => skill.name)).toEqual(["web-search", "style-guide"]);
    expect(registry.diagnostics().some((diagnostic) => diagnostic.code === "python_import_shared" && diagnostic.message.includes("web_search"))).toBe(true);
  });

  it("preserves registration order (the port's precedence axis)", () => {
    const registry = new PrimeSkillRegistry();
    for (const name of ["c-skill", "a-skill", "b-skill"]) {
      registry.register({
        type: "skill-md",
        skillMd: `---\nname: ${name}\ndescription: Skill ${name}.\n---\nbody`,
      });
    }
    expect(registry.list().map((skill) => skill.name)).toEqual(["c-skill", "a-skill", "b-skill"]);
  });

  it("tracks disable-model-invocation and frontmatter metadata", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({
      type: "skill-md",
      skillMd: [
        "---",
        "name: hidden-skill",
        "description: Only explicit invocation.",
        "version: '2.0'",
        "author: Prime",
        "disable-model-invocation: true",
        "allowed-tools: [read_file]",
        "load-context: [refs/editorial.md]",
        "---",
        "body",
      ].join("\n"),
    });
    expect(skill).toMatchObject({
      disableModelInvocation: true,
      version: "2.0",
      author: "Prime",
      allowedTools: ["read_file"],
      loadContext: ["refs/editorial.md"],
    });
  });
});

describe("PrimeSkillRegistry harness-entry registration", () => {
  it("registers a reference-less harness skill as markdown with derived description", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({ type: "harness-entry", entry: harnessSkillEntry() });
    expect(skill).toMatchObject({
      name: "sys-stats",
      kind: "markdown",
      description: "Collect CPU and memory statistics.",
      location: "harness:local/sys-stats",
      source: "harness:local",
    });
  });

  it("registers a reference-bearing harness skill as python with the harness code origin", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({
      type: "harness-entry",
      entry: harnessSkillEntry({ reference: { type: "python", import: "pkg.mod", callable: "stats.run" } }),
    });
    expect(skill?.kind).toBe("python");
    expect(skill?.python?.importName).toBe("pkg.mod");
    expect(skill?.python?.reference).toEqual({ type: "python", import: "pkg.mod", callable: "stats.run" });
    expect(skill?.python?.codeOrigin).toEqual({ type: "harness-entry", scope: "local", id: "sys-stats" });
  });

  it("prefers metadata.description for harness skills", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registry.register({
      type: "harness-entry",
      entry: harnessSkillEntry({ metadata: { description: "Reads host statistics." } }),
    });
    expect(skill?.description).toBe("Reads host statistics.");
  });

  it("refuses non-skill harness entries and unusable entry ids", () => {
    const registry = new PrimeSkillRegistry();
    expect(registry.register({ type: "harness-entry", entry: harnessSkillEntry({ kind: "memory" }) })).toBeUndefined();
    expect(registry.register({ type: "harness-entry", entry: harnessSkillEntry({ id: "Bad_Id" }) })).toBeUndefined();
    const codes = registry.diagnostics().map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(["invalid_skill", "invalid_skill"]);
  });
});

describe("PrimeSkillRegistry import-error ledger (_PRIME_AGENT_SKILL_IMPORT_ERRORS analogue)", () => {
  it("records per-import reasons and answers per skill with the standard remedy", () => {
    const registry = new PrimeSkillRegistry();
    const skill = registerWebSearch(registry);
    registry.recordImportError("web_search", "ModuleNotFoundError: No module named 'httpx'");
    const recorded = registry.importErrorForSkill(skill!);
    expect(recorded?.skillName).toBe("web-search");
    expect(recorded?.reason).toContain("httpx");
    expect(recorded?.remedy).toBe(PRIME_SKILL_UNAVAILABLE_REMEDY);
    const snapshot = registry.importErrors();
    expect(Object.keys(snapshot)).toEqual(["web_search"]);
    expect(snapshot.web_search.reason).toContain("httpx");
  });
});

describe("deriveModuleFilePath", () => {
  it("maps dotted imports onto package paths", () => {
    expect(deriveModuleFilePath("web_search")).toBe("web_search.py");
    expect(deriveModuleFilePath("pkg.mod")).toBe("pkg/mod.py");
  });
});

describe("renderPrimeSkillsPrompt (upstream formatSkillsForPrompt mirror)", () => {
  it("pins the intro copy verbatim, in order", () => {
    expect(PRIME_SKILLS_PROMPT_INTRO).toEqual([
      "The following skills provide specialized instructions for specific tasks.",
      "Use ipython to inspect a skill's file when the task matches its description.",
      "Skills with a python_import are prepared in the persistent IPython kernel when available and can be called directly by that import name.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    ]);
  });

  it("renders the byte-exact <available_skills> block for a mixed registry", () => {
    const registry = new PrimeSkillRegistry();
    registerWebSearch(registry);
    registry.register({ type: "skill-md", skillMd: STYLE_MD, baseDir: "skills/style-guide", source: "workspace" });
    const expected = [
      "\n\nThe following skills provide specialized instructions for specific tasks.",
      "Use ipython to inspect a skill's file when the task matches its description.",
      "Skills with a python_import are prepared in the persistent IPython kernel when available and can be called directly by that import name.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
      "  <skill>",
      "    <name>web-search</name>",
      "    <type>python</type>",
      "    <python_import>web_search</python_import>",
      "    <description>Search the web. Use when the task needs current facts.</description>",
      "    <location>skills/web-search/SKILL.md</location>",
      "  </skill>",
      "  <skill>",
      "    <name>style-guide</name>",
      "    <type>markdown</type>",
      "    <description>Enforce the house style on written answers.</description>",
      "    <location>skills/style-guide/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    expect(renderPrimeSkillsPrompt(registry)).toBe(expected);
  });

  it("excludes disable-model-invocation skills and stays empty when nothing is visible", () => {
    const registry = new PrimeSkillRegistry();
    expect(renderPrimeSkillsPrompt(registry)).toBe("");
    registry.register({
      type: "skill-md",
      skillMd: "---\nname: hidden-skill\ndescription: Not for the model.\ndisable-model-invocation: true\n---\nbody",
    });
    expect(renderPrimeSkillsPrompt(registry)).toBe("");
  });

  it("XML-escapes every substituted value", () => {
    const registry = new PrimeSkillRegistry();
    registry.register({
      type: "skill-md",
      skillMd: "---\nname: tricky\ndescription: A&B <tag> \"quoted\" 'single'\n---\nbody",
      location: "path/with&<chars>",
    });
    const rendered = renderPrimeSkillsPrompt(registry);
    expect(rendered).toContain("<description>A&amp;B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;</description>");
    expect(rendered).toContain("<location>path/with&amp;&lt;chars&gt;</location>");
  });
});
