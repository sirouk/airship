/**
 * The prime-native `read_file` tool: prime-agent's line-oriented read
 * semantics (1-indexed `offset`, `limit` in lines, head truncation with a
 * model-actionable continuation notice) over airship's WorkspacePort.
 *
 * Why this is not airship's byte-window `read_file`: prime-agent's read
 * tool is line-shaped because line numbers are the currency a coding
 * agent navigates with — and its truncation policy (upstream truncate.ts:
 * 2,000 lines or 50 KiB, never a partial line, a first line over budget
 * named with its own size) is what ported prompts and skills plan
 * against. The shapes that *must* match airship — control-plane refusal,
 * binary-envelope refusal, notice-first content, revision in metadata —
 * come from src/tools/workspace-tools.ts and src/workspace/contracts.ts.
 *
 * Boundedness policy (fail-closed, every bound named):
 *   - at most `readScanBytes` of storage content are fetched per call
 *     (`readBounded` when the port offers it; a full read is the named
 *     fallback); a windowed read says so and reports only the lines it
 *     can vouch are complete;
 *   - the returned window never exceeds `maxLines` lines or `maxBytes`
 *     bytes, whichever fires first, and never ends mid-line;
 *   - the continuation notice leads the content, because airship's
 *     context guard cuts result *tails* and metadata never reaches the
 *     model (src/core/agent.ts) — a trailing notice is the first thing
 *     deleted exactly when it matters most.
 */

import type { JsonValue, Tool, ToolExecutionResult } from "../../core/contracts";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, type WorkspaceFile, type WorkspacePort } from "../../workspace/contracts";
import { isWorkspaceBinaryEnvelope } from "../../workspace/content-codec";
import { objectArguments, requiredString } from "../../tools/schema";

/**
 * Head policy from prime-agent's truncate.ts (DEFAULT_MAX_LINES,
 * DEFAULT_MAX_BYTES). Kept identical so ported prompts that plan around
 * upstream's 2,000-line/50 KiB read window still plan correctly.
 */
const DEFAULT_READ_MAX_LINES = 2_000;
const DEFAULT_READ_MAX_BYTES = 50 * 1_024;

/**
 * Storage-scan ceiling per call. Upstream read the whole file and
 * truncated the presentation; here the storage read itself is bounded, so
 * a 40 MiB file cannot charge a full read through the tool before the
 * window policy says no. Sits at the registry's 1 MiB output ceiling
 * (src/tools/registry.ts MAX_TOOL_OUTPUT_BYTES), so window extraction
 * can never produce a result the registry must refuse.
 */
const DEFAULT_READ_SCAN_BYTES = 1_048_576;

/** Per-call knobs the host may tighten; the documented defaults stand when it does not. */
export type PrimeReadFileBudgets = Readonly<{
  maxLines: number;
  maxBytes: number;
  readScanBytes: number;
}>;

export const DEFAULT_PRIME_READ_BUDGETS: PrimeReadFileBudgets = Object.freeze({
  maxLines: DEFAULT_READ_MAX_LINES,
  maxBytes: DEFAULT_READ_MAX_BYTES,
  readScanBytes: DEFAULT_READ_SCAN_BYTES,
});

/**
 * Which bound stopped the read. `limit` names the caller's own line cap:
 * a result partial because the caller asked for a window is a different
 * fact than one partial because a budget fired, and the model reads it.
 */
export type PrimeReadTruncatedBy = "lines" | "bytes" | "scan" | "limit" | null;

function integerArgument(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
}

function modelVisiblePath(value: JsonValue | undefined, name: string): string {
  const path = normalizeWorkspacePath(requiredString(value, name));
  if (isWorkspaceControlPlanePath(path)) {
    throw new Error(`prime read_file excludes Airship control-plane paths: ${path}`);
  }
  return path;
}

/**
 * The upstream truncate.ts head policy, restated without Buffer: keep
 * whole lines from the head until the line budget *or* the byte budget
 * fires, never emit a partial line, and name the bound that fired.
 */
