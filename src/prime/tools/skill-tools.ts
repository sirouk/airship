/**
 * prime_skills: the model-facing Tool surface over the prime skill
 * registry (registry: ./skills.ts, parsing: ./skill-file-parser.ts).
 *
 * Three actions, one tool — same shape the other prime action tools
 * (prime_harness) use, with the honesty rules the port-manifest
 * requires:
 *
 *   - list is a bounded registry overview. It reports recorded
 *     import failures per skill (the _PRIME_AGENT_SKILL_IMPORT_ERRORS
 *     analogue) and the python engine posture, because a list that
 *     hides a broken import is how the model ends up calling into it.
 *   - read returns one skill's instructions, head-bounded, with the
 *     truncation notice LEADING (airship's context guard cuts result
 *     tails; a trailing notice is the first thing deleted exactly when
 *     it matters).
 *   - call executes one python skill inside the persistent kernel:
 *     the module materializes from its declared code origin (bounded
 *     workspace read / harness entry / host pack — nothing else),
 *     then one invoke job imports it and forwards the call with the
 *     harness {import, callable | call_pattern} contract (upstream's
 *     module-wrap semantics: a module with a callable `run` is
 *     invoked through it; a bare module ends in the same
 *     not-callable TypeError upstream produces).
 *
 * Kernel-engine honesty: the only engine PrimeKernelHost reports
 * today is "javascript" — a JS worker with no python FS, no
 * importlib, no pyodide. A python skill call under any non-pyodide
 * engine therefore refuses BEFORE any job is posted, with a named
 * python_engine_unavailable result whose remedy says what activates
 * the capability. Optional labels never become phantom executable
 * capabilities; a refusal the model can read is the honest failure.
 *
 * Approvals: the tool's effect is "execute" (it runs code), so every
 * call rides the normal tool-approval path — nothing ambient, no
 * separate skill privilege. Kernel jobs started here go through the
 * same bridge review as execute_code jobs because they ARE kernel
 * jobs (src/prime/kernel/*).
 *
 * Dependency policy: python skills run standard-library-only unless a
 * host pack ships their dependencies pre-approved. Kernel jobs NEVER
 * call pyodide.loadPackagesFromImports: ambient package resolution
 * from inside a sandbox is upstream's pip-install-at-bootstrap wearing
 * a costume, and it is removed on purpose (PORT.md).
 */

import type { JsonValue, Tool, ToolContext, ToolExecutionResult } from "../../core/contracts";
import { objectArguments, requiredString } from "../../tools/schema";
import {
  isWorkspaceControlPlanePath,
  normalizeWorkspacePath,
  type WorkspacePort,
} from "../../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../../workspace/content-codec";
import type { HarnessStore } from "../harness/store";
import type { HarnessSkillReference } from "../harness/types";
import type { KernelEngine, KernelJobEvent, KernelJobResult, KernelJobSpec } from "../kernel/kernel-contract";
import {
  canonicalPythonCallableName,
  deriveModuleFilePath,
  PRIME_SKILL_UNAVAILABLE_REMEDY,
  type PrimeSkill,
  type PrimeSkillCodeOrigin,
  type PrimeSkillRegistry,
} from "./skills";

// ---------------------------------------------------------------------------
// Bounds (every one named at the point it fires)
// ---------------------------------------------------------------------------

/** Skills shown per list action; the registry itself is in-memory and tiny, this is presentation spend. */
const MAX_LIST_SKILLS = 128;
/** Per-skill description slice inside list output. */
const MAX_LIST_DESCRIPTION_CHARS = 256;
/** read action body slice; the registry's 1 MiB output ceiling is never in reach. */
const MAX_READ_BODY_CHARS = 64 * 1_024;
/**
 * Total module-source bytes a call materializes. base64 inside the
 * materialize job inflates by exactly 4/3 (the deterministic encoding —
 * JSON string escaping has input-dependent worst cases, base64 does
 * not), so 96 KiB of module source stays under the kernel's 256 KiB
 * job-source budget with all boilerplate counted.
 */
const MAX_MODULE_SOURCE_BYTES = 96 * 1_024;
/** Single read size for workspace module files; readBounded(max+1) doubles as the oversize witness. */
const MAX_MODULE_FILES = 64;
const MAX_MODULE_FILE_PATH_CHARS = 256;
/** Serialized call-argument ceiling; the invoke job embeds the JSON verbatim. */
const MAX_CALL_ARGUMENTS_BYTES = 64 * 1_024;
/** Presentation slices of the durable result; names kept/total when cut. */
const MAX_PRESENT_STDOUT_CHARS = 64 * 1_024;
const MAX_PRESENT_STDERR_CHARS = 64 * 1_024;
const MAX_PRESENT_VALUE_CHARS = 48 * 1_024;
/** Live per-frame slice, the same slice execute_code forwards. */
const LIVE_CHUNK_CHARS = 4_097;
/** Per-job budget defaults and ceiling: kernel's maxJobWallMs (5 minutes) is the hard ceiling. */
const DEFAULT_SKILL_JOB_TIMEOUT_MS = 60 * 1_000;
const MIN_SKILL_JOB_TIMEOUT_MS = 100;
const MAX_SKILL_JOB_TIMEOUT_MS = 5 * 60 * 1_000;
/** Watchdog windows, mirroring kernel-tool.ts: cancel at budget+grace, settle, then report a named timeout. */
const WATCHDOG_GRACE_MS = 5_000;
const WATCHDOG_SETTLE_MS = 2_000;
/** Recorded import-error reasons persist bounded; a crash traceback paste is not a health record. */
const MAX_IMPORT_ERROR_CHARS = 1_024;

/**
 * The kernel-side directory skill modules materialize under, added to
 * sys.path for the invoke job. One root per kernel; modules are
 * name-spaced by their import path beneath it.
 */
export const PRIME_SKILL_KERNEL_ROOT = "/prime-skills";

/** Single-line result envelope sentinels; JSON.stringify emits no raw newlines, so the envelope survives stream framing intact. */
export const PRIME_SKILL_RESULT_BEGIN = "__PRIME_SKILL_RESULT_BEGIN__";
export const PRIME_SKILL_RESULT_END = "__PRIME_SKILL_RESULT_END__";

