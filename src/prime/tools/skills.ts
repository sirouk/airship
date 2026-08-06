/**
 * PrimeSkillRegistry: the model-facing skill authority for the port of
 * prime-agent's skills system (packages/coding-agent/src/core/skills.ts).
 *
 * What upstream does with a filesystem, this registry does with explicit
 * registrations, because the port has no ambient filesystem to walk:
 * upstream discovery order (user dir, project dir, extra paths, bundled
 * packs) becomes REGISTRATION order, with upstream's first-wins collision
 * rule preserved. A host that wants upstream precedence registers user
 * skills first, then project skills, then explicit paths, then packs.
 *
 * Two skill kinds, mirroring upstream:
 *   - markdown: prompt-only instruction content. It reaches the model
 *     through the `<available_skills>` prompt block assembled by
 *     renderPrimeSkillsPrompt below (a 1:1 mirror of upstream
 *     formatSkillsForPrompt, same copy, same XML shape, same filtering).
 *     Composing that block into a system prompt is the integration seam —
 *     this module assembles the fragment, and deliberately does NOT wire
 *     any system prompt here.
 *   - python: a skill whose module executes inside the persistent kernel.
 *     The registry records the module-wrap call contract
 *     ({type:"python", import, callable | call_pattern} — the harness
 *     reference shape from ../harness/store, so harness skill entries and
 *     registered skills speak one contract) plus a code origin saying
 *     where the module's CODE may materialize from. Execution itself
 *     lives in skill-tools.ts; the registry owns identity, uniqueness,
 *     and the import-error ledger.
 *
 * The import-error ledger is the host-side analogue of upstream's
 * _PRIME_AGENT_SKILL_IMPORT_ERRORS kernel registry and its
 * _PrimeAgentUnavailableSkill wrapper: when a kernel reports that a
 * module raised at import time, the reason is recorded per import name,
 * and every later surface (list/read/call) names the skill unavailable
 * with a remedy instead of retrying a known-broken import inside the
 * kernel. Upstream keys the registry by import name; so does the port.
 */

import { canonicalSkillReference } from "../harness/store";
import type { HarnessEntry, HarnessSkillReference, HarnessScope } from "../harness/types";
import {
  MAX_SKILL_DESCRIPTION_CHARS,
  parseSkillMd,
  type PrimeSkillFileIssue,
} from "./skill-file-parser";

export type PrimeSkillKind = "markdown" | "python";

/**
 * Where a python skill's module code may come from — exactly one of
 * these, fail closed otherwise (port-manifest §3.1 honesty rule: a skill
 * never materializes arbitrary module imports):
 *   - workspace-file: one bounded, control-plane-refused read of a
 *     workspace path at call time;
 *   - harness-entry: module code persisted on a kind:"skill" harness
 *     entry (content, or metadata.code when content is prose);
 *   - pack: the host's dependency-approved pack function hands the
 *     module source over. Host packs are the ONLY channel that may ship
 *     third-party dependencies — kernel jobs never run
 *     loadPackagesFromImports, because ambient PyPI pulls are the
 *     browser-port equivalent of upstream's pip-install-at-bootstrap,
 *     which this port removes on purpose.
 */
export type PrimeSkillCodeOrigin =
  | Readonly<{ type: "workspace-file"; path: string }>
  | Readonly<{ type: "harness-entry"; scope: HarnessScope; id: string }>
  | Readonly<{ type: "pack"; pack: string }>;

export type PrimeSkill = Readonly<{
  name: string;
  description: string;
  kind: PrimeSkillKind;
  /** SKILL.md instructions body (frontmatter consumed) or harness entry content. */
  body: string;
  /** Display location for the <available_skills> block and the read action. */
  location: string;
  /** Provenance label ("inline", "workspace", "harness:local", "pack", ...). */
  source: string;
  disableModelInvocation: boolean;
  version?: string;
  author?: string;
  allowedTools: readonly string[];
  loadContext: readonly string[];
  /** Present exactly when kind === "python"; typed as optional+undefined the way upstream's MarkdownSkill/PythonSkill union guarantees. */
  python?: Readonly<{
    importName: string;
    reference: HarnessSkillReference;
    codeOrigin: PrimeSkillCodeOrigin;
  }>;
}>;

