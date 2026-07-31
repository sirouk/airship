import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  credentialClause,
  EGRESS_NONE_OBSERVED,
  EGRESS_SCOPE_NOTE,
  EgressRecorder,
  egressCountLabel,
  egressSummarySeal,
  egressTotals,
  lastCredentialEgress,
  readCredential,
  summarizeEgressHosts,
} from "./egress-record";

const ORIGIN = "http://localhost:4173";

function recorder(now = 1_000): EgressRecorder {
  let clock = now;
  return new EgressRecorder({ origin: ORIGIN, now: () => (clock += 1) });
}

describe("what counts as egress", () => {
  it("does not record the page's own origin", () => {
    const ledger = recorder();
    expect(ledger.noteRequest(`${ORIGIN}/assets/index.js`, { method: "GET" })).toBeUndefined();
    expect(ledger.noteRequest("/manifest.webmanifest", { method: "GET" })).toBeUndefined();
    expect(ledger.read()).toEqual([]);
  });

  it("does not record data: or blob: URLs, which never leave the device", () => {
    const ledger = recorder();
    expect(ledger.noteRequest("data:text/plain,hello", { method: "GET" })).toBeUndefined();
    expect(ledger.noteRequest("blob:http://localhost:4173/abc", { method: "GET" })).toBeUndefined();
    expect(ledger.read()).toEqual([]);
  });

  it("records an off-origin request with the method and host it was dispatched with", () => {
    const ledger = recorder();
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "get" });
    const [record] = ledger.read();
    expect(record?.host).toBe("llm.chutes.ai");
    expect(record?.path).toBe("/v1/models");
    expect(record?.method).toBe("GET");
    expect(record?.witness).toBe("request");
    expect(record?.outcome).toBe("in-flight");
  });
});

/*
 * The ledger exists for a reader who is deciding whether to paste a secret, so
 * the one thing it may never do is become a place the secret is written down.
 */
describe("the record never carries the credential it reports", () => {
  it("keeps the query string out of the row, because that is where a key would be", () => {
    const ledger = recorder();
    ledger.noteRequest("https://api.example.com/v1/chat?api_key=SUPERSECRETVALUE", { method: "POST" });
    const [record] = ledger.read();
    expect(record?.path).toBe("/v1/chat");
    expect(JSON.stringify(ledger.read())).not.toContain("SUPERSECRETVALUE");
  });

  it("reports that an Authorization header was present, and nothing about its value", () => {
    const ledger = recorder();
    ledger.noteRequest("https://api.chutes.ai/e2e/instances/abc", {
      method: "GET",
      headers: new Headers({ authorization: "Bearer cpk_realkeyvalue" }),
    });
    const [record] = ledger.read();
    expect(record?.credential).toBe("attached");
    expect(record?.credentialVia).toBe("authorization header");
    expect(JSON.stringify(ledger.read())).not.toContain("cpk_realkeyvalue");
  });
});

describe("how a credential is detected", () => {
  it("names the header, the URL parameter or the cookie jar it travelled in", () => {
    expect(readCredential(new URL("https://a.example/x"), new Headers({ "x-api-key": "k" }), undefined))
      .toEqual({ credential: "attached", via: "x-api-key header" });
    expect(readCredential(new URL("https://a.example/x?access_token=t"), new Headers(), undefined))
      .toEqual({ credential: "attached", via: "access_token URL parameter" });
    expect(readCredential(new URL("https://a.example/x"), new Headers(), "include"))
      .toEqual({ credential: "attached", via: "browser cookies" });
  });

  it("says a credential was not attached only when it inspected the request", () => {
    expect(readCredential(new URL("https://llm.chutes.ai/v1/models"), new Headers(), "omit"))
      .toEqual({ credential: "not-attached" });
  });
});

