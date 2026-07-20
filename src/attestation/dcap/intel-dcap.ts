/**
 * In-browser Intel TDX (DCAP) quote evidence checker — a real, fail-closed
 * VerifierPort. Verifies the ECDSA path (attestation key → QE report →
 * PCK leaf → intermediate → Intel SGX Root CA), binds report_data to the
 * caller nonce + endpoint key, and evaluates TCB status against Intel-signed
 * collateral. A successful run deliberately returns `partial`: this compact
 * checker does not yet evaluate the PCK/root CRLs, QE Identity, and every
 * collateral validity window required by a complete Intel QVL decision.
 * Anything else fails closed to a non-verified result. Pure WebCrypto; no
 * third-party trust (collateral is Intel-signed).
 *
 * Proven end-to-end against a live Chutes Qwen/Qwen3-32B-TEE quote.
 */
import type {
  DcapVerificationResult,
  DcapVerifierInput,
  NonVerifiedResult,
  VerifierPort,
} from "../types";

/** Intel SGX Root CA — pinned SPKI SHA-256 (the sole external trust anchor). */
const INTEL_SGX_ROOT_CA_SPKI_SHA256 =
  "a0af031289f5d5d4132f9186068a7fc13628633ba235777472e29b6b6c67a49e";

/** Default collateral source. Intel-signed artifacts, so the mirror is not trusted. */
const DEFAULT_COLLATERAL_BASE = "https://pccs.phala.network";

const OID_SGX = "1.2.840.113741.1.13.1";
const subtle = () => globalThis.crypto.subtle;

export type IntelDcapVerifierOptions = Readonly<{
  /** Collateral (PCCS) base URL. Intel-signed content; default is a CORS-enabled mirror. */
  collateralBase?: string;
  fetchImpl?: typeof fetch;
}>;

export function createIntelDcapVerifierPort(
  options: IntelDcapVerifierOptions = {},
): VerifierPort<DcapVerifierInput, DcapVerificationResult> {
  const collateralBase = (options.collateralBase ?? DEFAULT_COLLATERAL_BASE).replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    id: "intel-dcap-webcrypto",
    version: "1.0.0",
    async verify(input, signal) {
      if (input.parsedQuote.attestationKeyType === 3) {
        return unavailable(
          "Intel TDX attestation key type 3 is not supported by the compact WebCrypto verifier; this quote was not verified.",
        );
      }
      if (input.parsedQuote.version === 5) {
        return unavailable(
          "Intel TDX quote-v5 requires the bundled Rust DCAP QVL parser and verifier; the compact verifier did not evaluate it.",
        );
      }
      try {
        return await verifyTdxQuote(input, collateralBase, fetchImpl, signal);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "TDX verification failed.");
      }
    },
  };
}

function fail(summary: string): NonVerifiedResult {
  return { status: "failed", summary };
}
function unavailable(summary: string): NonVerifiedResult {
  return { status: "unavailable", summary };
}

// ---------------------------------------------------------------------------
// bytes / hex helpers
// ---------------------------------------------------------------------------
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexOf(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function sha256(u8: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", u8 as unknown as BufferSource));
}

// ---------------------------------------------------------------------------
// minimal DER / ASN.1
// ---------------------------------------------------------------------------
type DerNode = { tag: number; len: number; headerLen: number; content: Uint8Array; end: number };
function derRead(buf: Uint8Array, pos: number): DerNode {
  const tag = buf[pos]!;
  let i = pos + 1;
  let len = buf[i++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | buf[i++]!;
  }
  const content = buf.subarray(i, i + len);
  return { tag, len, headerLen: i - pos, content, end: i + len };
}
function derChildren(seq: Uint8Array): DerNode[] {
  const out: DerNode[] = [];
  let p = 0;
  while (p < seq.length) {
    const t = derRead(seq, p);
    out.push(t);
    p = t.end;
  }
  return out;
}
/** ECDSA DER signature (SEQ{INT r, INT s}) → IEEE P1363 fixed 64 bytes. */
function derEcdsaToP1363(der: Uint8Array): Uint8Array {
  const [r, s] = derChildren(derRead(der, 0).content);
  const fix = (t: DerNode) => {
    let b = t.content;
    while (b.length > 32 && b[0] === 0) b = b.subarray(1);
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  };
  const out = new Uint8Array(64);
  out.set(fix(r!), 0);
  out.set(fix(s!), 32);
  return out;
}
function oidToStr(bytes: Uint8Array): string {
  const out: number[] = [];
  let v = 0;
  let first = true;
  for (const b of bytes) {
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) {
      if (first) {
        out.push(Math.floor(v / 40), v % 40);
        first = false;
      } else out.push(v);
      v = 0;
    }
  }
  return out.join(".");
}