export type PrimeSkillRegistration =
  | Readonly<{
      type: "skill-md";
      /** Raw SKILL.md content (frontmatter + body). */
      skillMd: string;
      /** Display location; defaults to the baseDir's SKILL.md or an inline label. */
      location?: string;
      /** Virtual directory of the SKILL.md; its basename feeds upstream's parent-dir name rules. */
      baseDir?: string;
      source?: string;
      /**
       * Declares the skill python. Upstream DETECTS python skills by
       * sniffing pyproject.toml + src/<import>/__init__.py off disk; the
       * port makes the declaration explicit because module materialization
       * travels kernel-job FS writes, not venv installs, and sniffing
       * would promise a filesystem walk no port host performs.
       */
      python?: Readonly<{
        /** Defaults to the skill name with "-" -> "_". Must be a dotted python identifier path. */
        importName?: string;
        codeOrigin: PrimeSkillCodeOrigin;
        /** Harness reference shape; defaults to {type:"python", import, callable:"run"} (the module-wrap convention). */
        reference?: unknown;
      }>;
    }>
  | Readonly<{
      type: "harness-entry";
      /** A kind:"skill" harness entry. Reference-bearing entries become python skills; the rest markdown. */
      entry: HarnessEntry;
      location?: string;
      source?: string;
    }>;

export type PrimeSkillDiagnostic = Readonly<{
  code: "invalid_skill" | "name_collision" | "python_import_shared";
  severity: "error" | "warning";
  message: string;
  name?: string;
}>;

/** Remedy sentence attached to every unavailable-skill surface; names the fix instead of leaving the model to guess. */
export const PRIME_SKILL_UNAVAILABLE_REMEDY =
  "Fix the module at its code origin (workspace file, harness entry, or host pack) and re-register the skill, or remove it; the import error is recorded per name and calls refuse until it clears.";

export type PrimeSkillImportError = Readonly<{
  importName: string;
  skillName: string;
  reason: string;
  remedy: string;
}>;

/** Dotted python identifier path ("module" or "package.module"); a superset of upstream's segment rule so harness references keep working. */
export function canonicalPythonImportName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) return undefined;
  return value;
}

/** Dotted attribute path ("run" or "search.run") resolved off the imported module. */
export function canonicalPythonCallableName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) return undefined;
  return value;
}

/** The file path a single-file module is materialized at, relative to the kernel skill root ("a.b" -> "a/b.py"; PEP 420 namespace packages need no __init__.py). */
export function deriveModuleFilePath(importName: string): string {
  return `${importName.split(".").join("/")}.py`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function formatIssues(issues: readonly PrimeSkillFileIssue[]): string {
  return issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ");
}

/** The name checks the parser encodes as issues, restated for harness entry ids (which never pass through parseSkillMd). */
function canonicalSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > 64) return undefined;
  if (!/^[a-z0-9-]+$/.test(value)) return undefined;
  if (value.startsWith("-") || value.endsWith("-") || value.includes("--")) return undefined;
  return value;
}

/**
 * First line of prose a harness skill entry offers the model as its
 * description, capped to the spec description bound so the derived value
 * stays valid by construction.
 */
function deriveHarnessDescription(entry: HarnessEntry): string {
  const meta = entry.metadata?.description;
  if (typeof meta === "string" && meta.trim() !== "") {
    return meta.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS);
  }
  const firstLine = entry.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return (firstLine ?? entry.title).slice(0, MAX_SKILL_DESCRIPTION_CHARS);
}

const DEFAULT_PYTHON_REFERENCE_CALLABLE = "run";

