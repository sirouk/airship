/**
 * The prime-native `list_files` and `search_text` tools: bounded,
 * deterministic inventory and literal content search over WorkspacePort.
 *
 * Why a separate scan policy from airship's search_text: airship's shared
 * scanner (src/workspace/content-search.ts) owns an 8 MiB total budget and
 * a 200-result ceiling frozen for the Explorer and its own tool; the prime
 * surface is documented against a more conservative story (4 MiB per call,
 * 200 results by default) that ported prompts plan around. The piece that
 * must NOT be rewritten is the per-file matching and glob machinery — that
 * logic is already adversary-tested over there, so this module composes
 * `collectLiteralMatches` and `workspacePathGlobMatcher` and owns only the
 * budget policy and the envelope facts around them.
 *
 * Determinism + honesty rules:
 *   - results sort by path, then line, then column — no list-order luck;
 *   - `.airship`, `.git`, and `node_modules` never appear: the first two
 *     via the workspace control-plane predicate, the last because vendored
 *     dependency trees are execution-time material, not workspace content
 *     (the execution mounts exclude the same three on ingress and egress);
 *   - `complete: false` always names one action the caller can take
 *     (nextCursor or capReachedIn), the same rule airship's scanner keeps;
 *   - the summary leads the JSON body, because the model only sees content
 *     and a context cut takes the tail.
 */

import type { JsonValue, Tool, ToolExecutionResult } from "../../core/contracts";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, workspaceEntryByteLength, type WorkspaceEntry, type WorkspacePort } from "../../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../../workspace/content-codec";
import {
  collectLiteralMatches,
  workspacePathGlobMatcher,
  WORKSPACE_SEARCH_LIMITS,
  type WorkspaceContentMatch,
} from "../../workspace/content-search";
import { objectArguments, requiredString } from "../../tools/schema";

/** Files considered per call after exclusion and include-filter, in inventory order. */
const PRIME_SEARCH_FILES = 512;
/** Bytes read from any one file per call. */
const PRIME_SEARCH_FILE_BYTES = 512 * 1_024;
/** Total bytes read across one call: the documented 4 MiB scan budget. */
const PRIME_SEARCH_TOTAL_BYTES = 4 * 1_024 * 1_024;
/** Results a call returns when the caller asks for nothing. */
const DEFAULT_SEARCH_RESULTS = 200;
/** The most a caller may ask for; past this, paginate with cursor. */
const PRIME_SEARCH_RESULT_CEILING = 2_000;
/** Entries list_files returns when the caller asks for nothing. */
const DEFAULT_LIST_LIMIT = 200;
/** The most a list_files caller may ask for per call. */
const PRIME_LIST_LIMIT_CEILING = 2_000;

export type PrimeSearchBudgets = Readonly<{
  files: number;
  fileBytes: number;
  totalBytes: number;
  defaultResults: number;
  resultCeiling: number;
}>;

export const DEFAULT_PRIME_SEARCH_BUDGETS: PrimeSearchBudgets = Object.freeze({
  files: PRIME_SEARCH_FILES,
  fileBytes: PRIME_SEARCH_FILE_BYTES,
  totalBytes: PRIME_SEARCH_TOTAL_BYTES,
  defaultResults: DEFAULT_SEARCH_RESULTS,
  resultCeiling: PRIME_SEARCH_RESULT_CEILING,
});

/**
 * The one exclusion predicate every prime workspace tool agrees on. The
 * control-plane predicate owns `.airship`/`.git`; `node_modules` joins
 * here rather than upstream in the workspace contract because the
 * contract deliberately describes *Airship* privacy while this is a
 * *content-modeling* choice: vendored trees are real user files, they are
 * just never the answer a prime tool should read, list, or grep.
 */
export function isPrimeModelVisiblePath(path: string): boolean {
  if (isWorkspaceControlPlanePath(path)) return false;
  return !normalizeWorkspacePath(path).split("/").some((segment) => segment === "node_modules");
}

function integerArgument(value: JsonValue | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
}

function optionalStringArgument(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function modelVisibleRoot(value: JsonValue | undefined): string {
  const path = normalizeWorkspacePath(typeof value === "string" ? value : "/workspace");
  if (isWorkspaceControlPlanePath(path)) {
    throw new Error(`prime workspace tools exclude Airship control-plane paths: ${path}`);
  }
  return path;
}

function byPathThenPosition(left: WorkspaceContentMatch, right: WorkspaceContentMatch): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
}

