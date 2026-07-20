import type {
  DcapVerificationResult,
  DcapVerifierInput,
  NonVerifiedResult,
  VerifierPort,
} from "../types";
import { createIntelDcapVerifierPort } from "./intel-dcap";

const DEFAULT_PCCS = "https://pccs.phala.network";

type QvlModule = typeof import("./qvl-wasm/airship_dcap_qvl.js");
type QvlReport = Readonly<{
  status?: unknown;
  advisory_ids?: unknown;
  qe_status?: unknown;
  platform_status?: unknown;
  report?: unknown;
}>;
type QvlParsedQuote = Readonly<{
  version?: unknown;
  attestationKeyType?: unknown;
  teeType?: unknown;
  bodyType?: unknown;
  reportBodyOffset?: unknown;
  reportBodyLength?: unknown;
  signatureDataLength?: unknown;
  reportData?: unknown;
}>;

type ValidatedQvlReport = Readonly<{
  status: string;
  advisoryIds: string[];
  qeStatus: Readonly<{ status: string; advisoryIds: string[] }>;
  platformStatus: Readonly<{ status: string; advisoryIds: string[] }>;
}>;

export type IntelDcapQvlOptions = Readonly<{
  collateralBase?: string;
  loadQvl?: () => Promise<QvlModule>;
  compactFallback?: VerifierPort<DcapVerifierInput, DcapVerificationResult>;
}>;

let qvlModulePromise: Promise<QvlModule> | undefined;

async function loadBundledQvl(): Promise<QvlModule> {
  qvlModulePromise ??= import("./qvl-wasm/airship_dcap_qvl.js").then(async (module) => {
    await module.default();
    return module;
  });
  return qvlModulePromise;
}

/**
 * Complete Intel DCAP quote verification, executed locally in deferred WASM.
 * Network services only deliver Intel-signed collateral; the verdict is made
 * by the browser. If full QVL cannot run, the existing compact checker still
 * returns its exact partial/failed diagnosis and never promotes the claim.
 */
export function createIntelDcapQvlVerifierPort(
  options: IntelDcapQvlOptions = {},
): VerifierPort<DcapVerifierInput, DcapVerificationResult> {
  const loadQvl = options.loadQvl ?? loadBundledQvl;
  const compact = options.compactFallback ?? createIntelDcapVerifierPort({
    ...(options.collateralBase ? { collateralBase: options.collateralBase } : {}),
  });
  const pccs = (options.collateralBase ?? DEFAULT_PCCS).replace(/\/$/u, "");
  return {
    id: "intel-dcap-qvl-wasm",
    version: "dcap-qvl/0.5.2",
    async verify(input, signal) {
      if (signal?.aborted) return unavailable("Intel DCAP QVL was cancelled before verification.");
      if (input.parsedQuote.attestationKeyType === 3) {
        return unavailable(
          "Intel TDX attestation key type 3 is accepted by Chutes, but the bundled dcap-qvl verifier supports only key type 2; this quote was not verified.",
        );
      }
      const quotedBinding = hex(input.parsedQuote.reportData.subarray(0, 32));
      if (quotedBinding !== input.expectedBindingDigestHex.toLowerCase()) {
        return failed("TDX report_data does not bind the fresh nonce and selected endpoint key.");
      }
      try {
        const qvl = await loadQvl();
        if (signal?.aborted) return unavailable("Intel DCAP QVL was cancelled before collateral retrieval.");
        const rawQuote = Array.from(input.parsedQuote.bytes);
        const normalized = validateParsedQuote(qvl.parse_quote(rawQuote) as QvlParsedQuote);
        assertSameParsedQuote(input.parsedQuote, normalized);
        const collateral = await withTimeout(
          qvl.get_collateral(pccs, rawQuote),
          25_000,
          "Intel collateral retrieval exceeded 25 seconds.",
        );
        if (signal?.aborted) return unavailable("Intel DCAP QVL was cancelled before quote evaluation.");
        const report = qvl.verify_quote(
          rawQuote,
          collateral,
          BigInt(Math.floor(Date.now() / 1_000)),
        ) as QvlReport;
        const validated = validateQvlReport(report);
        const allAdvisories = [
          ...validated.advisoryIds,
          ...validated.qeStatus.advisoryIds,
          ...validated.platformStatus.advisoryIds,
        ];
        if (
          validated.status !== "UpToDate" ||
          validated.qeStatus.status !== "UpToDate" ||
          validated.platformStatus.status !== "UpToDate" ||
          allAdvisories.length > 0
        ) {
          return failed(
            `Intel DCAP QVL returned ${validated.status}${allAdvisories.length ? ` (${allAdvisories.join(", ")})` : ""}.`,
            { ...validated, advisoryIds: allAdvisories },
          );
        }
        const collateralDigest = await sha256Json(collateral);
        return {
          status: "verified",
          summary: "Intel DCAP QVL verified the TDX quote, Intel production trust chain, revocation lists, QE Identity, collateral windows, debug prohibition, and an UpToDate TCB locally in this browser. Chutes runtime measurements are evaluated separately.",
          signatureVerified: true,
          tcbVerified: true,
          policyVerified: true,
          debugDisabled: true,
          policyDigest: collateralDigest,
          details: jsonSafe({
            engine: "dcap-qvl/0.5.2 (WASM)",
            execution: "client-browser",
            collateralTransport: pccs,
            collateralDigest,
            clockBasis: "browser-wall-clock",
            tcbStatus: validated.status,
            advisoryIds: allAdvisories,
            qeStatus: validated.qeStatus,
            platformStatus: validated.platformStatus,
          }),
        };
      } catch (error) {
        if (input.parsedQuote.version === 5) {
          return unavailable(
            `Intel DCAP QVL could not verify this quote-v5 evidence: ${safeError(error)}`,
          );
        }
        const diagnosis = await compact.verify(input, signal);
        if (diagnosis.status === "verified") return diagnosis;
        const qvlError = safeError(error);
        return {
          status: diagnosis.status,
          summary: `${diagnosis.summary} Full local DCAP QVL was unavailable: ${qvlError}`,
          details: jsonSafe({
            qvl: "unavailable",
            qvlError,
            compact: jsonSafe(diagnosis.details),
          }),
        };
      }
    },
  };
}

