import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { parseTdxQuoteV4 } from "../src/attestation/tdx";

const fixturePath = "/Users/chrisk/chutes-jumpmaster/airship/.airship-lab/attest/fixtures/evidence.json";

test.skip(!process.env.AIRSHIP_DCAP_LIVE, "requires captured Chutes evidence and live Intel collateral");

test("complete Intel DCAP QVL executes in the browser", async ({ page }) => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    nonce: string;
    e2ePubkey: string;
    instanceId: string;
    quote: string;
    certificate: string;
    gpu_evidence?: Record<string, unknown>[];
  };
  const parsed = parseTdxQuoteV4(fixture.quote);
  await page.goto("/");
  const expectedBindingDigestHex = await page.evaluate(async ({ nonce, key }) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce + key)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, { nonce: fixture.nonce, key: fixture.e2ePubkey });
  const result = await page.evaluate(async (payload) => {
    const { createIntelDcapQvlVerifierPort } = await import("/src/attestation/dcap/intel-dcap-qvl.ts");
    return createIntelDcapQvlVerifierPort().verify({
      ...payload,
      parsedQuote: {
        ...payload.parsedQuote,
        bytes: Uint8Array.from(payload.parsedQuote.bytes),
        reportData: Uint8Array.from(payload.parsedQuote.reportData),
      },
    });
  }, {
    instanceId: fixture.instanceId,
    nonce: fixture.nonce,
    e2ePublicKey: fixture.e2ePubkey,
    evidence: {
      quote: fixture.quote,
      gpuEvidence: fixture.gpu_evidence ?? [],
      instanceId: fixture.instanceId,
      certificate: fixture.certificate,
    },
    parsedQuote: {
      ...parsed,
      bytes: Array.from(parsed.bytes),
      reportData: Array.from(parsed.reportData),
    },
    expectedBindingDigestHex,
  });

  expect(result.status, result.summary).toBe("verified");
  expect(result).toMatchObject({ signatureVerified: true, tcbVerified: true, debugDisabled: true });
});