describe("the answer a request came back with", () => {
  it("separates an answer, a refusal and a failure", () => {
    const ledger = recorder();
    const answered = ledger.noteRequest("https://a.example/1", { method: "GET" })!;
    const refused = ledger.noteRequest("https://a.example/2", { method: "GET" })!;
    const failed = ledger.noteRequest("https://a.example/3", { method: "GET" })!;
    ledger.settleRequest(answered, { status: 200 });
    ledger.settleRequest(refused, { status: 401 });
    ledger.settleRequest(failed, { error: "TypeError: Failed to fetch" });
    const [first, second, third] = ledger.read();
    expect(first?.outcome).toBe("answered");
    expect(second?.outcome).toBe("refused");
    expect(second?.status).toBe(401);
    expect(third?.outcome).toBe("failed");
    expect(third?.detail).toContain("Failed to fetch");
  });

  it("tells a subscriber every time the reading changes", () => {
    const ledger = recorder();
    let changes = 0;
    const stop = ledger.subscribe(() => { changes += 1; });
    const id = ledger.noteRequest("https://a.example/1", { method: "GET" })!;
    ledger.settleRequest(id, { status: 200 });
    stop();
    ledger.noteRequest("https://a.example/2", { method: "GET" });
    expect(changes).toBe(2);
  });
});

/*
 * The resource timeline is the witness that sees `<img>` egress — the measured
 * defect was a logo request to a third-party host that no fetch wrapper could
 * have intercepted and no sentence on the page mentioned.
 */
describe("the browser's own resource timeline", () => {
  it("records an image nobody could have intercepted, and admits what it cannot know", () => {
    const ledger = recorder();
    ledger.noteResource({
      name: "https://logos.chutes.ai/logos/da257fa7.webp",
      initiatorType: "img",
      startedAt: 5_000,
      transferSize: 0,
      encodedBodySize: 0,
    });
    const [record] = ledger.read();
    expect(record?.host).toBe("logos.chutes.ai");
    expect(record?.kind).toBe("image");
    expect(record?.witness).toBe("resource-timing");
    // The timeline discloses no request headers, so this row may not claim the
    // request was uncredentialed — only that it cannot tell.
    expect(record?.credential).toBe("unknown");
    expect(record?.method).toBeUndefined();
    // A cross-origin response without Timing-Allow-Origin reports 0 bytes,
    // which is the browser declining to say rather than a measurement.
    expect(record?.bytes).toBeUndefined();
  });

  it("corroborates a request it already recorded instead of counting it twice", () => {
    const ledger = recorder();
    const id = ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" })!;
    ledger.settleRequest(id, { status: 200 });
    const matched = ledger.noteResource({
      name: "https://llm.chutes.ai/v1/models",
      initiatorType: "fetch",
      startedAt: 5_000,
      transferSize: 4_096,
    });
    expect(matched).toBe(id);
    expect(ledger.read()).toHaveLength(1);
    expect(ledger.read()[0]?.bytes).toBe(4_096);
    expect(ledger.read()[0]?.witness).toBe("request");
  });

  it("corroborates one row per repeated request rather than merging them", () => {
    const ledger = recorder();
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" });
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" });
    for (let index = 0; index < 2; index += 1) {
      ledger.noteResource({ name: "https://llm.chutes.ai/v1/models", initiatorType: "fetch", startedAt: 5_000 });
    }
    expect(ledger.read()).toHaveLength(2);
  });

  it("stops claiming completeness once the browser stops keeping entries", () => {
    const ledger = recorder();
    expect(ledger.timelineTruncated()).toBe(false);
    let changes = 0;
    ledger.subscribe(() => { changes += 1; });
    ledger.noteTimelineTruncation();
    ledger.noteTimelineTruncation();
    expect(ledger.timelineTruncated()).toBe(true);
    // Once, so the sentence changes once rather than on every later entry.
    expect(changes).toBe(1);
  });

  it("adds a row for a request made before the wrapper was installed", () => {
    const ledger = recorder();
    ledger.noteResource({ name: "https://fonts.example/inter.woff2", initiatorType: "css", startedAt: 40 });
    expect(ledger.read()).toHaveLength(1);
    expect(ledger.read()[0]?.witness).toBe("resource-timing");
  });
});

