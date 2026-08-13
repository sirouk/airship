import type { JsonValue, Tool, ToolExecutionResult } from "../core/contracts";

import {
  isWorkspaceControlPlanePath,
  WorkspaceConflictError,
  normalizeWorkspacePath,
  workspaceEntryByteLength,
  type WorkspaceFile,
  type WorkspacePort,
} from "../workspace/contracts";
import { isWorkspaceBinaryEnvelope, workspaceContentByteLength } from "../workspace/content-codec";
import { searchWorkspaceContent, workspaceSearchSummary, WORKSPACE_SEARCH_LIMITS } from "../workspace/content-search";
import { ToolRegistry } from "./registry";
import { objectArguments, rawString, requiredString } from "./schema";

const MAX_TEXT_EDITOR_EDITS = 32;

/**
 * The window `read_file` returns when the caller names none.
 *
 * `registry.ts:149-151` refuses any tool result over 1 MiB *after* the tool has
 * already built it, so a 2 MiB file used to cost a read and then throw
 * `Tool output exceeded 1048576 bytes.` — a budget message where a fix belonged,
 * and no way to see any part of the file at all. This sits just under that
 * ceiling with room for the head notice, so every file that returns whole today
 * still does and the throw becomes a first window instead. A caller that wants
 * less passes `maxBytes`.
 */
const MAX_READ_FILE_BYTES = 1_040_000;

