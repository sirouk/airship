import { isWorkspaceBinaryEnvelope } from "./content-codec";
import { workspaceEntryByteLength, type WorkspaceEntry, type WorkspacePort } from "./contracts";

/**
 * The bounds every workspace content search obeys, wherever it is driven from.
 *
 * These were literals inside `search_text` (src/tools/workspace-tools.ts:13-18)
 * and reachable only by a model calling that tool: the Workspace route — the
 * route that owns files — had no "find in files" at all, so a developer who
 * typed a symbol into the Explorer's one search-shaped box got filename matches
 * and concluded the product cannot grep. The scan is stated once, here, so the
 * human control and the tool cannot answer the same question differently.
 */
export const WORKSPACE_SEARCH_LIMITS = Object.freeze({
  /** Files considered, in inventory order. */
  files: 512,
  /** Bytes read from any one file. */
  fileBytes: 512 * 1024,
  /** Bytes read across the whole scan. */
  totalBytes: 8 * 1024 * 1024,
  /** Matches returned before the scan stops early. */
  results: 50,
  /** Characters kept around a match. */
  snippetCharacters: 240,
});

export type WorkspaceContentMatch = Readonly<{
  path: string;
  /** 1-based, so it can be read aloud and typed into a Go-to-line box. */
  line: number;
  column: number;
  snippet: string;
}>;

export type WorkspaceContentSearch = Readonly<{
  matches: readonly WorkspaceContentMatch[];
  scannedFiles: number;
  /** Binary envelopes and files past the per-file bound, counted not hidden. */
  skippedFiles: number;
  /** True when a bound stopped the scan, so the caller may not claim "all". */
  truncated: boolean;
}>;

/**
 * Literal, line-oriented matches inside one file's text.
 *
 * Literal rather than regular-expression: the query comes from a text field a
 * person is still typing into, and a half-typed `(` must not throw where a
 * filter would simply have matched nothing.
 */
export function collectLiteralMatches(
  path: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  maxResults: number,
  matches: WorkspaceContentMatch[],
): void {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  if (!needle) return;
  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    const haystack = caseSensitive ? line : line.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length && matches.length < maxResults) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      const snippetStart = Math.max(0, index - Math.floor(WORKSPACE_SEARCH_LIMITS.snippetCharacters / 3));
      matches.push(Object.freeze({
        path,
        line: lineIndex + 1,
        column: index + 1,
        snippet: line.slice(snippetStart, snippetStart + WORKSPACE_SEARCH_LIMITS.snippetCharacters),
      }));
      offset = index + needle.length;
    }
    if (matches.length >= maxResults) return;
  }
}

/**
 * Search bounded UTF-8 workspace content for a literal string.
 *
 * Takes the inventory the caller already holds instead of listing again: the
 * Explorer renders that exact array, so a result set built from a second listing
 * could name a path the tree beside it does not show.
 */
export async function searchWorkspaceContent(
  workspace: Pick<WorkspacePort, "read" | "readBounded">,
  entries: readonly WorkspaceEntry[],
  query: string,
  options: Readonly<{ caseSensitive?: boolean; maxResults?: number; signal?: AbortSignal }> = {},
): Promise<WorkspaceContentSearch> {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? WORKSPACE_SEARCH_LIMITS.results, WORKSPACE_SEARCH_LIMITS.results));
  const caseSensitive = options.caseSensitive === true;
  const matches: WorkspaceContentMatch[] = [];
  const considered = entries.slice(0, WORKSPACE_SEARCH_LIMITS.files);
  let scannedBytes = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  let stoppedEarly = false;

  if (!query) return frozenSearch(matches, 0, 0, false);

  for (const entry of considered) {
    if (options.signal?.aborted) { stoppedEarly = true; break; }
    if (matches.length >= maxResults || scannedBytes >= WORKSPACE_SEARCH_LIMITS.totalBytes) { stoppedEarly = true; break; }
    const readLimit = Math.min(WORKSPACE_SEARCH_LIMITS.fileBytes, WORKSPACE_SEARCH_LIMITS.totalBytes - scannedBytes);
    if (readLimit < 1) { stoppedEarly = true; break; }
    let file;
    if (workspace.readBounded) {
      file = await workspace.readBounded(entry.path, readLimit);
    } else if (workspaceEntryByteLength(entry) <= readLimit) {
      file = await workspace.read(entry.path);
    } else {
      skippedFiles += 1;
      continue;
    }
    if (!file) continue;
    // The storage envelope of a binary is base64 text that would "match" a
    // query no human typed, so it is skipped and counted rather than searched.
    if (isWorkspaceBinaryEnvelope(file.content)) { skippedFiles += 1; continue; }
    scannedFiles += 1;
    const contentBytes = new TextEncoder().encode(file.content).byteLength;
    scannedBytes += contentBytes;
    if (workspaceEntryByteLength(entry) > contentBytes) skippedFiles += 1;
    collectLiteralMatches(file.path, file.content, query, caseSensitive, maxResults, matches);
  }

  return frozenSearch(
    matches,
    scannedFiles,
    skippedFiles,
    stoppedEarly || entries.length > considered.length || skippedFiles > 0 || matches.length >= maxResults,
  );
}

function frozenSearch(
  matches: readonly WorkspaceContentMatch[],
  scannedFiles: number,
  skippedFiles: number,
  truncated: boolean,
): WorkspaceContentSearch {
  return Object.freeze({ matches: Object.freeze([...matches]), scannedFiles, skippedFiles, truncated });
}

/**
 * One sentence describing what a completed scan actually covered.
 *
 * A bounded result that says only "12 matches" invites the reader to conclude
 * there are exactly twelve in the workspace; every bound that fired has to be
 * visible in the same line as the count.
 */
export function workspaceSearchSummary(result: WorkspaceContentSearch): string {
  const matches = `${String(result.matches.length)} match${result.matches.length === 1 ? "" : "es"}`;
  const files = `${String(result.scannedFiles)} file${result.scannedFiles === 1 ? "" : "s"} read`;
  const skipped = result.skippedFiles > 0 ? ` · ${String(result.skippedFiles)} skipped as binary or oversized` : "";
  return `${matches} · ${files}${skipped}${result.truncated ? " · bounded scan" : ""}`;
}