export class PrimeSkillRegistry {
  private readonly skills = new Map<string, PrimeSkill>();
  private readonly pythonImports = new Map<string, string>();
  private readonly diagnosticsOut: PrimeSkillDiagnostic[] = [];
  private readonly importErrorLedger = new Map<string, PrimeSkillImportError>();

  /** Registration order IS precedence order; the first registered skill with a name owns it (upstream first-wins). */
  register(input: PrimeSkillRegistration): PrimeSkill | undefined {
    const built = this.buildSkill(input);
    if ("diagnostic" in built) {
      this.diagnosticsOut.push(built.diagnostic);
      return undefined;
    }
    const skill = built.skill;
    const existing = this.skills.get(skill.name);
    if (existing !== undefined) {
      // Upstream: addSkills keeps the first skill with a name and emits a
      // collision diagnostic naming winner and loser. Registration order is
      // the port's only precedence axis, so the same rule lands as:
      // first registered wins, loser is recorded, never swapped.
      this.diagnosticsOut.push(Object.freeze({
        code: "name_collision" as const,
        severity: "warning" as const,
        name: skill.name,
        message: `skill name "${skill.name}" collision: the skill from ${skill.location} loses to the already-registered ${existing.location} (upstream first-wins precedence).`,
      }));
      return undefined;
    }
    if (skill.python !== undefined) {
      const priorName = this.pythonImports.get(skill.python.importName);
      if (priorName !== undefined && priorName !== skill.name) {
        // Upstream pythonImportMap parity: both skills stay usable; the
        // shared import is a warning, because inside one kernel namespace
        // only one module gets the name and everyone should know.
        this.diagnosticsOut.push(Object.freeze({
          code: "python_import_shared" as const,
          severity: "warning" as const,
          name: skill.name,
          message: `python import name "${skill.python.importName}" is shared by skills "${priorName}" and "${skill.name}"`,
        }));
      } else {
        this.pythonImports.set(skill.python.importName, skill.name);
      }
    }
    this.skills.set(skill.name, skill);
    return skill;
  }

  get(name: string): PrimeSkill | undefined {
    return this.skills.get(name);
  }

  /** Deterministic registration order — the prompt block and list action are byte-stable for identical registration sequences. */
  list(): readonly PrimeSkill[] {
    return [...this.skills.values()];
  }

  diagnostics(): readonly PrimeSkillDiagnostic[] {
    return this.diagnosticsOut;
  }

  /**
   * Record one import-time failure against an import name — the
   * host-side _PRIME_AGENT_SKILL_IMPORT_ERRORS. Kernel-reported reasons
   * land here verbatim (bounded by the caller), the port attaches the
   * remedy, and the ledger sticks until the host registers a fix:
   * recorded failures are health facts, not per-call retries.
   */
  recordImportError(importName: string, reason: string, options: Readonly<{ skillName?: string; remedy?: string }> = {}): PrimeSkillImportError {
    const record: PrimeSkillImportError = Object.freeze({
      importName,
      skillName: options.skillName ?? this.pythonImports.get(importName) ?? importName,
      reason,
      remedy: options.remedy ?? PRIME_SKILL_UNAVAILABLE_REMEDY,
    });
    this.importErrorLedger.set(importName, record);
    return record;
  }

  importErrorForImport(importName: string): PrimeSkillImportError | undefined {
    return this.importErrorLedger.get(importName);
  }

  importErrorForSkill(skill: PrimeSkill): PrimeSkillImportError | undefined {
    return skill.python === undefined ? undefined : this.importErrorLedger.get(skill.python.importName);
  }

  /** Snapshot keyed by import name, the shape upstream's kernel registry serializes to. */
  importErrors(): Readonly<Record<string, PrimeSkillImportError>> {
    return Object.freeze(Object.fromEntries(this.importErrorLedger));
  }

  private buildSkill(input: PrimeSkillRegistration): { skill: PrimeSkill } | { diagnostic: PrimeSkillDiagnostic } {
    return input.type === "harness-entry" ? this.buildFromHarnessEntry(input) : this.buildFromSkillMd(input);
  }

