import { sha256 } from "../../core/hash";
import type { ExecutionAdapter, ExecutionResult } from "../../execution/runtime-registry";
import { MemoryWorkspace } from "../../workspace/memory";
import type { WorkspacePort } from "../../workspace/contracts";
import { decodeWorkspaceBytes } from "../../workspace/content-codec";
import {
  EGRESS_ENVELOPE_MARKER,
  NODE_EGRESS_BODY_HARD_LIMIT,
  NODE_EGRESS_RELAY_SCRIPT,
  NODE_EGRESS_RESULT_NAME,
  NODE_EGRESS_SCRIPT_NAME,
} from "./node-egress-script";

/**
 * Client-side egress over the Node.js WebContainer engine.
 *
 * The browser's same-origin read policy applies to page fetches, not to the
 * Node runtime Airship ships for execution. This engine mounts the reviewed
 * egress relay program (node-egress-script) into that runtime, runs it, and
 * reconciles the staged body back through the WebContainer workspace channel.
 * No server, no per-site CORS cooperation — the proxy is the client's own
 * containerized Node, served by the page itself.
 *
 * Bounds (structural, not policy):
 *   - activation is the runtime's own 30 s cold-start budget, once per page;
 *   - each run has a 45 s total job budget (30 s for network, then export)
 *     and a hard body cap of NODE_EGRESS_BODY_HARD_LIMIT (8 MiB), exactly the
 *     runtime's reviewed workspace-delta return channel;
 *   - the staged body is verified against the envelope's SHA-256 before it is
 *     trusted, and scrubbed after reads so a later run never inherits it.
 */

export type NodeEgressSuccess = Readonly<{
  ok: true;
  status: number;
  finalUrl: string;
  contentType: string;
  /**
   * The verified body, as bytes. Not text: the relay stages whatever the
   * origin sent, and decoding here would corrupt every non-UTF-8 answer before
   * the reader ever saw it. `fetch_url` classifies and decodes.
   */
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
  redirects: number;
  transportAttempts?: number;
  elapsedMs?: number;
  preview: string;
}>;

export type NodeEgressFailure = Readonly<{
  ok: false;
  code: string;
  message: string;
  /** Present when the origin (not the transport) answered: transport was fine. */
  status?: number;
  /** Node requests made before the relay returned or exhausted transient retries. */
  transportAttempts?: number;
}>;

export type NodeEgressResult = NodeEgressSuccess | NodeEgressFailure;

export interface ClientNodeEgressPort {
  fetch(target: URL, init: Readonly<{ maxBytes: number; signal: AbortSignal }>): Promise<NodeEgressResult>;
}

export type NodeEgressActivate = (signal: AbortSignal, timeoutMs: number) => Promise<ExecutionAdapter>;

export type ClientNodeEgressOptions = Readonly<{
  /** The containing execution pack supplies the page-lifetime WebContainer. */
  activate: NodeEgressActivate;
  /** Production sets this; injected unit adapters can run in a Node test realm. */
  requireBrowserHost?: boolean;
  /** Test seam: the real scratch workspace is a page-local in-memory mount. */
  workspace?: WorkspacePort;
}>;

const ACTIVATION_BUDGET_MS = 30_000;
const NETWORK_BUDGET_MS = 30_000;
const JOB_BUDGET_MS = 45_000;
const PREVIEW_BYTES = 16 * 1_024;
const MAX_ENVELOPE_TAIL = 2_048;

const SCRIPT_PATH = `/workspace/${NODE_EGRESS_SCRIPT_NAME}`;
const RESULT_PATH = `/workspace/${NODE_EGRESS_RESULT_NAME}`;