export function createPrimeListFilesTool(workspace: WorkspacePort): Tool {
  return {
    definition: {
      name: "list_files",
      description:
        `List workspace files, sorted by path, control-plane and node_modules excluded. Bounded to ${String(DEFAULT_LIST_LIMIT)} entries per call unless ` +
        "asked otherwise; a partial list carries cursor to resume with.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory under /workspace; defaults to the workspace root." },
          limit: { type: "integer", minimum: 1, maximum: PRIME_LIST_LIMIT_CEILING, default: DEFAULT_LIST_LIMIT },
          cursor: { type: "string", description: "A previous reply's nextCursor. Resumes after that path in sorted order." },
        },
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const path = modelVisibleRoot(args.path);
      const limit = integerArgument(args.limit, "limit", DEFAULT_LIST_LIMIT);
      if (limit < 1 || limit > PRIME_LIST_LIMIT_CEILING) throw new Error(`limit must be between 1 and ${String(PRIME_LIST_LIMIT_CEILING)}.`);
      const cursor = optionalStringArgument(args.cursor, "cursor");

      const entries = (await workspace.list(path))
        .filter((entry) => isPrimeModelVisiblePath(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path));
      /*
       * Cursor ordering uses localeCompare because both airship backends
       * sort with it (src/workspace/memory.ts, src/workspace/indexeddb.ts);
       * comparing the same way means a cursor names the same boundary the
       * inventory was sorted by, not a boundary byte-ordered differently.
       */
      const afterCursor = cursor !== undefined ? entries.filter((entry) => entry.path.localeCompare(cursor) > 0) : entries;
      const page = afterCursor.slice(0, limit);
      const nextCursor = afterCursor.length > page.length ? page[page.length - 1]?.path : undefined;

      const presented = page.map((entry) => ({
        path: entry.path,
        size: workspaceEntryByteLength(entry),
        updatedAt: entry.updatedAt,
      }));
      return {
        content: JSON.stringify({
          summary: {
            path,
            returned: presented.length,
            totalVisible: entries.length,
            complete: nextCursor === undefined,
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          },
          entries: presented,
        }, null, 2),
        metadata: {
          path,
          returned: presented.length,
          totalVisible: entries.length,
          complete: nextCursor === undefined,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        },
      };
    },
  };
}

