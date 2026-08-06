/**
 * Test doubles for the prime tool suite (src/prime/tools).
 *
 * FakeWorkspacePort is byte-honest exactly where the tools depend on it:
 *   - readBounded slices UTF-8 BYTES with a non-fatal decoder, so a
 *     mid-codepoint cut lands in the same U+FFFD seam territory the real
 *     bounded readers produce, while `size` stays the full stored object
 *     size (that is the signal read_file/search_text compute
 *     scanComplete from);
 *   - write/remove enforce the expectedRevision compare-and-swap contract
 *     by throwing the REAL WorkspaceConflictError, because the tools branch
 *     on that error identity (a plain Error would assert nothing about the
 *     CAS seam airship documents in src/workspace/contracts.ts);
 *   - revisions are monotonic `rev-<n>` tokens so tests can pin CAS success
 *     and mismatch wording without reading the fake's mind.
 *
 * Everything else (prefix listing, deterministic timestamps) is the
 * smallest state machine that honors the contract.
 */

import {
  WorkspaceConflictError,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspacePort,
} from "../../workspace/contracts";
import { workspaceContentByteLength } from "../../workspace/content-codec";
import type { ToolContext, ToolOutputChunk } from "../../core/contracts";

interface StoredFile {
  content: string;
  revision: number;
  updatedAt: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FakeWorkspacePort implements WorkspacePort {
  private readonly files = new Map<string, StoredFile>();
  private stamp = 0;
  /** Every write attempt that reached the port, for CAS-plan assertions. */
  readonly writes: Readonly<{ path: string; expectedRevision: string | null | undefined }>[] = [];

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(seed)) {
      this.stamp += 1;
      this.files.set(path, { content, revision: this.stamp, updatedAt: this.timestamp() });
    }
  }

  /** Test-side readback of the stored bytes, so mutations are observable. */
  storedContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const stored = this.files.get(path);
    return stored ? this.fileView(path, stored, stored.content) : undefined;
  }

  async readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    const stored = this.files.get(path);
    if (!stored) return undefined;
    const slice = encoder.encode(stored.content).subarray(0, maxBytes);
    // Non-fatal decode on purpose: a mid-codepoint cut surfaces as a U+FFFD
    // seam, matching what the workspace's real bounded readers hand back.
    return this.fileView(path, stored, decoder.decode(slice));
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: WorkspaceEntry[] = [];
    for (const [storedPath, stored] of this.files) {
      if (storedPath === path || storedPath.startsWith(prefix)) {
        entries.push(this.entryView(storedPath, stored));
      }
    }
    return entries;
  }

  async write(
    path: string,
    content: string,
    options?: { expectedRevision?: string | null },
  ): Promise<WorkspaceFile> {
    const expected = options?.expectedRevision;
    this.writes.push(Object.freeze({ path, expectedRevision: expected }));
    const existing = this.files.get(path);
    if (expected === null && existing) {
      throw new WorkspaceConflictError(
        `Refused to create ${path}: the file already exists at rev-${String(existing.revision)}.`,
      );
    }
    if (typeof expected === "string" && (!existing || `rev-${String(existing.revision)}` !== expected)) {
      throw new WorkspaceConflictError(
        `Refused to write ${path}: expected revision ${expected} but the file is at ${
          existing ? `rev-${String(existing.revision)}` : "absent"
        }.`,
      );
    }
    this.stamp += 1;
    const stored: StoredFile = { content, revision: this.stamp, updatedAt: this.timestamp() };
    this.files.set(path, stored);
    return this.fileView(path, stored, content);
  }

  async remove(path: string, options?: { expectedRevision?: string }): Promise<void> {
    const existing = this.files.get(path);
    if (!existing) throw new WorkspaceConflictError(`Refused to remove ${path}: the file does not exist.`);
    if (options?.expectedRevision !== undefined && `rev-${String(existing.revision)}` !== options.expectedRevision) {
      throw new WorkspaceConflictError(
        `Refused to remove ${path}: expected revision ${options.expectedRevision} but the file is at rev-${String(existing.revision)}.`,
      );
    }
    this.files.delete(path);
  }

  private timestamp(): string {
    return new Date(1_700_000_000_000 + this.stamp).toISOString();
  }

  private fileView(path: string, stored: StoredFile, content: string): WorkspaceFile {
    return {
      path,
      content,
      revision: `rev-${String(stored.revision)}`,
      updatedAt: stored.updatedAt,
      // The full object size, even from a bounded slice: this is the number
      // the tools compare against scanned bytes to name an incomplete scan.
      size: encoder.encode(stored.content).byteLength,
      contentByteLength: workspaceContentByteLength(stored.content),
    };
  }

  private entryView(path: string, stored: StoredFile): WorkspaceEntry {
    return {
      path,
      revision: `rev-${String(stored.revision)}`,
      updatedAt: stored.updatedAt,
      size: encoder.encode(stored.content).byteLength,
      contentByteLength: workspaceContentByteLength(stored.content),
    };
  }
}

/** ToolContext with a recording onOutput; the kernel tool streams into it. */
export function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext & { output: ToolOutputChunk[] } {
  const output: ToolOutputChunk[] = [];
  const base: ToolContext = {
    sessionId: "test-session",
    turnId: "test-turn",
    operationId: "op-test",
    signal: new AbortController().signal,
    ...overrides,
  };
  const forwarded = base.onOutput;
  return {
    ...base,
    onOutput: (chunk) => {
      output.push(chunk);
      forwarded?.(chunk);
    },
    output,
  };
}