  private buildFromSkillMd(
    input: Extract<PrimeSkillRegistration, { type: "skill-md" }>,
  ): { skill: PrimeSkill } | { diagnostic: PrimeSkillDiagnostic } {
    const parentDirName = input.baseDir === undefined ? undefined : basename(input.baseDir);
    const parsed = parseSkillMd(input.skillMd, { parentDirName });
    const fatal = parsed.issues.filter((issue) => issue.severity === "error");
    if (fatal.length > 0) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name: parsed.frontmatter?.name,
          message: `skill at ${input.location ?? input.baseDir ?? "(inline)"} refused: ${formatIssues(fatal)}`,
        }),
      };
    }
    const frontmatter = parsed.frontmatter ?? {};
    const name = frontmatter.name ?? parentDirName;
    // parseSkillMd already rejects name-less registrations without a
    // parent dir; this guard is the fail-closed restatement of that
    // invariant at the authority boundary, not a second policy.
    if (name === undefined || frontmatter.description === undefined) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          message: `skill at ${input.location ?? input.baseDir ?? "(inline)"} has no usable name/description frontmatter.`,
        }),
      };
    }
    const base = {
      name,
      description: frontmatter.description,
      body: parsed.body,
      location: input.location ?? (input.baseDir === undefined ? `inline:${name}` : `${input.baseDir}/SKILL.md`),
      source: input.source ?? "inline",
      disableModelInvocation: frontmatter.disableModelInvocation === true,
      ...(frontmatter.version !== undefined ? { version: frontmatter.version } : {}),
      ...(frontmatter.author !== undefined ? { author: frontmatter.author } : {}),
      allowedTools: Object.freeze([...(frontmatter.allowedTools ?? [])]),
      loadContext: Object.freeze([...(frontmatter.loadContext ?? [])]),
    };
    if (input.python === undefined) {
      return { skill: Object.freeze({ ...base, kind: "markdown" as const }) };
    }

    const requestedImport = input.python.importName ?? name.replaceAll("-", "_");
    const reference: HarnessSkillReference | undefined = input.python.reference === undefined
      ? Object.freeze({ type: "python" as const, import: requestedImport, callable: DEFAULT_PYTHON_REFERENCE_CALLABLE })
      : canonicalSkillReference(input.python.reference);
    if (reference === undefined) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name,
          message: `python skill "${name}" has an unusable reference: it must be {type:"python", import, callable | call_pattern} (the harness contract).`,
        }),
      };
    }
    if (input.python.reference !== undefined && input.python.importName !== undefined && reference.import !== requestedImport) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name,
          message: `python skill "${name}" names import "${requestedImport}" but its reference imports "${reference.import}"; ambiguous module identity is refused.`,
        }),
      };
    }
    const importName = canonicalPythonImportName(reference.import);
    const callable = reference.callable === undefined ? undefined : canonicalPythonCallableName(reference.callable);
    if (importName === undefined || (reference.callable !== undefined && callable === undefined)) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name,
          message: `python skill "${name}" has a malformed import or callable name (dotted python identifiers only).`,
        }),
      };
    }
    const python = Object.freeze({
      importName,
      reference: Object.freeze({
        type: "python" as const,
        import: importName,
        ...(callable !== undefined ? { callable } : {}),
        ...(reference.callPattern !== undefined ? { callPattern: reference.callPattern } : {}),
      }),
      codeOrigin: input.python.codeOrigin,
    });
    return { skill: Object.freeze({ ...base, kind: "python" as const, python }) };
  }

  private buildFromHarnessEntry(
    input: Extract<PrimeSkillRegistration, { type: "harness-entry" }>,
  ): { skill: PrimeSkill } | { diagnostic: PrimeSkillDiagnostic } {
    const entry = input.entry;
    if (entry.kind !== "skill") {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name: entry.id,
          message: `harness entry "${entry.id}" is kind "${entry.kind}", not "skill"; only kind:"skill" entries register as skills.`,
        }),
      };
    }
    const name = canonicalSkillName(entry.id);
    if (name === undefined) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name: entry.id,
          message: `harness skill entry "${entry.id}" is not a usable skill name (lowercase a-z, 0-9, hyphens, ≤64 chars, no leading/trailing/doubled hyphen).`,
        }),
      };
    }
    const base = {
      name,
      description: deriveHarnessDescription(entry),
      body: entry.content,
      location: input.location ?? `harness:${entry.scope}/${entry.id}`,
      source: input.source ?? `harness:${entry.scope}`,
      disableModelInvocation: false,
      allowedTools: Object.freeze([] as string[]),
      loadContext: Object.freeze([] as string[]),
    };
    if (entry.reference === undefined) {
      return { skill: Object.freeze({ ...base, kind: "markdown" as const }) };
    }
    const importName = canonicalPythonImportName(entry.reference.import);
    const callable = entry.reference.callable === undefined ? undefined : canonicalPythonCallableName(entry.reference.callable);
    if (importName === undefined || (entry.reference.callable !== undefined && callable === undefined)) {
      return {
        diagnostic: Object.freeze({
          code: "invalid_skill" as const,
          severity: "error" as const,
          name,
          message: `harness skill entry "${entry.id}" carries a malformed python import or callable name.`,
        }),
      };
    }
    const python = Object.freeze({
      importName,
      reference: Object.freeze({
        type: "python" as const,
        import: importName,
        ...(callable !== undefined ? { callable } : {}),
        ...(entry.reference.callPattern !== undefined ? { callPattern: entry.reference.callPattern } : {}),
      }),
      codeOrigin: Object.freeze({ type: "harness-entry" as const, scope: entry.scope, id: entry.id }),
    });
    return { skill: Object.freeze({ ...base, kind: "python" as const, python }) };
  }
}