export function createClientNodeEgress(options: ClientNodeEgressOptions): ClientNodeEgressPort {
  const activate = options.activate;
  const requiresBrowserHost = options.requireBrowserHost === true;
  let workspace = options.workspace;
  // Adapter execution is serialized, but body verification and scratch cleanup
  // happen after it resolves. Serialize that complete lifecycle as well so a
  // parallel fetch cannot snapshot the previous run's bulk result.
  let egressTail = Promise.resolve();

  async function scratch(): Promise<WorkspacePort> {
    if (!workspace) {
      workspace = new MemoryWorkspace();
      await workspace.write(SCRIPT_PATH, NODE_EGRESS_RELAY_SCRIPT);
    }
    // A staged body is bulk state: it must never ride into the next run's
    // input snapshot (the mount rejects files above 2 MiB) and never be
    // mistaken for a fresh answer.
    await workspace.remove(RESULT_PATH).catch(() => undefined);
    return workspace;
  }

  async function fetchOne(
    target: URL,
    init: Readonly<{ maxBytes: number; signal: AbortSignal }>,
  ): Promise<NodeEgressResult> {
    if (init.signal.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (requiresBrowserHost && typeof document === "undefined") {
      return {
        ok: false,
        code: "node-egress-unavailable",
        message: "The client Node egress engine requires a browser tab; none exists in this realm.",
      };
    }
    const maxBytes = Math.min(Math.max(Math.floor(init.maxBytes) || NODE_EGRESS_BODY_HARD_LIMIT, 1_024), NODE_EGRESS_BODY_HARD_LIMIT);
    const activeWorkspace = await scratch();
    let run: ExecutionResult;
    try {
      const adapter = await activate(init.signal, ACTIVATION_BUDGET_MS);
      run = await adapter.execute({
        runtime: "node-webcontainer",
        command: "node",
        args: [NODE_EGRESS_SCRIPT_NAME],
        env: {
          AIRSHIP_EGRESS_TARGET: target.toString(),
          AIRSHIP_EGRESS_MAX_BYTES: String(maxBytes),
          AIRSHIP_EGRESS_PREVIEW_BYTES: String(PREVIEW_BYTES),
          AIRSHIP_EGRESS_TIMEOUT_MS: String(NETWORK_BUDGET_MS),
        },
        workspaceRoot: "/workspace",
        workspace: activeWorkspace,
        writeBack: true,
        timeoutMs: JOB_BUDGET_MS,
        signal: init.signal,
      });
    } catch (error) {
      if (init.signal.aborted) throw init.signal.reason ?? error;
      return {
        ok: false,
        code: "node-egress-unavailable",
        message: `The client Node egress engine could not run: ${errorMessage(error)}`,
      };
    }
    return settle(activeWorkspace, run);
  }

  return {
    fetch(target, init) {
      const run = egressTail.then(() => fetchOne(target, init));
      egressTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

async function settle(workspace: WorkspacePort, run: ExecutionResult): Promise<NodeEgressResult> {
  try {
    const envelope = parseEnvelope(run);
    if (!envelope) {
      return {
        ok: false,
        code: "node-egress-runtime",
        message: `The egress relay returned no result envelope (exit ${run.exitCode}). Tail: ${tail(run.stdout)}`,
      };
    }
    if (envelope.ok !== true) {
      const transportAttempts = numberField(envelope.transportAttempts, 0);
      return {
        ok: false,
        code: typeof envelope.code === "string" ? envelope.code : "transport",
        message: typeof envelope.message === "string" ? envelope.message.slice(0, 512) : "The egress relay failed without a message.",
        ...(transportAttempts > 0 ? { transportAttempts } : {}),
      };
    }
    const staged = await workspace.read(RESULT_PATH).catch(() => undefined);
    if (!staged) {
      return {
        ok: false,
        code: "node-egress-integrity",
        message: "The relay reported a body but the staged body was absent; the result was discarded.",
      };
    }
    const bytes = decodeWorkspaceBytes(staged.content);
    const expectedBytes = numberField(envelope.resultBytes, -1);
    const digest = await sha256(bytes);
    if (expectedBytes !== bytes.byteLength || envelope.resultSha256 !== digest) {
      return {
        ok: false,
        code: "node-egress-integrity",
        message: "The staged body did not match its envelope size and SHA-256; the result was discarded rather than trusted.",
      };
    }
    return {
      ok: true,
      status: numberField(envelope.status, 0),
      finalUrl: stringField(envelope.finalUrl, ""),
      contentType: stringField(envelope.contentType, ""),
      bytes,
      byteLength: bytes.byteLength,
      truncated: envelope.truncated === true,
      redirects: numberField(envelope.redirects, 0),
      ...(numberField(envelope.transportAttempts, 0) > 0
        ? { transportAttempts: numberField(envelope.transportAttempts, 0) }
        : {}),
      ...(typeof envelope.elapsedMs === "number" ? { elapsedMs: envelope.elapsedMs } : {}),
      preview: stringField(envelope.preview, ""),
    };
  } finally {
    // Bulk output is page-local scratch, never agent workspace state.
    await workspace.remove(RESULT_PATH).catch(() => undefined);
  }
}

type EgressEnvelope = Readonly<Record<string, unknown>>;

function parseEnvelope(run: ExecutionResult): EgressEnvelope | null {
  const cleaned = run.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const at = cleaned.lastIndexOf(EGRESS_ENVELOPE_MARKER);
  if (at < 0) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(at + EGRESS_ENVELOPE_MARKER.length).trim());
    return parsed !== null && typeof parsed === "object" ? parsed as EgressEnvelope : null;
  } catch {
    return null;
  }
}

function tail(stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length > MAX_ENVELOPE_TAIL ? `…${trimmed.slice(-MAX_ENVELOPE_TAIL)}` : trimmed;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown failure");
  return raw.length > 512 ? `${raw.slice(0, 512)}…` : raw;
}