describe("the summary a reader gets without opening anything", () => {
  it("states the zero state as a fact rather than as an empty list", () => {
    expect(egressCountLabel([])).toBe(EGRESS_NONE_OBSERVED);
    expect(egressSummarySeal([])).toBe("none");
  });

  it("never omits the credential clause, because 'none' is the reassurance", () => {
    const ledger = recorder();
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" });
    ledger.noteRequest("https://api.chutes.ai/chutes/", { method: "GET" });
    expect(egressCountLabel(ledger.read())).toBe("2 requests · 2 hosts");
    expect(credentialClause(egressTotals(ledger.read()))).toBe("No credential attached");
    ledger.noteRequest("https://api.chutes.ai/e2e/instances/abc", {
      method: "GET",
      headers: new Headers({ authorization: "Bearer x" }),
    });
    expect(credentialClause(egressTotals(ledger.read()))).toBe("1 carried a credential");
  });

  it("never resolves an undisclosed credential into a clean one", () => {
    /*
     * Measured after a real discovery: three recorded fetches and one `<img>`
     * to logos.chutes.ai. The chip read "4 requests · 3 hosts · no credential
     * attached" while the row for that image correctly said the browser had not
     * disclosed it — a summary that answered a question its own detail refused.
     */
    const ledger = recorder();
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" });
    ledger.noteResource({ name: "https://logos.chutes.ai/logos/a.webp", initiatorType: "img", startedAt: 5_000 });
    expect(credentialClause(egressTotals(ledger.read()))).toBe("No credential on the 1 Airship sent · 1 not disclosed");
    expect(credentialClause({ requests: 1, credentialed: 0, unknownCredential: 1 })).toBe("Credential not disclosed by the browser");
    expect(credentialClause({ requests: 3, credentialed: 2, unknownCredential: 1 })).toBe("2 carried a credential");
    expect(credentialClause({ requests: 3, credentialed: 0, unknownCredential: 0 })).toBe("No credential attached");
  });

  it("groups by host and keeps the per-host credential count", () => {
    const ledger = recorder();
    ledger.noteRequest("https://api.chutes.ai/chutes/", { method: "GET" });
    ledger.noteRequest("https://api.chutes.ai/e2e/instances/abc", {
      method: "GET",
      headers: new Headers({ authorization: "Bearer x" }),
    });
    const [host] = summarizeEgressHosts(ledger.read());
    expect(host?.host).toBe("api.chutes.ai");
    expect(host?.requests).toBe(2);
    expect(host?.credentialed).toBe(1);
  });

  it("rests at asserted, checks while in flight, and only attends to a failure", () => {
    const ledger = recorder();
    const id = ledger.noteRequest("https://a.example/1", { method: "GET" })!;
    expect(egressSummarySeal(ledger.read())).toBe("checking");
    ledger.settleRequest(id, { status: 200 });
    expect(egressSummarySeal(ledger.read())).toBe("asserted");
    const failed = ledger.noteRequest("https://a.example/2", { method: "GET" })!;
    ledger.settleRequest(failed, { error: "AbortError: aborted" });
    expect(egressSummarySeal(ledger.read())).toBe("attention");
  });

  it("says what it does not list", () => {
    expect(EGRESS_SCOPE_NOTE).toContain("Airship's own origin");
    expect(EGRESS_SCOPE_NOTE).toContain("Credential values are never read or stored");
  });
});

/*
 * The field caption asks the ledger "did MY key leave, during THIS press?" —
 * a question that is wrong unless it is scoped to the attempt.
 */
describe("what the field caption reads back", () => {
  it("finds the host a credential actually reached, within the attempt that asked", () => {
    const ledger = new EgressRecorder({ origin: ORIGIN, now: () => 1_000 });
    ledger.noteRequest("https://api.chutes.ai/old", { method: "GET", headers: new Headers({ authorization: "Bearer old" }) });
    const later = new EgressRecorder({ origin: ORIGIN, now: () => 5_000 });
    later.noteRequest("https://api.chutes.ai/e2e/instances/abc", { method: "GET", headers: new Headers({ authorization: "Bearer new" }) });
    expect(lastCredentialEgress(ledger.read(), 4_000)).toBeUndefined();
    expect(lastCredentialEgress(later.read(), 4_000)?.host).toBe("api.chutes.ai");
  });

  it("reports nothing when the leg sent no credential at all", () => {
    const ledger = recorder();
    ledger.noteRequest("https://llm.chutes.ai/v1/models", { method: "GET" });
    expect(lastCredentialEgress(ledger.read())).toBeUndefined();
  });
});

describe("the wrapper is an observer, not a participant", () => {
  const source = readFileSync(new URL("./egress-record.ts", import.meta.url), "utf8");

  it("never reads a response body, which would change what the page receives", () => {
    for (const forbidden of [".clone(", ".text()", ".json()", ".arrayBuffer()"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("rethrows a failed request rather than absorbing it", () => {
    expect(source).toContain("throw caught;");
  });

  it("replays the timeline from page load so a late install is still complete", () => {
    expect(source).toContain('observer.observe({ type: "resource", buffered: true })');
  });
});