// ---------------------------------------------------------------------------
// The <available_skills> prompt block — a 1:1 mirror of upstream
// formatSkillsForPrompt (skills.ts), the fragment system-prompt composition
// later splices in. The intro copy is kept verbatim (including the word
// "ipython") because every shipped skill's SKILL.md — and therefore every
// prompt the port inherits — was written against exactly these sentences;
// PORT.md records the one approximation (the kernel-side tool is
// execute_code in the port, not upstream's ipython tool).
// ---------------------------------------------------------------------------

export const PRIME_SKILLS_PROMPT_INTRO: readonly string[] = Object.freeze([
  "The following skills provide specialized instructions for specific tasks.",
  "Use ipython to inspect a skill's file when the task matches its description.",
  "Skills with a python_import are prepared in the persistent IPython kernel when available and can be called directly by that import name.",
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
]);

function escapeSkillXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Mirror of upstream formatSkillsForPrompt: disable-model-invocation
 * skills hide from the model (they are slash-command-only upstream;
 * explicit host invocation in the port), an empty visible set assembles
 * to "" so composition can skip the block entirely, and the body is a
 * newline-joined fragment meant to append after the system prompt with
 * a blank line before it.
 */
export function renderPrimeSkillsPrompt(
  registry: PrimeSkillRegistry,
  options: Readonly<{ skills?: readonly PrimeSkill[] }> = {},
): string {
  const visible = (options.skills ?? registry.list()).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  // Upstream embeds the leading blank lines in the first intro element; keep
  // the emitted bytes identical ("\n\n" + intro) rather than re-styling them.
  const lines: string[] = [`\n\n${PRIME_SKILLS_PROMPT_INTRO[0]}`, ...PRIME_SKILLS_PROMPT_INTRO.slice(1), "", "<available_skills>"];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeSkillXml(skill.name)}</name>`);
    lines.push(`    <type>${skill.kind}</type>`);
    if (skill.python !== undefined) {
      lines.push(`    <python_import>${escapeSkillXml(skill.python.importName)}</python_import>`);
    }
    lines.push(`    <description>${escapeSkillXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeSkillXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
