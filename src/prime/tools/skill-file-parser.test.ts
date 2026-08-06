/**
 * SKILL.md subset-parser tests: a named-issue validation table (one row
 * per issue code the parser can raise against malformed input), then the
 * frontmatter variants well-formed skills actually ship — quoted scalars
 * with nested quotes, block scalars, dash/inline lists, env maps, key
 * aliases, comment and CRLF handling. The parser never throws; the table
 * asserts every rejection arrives as a named issue, not an exception.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_MD_CHARS,
  parseSkillMd,
  PRIME_SKILL_FILE_ISSUE_CODES,
  type PrimeSkillFileIssue,
  type PrimeSkillFileIssueCode,
} from "./skill-file-parser";

type IssueRow = Readonly<{
  title: string;
  input: string;
  parentDirName?: string;
  code: PrimeSkillFileIssueCode;
  severity: "error" | "warning";
}>;

const md = (frontmatter: string, body = "# Instructions") => `---\n${frontmatter}\n---\n${body}`;

const ISSUE_ROWS: readonly IssueRow[] = [
  { title: "name_missing without any parent fallback", input: "Just prose, no frontmatter.", code: "name_missing", severity: "error" },
  { title: "name_missing falls back to the parent dir name", input: "Just prose, no frontmatter.", parentDirName: "ops-tools", code: "name_missing", severity: "warning" },
  { title: "frontmatter_unterminated", input: "---\nname: web-search\ndescription: x\n", code: "frontmatter_unterminated", severity: "error" },
  { title: "frontmatter_not_mapping (bare scalar)", input: "---\nhello world\n---\nbody", code: "frontmatter_not_mapping", severity: "error" },
  { title: "frontmatter_not_mapping (list)", input: "---\n- a\n- b\n---\nbody", code: "frontmatter_not_mapping", severity: "error" },
  { title: "line_malformed (bad key shape)", input: md("na me: x\ndescription: ok"), code: "line_malformed", severity: "error" },
  { title: "line_malformed (tab indentation)", input: "---\n\tname: x\n---\nbody", code: "line_malformed", severity: "error" },
  { title: "duplicate_key", input: md("name: one\nname: two\ndescription: ok"), code: "duplicate_key", severity: "error" },
  { title: "unsupported_key", input: md("name: web-search\ndescription: ok\nlicense: MIT"), code: "unsupported_key", severity: "warning" },
  { title: "nested_value_unsupported", input: md("name: web-search\ndescription: ok\nenv:\n  KEY:\n    deep: v"), code: "nested_value_unsupported", severity: "warning" },
  { title: "quoted_unterminated", input: md('name: "unterminated\ndescription: ok'), code: "quoted_unterminated", severity: "error" },
  { title: "escape_unknown", input: md('name: web-search\ndescription: "one \\q two"'), code: "escape_unknown", severity: "warning" },
  { title: "block_scalar_bad_header", input: md("name: web-search\ndescription: |2 stuff"), code: "block_scalar_bad_header", severity: "warning" },
  { title: "inline_list_malformed", input: md("name: web-search\ndescription: ok\nallowed-tools: [read_file, search"), code: "inline_list_malformed", severity: "warning" },
  { title: "list_item_malformed", input: md("name: web-search\ndescription: ok\nallowed-tools: [read_file,,search]"), code: "list_item_malformed", severity: "warning" },
  {
    title: "list_too_many_items",
    input: md(`name: web-search\ndescription: ok\nallowed-tools: [${Array.from({ length: 33 }, (_, i) => `item-${i}`).join(", ")}]`),
    code: "list_too_many_items",
    severity: "warning",
  },
  {
    title: "list_item_length_exceeded",
    input: md(`name: web-search\ndescription: ok\nload-context:\n  - ${"x".repeat(300)}\n  - short.md`),
    code: "list_item_length_exceeded",
    severity: "warning",
  },
  { title: "name_not_string", input: md("name: [abc]\ndescription: ok"), code: "name_not_string", severity: "error" },
  { title: "name_length_exceeded", input: md(`name: ${"a".repeat(65)}\ndescription: ok`), code: "name_length_exceeded", severity: "error" },
  { title: "name_invalid_characters", input: md("name: MySkill_x\ndescription: ok"), code: "name_invalid_characters", severity: "error" },
  { title: "name_leading_trailing_hyphen", input: md("name: -bad-skill\ndescription: ok"), code: "name_leading_trailing_hyphen", severity: "error" },
  { title: "name_consecutive_hyphens", input: md("name: a--b\ndescription: ok"), code: "name_consecutive_hyphens", severity: "error" },
  { title: "name_parent_dir_mismatch", input: md("name: other\ndescription: ok"), parentDirName: "web-search", code: "name_parent_dir_mismatch", severity: "warning" },
  { title: "description_missing", input: md("name: web-search"), code: "description_missing", severity: "error" },
  { title: "description_not_string", input: md("name: web-search\ndescription:\n  nested: true"), code: "description_not_string", severity: "error" },
  { title: "description_length_exceeded", input: md(`name: web-search\ndescription: ${"d".repeat(1_025)}`), code: "description_length_exceeded", severity: "error" },
  { title: "version_not_string", input: md("name: web-search\ndescription: ok\nversion: [1]"), code: "version_not_string", severity: "warning" },
  { title: "author_not_string", input: md("name: web-search\ndescription: ok\nauthor:\n  who: x"), code: "author_not_string", severity: "warning" },
  { title: "env_not_mapping", input: md("name: web-search\ndescription: ok\nenv: hello"), code: "env_not_mapping", severity: "warning" },
  { title: "env_key_invalid", input: md("name: web-search\ndescription: ok\nenv:\n  1BAD: x"), code: "env_key_invalid", severity: "warning" },
  {
    title: "env_too_many_entries",
    input: md(`name: web-search\ndescription: ok\nenv:\n${Array.from({ length: 33 }, (_, i) => `  KEY_${i}: v${i}`).join("\n")}`),
    code: "env_too_many_entries",
    severity: "warning",
  },
  { title: "env_value_not_string", input: md("name: web-search\ndescription: ok\nenv:\n  FOO: [a]"), code: "env_value_not_string", severity: "warning" },
  { title: "allowed_tools_not_list", input: md("name: web-search\ndescription: ok\nallowed-tools: read_file"), code: "allowed_tools_not_list", severity: "warning" },
  { title: "load_context_not_list", input: md("name: web-search\ndescription: ok\nload-context: docs.md"), code: "load_context_not_list", severity: "warning" },
  { title: "disable_model_invocation_not_boolean", input: md("name: web-search\ndescription: ok\ndisable-model-invocation: maybe"), code: "disable_model_invocation_not_boolean", severity: "warning" },
  { title: "skill_md_too_large", input: `${"x".repeat(MAX_SKILL_MD_CHARS + 1)}`, code: "skill_md_too_large", severity: "error" },
];

function issuesOf(input: string, parentDirName?: string): readonly PrimeSkillFileIssue[] {
  return parseSkillMd(input, parentDirName === undefined ? {} : { parentDirName }).issues;
}

describe("parseSkillMd named issues", () => {
  it("covers at least 24 distinct named issue codes", () => {
    const distinct = new Set(ISSUE_ROWS.map((row) => row.code));
    expect(distinct.size).toBeGreaterThanOrEqual(24);
    for (const code of distinct) {
      expect(PRIME_SKILL_FILE_ISSUE_CODES).toContain(code);
    }
  });

  for (const row of ISSUE_ROWS) {
    it(`${row.code}: ${row.title}`, () => {
      // Never-throws contract: every malformed input returns a parsed shape.
      const parsed = parseSkillMd(row.input, row.parentDirName === undefined ? {} : { parentDirName: row.parentDirName });
      const matching = parsed.issues.filter((issue) => issue.code === row.code);
      expect(matching, `expected issue ${row.code} in ${JSON.stringify(parsed.issues)}`).toHaveLength(1);
      expect(matching[0].severity).toBe(row.severity);
      expect(typeof matching[0].message).toBe("string");
      expect(matching[0].message.length).toBeGreaterThan(0);
    });
  }
});

describe("parseSkillMd frontmatter variants", () => {
  it("parses the common upstream shape (name + description)", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: Search the web via Serper. Use for lookups."), {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter).toEqual({ name: "web-search", description: "Search the web via Serper. Use for lookups." });
    expect(parsed.body).toBe("# Instructions");
  });

  it("keeps nested opposite quotes inside double-quoted scalars", () => {
    // SKILL.md line: description: "she said \"hi, it's\" today"
    const parsed = parseSkillMd(md('name: say-hi\ndescription: "she said \\"hi, it\'s\\" today"'), {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter?.description).toBe('she said "hi, it\'s" today');
  });

  it("unescapes doubled single quotes and keeps double quotes inside single-quoted scalars", () => {
    // SKILL.md line: description: 'it''s "fine" here'
    const parsed = parseSkillMd(md("name: say-hi\ndescription: 'it''s \"fine\" here'"), {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter?.description).toBe('it\'s "fine" here');
  });

  it("does not strip comments inside quoted scalars", () => {
    const parsed = parseSkillMd(md('name: say-hi\ndescription: "a: b # not a comment"'), {});
    expect(parsed.frontmatter?.description).toBe("a: b # not a comment");
  });

  it("strips trailing comments from plain scalars and skips comment lines", () => {
    const parsed = parseSkillMd(md("name: web-search # trailing\n# a full-line comment\ndescription: ok"), {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter?.name).toBe("web-search");
  });

  it("parses block scalars with clip, strip, and folding", () => {
    const clip = parseSkillMd(md("name: web-search\ndescription: |\n  line one\n  line two"), {});
    expect(clip.frontmatter?.description).toBe("line one\nline two\n");
    const strip = parseSkillMd(md("name: web-search\ndescription: |-\n  line one\n  line two\n\n"), {});
    expect(strip.frontmatter?.description).toBe("line one\nline two");
    const folded = parseSkillMd(md("name: web-search\ndescription: >\n  first sentence\n  second sentence\n\n  new para"), {});
    expect(folded.frontmatter?.description).toBe("first sentence second sentence\nnew para\n");
  });

  it("folds plain multi-line scalars started on deeper lines, paragraphs preserved", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription:\n  first line\n  second line\n\n  third para"), {});
    expect(parsed.frontmatter?.description).toBe("first line second line\nthird para");
  });

  it("parses dash lists with quoted items carrying commas and brackets", () => {
    const parsed = parseSkillMd(md('name: web-search\ndescription: ok\nallowed-tools:\n  - read_file\n  - "search, grep]x"'), {});
    expect(parsed.frontmatter?.allowedTools).toEqual(["read_file", "search, grep]x"]);
  });

  it("parses inline lists with nested quotes and escapes commas inside quotes", () => {
    const parsed = parseSkillMd(md(`name: web-search\ndescription: ok\nallowed-tools: ["a, 'b'", 'say "hi"', plain]`), {});
    expect(parsed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(parsed.frontmatter?.allowedTools).toEqual(["a, 'b'", 'say "hi"', "plain"]);
  });

  it("parses env as a flat string map", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: ok\nenv:\n  SERPER_API_KEY: from-host\n  REGION: eu-west"), {});
    expect(parsed.frontmatter?.env).toEqual({ SERPER_API_KEY: "from-host", REGION: "eu-west" });
  });

  it("normalizes kebab, snake, and camel key spellings", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: ok\nallowed_tools: [a]\nload_context: [b.md]\ndisable_model_invocation: true"), {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter?.allowedTools).toEqual(["a"]);
    expect(parsed.frontmatter?.loadContext).toEqual(["b.md"]);
    expect(parsed.frontmatter?.disableModelInvocation).toBe(true);
  });

  it("treats a quoted boolean as a string and drops it with a warning (YAML core schema)", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: ok\ndisable-model-invocation: 'true'"), {});
    expect(parsed.frontmatter?.disableModelInvocation).toBeUndefined();
    expect(parsed.issues.some((issue) => issue.code === "disable_model_invocation_not_boolean")).toBe(true);
  });

  it("normalizes CRLF and lone CR newlines before parsing", () => {
    const parsed = parseSkillMd("---\r\nname: web-search\r\ndescription: ok\r\n---\r\nbody line", {});
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter?.name).toBe("web-search");
  });

  it("keeps the body untrimmed when no frontmatter exists (upstream parity)", () => {
    const parsed = parseSkillMd("\n\n  spaced body\n\n", {});
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("\n\n  spaced body\n\n");
  });

  it("trims the body when a frontmatter block was consumed (upstream parity)", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: ok", "\n\n  spaced body\n\n"), {});
    expect(parsed.body).toBe("spaced body");
  });

  it("marks the version and author fields", () => {
    const parsed = parseSkillMd(md("name: web-search\ndescription: ok\nversion: 1.2.3\nauthor: Prime Labs"), {});
    expect(parsed.frontmatter?.version).toBe("1.2.3");
    expect(parsed.frontmatter?.author).toBe("Prime Labs");
  });

  it("falls back to the parent directory name and warns on mismatch", () => {
    const parsed = parseSkillMd(md("name: different\ndescription: ok"), { parentDirName: "web-search" });
    expect(parsed.frontmatter?.name).toBe("different");
    expect(parsed.issues.some((issue) => issue.code === "name_parent_dir_mismatch" && issue.severity === "warning")).toBe(true);
    const fallback = parseSkillMd(md("description: ok"), { parentDirName: "web-search" });
    expect(fallback.frontmatter?.name).toBeUndefined();
    expect(fallback.issues.some((issue) => issue.code === "name_missing" && issue.message.includes("web-search"))).toBe(true);
  });

  it("keeps the first of duplicate spellings and refuses ambiguous values", () => {
    const parsed = parseSkillMd(md("name: first\nallowed-tools: [x]\nallowed_tools: [y]\ndescription: ok"), {});
    expect(parsed.issues.some((issue) => issue.code === "duplicate_key")).toBe(true);
    expect(parsed.frontmatter?.allowedTools ?? ["x"]).toEqual(["x"]);
  });
});