function optionalStringArgument(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function booleanArgument(value: JsonValue | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function integerArgument(value: JsonValue | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
}

function workspacePath(value: JsonValue | undefined, name: string): string {
  return userWorkspacePath(normalizeWorkspacePath(requiredString(value, name)));
}

function userWorkspacePath(path: string): string {
  if (isWorkspaceControlPlanePath(path)) {
    throw new Error(`Generic workspace tools exclude Airship control-plane paths: ${path}`);
  }
  return path;
}

function userWorkspaceEntries(files: readonly WorkspaceFile[]): WorkspaceFile[];
function userWorkspaceEntries(files: readonly Omit<WorkspaceFile, "content">[]): Array<Omit<WorkspaceFile, "content">>;
function userWorkspaceEntries(files: readonly WorkspaceFile[] | readonly Omit<WorkspaceFile, "content">[]) {
  return files.filter((file) => !isWorkspaceControlPlanePath(file.path));
}

/**
 * One size in the transcript, and it is the file's own.
 *
 * `WorkspaceEntry.size` is the storage envelope, so a binary listed here would
 * read ~4/3 too large while `read_file` reported it correctly for the same
 * path. Emit the decoded length as `size` and drop the storage field rather
 * than hand the model two competing numbers to choose between.
 */
/**
 * One weight the transcript can read without units gymnastics — list_files
 * is a person surface too (see C1).
 */
function formatWorkspaceBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

function presentedWorkspaceEntry(
  entry: Omit<WorkspaceFile, "content">,
): Omit<WorkspaceFile, "content" | "contentByteLength"> {
  const { contentByteLength: _stored, ...rest } = entry;
  return { ...rest, size: workspaceEntryByteLength(entry) };
}

export function createWorkspaceToolRegistry(workspace: WorkspacePort): ToolRegistry {
  const registry = new ToolRegistry();

  const listFiles: Tool = {
    definition: {
      name: "list_files",
      description: "List files in the private virtual workspace.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path under /workspace" } },
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const argumentsObject = objectArguments(argumentsValue);
      const path = userWorkspacePath(normalizeWorkspacePath(
        typeof argumentsObject.path === "string" ? argumentsObject.path : "/workspace",
      ));
      const files = userWorkspaceEntries(await workspace.list(path)).map((entry) => {
        /*
         * A line per entry, not JSON: this content goes to the transcript,
         * where a directory listing is read by a person, not parsed. The same
         * information on one line per entry is what the model reads too —
         * braces add nothing it uses.
         */
        const { contentByteLength: stored, ...rest } = entry;
        const kind = rest.path.endsWith("/") ? "/" : "";
        // The file's own weight, decoded — never the storage envelope, which
        // is how the binary case reads ~4/3 of the file (see stat_path).
        const sizeText = kind ? "" : ` ${formatWorkspaceBytes(workspaceEntryByteLength(entry))}`;
        return `${rest.path}${kind}${kind === "/" ? "" : ` ${sizeText.trimStart()}`}`;
      });
      const content = files.length ? files.join("\n") : `${path === "/" ? "/" : `${path}/`} (empty)`;
      return { content, metadata: { count: files.length } };
    },
  };

  const readFile: Tool = {
    definition: {
      name: "read_file",
      description: "Read one UTF-8 file, or one byte window of it, from the private virtual workspace. A partial read says so in its first line and names the offset to continue from.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 0, description: "First byte to return. Use the nextOffsetBytes a partial read reports." },
          maxBytes: { type: "integer", minimum: 1, maximum: MAX_READ_FILE_BYTES, description: "Bytes to return, snapped down to a whole character." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const argumentsObject = objectArguments(argumentsValue);
      const path = workspacePath(argumentsObject.path, "path");
      const offset = integerArgument(argumentsObject.offset, "offset", 0);
      const maxBytes = integerArgument(argumentsObject.maxBytes, "maxBytes", MAX_READ_FILE_BYTES);
      if (offset < 0) throw new Error("offset must not be negative.");
      if (maxBytes < 1 || maxBytes > MAX_READ_FILE_BYTES) {
        throw new Error(`maxBytes must be between 1 and ${MAX_READ_FILE_BYTES}.`);
      }
      const file = await workspace.read(path);
      if (!file) return { content: `File not found: ${path}`, isError: true };
      if (isWorkspaceBinaryEnvelope(file.content)) {
        return {
          content: `Binary file is not available through read_file: ${path}. Use stat_path or a byte-capable execution runtime.`,
          isError: true,
          metadata: { path: file.path, revision: file.revision, size: workspaceContentByteLength(file.content), encoding: "binary" },
        };
      }
      const bytes = new TextEncoder().encode(file.content);
      if (offset > bytes.byteLength) {
        return {
          content: `read_file offset ${String(offset)} is past the end of ${file.path}, which is ${String(bytes.byteLength)} bytes.`,
          isError: true,
          metadata: { path: file.path, revision: file.revision, size: bytes.byteLength, offset },
        };
      }
      const window = utf8Window(bytes, offset, maxBytes);
      const complete = window.start === 0 && window.end === bytes.byteLength;
      return {
        /*
         * The notice leads, and is never a trailer. `boundToolResultContent`
         * cuts the *tail* of a tool result (src/core/agent.ts:658-676) and
         * `metadata` never reaches the model at all (`:941-943` builds the tool
         * message from `content` alone), so a trailing notice is both the sole
         * carrier of the resume offset and the first thing deleted when the
         * context budget bites — exactly when the model most needs to know the
         * read was partial.
         */
        content: complete ? window.text : `${readWindowNotice(file.path, window.start, window.end, bytes.byteLength)}\n\n${window.text}`,
        metadata: {
          path: file.path,
          revision: file.revision,
          size: bytes.byteLength,
          offset: window.start,
          returnedBytes: window.end - window.start,
          complete,
          ...(window.end < bytes.byteLength ? { nextOffsetBytes: window.end } : {}),
        },
      };
    },
  };

  const writeFile: Tool = {
    definition: {
      name: "write_file",
      description: "Create or replace one UTF-8 file in the private virtual workspace.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedRevision: { type: ["string", "null"] },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const argumentsObject = objectArguments(argumentsValue);
      const path = workspacePath(argumentsObject.path, "path");
      const content = rawString(argumentsObject.content, "content");
      const expected = argumentsObject.expectedRevision;
      if (expected !== undefined && expected !== null && typeof expected !== "string") {
        throw new Error("expectedRevision must be a string or null.");
      }
      const file = await workspace.write(path, content, {
        expectedRevision: expected as string | null | undefined,
      });
      return {
        content: `Wrote ${file.path} (${file.size} bytes).`,
        metadata: { path: file.path, revision: file.revision, size: file.size },
      };
    },
  };

  const statPath: Tool = {
    definition: {
      name: "stat_path",
      description: "Inspect file or directory metadata in the private virtual workspace without reading file content.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const path = workspacePath(objectArguments(argumentsValue).path, "path");
      const entries = userWorkspaceEntries(await workspace.list(path));
      const file = entries.find((entry) => entry.path === path);
      if (file) {
        return {
          content: JSON.stringify({ type: "file", ...presentedWorkspaceEntry(file) }, null, 2),
          metadata: { type: "file", path: file.path, revision: file.revision, size: workspaceEntryByteLength(file) },
        };
      }
      if (entries.length > 0 || path === "/workspace") {
        const totalSize = entries.reduce((sum, entry) => sum + workspaceEntryByteLength(entry), 0);
        return {
          content: JSON.stringify({ type: "directory", path, files: entries.length, totalSize }, null, 2),
          metadata: { type: "directory", path, files: entries.length, totalSize },
        };
      }
      return { content: `Path not found: ${path}`, isError: true, metadata: { path } };
    },
  };

  const searchText: Tool = {
    definition: {
      name: "search_text",
      description: "Search bounded UTF-8 workspace content for a literal string and return line-oriented matches. Use it when you know the exact text — an identifier, an error message, a config key; when you only know the idea, search_context finds it by meaning. The reply's summary states every bound that fired, and an incomplete scan names either the cursor to resume from or the file its result cap filled inside.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory under /workspace" },
          query: { type: "string", minLength: 1, maxLength: 4096 },
          caseSensitive: { type: "boolean", default: false },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: WORKSPACE_SEARCH_LIMITS.resultCeiling,
            default: WORKSPACE_SEARCH_LIMITS.results,
          },
          include: {
            type: "string",
            description: "Path glob. A bare name matches the file name (*.ts); ** spans directories (src/**/*.ts). Matched against the whole path, inside path.",
          },
          cursor: {
            type: "string",
            description: "A previous reply's nextCursor. Resumes after that path in inventory order.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const argumentsObject = objectArguments(argumentsValue);
      const path = userWorkspacePath(normalizeWorkspacePath(
        typeof argumentsObject.path === "string" ? argumentsObject.path : "/workspace",
      ));
      // The blank-query refusal used to live here as a hand-added line, because
      // this file's local `stringArgument` was the one copy of seven that
      // accepted "". It is now inside `requiredString`, where the other six
      // always had it.
      const query = requiredString(argumentsObject.query, "query");
      const caseSensitive = booleanArgument(argumentsObject.caseSensitive, "caseSensitive");
      const maxResults = integerArgument(argumentsObject.maxResults, "maxResults", WORKSPACE_SEARCH_LIMITS.results);
      if (maxResults < 1 || maxResults > WORKSPACE_SEARCH_LIMITS.resultCeiling) {
        throw new Error(`maxResults must be between 1 and ${WORKSPACE_SEARCH_LIMITS.resultCeiling}.`);
      }
      const include = optionalStringArgument(argumentsObject.include, "include");
      const cursor = optionalStringArgument(argumentsObject.cursor, "cursor");

      /*
       * One scanner, driven from here and from the Explorer's Contents filter
       * (src/ui/workspace-view.tsx:643). The copy that used to live in this file
       * had drifted: it counted the storage envelope of a binary as the file's
       * size and reported `truncatedFiles` the shared scan calls `skippedFiles`,
       * so the same question answered here and on the route that owns files
       * could return two different bounded answers.
       */
      const entries = userWorkspaceEntries(await workspace.list(path));
      const result = await searchWorkspaceContent(workspace, entries, query, { caseSensitive, maxResults, include, cursor });

      if (include !== undefined && result.candidateFiles > 0 && result.candidateFiles === result.filteredOutFiles) {
        // Missing input, not a result. A filter that selects nothing used to
        // return `complete: true` with an empty match list — a confident false
        // negative in the one field the model receives (agent.ts:941-943),
        // which is the defect this whole lane exists to remove.
        const examples = entries.slice(0, 3).map((entry) => entry.path).join(", ");
        return {
          content: `search_text include ${JSON.stringify(include)} selected 0 of ${String(result.candidateFiles)} files under ${path}, so nothing was searched. Paths here look like ${examples}. A pattern matches the whole path: a bare name matches the file name (*.ts), ** spans directories (src/**/*.ts), and a leading ./ is not supported.`,
          isError: true,
          metadata: { path, query, include, candidateFiles: result.candidateFiles, selectedFiles: 0 },
        };
      }

      return {
        /*
         * `summary` first, and `complete` before the matches, because this
         * object is the whole of what the model reads (agent.ts:941-943) and a
         * context bound cuts the tail (`:658-676`). A truncated payload must
         * still have said "this scan was bounded" before it was cut.
         */
        content: JSON.stringify({
          summary: workspaceSearchSummary(result),
          complete: !result.truncated,
          ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
          ...(result.capReachedIn !== undefined ? { capReachedIn: result.capReachedIn } : {}),
          matches: result.matches,
        }, null, 2),
        metadata: {
          path,
          query,
          ...(include !== undefined ? { include } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          matches: result.matches.length,
          scannedFiles: result.scannedFiles,
          skippedFiles: result.skippedFiles,
          candidateFiles: result.candidateFiles,
          filteredOutFiles: result.filteredOutFiles,
          unsearchedFiles: result.unsearchedFiles,
          truncated: result.truncated,
        },
      };
    },
  };

  const replaceText: Tool = {
    definition: {
      name: "replace_text",
      description: "Replace one unambiguous literal occurrence, or all occurrences when explicitly requested, in a UTF-8 workspace file.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string", minLength: 1, maxLength: 262144 },
          newText: { type: "string", maxLength: 1048576 },
          replaceAll: { type: "boolean", default: false },
          expectedRevision: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const argumentsObject = objectArguments(argumentsValue);
      const path = workspacePath(argumentsObject.path, "path");
      const oldText = rawString(argumentsObject.oldText, "oldText");
      const newText = rawString(argumentsObject.newText, "newText");
      const replaceAll = booleanArgument(argumentsObject.replaceAll, "replaceAll");
      const expectedRevision = optionalStringArgument(argumentsObject.expectedRevision, "expectedRevision");
      if (!oldText) throw new Error("oldText must not be empty.");

      const file = await workspace.read(path);
      if (!file) return { content: `File not found: ${path}`, isError: true };
      if (isWorkspaceBinaryEnvelope(file.content)) {
        return { content: `Refused text replacement in binary file: ${path}.`, isError: true, metadata: { path, encoding: "binary" } };
      }
      if (expectedRevision !== undefined && expectedRevision !== file.revision) throw new WorkspaceConflictError();
      const occurrences = countOccurrences(file.content, oldText);
      if (occurrences === 0) return { content: `Text not found in ${path}.`, isError: true, metadata: { path, occurrences: 0 } };
      if (!replaceAll && occurrences !== 1) {
        return {
          content: `Refused ambiguous replacement: ${occurrences} occurrences found in ${path}. Set replaceAll to replace every occurrence.`,
          isError: true,
          metadata: { path, occurrences },
        };
      }
      const content = replaceAll ? file.content.split(oldText).join(newText) : file.content.replace(oldText, newText);
      const written = await workspace.write(path, content, { expectedRevision: file.revision });
      return {
        content: `Replaced ${replaceAll ? occurrences : 1} occurrence${replaceAll && occurrences !== 1 ? "s" : ""} in ${written.path}.`,
        metadata: { path: written.path, revision: written.revision, size: written.size, replacements: replaceAll ? occurrences : 1 },
      };
    },
  };

  const moveFile: Tool = {
    definition: {
      name: "move_file",
      description: "Move or rename one workspace file to a new, unoccupied path with optimistic revision checks.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: { type: "string" },
          destinationPath: { type: "string" },
          expectedRevision: { type: "string" },
        },
        required: ["sourcePath", "destinationPath"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const argumentsObject = objectArguments(argumentsValue);
      const sourcePath = workspacePath(argumentsObject.sourcePath, "sourcePath");
      const destinationPath = workspacePath(argumentsObject.destinationPath, "destinationPath");
      const expectedRevision = optionalStringArgument(argumentsObject.expectedRevision, "expectedRevision");
      if (sourcePath === destinationPath) throw new Error("sourcePath and destinationPath must differ.");
      const source = await workspace.read(sourcePath);
      if (!source) return { content: `File not found: ${sourcePath}`, isError: true };
      if (expectedRevision !== undefined && expectedRevision !== source.revision) throw new WorkspaceConflictError();
      if (await workspace.read(destinationPath)) {
        return { content: `Destination already exists: ${destinationPath}`, isError: true };
      }

      const destination = await workspace.write(destinationPath, source.content, { expectedRevision: null });
      try {
        await workspace.remove(sourcePath, { expectedRevision: source.revision });
      } catch (error) {
        try {
          await workspace.remove(destination.path, { expectedRevision: destination.revision });
        } catch {
          throw new Error(`Move conflicted and rollback could not remove ${destination.path}.`);
        }
        throw error;
      }
      return {
        content: `Moved ${sourcePath} to ${destination.path}.`,
        metadata: { sourcePath, destinationPath: destination.path, revision: destination.revision, size: workspaceEntryByteLength(destination) },
      };
    },
  };

  const removeFile: Tool = {
    definition: {
      name: "remove_file",
      description: "Remove one workspace file with an optimistic revision check.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expectedRevision: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue) {
      const argumentsObject = objectArguments(argumentsValue);
      const path = workspacePath(argumentsObject.path, "path");
      const expectedRevision = optionalStringArgument(argumentsObject.expectedRevision, "expectedRevision");
      const file = await workspace.read(path);
      if (!file) return { content: `File not found: ${path}`, isError: true };
      if (expectedRevision !== undefined && expectedRevision !== file.revision) throw new WorkspaceConflictError();
      await workspace.remove(path, { expectedRevision: file.revision });
      return { content: `Removed ${path}.`, metadata: { path, revision: file.revision, size: workspaceEntryByteLength(file) } };
    },
  };

  const textEditor: Tool = {
    definition: {
      name: "text_editor",
      description: "Apply a bounded batch of exact, revision-checked UTF-8 creates or replacements in the browser workspace. Every possible mutation is declared in this one approval-bound call.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TEXT_EDITOR_EDITS,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                oldText: { type: ["string", "null"], description: "Exact text to replace; null creates a new file." },
                newText: { type: "string", maxLength: 1_048_576 },
                replaceAll: { type: "boolean", default: false },
                expectedRevision: { type: ["string", "null"] },
              },
              required: ["path", "oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const rawEdits = objectArguments(argumentsValue).edits;
      if (!Array.isArray(rawEdits) || rawEdits.length < 1 || rawEdits.length > MAX_TEXT_EDITOR_EDITS) {
        throw new Error(`edits must contain 1 to ${MAX_TEXT_EDITOR_EDITS} operations.`);
      }
      const planned: Array<Readonly<{ path: string; content: string; expectedRevision: string | null; replacements: number }>> = [];
      const seen = new Set<string>();
      for (const [index, value] of rawEdits.entries()) {
        const edit = objectArguments(value);
        const path = workspacePath(edit.path, `edits[${index}].path`);
        if (seen.has(path)) throw new Error(`text_editor accepts at most one operation per path: ${path}`);
        seen.add(path);
        const newText = rawString(edit.newText, `edits[${index}].newText`);
        const replaceAll = booleanArgument(edit.replaceAll, `edits[${index}].replaceAll`);
        const declaredRevision = edit.expectedRevision;
        if (declaredRevision !== undefined && declaredRevision !== null && typeof declaredRevision !== "string") {
          throw new Error(`edits[${index}].expectedRevision must be a string or null.`);
        }
        const current = await workspace.read(path);
        if (edit.oldText === null) {
          if (current) throw new WorkspaceConflictError(`text_editor create target already exists: ${path}`);
          if (declaredRevision !== undefined && declaredRevision !== null) {
            throw new Error(`A create operation must use a null expectedRevision: ${path}`);
          }
          planned.push({ path, content: newText, expectedRevision: null, replacements: 0 });
          continue;
        }
        const oldText = rawString(edit.oldText, `edits[${index}].oldText`);
        if (!oldText) throw new Error(`edits[${index}].oldText must not be empty.`);
        if (!current) throw new WorkspaceConflictError(`text_editor replacement target is missing: ${path}`);
        if (isWorkspaceBinaryEnvelope(current.content)) {
          throw new Error(`text_editor refused opaque binary content: ${path}`);
        }
        if (typeof declaredRevision === "string" && declaredRevision !== current.revision) {
          throw new WorkspaceConflictError(`text_editor revision changed before execution: ${path}`);
        }
        const occurrences = countOccurrences(current.content, oldText);
        if (occurrences === 0) throw new WorkspaceConflictError(`text_editor could not find the declared text: ${path}`);
        if (!replaceAll && occurrences !== 1) {
          throw new Error(`text_editor refused ${occurrences} ambiguous occurrences in ${path}; set replaceAll explicitly.`);
        }
        planned.push({
          path,
          content: replaceAll ? current.content.split(oldText).join(newText) : current.content.replace(oldText, newText),
          expectedRevision: current.revision,
          replacements: replaceAll ? occurrences : 1,
        });
      }

      const written: Array<{ path: string; revision: string; size: number; replacements: number }> = [];
      for (const edit of planned) {
        const file = await workspace.write(edit.path, edit.content, { expectedRevision: edit.expectedRevision });
        written.push({ path: file.path, revision: file.revision, size: file.size, replacements: edit.replacements });
      }
      return {
        content: `Applied ${written.length} revision-checked workspace edit${written.length === 1 ? "" : "s"}.`,
        metadata: { files: written, transaction: "preflight-plus-per-file-cas", atomic: written.length === 1 },
      };
    },
  };

  registry.register(listFiles);
  registry.register(readFile);
  registry.register(writeFile);
  registry.register(statPath);
  registry.register(searchText);
  registry.register(replaceText);
  registry.register(moveFile);
  registry.register(removeFile);
  registry.register(textEditor);
  return registry;
}