export function createPrimeSearchTextTool(
  workspace: WorkspacePort,
  budgets: PrimeSearchBudgets = DEFAULT_PRIME_SEARCH_BUDGETS,
): Tool {
  return {
    definition: {
      name: "search_text",
      description:
        `Search bounded UTF-8 workspace content for a literal string; line-oriented matches sorted by path, line, column. ` +
        `One call scans at most ${String(budgets.files)} files and ${String(Math.floor(budgets.totalBytes / 1_048_576))} MiB; a bounded scan names the ` +
        "cursor to resume from or the file its result cap filled inside.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory under /workspace; defaults to the workspace root." },
          query: { type: "string", minLength: 1, maxLength: 4_096 },
          case_sensitive: { type: "boolean", default: false },
          max_results: { type: "integer", minimum: 1, maximum: budgets.resultCeiling, default: budgets.defaultResults },
          include: { type: "string", description: "Path glob. A bare name matches the file name (*.ts); ** spans directories (src/**/*.ts)." },
          cursor: { type: "string", description: "A previous reply's nextCursor. Resumes after that path in inventory order." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const root = modelVisibleRoot(args.path);
      const query = requiredString(args.query, "query");
      const caseSensitive = args.case_sensitive === true;
      if (args.case_sensitive !== undefined && typeof args.case_sensitive !== "boolean") {
        throw new Error("case_sensitive must be a boolean.");
      }
      const maxResults = integerArgument(args.max_results, "max_results", budgets.defaultResults);
      if (maxResults < 1 || maxResults > budgets.resultCeiling) {
        throw new Error(`max_results must be between 1 and ${String(budgets.resultCeiling)}.`);
      }
      const include = optionalStringArgument(args.include, "include");
      const cursor = optionalStringArgument(args.cursor, "cursor");

      const inventory = (await workspace.list(root))
        .filter((entry: WorkspaceEntry) => isPrimeModelVisiblePath(entry.path))
        .sort((left: WorkspaceEntry, right: WorkspaceEntry) => left.path.localeCompare(right.path));
      const afterCursor = cursor !== undefined
        ? inventory.filter((entry: WorkspaceEntry) => entry.path.localeCompare(cursor) > 0)
        : inventory;
      const matchesInclude = include !== undefined ? workspacePathGlobMatcher(include) : undefined;
      const eligible = matchesInclude ? afterCursor.filter((entry: WorkspaceEntry) => matchesInclude(entry.path)) : afterCursor;
      const candidateFiles = afterCursor.length;
      const filteredOutFiles = candidateFiles - eligible.length;

      if (include !== undefined && candidateFiles > 0 && candidateFiles === filteredOutFiles) {
        /*
         * A filter that selects nothing is missing input, not a result:
         * returning `complete: true` with zero matches here would be a
         * confident false negative in the one field the model reads.
         */
        const examples = inventory.slice(0, 3).map((entry) => entry.path).join(", ");
        return {
          content: `search_text include ${JSON.stringify(include)} selected 0 of ${String(candidateFiles)} files under ${root}, so nothing was searched. Paths here look like ${examples}. A pattern matches the whole path: a bare name matches the file name (*.ts), ** spans directories (src/**/*.ts).`,
          isError: true,
          metadata: { path: root, query, include, candidateFiles, selectedFiles: 0 },
        };
      }

      const considered = eligible.slice(0, budgets.files);
      const matches: WorkspaceContentMatch[] = [];
      let scannedBytes = 0;
      let scannedFiles = 0;
      let skippedFiles = 0;
      let visitedFiles = 0;
      let stoppedEarly = false;
      let finished: string | undefined;
      let capReachedIn: string | undefined;

      for (const entry of considered) {
        if (matches.length >= maxResults) break;
        if (scannedBytes >= budgets.totalBytes) { stoppedEarly = true; break; }
        const readLimit = Math.min(budgets.fileBytes, budgets.totalBytes - scannedBytes);
        if (readLimit < 1) { stoppedEarly = true; break; }
        visitedFiles += 1;
        let file;
        if (workspace.readBounded) {
          file = await workspace.readBounded(entry.path, readLimit);
        } else if (workspaceEntryByteLength(entry) <= readLimit) {
          file = await workspace.read(entry.path);
        } else {
          // The port cannot bound; reading past the budget is worse than naming the skip.
          skippedFiles += 1;
          finished = entry.path;
          continue;
        }
        if (!file) { finished = entry.path; continue; }
        if (isWorkspaceBinaryEnvelope(file.content)) { skippedFiles += 1; finished = entry.path; continue; }
        scannedFiles += 1;
        scannedBytes += new TextEncoder().encode(file.content).byteLength;
        collectLiteralMatches(file.path, file.content, query, caseSensitive, maxResults, matches);
        if (matches.length >= maxResults) { capReachedIn = entry.path; break; }
        finished = entry.path;
      }

      /*
       * collected in path-ascending inventory order but the shared matcher
       * appends in scan order *within* a file too, so a stable resort is a
       * cheap guarantee rather than a hope, and it pins the order the
       * result-set contract promises.
       */
      matches.sort(byPathThenPosition);
      if (matches.length > maxResults) matches.length = maxResults;

      const unsearchedFiles = eligible.length - visitedFiles;
      const complete = !stoppedEarly && unsearchedFiles <= 0 && skippedFiles === 0 && capReachedIn === undefined;
      const summary = [
        `${String(matches.length)} match${matches.length === 1 ? "" : "es"} in ${String(scannedFiles)} scanned file${scannedFiles === 1 ? "" : "s"}`,
        skippedFiles > 0 ? `${String(skippedFiles)} skipped (binary or past a per-file bound)` : undefined,
        unsearchedFiles > 0 ? `${String(unsearchedFiles)} not reached by the bounded scan` : undefined,
        stoppedEarly ? `stopped at the ${String(Math.floor(budgets.totalBytes / 1_048_576))} MiB scan budget` : undefined,
      ].filter((part): part is string => part !== undefined).join("; ");

      return {
        content: JSON.stringify({
          summary,
          complete,
          ...(complete === false && finished !== undefined ? { nextCursor: finished } : {}),
          ...(capReachedIn !== undefined ? { capReachedIn } : {}),
          matches,
        }, null, 2),
        metadata: {
          path: root,
          query,
          ...(include !== undefined ? { include } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          matches: matches.length,
          scannedFiles,
          skippedFiles,
          candidateFiles,
          filteredOutFiles,
          unsearchedFiles,
          scannedBytes,
          complete,
          snippetCharacters: WORKSPACE_SEARCH_LIMITS.snippetCharacters,
        },
      };
    },
  };
}
