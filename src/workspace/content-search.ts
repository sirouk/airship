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
  /** Matches returned before the scan stops early, when the caller names none. */
  results: 50,
  /**
   * The most a caller may ask for.
   *
   * `search_text` accepted `maxResults: 200` before this scan was shared, so a
   * ceiling of `results` here would have halved that tool's declared maximum
   * the moment it delegated — a silent regression in the one number a model
   * uses to decide whether it has seen everything. The Explorer still asks for
   * nothing and still gets `results`.
   */
  resultCeiling: 200,
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
  /** Files this scan was allowed to open but never reached. */
  unsearchedFiles: number;
  /** Files offered to this scan after the cursor, before `include` ran. */
  candidateFiles: number;
  /** Candidates `include` rejected. Equal to `candidateFiles` means nothing was searched. */
  filteredOutFiles: number;
  /**
   * The last path this scan finished, or `undefined` when it finished none.
   * Present only when there is something left to do, so a caller can resume by
   * passing it back as `cursor`.
   */
  nextCursor?: string;
  /**
   * The file the result cap filled inside, if it did.
   *
   * Distinct from `nextCursor` because resuming *after* this file would hide
   * the rest of its matches — and because when the cap fires in the very first
   * eligible file there is no finished path to hand back at all. A scan that
   * says `complete: false` must always name one action the caller can take.
   */
  capReachedIn?: string;
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
  options: Readonly<{
    caseSensitive?: boolean;
    maxResults?: number;
    signal?: AbortSignal;
    /** Path glob. `*` stays inside one segment, `**` spans them. */
    include?: string;
    /** A previous scan's `nextCursor`: start after this path, in inventory order. */
    cursor?: string;
  }> = {},
): Promise<WorkspaceContentSearch> {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? WORKSPACE_SEARCH_LIMITS.results, WORKSPACE_SEARCH_LIMITS.resultCeiling));
  const caseSensitive = options.caseSensitive === true;
  const matches: WorkspaceContentMatch[] = [];
  /*
   * Cursor and filter run before the file bound, not after it.
   *
   * Slicing to 512 first and filtering the slice would make `include` a filter
   * on the alphabetically first 512 paths — so `src/**` in a workspace whose
   * assets sort ahead of `src/` selects nothing while reporting a bounded scan.
   * Both backends list with `localeCompare` (src/workspace/memory.ts:34,
   * every production workspace port), so the cursor compares the same way the
   * inventory is ordered rather than with `<`, which disagrees on case.
   */
  const afterCursor = options.cursor
    ? entries.filter((entry) => entry.path.localeCompare(options.cursor ?? "") > 0)
    : entries;
  const matchesInclude = options.include ? workspacePathGlobMatcher(options.include) : undefined;
  const eligible = matchesInclude ? afterCursor.filter((entry) => matchesInclude(entry.path)) : afterCursor;
  const candidateFiles = afterCursor.length;
  const filteredOutFiles = candidateFiles - eligible.length;
  const considered = eligible.slice(0, WORKSPACE_SEARCH_LIMITS.files);
  let scannedBytes = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  let visitedFiles = 0;
  let stoppedEarly = false;
  let finished: string | undefined;
  let capReachedIn: string | undefined;

  if (!query) {
    return frozenSearch({ matches, scannedFiles: 0, skippedFiles: 0, truncated: false, unsearchedFiles: 0, candidateFiles, filteredOutFiles });
  }

  for (const entry of considered) {
    if (options.signal?.aborted) { stoppedEarly = true; break; }
    if (scannedBytes >= WORKSPACE_SEARCH_LIMITS.totalBytes) { stoppedEarly = true; break; }
    const readLimit = Math.min(WORKSPACE_SEARCH_LIMITS.fileBytes, WORKSPACE_SEARCH_LIMITS.totalBytes - scannedBytes);
    if (readLimit < 1) { stoppedEarly = true; break; }
    visitedFiles += 1;
    let file;
    if (workspace.readBounded) {
      file = await workspace.readBounded(entry.path, readLimit);
    } else if (workspaceEntryByteLength(entry) <= readLimit) {
      file = await workspace.read(entry.path);
    } else {
      skippedFiles += 1;
      finished = entry.path;
      continue;
    }
    if (!file) { finished = entry.path; continue; }
    // The storage envelope of a binary is base64 text that would "match" a
    // query no human typed, so it is skipped and counted rather than searched.
    if (isWorkspaceBinaryEnvelope(file.content)) { skippedFiles += 1; finished = entry.path; continue; }
    scannedFiles += 1;
    const contentBytes = new TextEncoder().encode(file.content).byteLength;
    scannedBytes += contentBytes;
    if (workspaceEntryByteLength(entry) > contentBytes) skippedFiles += 1;
    collectLiteralMatches(file.path, file.content, query, caseSensitive, maxResults, matches);
    if (matches.length >= maxResults) { capReachedIn = entry.path; break; }
    /*
     * The resume point advances past a file only when this scan finished it.
     * If the cap filled up *inside* this file, resuming after it would hide that
     * file's remaining matches. `capReachedIn` names the file instead, because a
     * scan that reports `complete: false` must always name one action a caller
     * can take — and when the cap fires in the first eligible file there is no
     * completed path to hand back.
     */
    finished = entry.path;
  }

  const unsearchedFiles = eligible.length - visitedFiles;
  const truncated = stoppedEarly || unsearchedFiles > 0 || skippedFiles > 0 || capReachedIn !== undefined;
  return frozenSearch({
    matches,
    scannedFiles,
    skippedFiles,
    truncated,
    unsearchedFiles,
    candidateFiles,
    filteredOutFiles,
    nextCursor: (unsearchedFiles > 0 || capReachedIn !== undefined) ? finished : undefined,
    capReachedIn,
  });
}