// ---------------------------------------------------------------------------
// X.509
// ---------------------------------------------------------------------------
type Cert = { tbsRaw: Uint8Array; sigP1363: Uint8Array; spkiDer: Uint8Array; extensionsSeq: Uint8Array | null };
function parseCert(der: Uint8Array): Cert {
  const top = derRead(der, 0);
  const kids = derChildren(top.content);
  const tbsNode = kids[0]!;
  const tbsRaw = der.subarray(top.headerLen, top.headerLen + tbsNode.headerLen + tbsNode.len);
  const tbs = tbsNode.content;
  const sigDer = kids[2]!.content.subarray(1); // strip BIT STRING unused-bits byte
  const tb = derChildren(tbs);
  let idx = 0;
  if ((tb[0]!.tag & 0xa0) === 0xa0) idx = 1; // skip [0] version
  const spkiIdx = idx + 5;
  let off = 0;
  for (let k = 0; k < spkiIdx; k++) off += tb[k]!.headerLen + tb[k]!.len;
  const spkiField = tb[spkiIdx]!;
  const spkiDer = tbs.subarray(off, off + spkiField.headerLen + spkiField.len);
  let extensionsSeq: Uint8Array | null = null;
  for (const c of tb) if ((c.tag & 0xff) === 0xa3) extensionsSeq = derRead(c.content, 0).content;
  return { tbsRaw, sigP1363: derEcdsaToP1363(sigDer), spkiDer, extensionsSeq };
}
function extractSgx(extensionsSeq: Uint8Array | null): { fmspc: string | null; tcbSeq: Uint8Array | null } | null {
  if (!extensionsSeq) return null;
  for (const ext of derChildren(extensionsSeq)) {
    const parts = derChildren(ext.content);
    if (oidToStr(parts[0]!.content) !== OID_SGX) continue;
    const octet = parts[parts.length - 1]!.content;
    const attrs = derChildren(derRead(octet, 0).content);
    let fmspc: string | null = null;
    let tcbSeq: Uint8Array | null = null;
    for (const a of attrs) {
      const [k, val] = derChildren(a.content);
      const koid = oidToStr(k!.content);
      if (koid === OID_SGX + ".4") fmspc = hexOf(val!.content);
      if (koid === OID_SGX + ".2") tcbSeq = val!.content;
    }
    return { fmspc, tcbSeq };
  }
  return null;
}

async function importEcdsaRaw(pub64: Uint8Array): Promise<CryptoKey> {
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(pub64, 1);
  return subtle().importKey("raw", raw as unknown as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}
async function importEcdsaSpki(spki: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("spki", spki as unknown as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}
function ecdsaVerify(key: CryptoKey, sigP1363: Uint8Array, msg: Uint8Array): Promise<boolean> {
  return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, sigP1363 as unknown as BufferSource, msg as unknown as BufferSource);
}

// ---------------------------------------------------------------------------
// TDX quote v4/v5
// ---------------------------------------------------------------------------
type ParsedQuote = {
  version: number;
  headerAndReport: Uint8Array;
  tdReport: Uint8Array;
  reportData: Uint8Array;
  quoteSig: Uint8Array;
  akPub: Uint8Array;
  qeReport: Uint8Array;
  qeReportSig: Uint8Array;
  qeAuth: Uint8Array;
  certData: Uint8Array;
};
function parseQuote(q: Uint8Array): ParsedQuote {
  if (q.length < 636) throw new Error("Quote too short.");
  const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
  const version = dv.getUint16(0, true);
  const teeType = dv.getUint32(4, true);
  if (version !== 4 && version !== 5) throw new Error(`Unsupported quote version ${version}.`);
  if (teeType !== 0x81) throw new Error("Quote is not a TDX quote.");
  const tdReport = q.subarray(48, 632);
  let p = 636; // skip 4-byte signature_data_len
  const quoteSig = q.subarray(p, (p += 64));
  const akPub = q.subarray(p, (p += 64));
  p += 2 + 4; // outer certification_data header (type 6 = QE_REPORT) + size
  const qeReport = q.subarray(p, (p += 384));
  const qeReportSig = q.subarray(p, (p += 64));
  const qeAuthLen = dv.getUint16(p, true);
  p += 2;
  const qeAuth = q.subarray(p, (p += qeAuthLen));
  p += 2; // inner cert_key_type (5 = PCK_CHAIN_PEM)
  const certSize = dv.getUint32(p, true);
  p += 4;
  const certData = q.subarray(p, p + certSize);
  return {
    version,
    headerAndReport: q.subarray(0, 632),
    tdReport,
    reportData: tdReport.subarray(520, 584),
    quoteSig,
    akPub,
    qeReport,
    qeReportSig,
    qeAuth,
    certData,
  };
}
function pemCerts(pem: Uint8Array): Uint8Array[] {
  const text = new TextDecoder().decode(pem);
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu)].map((m) =>
    b64ToBytes(m[1]!.replace(/\s+/gu, "")),
  );
}