/** Every named failure this tool can return, frozen so tests branch on identity and a new code fails to compile unlisted. */
export const PRIME_SKILL_TOOL_ERROR_CODES = Object.freeze([
  "skill_not_found",
  "skill_not_callable",
  "python_skill_unavailable",
  "kernel_not_attached",
  "kernel_not_ready",
  "python_engine_unavailable",
  "module_source_missing",
  "module_source_not_text",
  "module_source_too_large",
  "module_file_path_invalid",
  "control_plane_refusal",
  "harness_entry_missing",
  "harness_entry_kind_mismatch",
  "harness_store_not_attached",
  "pack_not_found",
  "arguments_invalid",
  "arguments_too_large",
  "callable_name_invalid",
  "call_pattern_without_placeholders",
  "skill_materialize_failed",
  "skill_call_failed",
  "skill_import_failed",
  "skill_invoke_failed",
  "result_envelope_missing",
  "skill_job_watchdog_timeout",
] as const);

export type PrimeSkillToolErrorCode = (typeof PRIME_SKILL_TOOL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The minimal kernel surface a skill call needs. PrimeKernelHost
 * satisfies it directly (its description() reports engine "javascript",
 * so a plain host always trips the python_engine_unavailable gate —
 * the honest state of the port until a pyodide engine lands).
 */
export type PrimeSkillKernelPort = Readonly<{
  description(): Readonly<{ state: string; engine: KernelEngine }>;
  exec(spec: KernelJobSpec, listener?: (event: KernelJobEvent) => void): Promise<KernelJobResult>;
}>;

export type PrimeSkillModuleFile = Readonly<{ path: string; content: string }>;

export type PrimeSkillModuleSource = Readonly<{
  importName: string;
  files: readonly PrimeSkillModuleFile[];
}>;

/** Host-supplied, dependency-approved module packs; the only channel allowed to ship non-stdlib code. */
export type PrimeSkillPackFunction = (
  name: string,
) => PrimeSkillModuleSource | undefined | Promise<PrimeSkillModuleSource | undefined>;

export type PrimeSkillModuleErrorCode =
  | "module_source_missing"
  | "module_source_not_text"
  | "module_source_too_large"
  | "module_file_path_invalid"
  | "control_plane_refusal"
  | "harness_entry_missing"
  | "harness_entry_kind_mismatch"
  | "harness_store_not_attached"
  | "pack_not_found";

export type PrimeSkillModuleResolution =
  | Readonly<{ ok: true; source: PrimeSkillModuleSource }>
  | Readonly<{ ok: false; code: PrimeSkillModuleErrorCode; message: string }>;

export type PrimeSkillModuleResolverDeps = Readonly<{
  workspace?: WorkspacePort;
  harnessStore?: HarnessStore;
  packs?: PrimeSkillPackFunction;
}>;

/**
 * The host policy seam for module resolution. When provided, it replaces
 * the default origin resolution entirely — dependency approval, origin
 * allow-lists, and provenance checks belong here, and its named errors
 * pass through to the model unchanged.
 */
export type PrimeSkillModuleResolver = (
  skill: PrimeSkill,
  deps: PrimeSkillModuleResolverDeps,
) => Promise<PrimeSkillModuleResolution>;

export type PrimeSkillToolPorts = Readonly<{
  kernel?: PrimeSkillKernelPort;
  workspace?: WorkspacePort;
  harnessStore?: HarnessStore;
  packs?: PrimeSkillPackFunction;
  moduleResolver?: PrimeSkillModuleResolver;
}>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const byteEncoder = new TextEncoder();

function byteLength(text: string): number {
  return byteEncoder.encode(text).byteLength;
}

/** UTF-8 -> base64 with a fixed 4/3 inflation; embedded into the materialize job so module bytes arrive exact. */
function encodeBase64Utf8(text: string): string {
  const bytes = byteEncoder.encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function sliceHead(text: string, maxChars: number): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function sliceTail(text: string, maxChars: number): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function namedError(
  code: PrimeSkillToolErrorCode,
  message: string,
  extra: Readonly<Record<string, JsonValue>> = {},
): ToolExecutionResult {
  return { content: message, isError: true, metadata: Object.freeze({ error: Object.freeze({ code, ...extra }) }) };
}

function originLabel(origin: PrimeSkillCodeOrigin): string {
  switch (origin.type) {
    case "workspace-file":
      return `workspace file ${origin.path}`;
    case "harness-entry":
      return `harness entry ${origin.scope}/${origin.id}`;
    case "pack":
      return `host pack "${origin.pack}"`;
  }
}

// ---------------------------------------------------------------------------
// Module source canonicalization + default origin resolution
// ---------------------------------------------------------------------------

/**
 * Fail-closed shape check for module materialization: nothing reaches a
 * kernel job that cannot prove its paths are relative, plain, and inside
 * the byte bound. The materialize job itself performs no path math
 * beyond join(), so confinement is decided entirely here, host-side.
 */
export function canonicalPrimeSkillModuleSource(value: PrimeSkillModuleSource): PrimeSkillModuleResolution {
  const importName = value.importName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(importName)) {
    return { ok: false, code: "module_file_path_invalid", message: `module source names import "${importName}", which is not a dotted python identifier path.` };
  }
  if (value.files.length === 0) {
    return { ok: false, code: "module_source_missing", message: `module source for "${importName}" carries no files; nothing can be materialized.` };
  }
  if (value.files.length > MAX_MODULE_FILES) {
    return { ok: false, code: "module_source_too_large", message: `module source for "${importName}" carries ${String(value.files.length)} files, over the ${String(MAX_MODULE_FILES)}-file materialization bound.` };
  }
  let totalBytes = 0;
  const files: PrimeSkillModuleFile[] = [];
  for (const file of value.files) {
    const path = file.path;
    const pathOk =
      path.length > 0 &&
      path.length <= MAX_MODULE_FILE_PATH_CHARS &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(path) &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
    if (!pathOk) {
      return { ok: false, code: "module_file_path_invalid", message: `module file path ${JSON.stringify(path.slice(0, 80))} is not a confined relative posix path (no leading /, no . or .. segments, no control characters).` };
    }
    if (typeof file.content !== "string") {
      return { ok: false, code: "module_source_not_text", message: `module file "${path}" content is not a string.` };
    }
    totalBytes += byteLength(file.content);
    if (totalBytes > MAX_MODULE_SOURCE_BYTES) {
      return { ok: false, code: "module_source_too_large", message: `module source for "${importName}" crosses the ${String(MAX_MODULE_SOURCE_BYTES)}-byte materialization bound at file "${path}".` };
    }
    files.push(Object.freeze({ path, content: file.content }));
  }
  return { ok: true, source: Object.freeze({ importName, files: Object.freeze(files) }) };
}

/**
 * The default origin resolution: bounded, control-plane-refused
 * workspace reads; harness entry code; host packs. Hosts replace this
 * wholesale through ports.moduleResolver when they need dependency
 * approval or provenance policy beyond "one of three declared origins".
 */
export async function resolvePrimeSkillModuleSource(
  skill: PrimeSkill,
  deps: PrimeSkillModuleResolverDeps,
): Promise<PrimeSkillModuleResolution> {
  const python = skill.python;
  if (python === undefined) {
    return { ok: false, code: "module_source_missing", message: `skill "${skill.name}" is not a python skill and has no module source.` };
  }
  const origin = python.codeOrigin;
  switch (origin.type) {
    case "workspace-file": {
      if (deps.workspace === undefined) {
        return { ok: false, code: "module_source_missing", message: `skill "${skill.name}" reads its module from ${originLabel(origin)} but no workspace port is attached.` };
      }
      let path: string;
      try {
        path = normalizeWorkspacePath(origin.path);
      } catch (error) {
        return { ok: false, code: "module_file_path_invalid", message: `skill "${skill.name}" module path ${JSON.stringify(origin.path)} is invalid: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (isWorkspaceControlPlanePath(path)) {
        return { ok: false, code: "control_plane_refusal", message: `prime_skills excludes Airship control-plane paths: ${path}` };
      }
      const file = deps.workspace.readBounded
        ? await deps.workspace.readBounded(path, MAX_MODULE_SOURCE_BYTES + 1)
        : await deps.workspace.read(path);
      if (!file) {
        return { ok: false, code: "module_source_missing", message: `skill "${skill.name}" module file is not in the workspace: ${path}` };
      }
      if (isWorkspaceBinaryEnvelope(file.content)) {
        return { ok: false, code: "module_source_not_text", message: `skill "${skill.name}" module file ${path} is stored as binary; python modules must be UTF-8 text.` };
      }
      if (file.size > MAX_MODULE_SOURCE_BYTES) {
        return { ok: false, code: "module_source_too_large", message: `skill "${skill.name}" module file ${path} is ${String(file.size)} bytes, over the ${String(MAX_MODULE_SOURCE_BYTES)}-byte materialization bound.` };
      }
      return canonicalPrimeSkillModuleSource({
        importName: python.importName,
        files: [Object.freeze({ path: deriveModuleFilePath(python.importName), content: file.content })],
      });
    }
    case "harness-entry": {
      if (deps.harnessStore === undefined) {
        return { ok: false, code: "harness_store_not_attached", message: `skill "${skill.name}" resolves its module from ${originLabel(origin)} but no harness store is attached.` };
      }
      const entry = await deps.harnessStore.get(origin.scope, "skill", origin.id);
      if (!entry) {
        return { ok: false, code: "harness_entry_missing", message: `harness skill entry ${origin.scope}/${origin.id} no longer exists; re-register the skill or restore the entry.` };
      }
      if (entry.kind !== "skill") {
        return { ok: false, code: "harness_entry_kind_mismatch", message: `harness entry ${origin.scope}/${origin.id} is kind "${entry.kind}", not "skill".` };
      }
      const metaCode = entry.metadata?.code;
      const content = typeof metaCode === "string" ? metaCode : entry.content;
      if (content.trim() === "") {
        return { ok: false, code: "module_source_missing", message: `harness skill entry ${origin.scope}/${origin.id} persists no module code (content is empty; metadata.code may carry it instead).` };
      }
      return canonicalPrimeSkillModuleSource({
        importName: python.importName,
        files: [Object.freeze({ path: deriveModuleFilePath(python.importName), content })],
      });
    }
    case "pack": {
      if (deps.packs === undefined) {
        return { ok: false, code: "pack_not_found", message: `skill "${skill.name}" resolves its module from ${originLabel(origin)} but the host attached no pack provider.` };
      }
      const source = await deps.packs(origin.pack);
      if (source === undefined) {
        return { ok: false, code: "pack_not_found", message: `host pack "${origin.pack}" is not available from the attached pack provider.` };
      }
      return canonicalPrimeSkillModuleSource(source);
    }
  }
}

// ---------------------------------------------------------------------------
// Kernel job code (pyodide-engine python)
// ---------------------------------------------------------------------------

/**
 * The materialize job: byte-exact module files under the skill root.
 * Contents travel base64 because the encoding's inflation is a constant
 * 4/3 whatever the module contains; the job performs no path arithmetic
 * beyond join() because confinement was already decided host-side.
 */
export function buildPrimeSkillMaterializeJobCode(source: PrimeSkillModuleSource, root: string = PRIME_SKILL_KERNEL_ROOT): string {
  const filesJson = JSON.stringify(source.files.map((file) => [file.path, encodeBase64Utf8(file.content)]));
  return [
    "import base64 as _prime_skill_b64",
    "import os as _prime_skill_os",
    "",
    `_prime_skill_root = ${JSON.stringify(root)}`,
    `_prime_skill_files = ${filesJson}`,
    "for _prime_skill_path, _prime_skill_data in _prime_skill_files:",
    '    _prime_skill_full = _prime_skill_os.path.join(_prime_skill_root, *_prime_skill_path.split("/"))',
    "    _prime_skill_dir = _prime_skill_os.path.dirname(_prime_skill_full)",
    "    if _prime_skill_dir:",
    "        _prime_skill_os.makedirs(_prime_skill_dir, exist_ok=True)",
    '    with open(_prime_skill_full, "wb") as _prime_skill_handle:',
    "        _prime_skill_handle.write(_prime_skill_b64.b64decode(_prime_skill_data))",
    `print("materialized ${String(source.files.length)} skill module file(s) under " + _prime_skill_root)`,
  ].join("\n");
}

export type PrimeSkillInvocationPlan =
  | Readonly<{ kind: "callable"; callable?: string }>
  | Readonly<{ kind: "pattern"; pattern: string }>;

export type PrimeSkillInvocationPlanResult =
  | Readonly<{ ok: true; plan: PrimeSkillInvocationPlan }>
  | Readonly<{ ok: false; code: "callable_name_invalid" | "call_pattern_without_placeholders"; message: string }>;

/**
 * Reference -> invocation plan, honoring upstream's module-wrap
 * semantics: `callable` resolves a dotted attribute off the imported
 * module; a reference with neither names the upstream wrap (a module
 * with callable `run` is called through it, a bare module fails
 * not-callable exactly as an unwrapped ModuleType does); `call_pattern`
 * is the harness's RLM-native call form, invocable here only when it
 * carries the {import}/{callable}/{args} placeholders — a documentation-
 * form pattern ("await fn(...)") describes the call to the model and is
 * NOT mechanically executed, which this names instead of guessing.
 */
export function planPrimeSkillInvocation(reference: HarnessSkillReference): PrimeSkillInvocationPlanResult {
  if (reference.callable !== undefined) {
    if (canonicalPythonCallableName(reference.callable) === undefined) {
      return { ok: false, code: "callable_name_invalid", message: `callable ${JSON.stringify(reference.callable)} is not a dotted python identifier path.` };
    }
    return { ok: true, plan: Object.freeze({ kind: "callable" as const, callable: reference.callable }) };
  }
  if (reference.callPattern !== undefined) {
    const pattern = reference.callPattern;
    if (!pattern.includes("{import}") && !pattern.includes("{callable}") && !pattern.includes("{args}")) {
      return {
        ok: false,
        code: "call_pattern_without_placeholders",
        message:
          `call_pattern ${JSON.stringify(pattern.slice(0, 80))} carries no {import}/{callable}/{args} placeholder: documentation-form patterns describe the RLM-native call form to the model but are not mechanically invocable. ` +
          "Remedy: add a callable to the reference, or write the pattern with placeholders (e.g. {callable}(**{args})).",
      };
    }
    return { ok: true, plan: Object.freeze({ kind: "pattern" as const, pattern }) };
  }
  return { ok: true, plan: Object.freeze({ kind: "callable" as const }) };
}

/**
 * The invoke job: import after the skill root joins sys.path, forward
 * the call, emit the single-line result envelope. Import failures feed
 * the in-kernel _PRIME_AGENT_SKILL_IMPORT_ERRORS dict — the verbatim
 * upstream registry — and the envelope carries the reason host-side so
 * the registry's own ledger records it per name.
 */
export function buildPrimeSkillInvokeJobCode(
  invocation: Readonly<{
    importName: string;
    plan: PrimeSkillInvocationPlan;
    argumentsJson: string;
    root?: string;
  }>,
): string {
  const root = invocation.root ?? PRIME_SKILL_KERNEL_ROOT;
  const targetLines: string[] = [];
  if (invocation.plan.kind === "pattern") {
    // Placeholders substitute EXPRESSIONS: {import} is the imported module
    // object, {callable} is the module-wrap target (module.run when callable,
    // else the module itself, the upstream wrap rule), {args} is the kwargs
    // dict. "await {callable}(**{args})" therefore invokes exactly like the
    // callable branch, which is what the harness call_pattern documents.
    const pattern = invocation.plan.pattern
      .split("{import}").join("_prime_skill_module")
      .split("{callable}").join('(getattr(_prime_skill_module, "run", None) or _prime_skill_module)')
      .split("{args}").join("_prime_skill_args");
    targetLines.push(`        _prime_skill_result = ${pattern}`);
  } else if (invocation.plan.callable !== undefined) {
    const parts = JSON.stringify(invocation.plan.callable.split("."));
    targetLines.push("        _prime_skill_target = _prime_skill_module");
    targetLines.push(`        for _prime_skill_attr in ${parts}:`);
    targetLines.push("            _prime_skill_target = getattr(_prime_skill_target, _prime_skill_attr)");
    targetLines.push("        _prime_skill_result = _prime_skill_target(**_prime_skill_args)");
  } else {
    // Upstream _PrimeAgentCallableSkillModule parity: wrap forwards module(...) -> module.run(...).
    targetLines.push('        _prime_skill_target = getattr(_prime_skill_module, "run", None) or _prime_skill_module');
    targetLines.push("        _prime_skill_result = _prime_skill_target(**_prime_skill_args)");
  }
  return [
    "import importlib as _prime_skill_importlib",
    "import inspect as _prime_skill_inspect",
    "import json as _prime_skill_json",
    "import sys as _prime_skill_sys",
    "",
    "_PRIME_AGENT_SKILL_IMPORT_ERRORS = globals().get(\"_PRIME_AGENT_SKILL_IMPORT_ERRORS\")",
    "if _PRIME_AGENT_SKILL_IMPORT_ERRORS is None:",
    "    _PRIME_AGENT_SKILL_IMPORT_ERRORS = {}",
    '    globals()["_PRIME_AGENT_SKILL_IMPORT_ERRORS"] = _PRIME_AGENT_SKILL_IMPORT_ERRORS',
    "",
    `_prime_skill_root = ${JSON.stringify(root)}`,
    `_prime_skill_name = ${JSON.stringify(invocation.importName)}`,
    `_prime_skill_args = _prime_skill_json.loads(${JSON.stringify(invocation.argumentsJson)})`,
    "",
    "def _prime_skill_emit(payload):",
    `    print(${JSON.stringify(PRIME_SKILL_RESULT_BEGIN)} + _prime_skill_json.dumps(payload) + ${JSON.stringify(PRIME_SKILL_RESULT_END)})`,
    "",
    "if _prime_skill_root not in _prime_skill_sys.path:",
    "    _prime_skill_sys.path.insert(0, _prime_skill_root)",
    "",
    "try:",
    "    _prime_skill_module = _prime_skill_importlib.import_module(_prime_skill_name)",
    "except Exception as _prime_skill_error:",
    "    _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_skill_name] = str(_prime_skill_error)",
    '    _prime_skill_emit({"ok": False, "stage": "import", "importName": _prime_skill_name, "error": str(_prime_skill_error)})',
    "else:",
    "    try:",
    ...targetLines,
    "        if _prime_skill_inspect.isawaitable(_prime_skill_result):",
    "            _prime_skill_result = await _prime_skill_result",
    "        try:",
    "            _prime_skill_json.dumps(_prime_skill_result)",
    "            _prime_skill_value = _prime_skill_result",
    "            _prime_skill_unserializable = False",
    "        except Exception:",
    "            _prime_skill_value = None",
    "            _prime_skill_unserializable = True",
    '        _prime_skill_emit({"ok": True, "value": _prime_skill_value, "repr": repr(_prime_skill_result)[:2048], "unserializable": _prime_skill_unserializable})',
    "    except Exception as _prime_skill_error:",
    '        _prime_skill_emit({"ok": False, "stage": "invoke", "error": str(_prime_skill_error), "ename": type(_prime_skill_error).__name__})',
  ].join("\n");
}

export type PrimeSkillCallEnvelope =
  | Readonly<{ ok: true; value: JsonValue; repr?: string; unserializable?: boolean }>
  | Readonly<{ ok: false; stage: "import" | "invoke"; error: string; ename?: string; importName?: string }>;

/** Last envelope in a stdout stream wins; earlier materialize echoes or prints are ignored. */
export function extractPrimeSkillResultEnvelope(stdout: string): PrimeSkillCallEnvelope | undefined {
  const begin = stdout.lastIndexOf(PRIME_SKILL_RESULT_BEGIN);
  if (begin < 0) return undefined;
  const end = stdout.indexOf(PRIME_SKILL_RESULT_END, begin + PRIME_SKILL_RESULT_BEGIN.length);
  if (end < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(begin + PRIME_SKILL_RESULT_BEGIN.length, end));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.ok === true) {
      return Object.freeze({ ok: true as const, value: record.value as JsonValue, ...(typeof record.repr === "string" ? { repr: record.repr } : {}), ...(record.unserializable === true ? { unserializable: true as const } : {}) });
    }
    if (record.ok === false && (record.stage === "import" || record.stage === "invoke") && typeof record.error === "string") {
      return Object.freeze({ ok: false as const, stage: record.stage, error: record.error, ...(typeof record.ename === "string" ? { ename: record.ename } : {}), ...(typeof record.importName === "string" ? { importName: record.importName } : {}) });
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

type SkillJobWait = Readonly<{ job: KernelJobResult }> | Readonly<{ watchdog: true }>;

/**
 * One kernel job with kernel-tool.ts's wait discipline: abort cancels
 * the job (a job still queued behind another never runs), and the
 * watchdog stops waiting at budget+grace with a settle window rather
 * than hanging the turn on a wedged worker. Copied deliberately — the
 * kernel tool does not export its helper, and the job-label/job-id
 * semantics differ.
 */
async function runSkillJob(
  kernel: PrimeSkillKernelPort,
  spec: KernelJobSpec,
  context: ToolContext,
): Promise<SkillJobWait> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_SKILL_JOB_TIMEOUT_MS;
  const jobPromise = kernel.exec(spec, (event) => {
    if (event.type === "stdout") emitSkillOutput(context, { stream: "stdout", text: event.text.slice(0, LIVE_CHUNK_CHARS) });
    if (event.type === "stderr") emitSkillOutput(context, { stream: "stderr", text: event.text.slice(0, LIVE_CHUNK_CHARS) });
  });
  const jobId = spec.jobId ?? "";
  const onAbort = (): void => {
    kernelCancel(kernel, jobId, "prime_skills call was aborted by the turn.");
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<SkillJobWait>((resolve) => {
    watchdogTimer = setTimeout(() => {
      kernelCancel(kernel, jobId, `prime_skills watchdog fired after ${String(timeoutMs + WATCHDOG_GRACE_MS)} ms; the kernel job was cancelled.`);
      settleTimer = setTimeout(() => resolve(Object.freeze({ watchdog: true as const })), WATCHDOG_SETTLE_MS);
    }, timeoutMs + WATCHDOG_GRACE_MS);
  });
  const finished = jobPromise.then((job) => Object.freeze({ job }) as SkillJobWait);
  const race = await Promise.race([finished, watchdog]);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  if (settleTimer) clearTimeout(settleTimer);
  context.signal.removeEventListener("abort", onAbort);
  return race;
}

/** cancel is host-optional on the structural port; the real kernel always has it. */
function kernelCancel(kernel: PrimeSkillKernelPort, jobId: string, reason: string): void {
  const cancellable = kernel as PrimeSkillKernelPort & { cancel?: (jobId: string, reason?: string) => boolean };
  cancellable.cancel?.(jobId, reason);
}

function emitSkillOutput(context: ToolContext, chunk: { stream: "stdout" | "stderr"; text: string }): void {
  try {
    context.onOutput?.(chunk);
  } catch {
    // Output projection is presentation; a misbehaving view must not poison the call (execute_code parity).
  }
}

/** The durable body sections for one job, mirroring kernel-tool's renderJobContent: stdout head, stderr tail, named kept/total. */
function renderSkillJobSections(result: KernelJobResult): Readonly<{ sections: string[]; truncation: Record<string, JsonValue> }> {
  const sections: string[] = [];
  const stdout = sliceHead(result.stdout, MAX_PRESENT_STDOUT_CHARS);
  const stderr = sliceTail(result.stderr, MAX_PRESENT_STDERR_CHARS);
  if (result.stdout.length > 0) {
    const marker = stdout.truncated
      ? `[… stdout truncated: kept first ${String(MAX_PRESENT_STDOUT_CHARS)} of ${String(result.stdout.length)} chars …]\n`
      : "";
    sections.push(`[stdout]\n${marker}${stdout.text}`);
  }
  if (result.stderr.length > 0) {
    const marker = stderr.truncated
      ? `\n[… stderr truncated: kept last ${String(MAX_PRESENT_STDERR_CHARS)} of ${String(result.stderr.length)} chars …]`
      : "";
    sections.push(`[stderr]\n${stderr.text}${marker}`);
  }
  return Object.freeze({
    sections,
    truncation: Object.freeze({
      stdout: stdout.truncated ? Object.freeze({ kept: MAX_PRESENT_STDOUT_CHARS, total: result.stdout.length, keptFrom: "head" }) : false,
      stderr: stderr.truncated ? Object.freeze({ kept: MAX_PRESENT_STDERR_CHARS, total: result.stderr.length, keptFrom: "tail" }) : false,
    }),
  });
}

function parseSkillJobTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_SKILL_JOB_TIMEOUT_MS;
  if (!Number.isInteger(value)) throw new Error("timeoutMs must be an integer.");
  const timeout = value as number;
  if (timeout < MIN_SKILL_JOB_TIMEOUT_MS || timeout > MAX_SKILL_JOB_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between ${String(MIN_SKILL_JOB_TIMEOUT_MS)} and ${String(MAX_SKILL_JOB_TIMEOUT_MS)} ms.`);
  }
  return timeout;
}

function parseCallArguments(value: JsonValue | undefined): Readonly<{ ok: true; argumentsJson: string } | { ok: false; result: ToolExecutionResult }> {
  if (value === undefined) return { ok: true, argumentsJson: "{}" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, result: namedError("arguments_invalid", "prime_skills call arguments must be an object whose keys are python parameter names.") };
  }
  let argumentsJson: string;
  try {
    argumentsJson = JSON.stringify(value) ?? "{}";
  } catch {
    return { ok: false, result: namedError("arguments_invalid", "prime_skills call arguments must be JSON-serializable.") };
  }
  if (byteLength(argumentsJson) > MAX_CALL_ARGUMENTS_BYTES) {
    return { ok: false, result: namedError("arguments_too_large", `prime_skills call arguments serialize to ${String(byteLength(argumentsJson))} bytes, over the ${String(MAX_CALL_ARGUMENTS_BYTES)}-byte bound; pass large inputs through workspace files instead.`) };
  }
  for (const key of Object.keys(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, result: namedError("arguments_invalid", `prime_skills call argument ${JSON.stringify(key)} is not a python identifier; keyword arguments must be valid parameter names.`) };
    }
  }
  return { ok: true, argumentsJson };
}

export function createPrimeSkillsTool(registry: PrimeSkillRegistry, ports: PrimeSkillToolPorts): Tool {

  async function callAction(name: string, args: Record<string, JsonValue>, context: ToolContext): Promise<ToolExecutionResult> {
    const skill = registry.get(name);
    if (skill === undefined) {
      return namedError("skill_not_found", skillNotFoundMessage(registry, name));
    }
    if (skill.python === undefined) {
      return namedError(
        "skill_not_callable",
        `Skill "${name}" is a markdown skill: prompt-only instructions, not a callable. Read it with prime_skills {"action":"read","name":"${name}"} and follow the instructions.`,
        { skill: name, kind: "markdown" },
      );
    }
    const python = skill.python;
    const recorded = registry.importErrorForImport(python.importName);
    if (recorded !== undefined) {
      return namedError(
        "python_skill_unavailable",
        `Python skill "${name}" is unavailable in the prime kernel. Import error recorded for "${python.importName}": ${recorded.reason} Remedy: ${recorded.remedy}`,
        { skill: name, importName: python.importName, recordedReason: sliceHead(recorded.reason, MAX_IMPORT_ERROR_CHARS).text },
      );
    }
    if (ports.kernel === undefined) {
      return namedError(
        "kernel_not_attached",
        `This session has no prime kernel attached, so python skill "${name}" cannot run. Remedy: the session authority attaches a kernel (execute_code availability is the signal).`,
        { skill: name },
      );
    }
    const kernel = ports.kernel;
    const description = kernel.description();
    if (description.state === "failed" || description.state === "stopped") {
      return namedError(
        "kernel_not_ready",
        `The prime kernel is ${description.state}, so python skill "${name}" cannot run. Remedy: restart the kernel and retry; the skill module re-materializes on the next call.`,
        { skill: name, kernelState: description.state },
      );
    }
    if (description.engine !== "pyodide") {
      return namedError(
        "python_engine_unavailable",
        `Python skills require the pyodide kernel engine; the attached prime kernel runs the "${description.engine}" engine, which has no python filesystem or import system. ` +
          `Remedy: start the session kernel with the pyodide engine (the execute_code capability announces the active engine), then retry prime_skills {"action":"call","name":"${name}"}.`,
        { skill: name, engine: description.engine, capability: "python-skill-call", capabilityAvailable: false },
      );
    }

    const resolver = ports.moduleResolver ?? resolvePrimeSkillModuleSource;
    const resolution = await resolver(skill, ports);
    if (!resolution.ok) {
      return namedError(resolution.code, resolution.message, { skill: name, origin: python.codeOrigin.type });
    }

    const timeoutMs = parseSkillJobTimeout(args.timeoutMs);
    const callArguments = parseCallArguments(args.arguments);
    if (!callArguments.ok) return callArguments.result;

    const planResult = planPrimeSkillInvocation(python.reference);
    if (!planResult.ok) {
      return namedError(planResult.code, planResult.message, { skill: name });
    }

    const materializeJobId = `prime-skill-${context.operationId}-materialize`;
    const materialize = await runSkillJob(
      kernel,
      {
        jobId: materializeJobId,
        code: buildPrimeSkillMaterializeJobCode(resolution.source),
        timeoutMs,
        label: "skill",
      },
      context,
    );
    if ("watchdog" in materialize) {
      return namedError(
        "skill_job_watchdog_timeout",
        `prime_skills stopped waiting for the materialize job ${materializeJobId} after ${String(timeoutMs + WATCHDOG_GRACE_MS + WATCHDOG_SETTLE_MS)} ms and cancelled it; the kernel did not confirm the job's end inside the budget plus the watchdog windows.`,
        { skill: name, jobId: materializeJobId, stage: "materialize", watchdogTimeout: true },
      );
    }
    if (materialize.job.outcome !== "completed") {
      return namedError(
        "skill_materialize_failed",
        `Module materialization for skill "${name}" ended ${materialize.job.outcome}${materialize.job.error !== undefined ? `: ${sliceHead(materialize.job.error, MAX_PRESENT_VALUE_CHARS).text}` : ""}`,
        { skill: name, jobId: materialize.job.jobId, outcome: materialize.job.outcome },
      );
    }

    const invokeJobId = `prime-skill-${context.operationId}-invoke`;
    const invoke = await runSkillJob(
      kernel,
      {
        jobId: invokeJobId,
        code: buildPrimeSkillInvokeJobCode({ importName: python.importName, plan: planResult.plan, argumentsJson: callArguments.argumentsJson }),
        timeoutMs,
        label: "skill",
      },
      context,
    );
    if ("watchdog" in invoke) {
      return namedError(
        "skill_job_watchdog_timeout",
        `prime_skills stopped waiting for the invoke job ${invokeJobId} after ${String(timeoutMs + WATCHDOG_GRACE_MS + WATCHDOG_SETTLE_MS)} ms and cancelled it; the kernel did not confirm the job's end inside the budget plus the watchdog windows.`,
        { skill: name, jobId: invokeJobId, stage: "invoke", watchdogTimeout: true },
      );
    }
    if (invoke.job.outcome !== "completed") {
      return namedError(
        "skill_call_failed",
        `Skill "${name}" call ended ${invoke.job.outcome} before a result was produced${invoke.job.error !== undefined ? `: ${sliceHead(invoke.job.error, MAX_PRESENT_VALUE_CHARS).text}` : ""}`,
        { skill: name, jobId: invoke.job.jobId, outcome: invoke.job.outcome },
      );
    }

    const envelope = extractPrimeSkillResultEnvelope(invoke.job.stdout);
    if (envelope === undefined) {
      const rendered = renderSkillJobSections(invoke.job);
      return namedError(
        "result_envelope_missing",
        `Skill "${name}" finished without emitting the result envelope; the kernel engine honored the job but not the pyodide skill protocol. Bounded output follows.\n\n${rendered.sections.join("\n\n")}`,
        { skill: name, jobId: invoke.job.jobId, truncation: rendered.truncation as JsonValue },
      );
    }
    if (envelope.ok === false && envelope.stage === "import") {
      const reason = sliceHead(envelope.error, MAX_IMPORT_ERROR_CHARS).text;
      registry.recordImportError(python.importName, reason, { skillName: name });
      return namedError(
        "skill_import_failed",
        `Python skill "${name}" is unavailable in the prime kernel. Import error: ${reason}\nRemedy: ${PRIME_SKILL_UNAVAILABLE_REMEDY}`,
        { skill: name, importName: python.importName, recorded: true },
      );
    }
    if (envelope.ok === false) {
      const rendered = renderSkillJobSections(invoke.job);
      const ename = envelope.ename !== undefined ? `${envelope.ename}: ` : "";
      const sections = [`[error]\n${ename}${sliceHead(envelope.error, MAX_PRESENT_VALUE_CHARS).text}`, ...rendered.sections];
      return {
        content: `Skill "${name}" call raised inside its invoke job (${invoke.job.jobId}, ${String(invoke.job.wallMs)} ms).\n\n${sections.join("\n\n")}`,
        isError: true,
        metadata: {
          error: Object.freeze({ code: "skill_invoke_failed" as const, skill: name, ename: envelope.ename ?? null }),
          jobId: invoke.job.jobId,
          outcome: invoke.job.outcome,
          wallMs: invoke.job.wallMs,
          truncation: rendered.truncation as JsonValue,
        },
      };
    }

    const valueJson = JSON.stringify(envelope.value ?? null, null, 2) ?? "null";
    const value = sliceHead(valueJson, MAX_PRESENT_VALUE_CHARS);
    const valueMarker = value.truncated ? `\n[… result value truncated: kept first ${String(MAX_PRESENT_VALUE_CHARS)} of ${String(valueJson.length)} chars …]` : "";
    const rendered = renderSkillJobSections(invoke.job);
    const banner = `Skill "${name}" call completed in ${String(invoke.job.wallMs)} ms (${invoke.job.engine} kernel, ${String(invoke.job.bridgeCalls)} bridge call${invoke.job.bridgeCalls === 1 ? "" : "s"}).`;
    const sections = [...rendered.sections, `[result]\n${envelope.unserializable === true ? `# not JSON-serializable; repr follows\n${envelope.repr ?? "None"}` : `${value.text}${valueMarker}`}`];
    return {
      content: `${banner}\n\n${sections.join("\n\n")}`,
      metadata: {
        skill: name,
        importName: python.importName,
        engine: invoke.job.engine,
        outcome: invoke.job.outcome,
        materializeJobId: materialize.job.jobId,
        invokeJobId: invoke.job.jobId,
        bridgeCalls: invoke.job.bridgeCalls,
        wallMs: invoke.job.wallMs,
        valueChars: valueJson.length,
        truncation: Object.freeze({ ...rendered.truncation, value: value.truncated ? Object.freeze({ kept: MAX_PRESENT_VALUE_CHARS, total: valueJson.length, keptFrom: "head" }) : false }) as JsonValue,
      },
    };
  }

  function readAction(name: string): ToolExecutionResult {
    const skill = registry.get(name);
    if (skill === undefined) {
      return namedError("skill_not_found", skillNotFoundMessage(registry, name));
    }
    const body = sliceHead(skill.body, MAX_READ_BODY_CHARS);
    const notice = body.truncated
      ? `[… skill instructions truncated: kept first ${String(MAX_READ_BODY_CHARS)} of ${String(skill.body.length)} chars. Read narrower sections through read_file on the skill location when it is workspace-backed. …]\n\n`
      : "";
    const headerLines = [
      `# Skill: ${skill.name}`,
      `kind: ${skill.kind}${skill.python !== undefined ? ` (import ${skill.python.importName}, origin ${originLabel(skill.python.codeOrigin)}, reference ${JSON.stringify(skill.python.reference)})` : ""}`,
      `description: ${skill.description}`,
      `location: ${skill.location}`,
      `source: ${skill.source}`,
    ];
    if (skill.version !== undefined) headerLines.push(`version: ${skill.version}`);
    if (skill.author !== undefined) headerLines.push(`author: ${skill.author}`);
    if (skill.allowedTools.length > 0) headerLines.push(`allowed-tools: ${skill.allowedTools.join(", ")}`);
    if (skill.loadContext.length > 0) headerLines.push(`load-context: ${skill.loadContext.join(", ")}`);
    if (skill.disableModelInvocation) headerLines.push("disable-model-invocation: true (excluded from the skills prompt block)");
    const recorded = registry.importErrorForSkill(skill);
    if (recorded !== undefined) {
      headerLines.push(`unavailable: ${recorded.reason}`);
      headerLines.push(`remedy: ${recorded.remedy}`);
    }
    return {
      content: `${headerLines.join("\n")}\n\n${notice}${body.text}`,
      metadata: {
        skill: skill.name,
        kind: skill.kind,
        ...(skill.python !== undefined ? { importName: skill.python.importName } : {}),
        location: skill.location,
        bodyChars: skill.body.length,
        truncated: body.truncated,
        ...(recorded !== undefined ? { unavailable: recorded.reason } : {}),
      },
    };
  }

  function listAction(): ToolExecutionResult {
    const skills = registry.list();
    const engine = ports.kernel === undefined ? null : ports.kernel.description().engine;
    const pythonCount = skills.filter((skill) => skill.python !== undefined).length;
    const entries = skills.slice(0, MAX_LIST_SKILLS).map((skill) => {
      const description = sliceHead(skill.description, MAX_LIST_DESCRIPTION_CHARS);
      const suffix = description.truncated ? `… (description ${String(skill.description.length)} chars)` : "";
      const unavailable = registry.importErrorForSkill(skill);
      const unavailableText = unavailable !== undefined ? ` UNAVAILABLE: ${unavailable.reason} Remedy: ${unavailable.remedy}` : "";
      const disabled = skill.disableModelInvocation ? " [model-invocation disabled]" : "";
      const importText = skill.python !== undefined ? `, import ${skill.python.importName}` : "";
      return `- ${skill.name} (${skill.kind}${importText}, ${skill.source}) — ${description.text}${suffix}${disabled}${unavailableText}`;
    });
    const header = skills.length === 0
      ? "No skills are registered in this session (skills arrive through host registration or prime_harness skill entries)."
      : `${String(skills.length)} skill(s) registered (${String(pythonCount)} python, ${String(skills.length - pythonCount)} markdown).`;
    const engineNote = pythonCount === 0
      ? []
      : [`python engine: ${engine ?? "not attached"} — python skill calls ${engine === "pyodide" ? "available" : "unavailable until the pyodide kernel engine is active"}.`];
    const overflow = skills.length > MAX_LIST_SKILLS ? [`… and ${String(skills.length - MAX_LIST_SKILLS)} more skill(s) not listed (list cap ${String(MAX_LIST_SKILLS)}).`] : [];
    const content = [header, ...engineNote, ...entries, ...overflow].join("\n");
    return {
      content,
      metadata: {
        count: skills.length,
        shown: Math.min(skills.length, MAX_LIST_SKILLS),
        pythonEngine: engine,
        skills: skills.slice(0, MAX_LIST_SKILLS).map((skill) => Object.freeze({
          name: skill.name,
          kind: skill.kind,
          ...(skill.python !== undefined ? { importName: skill.python.importName } : {}),
          source: skill.source,
          ...(registry.importErrorForSkill(skill) !== undefined ? { unavailable: registry.importErrorForSkill(skill)?.reason ?? "" } : {}),
        })) as unknown as JsonValue,
      },
    };
  }

  return {
    definition: {
      name: "prime_skills",
      description:
        "Inspect and invoke the registered prime skills. " +
        "list shows the bounded registry overview: name, kind, python import, recorded unavailability, python engine posture. " +
        "read returns one skill's SKILL.md instructions, head-bounded; a markdown skill is prompt-only — read it and follow it, never call it. " +
        "call executes ONE python skill inside the persistent kernel with named arguments: its module materializes from the declared code origin (workspace file, harness entry, or host pack), then one invoke job imports and calls it with the reference contract, returning a bounded result. " +
        "Python calls need the pyodide kernel engine; any other engine refuses with python_engine_unavailable before any job runs.",
      effect: "execute",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read", "call"] },
          name: { type: "string", minLength: 1, maxLength: 64, description: "Skill name (required for read and call)." },
          arguments: { type: "object", additionalProperties: true, description: "Keyword arguments for a call action; keys must be python identifiers." },
          timeoutMs: { type: "integer", minimum: MIN_SKILL_JOB_TIMEOUT_MS, maximum: MAX_SKILL_JOB_TIMEOUT_MS, description: "Per-kernel-job budget for call actions." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue: JsonValue, context: ToolContext): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const action = requiredString(args.action, "action");
      if (action === "list") return listAction();
      const name = requiredString(args.name, "name");
      if (action === "read") return readAction(name);
      if (action === "call") return callAction(name, args, context);
      throw new Error(`prime_skills action must be one of "list", "read", "call"; got ${JSON.stringify(action)}.`);
    },
  };
}

function skillNotFoundMessage(registry: PrimeSkillRegistry, name: string): string {
  const names = registry.list().slice(0, 32).map((skill) => skill.name);
  const suffix = names.length > 0 ? ` Registered skills: ${names.join(", ")}${registry.list().length > names.length ? ", …" : ""}.` : " No skills are registered.";
  return `No skill named "${name}" is registered.${suffix}`;
}