function countOccurrences(content: string, query: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - query.length) {
    const index = content.indexOf(query, offset);
    if (index < 0) break;
    count += 1;
    offset = index + query.length;
  }
  return count;
}

/**
 * The byte index of the character containing `index`.
 *
 * A window that ends mid-character decodes to U+FFFD on both sides of the seam,
 * so the two halves of a resumed read would not reassemble into the file the
 * caller asked for. Snapping backwards keeps every window a whole-character
 * string and every reported offset a boundary the next call can start on.
 */
function codepointStart(bytes: Uint8Array, index: number): number {
  let at = Math.min(Math.max(index, 0), bytes.byteLength);
  while (at > 0 && at < bytes.byteLength && ((bytes[at] ?? 0) & 0xc0) === 0x80) at -= 1;
  return at;
}

function utf8Window(
  bytes: Uint8Array,
  offset: number,
  maxBytes: number,
): Readonly<{ text: string; start: number; end: number }> {
  const start = codepointStart(bytes, offset);
  let end = codepointStart(bytes, Math.min(start + maxBytes, bytes.byteLength));
  // A `maxBytes` smaller than the character at `start` would otherwise return an
  // empty window whose `nextOffsetBytes` equals its own offset — a caller
  // following the instruction would loop forever. One whole character is the
  // floor, so every window advances.
  if (end <= start && start < bytes.byteLength) {
    end = start + 1;
    while (end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end += 1;
  }
  return Object.freeze({ text: new TextDecoder().decode(bytes.subarray(start, end)), start, end });
}

function readWindowNotice(path: string, start: number, end: number, total: number): string {
  const next = end < total
    ? ` Continue with read_file {"path":${JSON.stringify(path)},"offset":${String(end)}}.`
    : " This window reaches the end of the file.";
  return `[Airship returned bytes ${String(start)}–${String(end)} of ${String(total)} for ${path}.${next}]`;
}
