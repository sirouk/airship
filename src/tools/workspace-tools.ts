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
import { ToolRegistry } from "./registry";

const MAX_SEARCH_FILES = 512;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_SNIPPET_CHARACTERS = 240;
const MAX_TEXT_EDITOR_EDITS = 32;

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalStringArgument(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringArgument(value, name);
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
  return userWorkspacePath(normalizeWorkspacePath(stringArgument(value, name)));
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
      const files = userWorkspaceEntries(await workspace.list(path)).map(presentedWorkspaceEntry);
      return { content: JSON.stringify(files, null, 2), metadata: { count: files.length } };
    },
  };

  const readFile: Tool = {
    definition: {
      name: "read_file",
      description: "Read one UTF-8 file from the private virtual workspace.",
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
      const file = await workspace.read(path);
      if (!file) return { content: `File not found: ${path}`, isError: true };
      if (isWorkspaceBinaryEnvelope(file.content)) {
        return {
          content: `Binary file is not available through read_file: ${path}. Use stat_path or a byte-capable execution runtime.`,
          isError: true,
          metadata: { path: file.path, revision: file.revision, size: workspaceContentByteLength(file.content), encoding: "binary" },
        };
      }
      return { content: file.content, metadata: { path: file.path, revision: file.revision, size: file.size } };
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
      const content = stringArgument(argumentsObject.content, "content");
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
      description: "Search bounded UTF-8 workspace content for a literal string and return line-oriented matches.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory under /workspace" },
          query: { type: "string", minLength: 1, maxLength: 4096 },
          caseSensitive: { type: "boolean", default: false },
          maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: DEFAULT_SEARCH_RESULTS },
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
      const query = stringArgument(argumentsObject.query, "query");
      if (!query) throw new Error("query must not be empty.");
      const caseSensitive = booleanArgument(argumentsObject.caseSensitive, "caseSensitive");
      const maxResults = integerArgument(argumentsObject.maxResults, "maxResults", DEFAULT_SEARCH_RESULTS);
      if (maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
        throw new Error(`maxResults must be between 1 and ${MAX_SEARCH_RESULTS}.`);
      }

      const allEntries = userWorkspaceEntries(await workspace.list(path));
      const entries = allEntries.slice(0, MAX_SEARCH_FILES);
      const matches: Array<{ path: string; line: number; column: number; snippet: string }> = [];
      let scannedBytes = 0;
      let scannedFiles = 0;
      let truncatedFiles = 0;
      let skippedFiles = 0;

      for (const entry of entries) {
        if (matches.length >= maxResults || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
        const remaining = MAX_SEARCH_TOTAL_BYTES - scannedBytes;
        const readLimit = Math.min(MAX_SEARCH_FILE_BYTES, remaining);
        if (readLimit < 1) break;
        let file: WorkspaceFile | undefined;
        if (workspace.readBounded) {
          file = await workspace.readBounded(entry.path, readLimit);
        } else if (entry.size <= readLimit) {
          file = await workspace.read(entry.path);
        } else {
          skippedFiles += 1;
          continue;
        }
        if (!file) continue;
        if (isWorkspaceBinaryEnvelope(file.content)) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const contentBytes = new TextEncoder().encode(file.content).byteLength;
        scannedBytes += contentBytes;
        if (entry.size > contentBytes) truncatedFiles += 1;
        collectLiteralMatches(file.path, file.content, query, caseSensitive, maxResults, matches);
      }

      const truncated = allEntries.length > MAX_SEARCH_FILES
        || scannedBytes >= MAX_SEARCH_TOTAL_BYTES
        || matches.length >= maxResults
        || truncatedFiles > 0
        || skippedFiles > 0;
      return {
        content: matches.length > 0 ? JSON.stringify(matches, null, 2) : `No matches for ${JSON.stringify(query)} under ${path}.`,
        metadata: {
          path,
          query,
          matches: matches.length,
          scannedFiles,
          scannedBytes,
          truncatedFiles,
          skippedFiles,
          truncated,
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
      const oldText = stringArgument(argumentsObject.oldText, "oldText");
      const newText = stringArgument(argumentsObject.newText, "newText");
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
        const newText = stringArgument(edit.newText, `edits[${index}].newText`);
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
        const oldText = stringArgument(edit.oldText, `edits[${index}].oldText`);
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

function collectLiteralMatches(
  path: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  maxResults: number,
  matches: Array<{ path: string; line: number; column: number; snippet: string }>,
): void {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    const haystack = caseSensitive ? line : line.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length && matches.length < maxResults) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      const snippetStart = Math.max(0, index - Math.floor(MAX_SNIPPET_CHARACTERS / 3));
      const snippet = line.slice(snippetStart, snippetStart + MAX_SNIPPET_CHARACTERS);
      matches.push({ path, line: lineIndex + 1, column: index + 1, snippet });
      offset = index + needle.length;
    }
    if (matches.length >= maxResults) return;
  }
}
