import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUTES_API_BASE, CHUTES_LLM_MODELS_URL } from "../../models/types";
import {
  CHUTES_AUTHORIZATION_HOST,
  CHUTES_CATALOG_HOSTS,
  CHUTES_DISCOVERY_PREFLIGHT,
  CHUTES_LOGO_HOST,
  hostPhrase,
} from "./egress-preflight";

/*
 * A pre-flight disclosure is only worth reading if it cannot drift from the
 * requests it describes. Two of the three hosts are derived from the constants
 * the requests are built from and cannot drift at all; the third is a literal
 * inside a file this package does not own, so it is bound here instead.
 */
describe("the hosts named before the button is pressed", () => {
  it("derives the catalog hosts from the URLs the catalog client requests", () => {
    expect(CHUTES_CATALOG_HOSTS).toEqual([
      new URL(CHUTES_LLM_MODELS_URL).host,
      new URL(CHUTES_API_BASE).host,
    ]);
    expect(CHUTES_AUTHORIZATION_HOST).toBe(new URL(CHUTES_API_BASE).host);
  });

  it("names the logo host the model picker actually contacts", () => {
    // src/ui/model-picker.tsx renders `<img src={`https://logos.chutes.ai/…`}>`
    // for every discovered model. That literal is the measured egress this
    // sentence discloses; if it moves, this disclosure is a false statement.
    const picker = readFileSync(new URL("../model-picker.tsx", import.meta.url), "utf8");
    expect(picker).toContain(CHUTES_LOGO_HOST);
    expect(picker).toContain(`https://${CHUTES_LOGO_HOST}/logos/`);
  });

  it("names every one of them in the sentence, and says the key is not among them", () => {
    for (const host of [...CHUTES_CATALOG_HOSTS, CHUTES_LOGO_HOST, CHUTES_AUTHORIZATION_HOST]) {
      expect(CHUTES_DISCOVERY_PREFLIGHT, host).toContain(host);
    }
    // Measured: the whole discovery leg is unauthenticated (`auth=no` on all
    // three requests); the key rides only on the Finish leg.
    expect(CHUTES_DISCOVERY_PREFLIGHT).toContain("not attached");
    expect(CHUTES_DISCOVERY_PREFLIGHT).toContain("Finish: verify & connect");
  });

  it("reads as a sentence for one, two or many hosts", () => {
    expect(hostPhrase([])).toBe("no host");
    expect(hostPhrase(["a.example"])).toBe("a.example");
    expect(hostPhrase(["a.example", "b.example"])).toBe("a.example and b.example");
    expect(hostPhrase(["a", "b", "c"])).toBe("a, b and c");
  });
});