// ---------------------------------------------------------------------------
// TCB status (Intel's TDX algorithm — mirrors chutes-api resolve_tdx_tcb_status)
// ---------------------------------------------------------------------------
type TcbVerdict = { status: string; advisoryIds: string[] };
function matchPlatformTcb(
  tcbInfo: Record<string, unknown>,
  teeTcbSvn: number[],
  sgxComps: number[],
  pcesvn: number,
): TcbVerdict {
  const tdxStart = teeTcbSvn[1]! > 0 ? 2 : 0;
  const levels = (tcbInfo.tcbLevels as Array<Record<string, unknown>>) ?? [];
  for (const level of levels) {
    const tcb = level.tcb as Record<string, unknown>;
    if (pcesvn < (tcb.pcesvn as number)) continue;
    const sgxLevel = ((tcb.sgxtcbcomponents as Array<{ svn: number }>) ?? []).map((c) => c.svn);
    if (sgxLevel.length !== sgxComps.length) throw new Error("SGX TCB component count mismatch.");
    if (sgxComps.some((a, i) => a < sgxLevel[i]!)) continue;
    const tdxLevel = ((tcb.tdxtcbcomponents as Array<{ svn: number }>) ?? []).map((c) => c.svn);
    if (tdxLevel.length !== teeTcbSvn.length) throw new Error("TDX TCB component count mismatch.");
    if (teeTcbSvn.slice(tdxStart).some((a, i) => a < tdxLevel[tdxStart + i]!)) continue;
    return { status: level.tcbStatus as string, advisoryIds: (level.advisoryIDs as string[]) ?? [] };
  }
  throw new Error("No matching platform TCB level found.");
}

