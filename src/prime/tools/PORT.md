# src/prime/tools — prime skills system port notes

Port of prime-agent's skills system (upstream
`packages/coding-agent/src/core/skills.ts` discovery/validation +
`formatSkillsForPrompt`, the kernel-side module-wrap bootstrap in
`src/core/tools/ipython.ts` `buildRlmBootstrapCode`, and the harness
skill-entry contract from `src/core/refinement/refinement.ts` +
`prime-agent-runtime/src/rlm/harness.py`). Port-manifest §3.3 (skill rules)
and §3.18 (settings interplay) govern; the verdict is ADAPT and this is
the adaptation.

## Files

| file | upstream source | status |
|---|---|---|
| `skill-file-parser.ts` | `utils/frontmatter.ts` + the `SkillFrontmatter` gate in `skills.ts` (`validateName` / `validateDescription`) | ported semantics, subset parser (below) |
| `skills.ts` | `skills.ts` (Skill types, loadSkills precedence, `getPythonSkillRuntimeInfo`, `formatSkillsForPrompt`) | ported; discovery becomes registration |
| `skill-tools.ts` | `tools/ipython.ts` skill bootstrap (`_PrimeAgentCallableSkillModule`, `_PrimeAgentUnavailableSkill`, `_PRIME_AGENT_SKILL_IMPORT_ERRORS`) + harness `reference` invocation contract | ported to kernel jobs |
| `skill-file-parser.test.ts` | — | 55 tests (24+ named-issue table + variants) |
| `skills.test.ts` | — | 18 tests |
| `skill-tools.test.ts` | — | 24 tests (scripted-workerFactory flow, kernel-host pattern) |

## Ported 1:1

- **Frontmatter field rules.** `name` (≤64 chars, `^[a-z0-9-]+$`, no
  leading/trailing/doubled hyphen), `description` (required, ≤1024
  chars), and the name/parent-directory rules (missing name falls back
  to the parent directory name; mismatch is a warning, not a rejection)
  mirror `validateName`/`validateDescription` verbatim — same messages.
- **The `<available_skills>` prompt block.** `renderPrimeSkillsPrompt`
  mirrors upstream `formatSkillsForPrompt` byte-for-byte: the same four
  intro sentences (kept verbatim, including the word "ipython" — every
  shipped SKILL.md, and therefore every inherited prompt, was written
  against these exact sentences), the same `<skill>/<name>/<type>/
  <python_import>/<description>/<location>` element order, the same
  five-entity XML escaping, the same `disable-model-invocation`
  filtering, and "" when nothing is visible. Composing the block into a
  system prompt is the integration seam: this module assembles the
  fragment and deliberately does not touch any system-prompt code.
- **Module-wrap call semantics.** A python skill's reference
  `{type:"python", import, callable | call_pattern}` is the frozen
  harness contract (`canonicalSkillReference`, including the upstream
  `python_import`/`call_pattern` aliases). Invocation mirrors
  `_PrimeAgentCallableSkillModule`: with `callable`, a dotted attribute
  chain resolves off the imported module; with neither (the registry's
  default reference is `callable:"run"`), the invoke job calls
  `getattr(module, "run", None) or module` — a module without a callable
  `run` fails with the same not-callable `TypeError` an unwrapped
  ModuleType raises upstream.
- **The import-error registry.** Kernel jobs maintain an in-kernel
  `_PRIME_AGENT_SKILL_IMPORT_ERRORS` dict verbatim, and the host-side
  `PrimeSkillRegistry.recordImportError` ledger is its durable analogue:
  import-time failures record per-import-name reasons, and every later
  surface (list/read/call) names the skill unavailable with a remedy —
  upstream's `_PrimeAgentUnavailableSkill` behavior moved from kernel
  wrapper to registry fact.
- **First-wins collisions + shared-import warnings.** Name collisions
  keep the first skill and emit a collision diagnostic naming winner and
  loser; two names sharing a python import both register with the
  upstream warning text.
- **Harness skill entries register directly.** kind:"skill" entries
  become registry skills (reference-bearing ⇒ python with a
  `harness-entry` code origin; reference-less ⇒ markdown with the
  description derived from `metadata.description`, then the first
  content line, then the title).

## Adjusted for the browser

- **Registration replaces discovery.** There is no ambient filesystem to
  walk, so upstream's load order (user dir, project dir, explicit paths,
  bundled packs) becomes registration order; hosts wanting upstream
  precedence register in that order. Upstream's pyproject sniffing
  (`pyproject.toml` + `src/<import>/__init__.py`) becomes an explicit
  `python: { importName?, codeOrigin, reference? }` declaration — kind
  detection by filesystem probe would promise a walk no port host
  performs.
