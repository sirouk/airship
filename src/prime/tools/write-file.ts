/**
 * The prime-native `write_file` and `edit_file` tools: prime-agent's
 * write/edit vocabulary carried onto airship's revision-CAS WorkspacePort.
 *
 * Why two narrow tools instead of airship's batched `text_editor`: ported
 * prime-agent skills and prompts speak in single-file writes and exact
 * old_text/new_text edits, and a coding agent's edit failure modes
 * (ambiguous match, no-match, no-op) deserve their own named refusals
 * rather than a batch transaction report. The *rules* the refusals encode
 * are studied from src/tools/workspace-tools.ts `replace_text` /
 * `text_editor` and restated here:
 *   - zero occurrences of old_text is not a successful no-edit: it is a
 *     refusal, because the model's premise about the file was wrong;
 *   - more than one occurrence without `replace_all: true` is refused
 *     with the count and the remedy named;
 *   - old_text === new_text is refused as a no-op: nothing would change,
 *     and a silent success would teach the model its edit landed;
 *   - every write carries the revision it was planned against
 *     (expectedRevision CAS), so a concurrent writer turns the mutation
 *     into a WorkspaceConflictError instead of a silent overwrite;
 *   - control-plane paths and binary envelopes are refused, never
 *     decoded or partially written.
 */

import type { JsonValue, Tool, ToolExecutionResult } from "../../core/contracts";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, WorkspaceConflictError, type WorkspacePort } from "../../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../../workspace/content-codec";
import { objectArguments, rawString, requiredString } from "../../tools/schema";

/**
 * Full-replace byte ceiling: generous enough to author whole modules,
 * small enough that a write cannot smoke a multi-megabyte payload through
 * a single model tool call. Host-configurable at the factory.
 */
const DEFAULT_WRITE_MAX_BYTES = 1_048_576;

/** old_text match bound, mirroring airship replace_text (256 KiB). */
const MAX_EDIT_OLD_TEXT_CHARS = 262_144;
/** new_text payload bound, mirroring airship replace_text (1 MiB). */
const MAX_EDIT_NEW_TEXT_CHARS = 1_048_576;

export type PrimeWriteFileBudgets = Readonly<{
  maxWriteBytes: number;
}>;

export const DEFAULT_PRIME_WRITE_BUDGETS: PrimeWriteFileBudgets = Object.freeze({
  maxWriteBytes: DEFAULT_WRITE_MAX_BYTES,
});

function modelVisiblePath(value: JsonValue | undefined, name: string): string {
  const path = normalizeWorkspacePath(requiredString(value, name));
  if (isWorkspaceControlPlanePath(path)) {
    throw new Error("prime file tools exclude Airship control-plane paths: " + path);
  }
  return path;
}