function validateParsedQuote(value: QvlParsedQuote): {
  version: number;
  attestationKeyType: number;
  teeType: number;
  bodyType: number;
  reportBodyOffset: number;
  reportBodyLength: number;
  signatureDataLength: number;
  reportData: Uint8Array;
} {
  if (!value || typeof value !== "object") throw new Error("DCAP QVL returned a malformed parsed quote.");
  const integer = (field: keyof QvlParsedQuote) => {
    const result = value[field];
    if (!Number.isSafeInteger(result)) throw new Error(`DCAP QVL returned malformed ${field}.`);
    return result as number;
  };
  const reportData = value.reportData instanceof Uint8Array
    ? value.reportData
    : Array.isArray(value.reportData) && value.reportData.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ? Uint8Array.from(value.reportData)
      : undefined;
  if (!reportData || reportData.byteLength !== 64) {
    throw new Error("DCAP QVL returned malformed reportData.");
  }
  return {
    version: integer("version"),
    attestationKeyType: integer("attestationKeyType"),
    teeType: integer("teeType"),
    bodyType: integer("bodyType"),
    reportBodyOffset: integer("reportBodyOffset"),
    reportBodyLength: integer("reportBodyLength"),
    signatureDataLength: integer("signatureDataLength"),
    reportData,
  };
}

function assertSameParsedQuote(
  parsed: DcapVerifierInput["parsedQuote"],
  normalized: ReturnType<typeof validateParsedQuote>,
): void {
  for (const field of [
    "version",
    "attestationKeyType",
    "teeType",
    "bodyType",
    "reportBodyOffset",
    "reportBodyLength",
    "signatureDataLength",
  ] as const) {
    if (parsed[field] !== normalized[field]) {
      throw new Error(`Browser and Rust QVL quote parsing disagree on ${field}.`);
    }
  }
  if (hex(parsed.reportData) !== hex(normalized.reportData)) {
    throw new Error("Browser and Rust QVL quote parsing disagree on report_data.");
  }
}

function failed(summary: string, details?: Record<string, unknown>): NonVerifiedResult {
  return { status: "failed", summary, ...(details ? { details: jsonSafe(details) } : {}) };
}

function unavailable(summary: string): NonVerifiedResult {
  return { status: "unavailable", summary };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateQvlReport(report: QvlReport): ValidatedQvlReport {
  if (!report || typeof report !== "object" || !report.report || typeof report.report !== "object") {
    throw new Error("DCAP QVL returned a malformed verified report.");
  }
  if (typeof report.status !== "string" || !Array.isArray(report.advisory_ids)) {
    throw new Error("DCAP QVL omitted the aggregate TCB status or advisory list.");
  }
  const parseStatus = (value: unknown, label: string) => {
    if (!value || typeof value !== "object") throw new Error(`DCAP QVL omitted ${label}.`);
    const record = value as Record<string, unknown>;
    if (typeof record.status !== "string" || !Array.isArray(record.advisory_ids)) {
      throw new Error(`DCAP QVL returned malformed ${label}.`);
    }
    if (record.advisory_ids.some((item) => typeof item !== "string")) {
      throw new Error(`DCAP QVL returned a malformed ${label} advisory list.`);
    }
    return { status: record.status, advisoryIds: stringArray(record.advisory_ids) };
  };
  if (report.advisory_ids.some((item) => typeof item !== "string")) {
    throw new Error("DCAP QVL returned a malformed aggregate advisory list.");
  }
  return {
    status: report.status,
    advisoryIds: stringArray(report.advisory_ids),
    qeStatus: parseStatus(report.qe_status, "QE status"),
    platformStatus: parseStatus(report.platform_status, "platform status"),
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${hex(digest)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      (error) => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

function safeError(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "unknown QVL error";
  return message.replace(/\s+/gu, " ").slice(0, 240);
}

function jsonSafe(value: unknown): import("../../core/contracts").JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as import("../../core/contracts").JsonValue;
  } catch {
    return null;
  }
}