function truncateHeadLines(
  lines: readonly string[],
  maxLines: number,
  maxBytes: number,
): Readonly<{ kept: readonly string[]; bytes: number; truncatedBy: "lines" | "bytes" | null; firstLineExceedsBytes: number | undefined }> {
  const encoder = new TextEncoder();
  const allBytes = encoder.encode(lines.join("\n")).byteLength;
  if (lines.length <= maxLines && allBytes <= maxBytes) {
    return Object.freeze({ kept: lines, bytes: allBytes, truncatedBy: null, firstLineExceedsBytes: undefined });
  }
  const firstLineBytes = lines.length > 0 ? encoder.encode(lines[0] ?? "").byteLength : 0;
  if (lines.length > 0 && firstLineBytes > maxBytes) {
    return Object.freeze({ kept: [], bytes: 0, truncatedBy: "bytes", firstLineExceedsBytes: firstLineBytes });
  }
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (const [index, line] of lines.entries()) {
    if (index >= maxLines) break;
    const lineBytes = encoder.encode(line).byteLength + (index > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return Object.freeze({ kept, bytes, truncatedBy: kept.length >= lines.length ? null : truncatedBy, firstLineExceedsBytes: undefined });
}

/**
 * Fetch at most `scanBytes` of the file's bytes. When the scan stops
 * inside the file, the held tail can end mid-line (or mid-codepoint on
 * ports whose readBounded slices bytes with a non-fatal decoder): strip
 * one trailing U+FFFD seam, then drop the last line unless the slice
 * provably ended on a newline. A half-line shown as whole invites the
 * model to quote bytes that never existed.
 */
async function scanFile(
  workspace: WorkspacePort,
  path: string,
  scanBytes: number,
): Promise<Readonly<{ file: WorkspaceFile; lines: readonly string[]; scanComplete: boolean; totalBytes: number }> | undefined> {
  const file = workspace.readBounded
    ? await workspace.readBounded(path, scanBytes)
    : await workspace.read(path);
  if (!file) return undefined;
  if (isWorkspaceBinaryEnvelope(file.content)) {
    return Object.freeze({ file, lines: [], scanComplete: true, totalBytes: file.size });
  }
  let text = file.content;
  const scannedBytes = new TextEncoder().encode(text).byteLength;
  const totalBytes = file.size;
  const scanComplete = scannedBytes >= totalBytes;
  if (!scanComplete && text.endsWith("\uFFFD")) text = text.slice(0, -1);
  const rawLines = text.split("\n");
  const lines = !scanComplete && !text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
  return Object.freeze({ file, lines, scanComplete, totalBytes });
}

export function createPrimeReadFileTool(
  workspace: WorkspacePort,
  budgets: PrimeReadFileBudgets = DEFAULT_PRIME_READ_BUDGETS,
): Tool {
  return {
    definition: {
      name: "read_file",
      description:
        `Read one UTF-8 workspace file by 1-indexed line range. Output is bounded to ${String(budgets.maxLines)} lines or ` +
        `${String(Math.floor(budgets.maxBytes / 1024))} KiB, whichever fires first, never ends mid-line, and a partial read ` +
        "leads with the line its continuation should start at.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace path; unrooted paths resolve under /workspace." },
          offset: { type: "integer", minimum: 1, description: "1-indexed line to start from. Use the nextOffsetLine a partial read reports." },
          limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue): Promise<ToolExecutionResult> {
      const args = objectArguments(argumentsValue);
      const path = modelVisiblePath(args.path, "path");
      const offset = integerArgument(args.offset, "offset") ?? 1;
      const limit = integerArgument(args.limit, "limit");
      if (offset < 1) throw new Error("offset is 1-indexed and must be at least 1.");
      if (limit !== undefined && limit < 1) throw new Error("limit must be at least 1.");

      const scanned = await scanFile(workspace, path, budgets.readScanBytes);
      if (!scanned) return { content: `File not found: ${path}`, isError: true, metadata: { path } };
      if (isWorkspaceBinaryEnvelope(scanned.file.content)) {
        return {
          content: `Binary file is not available through read_file: ${path}. Use execute_code for byte-level access.`,
          isError: true,
          metadata: { path, revision: scanned.file.revision, encoding: "binary", size: scanned.file.size },
        };
      }

      const lines = scanned.lines;
      const startIndex = offset - 1;
      if (startIndex >= lines.length) {
        const known = scanned.scanComplete
          ? `which has ${String(lines.length)} lines`
          : `of which the bounded scan (${String(budgets.readScanBytes)} of ${String(scanned.totalBytes)} bytes) holds ${String(lines.length)} complete lines`;
        return {
          content: `read_file offset ${String(offset)} is beyond the end of ${path}, ${known}.`,
          isError: true,
          metadata: {
            path,
            revision: scanned.file.revision,
            offset,
            scannedLines: lines.length,
            totalBytes: scanned.totalBytes,
            scanComplete: scanned.scanComplete,
          },
        };
      }

      const selected = limit !== undefined ? lines.slice(startIndex, startIndex + limit) : lines.slice(startIndex);
      const head = truncateHeadLines(selected, budgets.maxLines, budgets.maxBytes);
      if (head.firstLineExceedsBytes !== undefined) {
        return {
          content:
            `Line ${String(offset)} of ${path} is ${String(head.firstLineExceedsBytes)} bytes, exceeding the ${String(budgets.maxBytes)}-byte read budget. ` +
            "Use search_text to locate content inside it, or execute_code for byte-level access.",
          isError: true,
          metadata: { path, revision: scanned.file.revision, offset, lineBytes: head.firstLineExceedsBytes, maxBytes: budgets.maxBytes },
        };
      }

      /*
       * `truncatedBy` precedence mirrors the way a continuation differs:
       * presentation budgets (`lines`/`bytes`) resume at the next line;
       * `limit` is the caller's own window and resumed by passing a new
       * offset; `scan` means the storage bound stopped the read and the
       * file is larger than any metadata here vouches for.
       */
      const endLine = offset + head.kept.length - 1;
      const fileHasMore = !scanned.scanComplete || endLine < lines.length;
      const truncatedBy: PrimeReadTruncatedBy = !fileHasMore
        ? null
        : head.truncatedBy ?? (endLine < lines.length ? "limit" : "scan");
      const notice = fileHasMore
        ? `[prime read_file returned lines ${String(offset)}\u2013${String(endLine)}` +
          `${scanned.scanComplete ? ` of ${String(lines.length)}` : ""} for ${path} ` +
          `(${String(head.bytes)} of ${String(scanned.totalBytes)} bytes, bounded by ${String(truncatedBy)}). ` +
          `Continue with read_file ${JSON.stringify({ path, offset: endLine + 1 })}.]\n\n`
        : "";
      return {
        content: `${notice}${head.kept.join("\n")}`,
        metadata: {
          path,
          revision: scanned.file.revision,
          offset,
          returnedLines: head.kept.length,
          returnedBytes: head.bytes,
          totalBytes: scanned.totalBytes,
          ...(scanned.scanComplete ? { totalLines: lines.length } : { scannedLines: lines.length }),
          scanComplete: scanned.scanComplete,
          truncated: fileHasMore,
          truncatedBy,
          ...(fileHasMore ? { nextOffsetLine: endLine + 1 } : {}),
        },
      };
    },
  };
}