- **Module materialization travels kernel jobs, not venv installs.**
  Python skills are NOT installed at bootstrap. At call time the declared
  code origin (bounded workspace read / harness entry code / host pack)
  is resolved and canonicalized host-side, written byte-exact (base64,
  whose inflation is a constant 4/3, into `/prime-skills/` inside the
  kernel FS) by a materialize job, then imported by the invoke job.
  Confinement is decided entirely host-side; the job only `join()`s.
- **No `loadPackagesFromImports`, ever.** Skills run standard-library
  only unless a host pack ships their dependencies pre-approved. Ambient
  package pulls from inside the sandbox are upstream's
  pip-install-at-bootstrap wearing a costume; the host pack function is
  the dependency-approval seam (`PrimeSkillToolPorts.packs`), and
  `moduleResolver` replaces origin resolution wholesale when the host
  wants provenance policy beyond the three declared origins.
- **Frontmatter parsing is a bounded subset, not full YAML.** Upstream
  parses with the `yaml` package and tolerates everything YAML 1.2
  accepts. The port accepts the shape skills actually ship (plain /
  single-quoted / double-quoted scalars with `''`/`\xHH`/`\uXXXX`/
  `\UXXXXXXXX` escapes, `|`/`>` block scalars with `-`/`+` chomping,
  inline and dash lists, one nesting level for `env`, plain-scalar
  line folding) and refuses the rest with one of 37 named issues at
  line+column granularity instead of throwing or coercing. `allowed-tools`
  /`allowed_tools`/`allowedTools` (and the same family for `load-context`,
  `disable-model-invocation`) normalize onto the camelCase field; unknown
  keys are named `unsupported_key` warnings rather than smuggled through
  an open index signature. Two upstream tolerances are deliberately
  stricter because the registry is the model-facing authority:
  description over 1024 chars is fatal (prompt bloat), and malformed
  names are fatal where upstream kept the skill with warnings.
- **Engine honesty instead of a boot-time promise.** The only kernel
  engine today is `javascript` (PrimeKernelHost reports it; there is no
  python FS or import system behind it), so `call` gates on
  `kernel.description().engine === "pyodide"` and refuses with a named
  `python_engine_unavailable` result — naming the active engine and the
  remedy — before any job is posted. When a pyodide engine lands and the
  host reports it from the ready handshake, the gate opens with zero
  further changes here. The invoke job assumes top-level `await` and a
  writable FS plus `sys.path` semantics (pyodide's `runPythonAsync`
  world); that assumption is unreachable until the engine exists.
- **`call_pattern` is executable only with placeholders.** Upstream
  treats it as documentation of the RLM-native call form. The port
  executes patterns carrying `{import}` (the imported module object),
  `{callable}` (the module-wrap target), and `{args}` (the kwargs dict)
  — `await {callable}(**{args})` invokes exactly like the callable
  branch — and names documentation-form patterns
  `call_pattern_without_placeholders` with a remedy instead of guessing.
- **Settings interplay (§3.18).** Upstream's `skills` settings entries
  and `--skill` paths have no settings shape in the port yet: they arrive
  as host registrations in precedence order. When an airship settings
  surface lands, it should map each configured path to one workspace
  registration (and each configured pack to a `pack` entry), preserving
  user → project → path → pack order.

## Deferred

- **skill-creator tool.** Upstream's bundled skill-creator skill (plus
  its npm-install of skill packs) is not ported; creating skills in the
  port is writing SKILL.md to the workspace or a harness skill entry.
- **npm-install of skill packs** (upstream `package-manager.ts`,
  EXCLUDE per manifest §3.19): replaced entirely by the host pack seam.
- **Skill-in-child inheritance scoping.** Upstream flows skills to
  subagents through shared kernel process state; the port's subagent
  spawn is a separate runtime, so "children inherit the parent's
  harness-configured skill blocks" stays a deferred seam: the spawn path
  (`subagents/registry.ts` factory options) is where a child session
  would receive the parent's registered skills, and nothing claims it
  today.
- **Slash-command expansion** (`/skill:name`) and
  `disable-model-invocation` command surfaces — prompt flow, not the
  registry's job.
- **`.gitignore`-aware discovery** — there is no filesystem discovery.

## Host policy seams (summary)

- `PrimeSkillToolPorts.kernel` — the `PrimeSkillKernelPort` the call
  action executes through (PrimeKernelHost satisfies it directly).
- `PrimeSkillToolPorts.packs` — dependency-approved host packs; the only
  channel for non-stdlib code.
- `PrimeSkillToolPorts.moduleResolver` — wholesale origin-resolution
  override for provenance/dependency policy.
- Registration order — the only precedence axis (user → project → path
  → pack).
- `renderPrimeSkillsPrompt` — the system-prompt composition seam; wired
  by the prompt builder, not here.
- Effect class `execute` — normal tool approval, nothing ambient.