// ---------------------------------------------------------------------------
// main verification
// ---------------------------------------------------------------------------
async function verifyTdxQuote(
  input: DcapVerifierInput,
  collateralBase: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<DcapVerificationResult> {
  const q = b64ToBytes(input.evidence.quote);
  const p = parseQuote(q);

  // 1) report_data binds the caller nonce + endpoint key.
  const rd0 = hexOf(p.reportData.subarray(0, 32));
  if (rd0 !== input.expectedBindingDigestHex.toLowerCase()) {
    return fail("Quote report_data does not bind the caller nonce and endpoint key.");
  }

  // 2) attestation key signs (header ‖ TD report).
  const akKey = await importEcdsaRaw(p.akPub);
  if (!(await ecdsaVerify(akKey, p.quoteSig, p.headerAndReport))) {
    return fail("Quote signature (attestation key) is invalid.");
  }

  // 3) QE report binds the attestation key.
  const qeBind = await sha256(concat(p.akPub, p.qeAuth));
  if (hexOf(p.qeReport.subarray(320, 352)) !== hexOf(qeBind)) {
    return fail("QE report does not bind the attestation key.");
  }

  // 4) PCK leaf signs the QE report; chain to the pinned Intel Root CA.
  const certs = pemCerts(p.certData);
  if (certs.length < 2) return fail("PCK certificate chain is incomplete.");
  const parsed = certs.map(parseCert);
  const pckLeaf = parsed[0]!;
  if (!(await ecdsaVerify(await importEcdsaSpki(pckLeaf.spkiDer), p.qeReportSig, p.qeReport))) {
    return fail("QE report signature (PCK) is invalid.");
  }
  for (let i = 0; i < parsed.length - 1; i++) {
    const parentKey = await importEcdsaSpki(parsed[i + 1]!.spkiDer);
    if (!(await ecdsaVerify(parentKey, parsed[i]!.sigP1363, parsed[i]!.tbsRaw))) {
      return fail(`PCK chain link ${i} → ${i + 1} is invalid.`);
    }
  }
  const root = parsed[parsed.length - 1]!;
  const rootPin = hexOf(await sha256(root.spkiDer));
  if (rootPin !== INTEL_SGX_ROOT_CA_SPKI_SHA256) {
    return fail("PCK chain does not anchor to the pinned Intel SGX Root CA.");
  }
  if (!(await ecdsaVerify(await importEcdsaSpki(root.spkiDer), root.sigP1363, root.tbsRaw))) {
    return fail("Intel SGX Root CA is not self-consistent.");
  }

  // 5) TD debug mode must be off.
  const debugEnabled = (p.tdReport[120]! & 1) === 1; // td_attributes byte 0, bit 0
  if (debugEnabled) return fail("TD is in debug mode.");

  // 6) TCB evaluation against Intel-signed collateral.
  const sgx = extractSgx(pckLeaf.extensionsSeq);
  if (!sgx?.fmspc || !sgx.tcbSeq) return fail("PCK certificate is missing the SGX FMSPC/TCB extension.");
  const teeTcbSvn = [...p.tdReport.subarray(0, 16)];
  const { sgxComps, pcesvn } = readPckTcb(sgx.tcbSeq);
  if (pcesvn === null || sgxComps.length !== 16) return fail("PCK TCB components could not be parsed.");

  let tcbResp: Response;
  try {
    tcbResp = await fetchImpl(`${collateralBase}/tdx/certification/v4/tcb?fmspc=${sgx.fmspc}`, {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: signal ?? null,
    });
  } catch {
    return unavailable("Intel TCB collateral could not be fetched (network/CORS).");
  }
  if (!tcbResp.ok) return unavailable(`Intel TCB collateral fetch failed (HTTP ${tcbResp.status}).`);
  const issuerChain = tcbResp.headers.get("tcb-info-issuer-chain") ?? tcbResp.headers.get("sgx-tcb-info-issuer-chain");
  const tcbText = await tcbResp.text();
  if (!issuerChain) return unavailable("Intel TCB collateral is missing its issuer chain.");

  // verify the TCB info is Intel-signed and chains to the same pinned root.
  const m = /"tcbInfo":(.*),"signature":"([0-9a-fA-F]+)"/su.exec(tcbText);
  if (!m) return fail("TCB info could not be parsed for signature verification.");
  const tcbInfoBytes = new TextEncoder().encode(m[1]!);
  const tcbSig = hexToBytes(m[2]!);
  const signChain = pemCerts(new TextEncoder().encode(decodeURIComponent(issuerChain))).map(parseCert);
  if (signChain.length < 2) return fail("TCB signing chain is incomplete.");
  if (!(await ecdsaVerify(await importEcdsaSpki(signChain[0]!.spkiDer), tcbSig, tcbInfoBytes))) {
    return fail("TCB info signature (Intel TCB signing cert) is invalid.");
  }
  for (let i = 0; i < signChain.length - 1; i++) {
    if (!(await ecdsaVerify(await importEcdsaSpki(signChain[i + 1]!.spkiDer), signChain[i]!.sigP1363, signChain[i]!.tbsRaw))) {
      return fail("TCB signing chain is invalid.");
    }
  }
  if (hexOf(await sha256(signChain[signChain.length - 1]!.spkiDer)) !== INTEL_SGX_ROOT_CA_SPKI_SHA256) {
    return fail("TCB collateral does not anchor to the pinned Intel SGX Root CA.");
  }

  const tcbInfo = JSON.parse(tcbText).tcbInfo as Record<string, unknown>;
  let verdict: TcbVerdict;
  try {
    verdict = matchPlatformTcb(tcbInfo, teeTcbSvn, sgxComps, pcesvn);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "TCB status could not be resolved.");
  }
  if (verdict.status !== "UpToDate" || verdict.advisoryIds.length > 0) {
    return {
      status: "failed",
      summary: `TDX TCB status is ${verdict.status}${verdict.advisoryIds.length ? ` (advisories: ${verdict.advisoryIds.join(", ")})` : ""}.`,
    };
  }

  const policyDigest = "sha256:" + hexOf(await sha256(tcbInfoBytes));
  return {
    status: "partial",
    summary: "TDX quote signatures, Intel root pin, report_data, debug state, and signed TCB info passed locally; full Intel QVL CRL, QE Identity, and collateral-freshness evaluation is not installed, so CPU authenticity remains unverified.",
    details: {
      signatureChainChecked: true,
      reportDataChecked: true,
      debugDisabled: true,
      signedTcbInfoChecked: true,
      policyDigest,
      fmspc: sgx.fmspc,
      tcbStatus: verdict.status,
      quoteVersion: p.version,
      omittedChecks: ["pck-crl", "root-ca-crl", "qe-identity", "all-collateral-validity-windows"],
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function readPckTcb(tcbSeq: Uint8Array): { sgxComps: number[]; pcesvn: number | null } {
  const sgxComps: number[] = [];
  let pcesvn: number | null = null;
  for (const el of derChildren(tcbSeq)) {
    const [k, v] = derChildren(el.content);
    const koid = oidToStr(k!.content);
    const mm = /^1\.2\.840\.113741\.1\.13\.1\.2\.(\d+)$/u.exec(koid);
    if (!mm) continue;
    const idx = Number(mm[1]);
    if (idx >= 1 && idx <= 16) sgxComps[idx - 1] = v!.content[v!.content.length - 1]!;
    if (idx === 17) pcesvn = intOf(v!.content);
  }
  return { sgxComps, pcesvn };
}
function intOf(u8: Uint8Array): number {
  let v = 0;
  for (const b of u8) v = v * 256 + b;
  return v;
}