function optionalRevision(value: JsonValue | undefined, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string or null.`);
  return value;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Non-overlapping literal occurrences, the same count airship's replace_text reports. */
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

export function createPrimeWriteFileTool(
  workspace: WorkspacePort,
  budgets: PrimeWriteFileBudgets = DEFAULT_PRIME_WRITE_BUDGETS,
): Tool {
  return {
    definition: {
      name: "write_file",
      description:
        "Create or fully replace one UTF-8 workspace file. Pair expected_revision with a read_file metadata value " +
        "to refuse the write when the file changed underneath you (create with null to require absence).",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", maxLength: budgets.maxWriteBytes },
          expected_revision: { type: ["string", "null"], description: "Revision an earlier read/edit returned; null requires the file to not exist." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const path = modelVisiblePath(args.path, "path");
      const content = rawString(args.content, "content");
      const expectedRevision = optionalRevision(args.expected_revision, "expected_revision");
      const contentBytes = byteLength(content);
      if (contentBytes > budgets.maxWriteBytes) {
        throw new Error(`write_file content is ${String(contentBytes)} bytes, over the ${String(budgets.maxWriteBytes)}-byte write budget; split the file across write_file plus edit_file calls.`);
      }
      const before = await workspace.read(path);
      /*
       * The create-only guard (expected_revision: null on a present file)
       * is delegated to the port's compare-and-swap: the refusal reaches
       * the seam as a WorkspaceConflictError ("the file already exists"),
       * which is the one layer that owns revisions and the one the journal
       * shape documents. Every write attempt is routed through it so a
       * refused plan leaves the same evidence the real backends leave.
       */
      const file = await workspace.write(path, content, { expectedRevision });
      return {
        content: `${before ? "Replaced" : "Wrote"} ${file.path} (${String(byteLength(file.content))} bytes).`,
        metadata: {
          path: file.path,
          revision: file.revision,
          size: byteLength(file.content),
          created: before === undefined,
          ...(before ? { previousRevision: before.revision } : {}),
        },
      };
    },
  };
}

export function createPrimeEditFileTool(workspace: WorkspacePort): Tool {
  return {
    definition: {
      name: "edit_file",
      description:
        "Replace exact text in one UTF-8 workspace file. old_text must match exactly once unless replace_all is true, " +
        "a missing match or a no-op edit is refused, and the write is revision-checked against the read that planned it.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string", minLength: 1, maxLength: MAX_EDIT_OLD_TEXT_CHARS },
          new_text: { type: "string", maxLength: MAX_EDIT_NEW_TEXT_CHARS },
          replace_all: { type: "boolean", default: false },
          expected_revision: { type: "string", description: "Revision an earlier read returned; the edit refuses a file that has since changed." },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const path = modelVisiblePath(args.path, "path");
      const oldText = requiredString(args.old_text, "old_text");
      const newText = rawString(args.new_text, "new_text");
      const replaceAll = args.replace_all === undefined ? false : args.replace_all;
      if (typeof replaceAll !== "boolean") throw new Error("replace_all must be a boolean.");
      const expectedRevision = optionalRevision(args.expected_revision, "expected_revision");
      if (oldText === newText) {
        return {
          content: `Refused a no-op edit in ${path}: old_text and new_text are identical, so the file would be byte-identical after the edit.`,
          isError: true,
          metadata: { path, noOp: true },
        };
      }

      const file = await workspace.read(path);
      if (!file) return { content: `File not found: ${path}`, isError: true, metadata: { path } };
      if (isWorkspaceBinaryEnvelope(file.content)) {
        return { content: `Refused text edit in binary file: ${path}.`, isError: true, metadata: { path, encoding: "binary" } };
      }
      if (expectedRevision !== undefined && expectedRevision !== file.revision) {
        throw new WorkspaceConflictError(`edit_file expected revision ${expectedRevision} but ${path} is at ${file.revision}; re-read the file and re-plan the edit.`);
      }

      const occurrences = countOccurrences(file.content, oldText);
      if (occurrences === 0) {
        return { content: `edit_file found no occurrence of old_text in ${path}.`, isError: true, metadata: { path, occurrences: 0 } };
      }
      if (!replaceAll && occurrences !== 1) {
        return {
          content: `Refused ambiguous edit: old_text occurs ${String(occurrences)} times in ${path}. Widen old_text to a unique passage or set replace_all: true.`,
          isError: true,
          metadata: { path, occurrences },
        };
      }

      /*
       * The write is planned against `file.revision`, not the caller's
       * declared one: a caller who skipped expected_revision still gets
       * the workspace's only concurrent-writer defense, while a caller
       * who declared one was checked above and the same token re-checks
       * at write time.
       */
      const content = replaceAll ? file.content.split(oldText).join(newText) : file.content.replace(oldText, newText);
      const written = await workspace.write(path, content, { expectedRevision: file.revision });
      const replacements = replaceAll ? occurrences : 1;
      return {
        content: `Edited ${written.path}: replaced ${String(replacements)} occurrence${replacements === 1 ? "" : "s"}.`,
        metadata: {
          path: written.path,
          revision: written.revision,
          previousRevision: file.revision,
          size: byteLength(written.content),
          replacements,
          replaceAll,
        },
      };
    },
  };
}
