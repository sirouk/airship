/**
 * In-browser NVIDIA GPU attestation verifier (fail-closed).
 *
 * Verifies, per GPU, entirely from the self-contained evidence (no external
 * collateral): the device certificate chain (ECDSA P-384) up to a PINNED
 * NVIDIA root CA, and the SPDM MEASUREMENTS report signature over the
 * request/response transcript. This proves the report was signed by a genuine
 * NVIDIA GPU device whose identity chains to NVIDIA's root.
 *
 * It deliberately does NOT claim full attestation: the GPU SPDM nonce is not
 * the caller's nonce (freshness rests on the TDX quote/proxy), and firmware
 * measurements are not compared to golden RIM values (NVIDIA's RIM service is
 * not browser-readable). Those require Chutes to bind the caller nonce into the
 * GPU request and to serve the RIM. So a full pass yields state "matched"
 * (device + signature authenticity), never "verified".
 */
import type { JsonObject } from "../types";

/**
 * Pinned NVIDIA attestation roots (self-signed "NVIDIA Device Identity CA",
 * SPKI SHA-384). NVIDIA rotates a small set of device-identity roots; both
 * values below were observed as genuine self-signed NVIDIA roots on live
 * Chutes Blackwell endpoints. Fail-closed on anything else. This set should
 * track NVIDIA's authoritative published root bundle.
 */
const NVIDIA_ROOT_SPKI_SHA384 = new Set<string>([
  "e108f61de3fce5261151f8a0eb562a920639ef1b0fcebba785ee52f54420e4248be3400366d45c2880bdf13044325393",
  "4136e1670d50cca9ec47097e7aedbf9eeea0870b9d2824160e179ddfe0dfaa32dae76e1cc1ced67320042471685e01d8",
]);

export type NvidiaGpuVerification = Readonly<{
  state: "matched" | "failed" | "unavailable";
  deviceCount: number;
  verifiedCount: number;
  summary: string;
}>;

const subtle = () => globalThis.crypto.subtle;

export async function verifyNvidiaGpuEvidence(gpuEvidence: readonly JsonObject[]): Promise<NvidiaGpuVerification> {
  if (!gpuEvidence || gpuEvidence.length === 0) {
    return { state: "unavailable", deviceCount: 0, verifiedCount: 0, summary: "The response contains no NVIDIA GPU evidence objects." };
  }
  let verified = 0;
  for (const gpu of gpuEvidence) {
    try {
      if (await verifyOneGpu(gpu)) verified += 1;
      else return failed(gpuEvidence.length, verified);
    } catch {
      return failed(gpuEvidence.length, verified);
    }
  }
  return {
    state: "matched",
    deviceCount: gpuEvidence.length,
    verifiedCount: verified,
    summary: `${verified} NVIDIA GPU device${verified === 1 ? "" : "s"} authenticated: SPDM report signature valid and the device certificate chain anchors to a pinned NVIDIA root. Not bound to this request's nonce, and firmware measurements were not compared to golden RIM values.`,
  };
}

function failed(deviceCount: number, verified: number): NvidiaGpuVerification {
  return { state: "failed", deviceCount, verifiedCount: verified, summary: `A GPU failed verification after ${verified}/${deviceCount} device${deviceCount === 1 ? "" : "s"}: the certificate chain, pinned NVIDIA root, or SPDM report signature did not check.` };
}

async function verifyOneGpu(gpu: JsonObject): Promise<boolean> {
  const certPem = typeof gpu.certificate === "string" ? gpu.certificate : "";
  const evidenceB64 = typeof gpu.evidence === "string" ? gpu.evidence : "";
  if (!certPem || !evidenceB64) return false;
  const certs = pemCerts(b64ToBytes(certPem)).map(parseCert);
  if (certs.length < 2) return false;

  // certificate chain: each cert signed by the next; root is self-signed + pinned.
  for (let i = 0; i < certs.length - 1; i++) {
    const parentKey = await importSpki384(certs[i + 1]!.spkiDer);
    if (!(await verify384(parentKey, certs[i]!.sigP1363, certs[i]!.tbsRaw))) return false;
  }
  const root = certs[certs.length - 1]!;
  if (!NVIDIA_ROOT_SPKI_SHA384.has(hexOf(await sha384(root.spkiDer)))) return false;
  if (!(await verify384(await importSpki384(root.spkiDer), root.sigP1363, root.tbsRaw))) return false;

  // SPDM MEASUREMENTS report signature: last 96 bytes = P-384 r||s over the
  // transcript (request + response minus the signature), SHA-384.
  const ev = b64ToBytes(evidenceB64);
  if (ev.length < 100) return false;
  const leafKey = await importSpki384(certs[0]!.spkiDer);
  const sig = ev.subarray(ev.length - 96);
  return verify384(leafKey, sig, ev.subarray(0, ev.length - 96));
}

// ---- helpers (P-384 / DER) ----
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
async function sha384(u8: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-384", u8 as unknown as BufferSource));
}
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
  return { tag, len, headerLen: i - pos, content: buf.subarray(i, i + len), end: i + len };
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
function derEcdsaToP1363(der: Uint8Array): Uint8Array {
  const [r, s] = derChildren(derRead(der, 0).content);
  const fix = (t: DerNode) => {
    let b = t.content;
    while (b.length > 48 && b[0] === 0) b = b.subarray(1);
    const out = new Uint8Array(48);
    out.set(b, 48 - b.length);
    return out;
  };
  const out = new Uint8Array(96);
  out.set(fix(r!), 0);
  out.set(fix(s!), 48);
  return out;
}
type Cert = { tbsRaw: Uint8Array; sigP1363: Uint8Array; spkiDer: Uint8Array };
function parseCert(der: Uint8Array): Cert {
  const top = derRead(der, 0);
  const kids = derChildren(top.content);
  const tbsNode = kids[0]!;
  const tbsRaw = der.subarray(top.headerLen, top.headerLen + tbsNode.headerLen + tbsNode.len);
  const tbs = tbsNode.content;
  const sigDer = kids[2]!.content.subarray(1);
  const tb = derChildren(tbs);
  let idx = 0;
  if ((tb[0]!.tag & 0xa0) === 0xa0) idx = 1;
  const spkiIdx = idx + 5;
  let off = 0;
  for (let k = 0; k < spkiIdx; k++) off += tb[k]!.headerLen + tb[k]!.len;
  const spkiField = tb[spkiIdx]!;
  return { tbsRaw, sigP1363: derEcdsaToP1363(sigDer), spkiDer: tbs.subarray(off, off + spkiField.headerLen + spkiField.len) };
}
function pemCerts(pem: Uint8Array): Uint8Array[] {
  const text = new TextDecoder().decode(pem);
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu)].map((m) => b64ToBytes(m[1]!.replace(/\s+/gu, "")));
}
function importSpki384(spki: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("spki", spki as unknown as BufferSource, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
}
function verify384(key: CryptoKey, sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  return subtle().verify({ name: "ECDSA", hash: "SHA-384" }, key, sig as unknown as BufferSource, msg as unknown as BufferSource);
}
