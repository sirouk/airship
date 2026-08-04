import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUTES_EMBEDDING_ENDPOINT } from "../../indexing/chutes-embeddings";
import { CHUTES_API_BASE, CHUTES_LLM_MODELS_URL } from "../../models/types";
import {
  CHUTES_AUTHORIZATION_HOST,
  CHUTES_CATALOG_HOSTS,
  CHUTES_CONFIDENTIAL_EMBEDDING_HOST,
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

  it("names every one of them in the sentence, in the order the requests happen", () => {
    for (const host of [...CHUTES_CATALOG_HOSTS, CHUTES_LOGO_HOST, CHUTES_AUTHORIZATION_HOST]) {
      expect(CHUTES_DISCOVERY_PREFLIGHT, host).toContain(host);
    }
    // The credentialed request is now first and is disclosed first; the catalog
    // reads that follow it are still unauthenticated and still say so.
    expect(CHUTES_DISCOVERY_PREFLIGHT).toContain("sends your key");
    expect(CHUTES_DISCOVERY_PREFLIGHT).toContain("without your key attached");
    expect(CHUTES_DISCOVERY_PREFLIGHT.indexOf(CHUTES_AUTHORIZATION_HOST))
      .toBeLessThan(CHUTES_DISCOVERY_PREFLIGHT.indexOf(CHUTES_LOGO_HOST));
  });

  /*
   * The fourth Chutes host. It is granted in `connect-src` and takes the same
   * `cpk_` bearer, so its absence from the sentence above is a claim that must
   * be checkable rather than a comment that can rot: it is absent *because
   * nothing can reach it yet*, not because it is unimportant. All three halves
   * are asserted here so the exemption expires by itself.
   */
  it("keeps the unreachable embedding chute out of a sentence about a button that never contacts it", () => {
    expect(CHUTES_CONFIDENTIAL_EMBEDDING_HOST).toBe(new URL(CHUTES_EMBEDDING_ENDPOINT).host);

    // (i) The grant is real, so this is a genuine egress surface, not a typo.
    const csp = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
    expect(csp).toContain(`https://${CHUTES_CONFIDENTIAL_EMBEDDING_HOST}`);

    // (ii) The discovery sentence still describes only what the button does.
    expect(CHUTES_DISCOVERY_PREFLIGHT).not.toContain(CHUTES_CONFIDENTIAL_EMBEDDING_HOST);

    // (iii) And nothing ships that selects the mode which would contact it. If
    // a control ever does, this fails, and the fix is the disclosure beside it
    // — not deleting this line.
    const engineControls = readFileSync(new URL("../context-view.tsx", import.meta.url), "utf8");
    expect(engineControls).toContain(`changeEmbeddingMode("semantic")`);
    expect(engineControls).not.toContain(`changeEmbeddingMode("chutes")`);
  });

  it("reads as a sentence for one, two or many hosts", () => {
    expect(hostPhrase([])).toBe("no host");
    expect(hostPhrase(["a.example"])).toBe("a.example");
    expect(hostPhrase(["a.example", "b.example"])).toBe("a.example and b.example");
    expect(hostPhrase(["a", "b", "c"])).toBe("a, b and c");
  });
});