function frozenSearch(
  result: Omit<WorkspaceContentSearch, "matches"> & { matches: readonly WorkspaceContentMatch[] },
): WorkspaceContentSearch {
  return Object.freeze({ ...result, matches: Object.freeze([...result.matches]) });
}

type GlobSegmentToken = "*" | Readonly<{ literal: string }>;
type GlobSegment = "**" | readonly GlobSegmentToken[];
type GlobPathPattern = readonly GlobSegment[];

/**
 * Compile a path glob to a predicate, segment by segment and without a RegExp.
 *
 * This runs on the agent's own thread, and one `RegExp.exec` cannot be
 * interrupted: a compiled `*a*a*a*a*b` against a long non-matching path is a
 * frozen tab, not a slow search. The two-pointer matcher below backtracks over
 * at most one star at a time, so its worst case is the product of the two
 * lengths rather than exponential in the number of stars.
 */
export function workspacePathGlobMatcher(pattern: string): (path: string) => boolean {
  if (pattern.includes("/")) {
    const raw = pattern.split("/");
    /*
     * A pattern that is neither rooted at `/` nor led by `**` is anchored with
     * one. Without this, `src/**\/*.ts` — the commonest form a model writes —
     * matched zero files, because splitting an absolute path yields a leading
     * empty segment the pattern had no anchor to skip. Measured: `src/**`,
     * `src/**\/*.ts` and `docs/*.md` all selected 0 of 4 realistic paths.
     */
    const anchored = raw[0] === "" || /^\*\*+$/u.test(raw[0] ?? "") ? raw : ["**", ...raw];
    const compiled: GlobPathPattern = anchored.map((segment) =>
      (/^\*\*+$/u.test(segment) ? "**" as const : tokenizeGlobSegment(segment)));
    return (path) => matchesGlobPath(path, compiled);
  }
  // A pattern with no separator names a file, not a place: `*.ts` is what a
  // model writes when it means "any TypeScript file", never "a .ts file in the
  // workspace root".
  const compiled = tokenizeGlobSegment(pattern);
  return (path) => matchesGlobSegment(path.slice(path.lastIndexOf("/") + 1), compiled);
}

function tokenizeGlobSegment(segment: string): readonly GlobSegmentToken[] {
  const tokens: GlobSegmentToken[] = [];
  let literal = "";
  for (const character of segment) {
    if (character === "*") {
      if (literal) { tokens.push({ literal }); literal = ""; }
      if (tokens[tokens.length - 1] !== "*") tokens.push("*");
      continue;
    }
    literal += character;
  }
  if (literal) tokens.push({ literal });
  return tokens;
}

function matchesGlobSegment(name: string, tokens: readonly GlobSegmentToken[]): boolean {
  let nameIndex = 0;
  let tokenIndex = 0;
  let starToken = -1;
  let starName = 0;
  while (nameIndex < name.length) {
    const token = tokens[tokenIndex];
    if (token === "*") { starToken = tokenIndex; starName = nameIndex; tokenIndex += 1; continue; }
    if (token !== undefined && name.startsWith(token.literal, nameIndex)) {
      nameIndex += token.literal.length;
      tokenIndex += 1;
      continue;
    }
    if (starToken < 0) return false;
    starName += 1;
    if (starName > name.length) return false;
    nameIndex = starName;
    tokenIndex = starToken + 1;
  }
  while (tokens[tokenIndex] === "*") tokenIndex += 1;
  return tokenIndex === tokens.length;
}

function matchesGlobPath(path: string, pattern: GlobPathPattern): boolean {
  const segments = path.split("/");
  let segmentIndex = 0;
  let patternIndex = 0;
  let starPattern = -1;
  let starSegment = 0;
  while (segmentIndex < segments.length) {
    const token = pattern[patternIndex];
    if (token === "**") { starPattern = patternIndex; starSegment = segmentIndex; patternIndex += 1; continue; }
    if (token !== undefined && matchesGlobSegment(segments[segmentIndex] ?? "", token)) {
      segmentIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (starPattern < 0) return false;
    starSegment += 1;
    if (starSegment > segments.length) return false;
    segmentIndex = starSegment;
    patternIndex = starPattern + 1;
  }
  while (pattern[patternIndex] === "**") patternIndex += 1;
  return patternIndex === pattern.length;
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
  /*
   * A filter that rejected files is named in the same sentence as the count.
   * This line is the whole content of the model's channel (src/core/agent.ts:941
   * builds the tool message from `content` alone), and "0 matches · 0 files
   * read" from a filter that selected nothing reads as a searched workspace
   * with nothing in it.
   */
  const filtered = result.filteredOutFiles > 0
    ? ` · ${String(result.candidateFiles - result.filteredOutFiles)} of ${String(result.candidateFiles)} files matched the filter`
    : "";
  const skipped = result.skippedFiles > 0 ? ` · ${String(result.skippedFiles)} skipped as binary or oversized` : "";
  const capped = result.capReachedIn
    ? ` · result cap reached inside ${result.capReachedIn}; raise maxResults or narrow with include`
    : "";
  const more = result.unsearchedFiles > 0 ? ` · ${String(result.unsearchedFiles)} files not reached` : "";
  return `${matches} · ${files}${filtered}${skipped}${capped}${more}${result.truncated ? " · bounded scan" : ""}`;
}
