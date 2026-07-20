import {
  assertLowerHex,
  bytesToHex,
  decodeCanonicalBase64,
  equalBytes,
  hexToBytes,
  sha256Hex,
} from "./encoding";
import type { LocalKeyBindingCheck, ParsedTdxQuote } from "./types";

// Chutes' third-party verification guide follows Intel TDX quote-v4 layout:
// quote body begins at 48, report_data is body[520..584], and the signature
// data length immediately follows the 584-byte body.
// https://github.com/chutesai/chutes-api/blob/main/docs/tee-verification.md
export const TDX_QUOTE_HEADER_BYTES = 48;
export const TDX_REPORT_BODY_BYTES = 584;
export const TDX_REPORT15_BODY_BYTES = 648;
export const TDX_QUOTE_V5_BODY_HEADER_BYTES = 6;
export const TDX_REPORT_DATA_OFFSET_IN_BODY = 520;
export const TDX_REPORT_DATA_BYTES = 64;
export const TDX_REPORT_DATA_OFFSET =
  TDX_QUOTE_HEADER_BYTES + TDX_REPORT_DATA_OFFSET_IN_BODY;
export const TDX_SIGNATURE_LENGTH_OFFSET = TDX_QUOTE_HEADER_BYTES + TDX_REPORT_BODY_BYTES;
export const TDX_QUOTE_PREFIX_BYTES = TDX_SIGNATURE_LENGTH_OFFSET + 4;
export const MAX_TDX_QUOTE_BYTES = 64 * 1024;
export const ML_KEM_768_PUBLIC_KEY_BYTES = 1184;

/**
 * Parse the Intel TDX quote-v4/v5 envelope needed for Chutes' documented
 * report_data binding. This is structural parsing only: it does not validate
 * the quote signature, DCAP collateral, TCB status, measurements, or policy.
 */
export function parseTdxQuote(quoteBase64: string): ParsedTdxQuote {
  const bytes = decodeCanonicalBase64({
    value: quoteBase64,
    label: "TDX quote",
    minBytes: TDX_QUOTE_PREFIX_BYTES,
    maxBytes: MAX_TDX_QUOTE_BYTES,
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(0, true);
  const attestationKeyType = view.getUint16(2, true);
  const teeType = view.getUint32(4, true);

  if (version !== 4 && version !== 5) {
    throw new Error(`unsupported TDX quote version ${version}; expected 4 or 5`);
  }
  if (attestationKeyType !== 2 && attestationKeyType !== 3) {
    throw new Error(
      `unsupported TDX attestation key type ${attestationKeyType}; expected 2 or 3`,
    );
  }
  if (teeType !== 0x81) {
    throw new Error(`quote TEE type is 0x${teeType.toString(16)}, not Intel TDX (0x81)`);
  }

  let bodyType: 2 | 3 = 2;
  let reportBodyOffset = TDX_QUOTE_HEADER_BYTES;
  let reportBodyLength: 584 | 648 = TDX_REPORT_BODY_BYTES;
  if (version === 5) {
    bodyType = view.getUint16(TDX_QUOTE_HEADER_BYTES, true) as 2 | 3;
    const declaredBodyLength = view.getUint32(TDX_QUOTE_HEADER_BYTES + 2, true);
    if (bodyType !== 2 && bodyType !== 3) {
      throw new Error(`unsupported TDX quote-v5 body type ${bodyType}`);
    }
    reportBodyLength = bodyType === 2 ? TDX_REPORT_BODY_BYTES : TDX_REPORT15_BODY_BYTES;
    if (declaredBodyLength !== reportBodyLength) {
      throw new Error(
        `TDX quote-v5 body length ${declaredBodyLength} does not match body type ${bodyType}`,
      );
    }
    reportBodyOffset += TDX_QUOTE_V5_BODY_HEADER_BYTES;
  }
  const signatureLengthOffset = reportBodyOffset + reportBodyLength;
  if (bytes.length < signatureLengthOffset + 4) {
    throw new Error("TDX quote is truncated before its signature-data length");
  }
  const signatureDataLength = view.getUint32(signatureLengthOffset, true);
  const expectedLength = signatureLengthOffset + 4 + signatureDataLength;
  // Reject only a TRUNCATED quote (shorter than its declared signature data).
  // Real Chutes/Intel quotes carry trailing bytes after the signature section
  // (e.g. PEM certificate whitespace) that are not counted in signature_data_len
  // and are never read; requiring exact equality wrongly rejected valid quotes.
  if (bytes.length < expectedLength) {
    throw new Error(
      `TDX quote is truncated before its signature data (${bytes.length} < ${expectedLength})`,
    );
  }

  const reportData = bytes.slice(
    reportBodyOffset + TDX_REPORT_DATA_OFFSET_IN_BODY,
    reportBodyOffset + TDX_REPORT_DATA_OFFSET_IN_BODY + TDX_REPORT_DATA_BYTES,
  );
  if (reportData.length !== TDX_REPORT_DATA_BYTES) {
    throw new Error("TDX quote is truncated before report_data");
  }

  return {
    bytes,
    version,
    attestationKeyType,
    teeType: 0x81,
    bodyType,
    reportBodyOffset,
    reportBodyLength,
    signatureDataLength,
    reportData,
    reportDataHex: bytesToHex(reportData),
  };
}

/** @deprecated The name is retained for callers; the parser accepts quote v4 and v5. */
export const parseTdxQuoteV4 = parseTdxQuote;

export function validateChutesE2ePublicKey(e2ePublicKey: string): Uint8Array {
  return decodeCanonicalBase64({
    value: e2ePublicKey,
    label: "Chutes E2E public key",
    minBytes: ML_KEM_768_PUBLIC_KEY_BYTES,
    maxBytes: ML_KEM_768_PUBLIC_KEY_BYTES,
  });
}

/**
 * Check Chutes' documented local binding:
 *   report_data[0..32] == SHA256(UTF8(nonce + e2e_pubkey))
 *
 * A match is not remote attestation. It becomes meaningful only after a DCAP
 * verifier authenticates the quote and applies TCB and measurement policy.
 */
export async function checkChutesReportDataBinding(args: {
  quoteBase64: string;
  nonce: string;
  e2ePublicKey: string;
  subtle?: SubtleCrypto;
}): Promise<LocalKeyBindingCheck> {
  assertLowerHex(args.nonce, 32, "attestation nonce");
  validateChutesE2ePublicKey(args.e2ePublicKey);
  const quote = parseTdxQuote(args.quoteBase64);
  const expectedDigestHex = await sha256Hex(
    `${args.nonce}${args.e2ePublicKey}`,
    args.subtle ?? crypto.subtle,
  );
  const expectedDigest = hexToBytes(expectedDigestHex);
  const quotedDigest = quote.reportData.slice(0, 32);

  return {
    algorithm: "SHA-256",
    construction: "utf8(nonce + e2e_pubkey)",
    matched: equalBytes(expectedDigest, quotedDigest),
    expectedDigestHex,
    quotedDigestHex: bytesToHex(quotedDigest),
    reportDataHex: quote.reportDataHex,
    quote,
  };
}
