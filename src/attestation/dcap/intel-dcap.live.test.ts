import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createIntelDcapVerifierPort } from "./intel-dcap";
import type { DcapVerifierInput } from "../types";

// Live test: runs the real WebCrypto DCAP verifier against a captured real
// Chutes quote + fetches live Intel collateral from the CORS-enabled PCCS.
// Gated behind AIRSHIP_DCAP_LIVE so it never runs in the offline CI suite.
const FIXTURE = resolve(process.cwd(), ".airship-lab", "attest", "fixtures", "evidence.json");

describe.skipIf(!process.env.AIRSHIP_DCAP_LIVE)("IntelDcapVerifierPort (live)", () => {
  it("reports the compact-checker boundary on a genuine Chutes TDX quote", async () => {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const bind = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fx.nonce + fx.e2ePubkey)),
    );
    const bindingHex = [...bind].map((b) => b.toString(16).padStart(2, "0")).join("");
    const input = {
      instanceId: fx.instanceId,
      nonce: fx.nonce,
      e2ePublicKey: fx.e2ePubkey,
      evidence: { quote: fx.quote, gpuEvidence: fx.gpu_evidence ?? [], instanceId: fx.instanceId, certificate: fx.certificate },
      parsedQuote: {} as never,
      expectedBindingDigestHex: bindingHex,
    } as unknown as DcapVerifierInput;

    const result = await createIntelDcapVerifierPort().verify(input);
    if (result.status !== "partial") throw new Error(`expected partial, got ${result.status}: ${result.summary}`);
    expect(result.summary).toContain("full Intel QVL");
    expect(result.details).toMatchObject({
      signatureChainChecked: true,
      reportDataChecked: true,
      debugDisabled: true,
      signedTcbInfoChecked: true,
    });
  });

  it("fails closed when report_data binding is wrong", async () => {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const input = {
      instanceId: fx.instanceId,
      nonce: fx.nonce,
      e2ePublicKey: fx.e2ePubkey,
      evidence: { quote: fx.quote, gpuEvidence: [], instanceId: fx.instanceId, certificate: fx.certificate },
      parsedQuote: {} as never,
      expectedBindingDigestHex: "00".repeat(32),
    } as unknown as DcapVerifierInput;
    const result = await createIntelDcapVerifierPort().verify(input);
    expect(result.status).not.toBe("verified");
  });
});
