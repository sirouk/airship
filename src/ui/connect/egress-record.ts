/**
 * What has left this device.
 *
 * The Connection route enumerated its own boundaries meticulously and could
 * still not answer the one question the person pasting a credential was asking.
 * Measured on this build: pressing "Discover models with key" put three
 * requests on the wire at t=28ms (llm.chutes.ai/v1/models, api.chutes.ai/chutes/,
 * api.chutes.ai/chutes/utilization) and, 4.8 seconds later, an image request to
 * logos.chutes.ai that no sentence anywhere in Airship mentioned. The observer
 * only found it by opening devtools — which a phone does not have.
 *
 * So this is a record of observation, not a re-statement of intent. Two
 * witnesses feed it and each is labelled by name, because they know different
 * things:
 *
 *   - `request` — the page's own `fetch`, wrapped. Knows the method, whether a
 *     credential was attached and how, and what came back. Sees nothing that
 *     was dispatched before the wrapper was installed.
 *   - `resource-timing` — the browser's own resource timeline, replayed from
 *     page load with `buffered: true`. Sees *everything* the document loaded,
 *     including `<img>` egress no fetch wrapper can intercept, and knows the
 *     method and the credential of none of it.
 *
 * A row never claims what its witness cannot establish: `method` is absent on a
 * resource-timing row rather than guessed as GET, and `credential` is `unknown`
 * rather than "not attached". The credential VALUE is never read, stored or
 * rendered — only the fact that a header carrying one was present.
 */

/** Which observer saw this request, and therefore which fields can be true. */
export type EgressWitness = "request" | "resource-timing";

/**
 * Whether the request left the machine.
 *
 * The boundary used to be the browser's origin comparison and nothing else, so
 * "Check Ollama" — a request to `http://127.0.0.1:11434/api/version` from a page
 * served on `http://127.0.0.1:4173` — was filed under "What has left this
 * device". Nothing left. The lane it belongs to advertises itself as
 * `Endpoint · loopback allowlist only` and is the one provider route in the
 * product that involves no third party at all, and the egress panel was calling
 * it egress on the strength of a port number.
 *
 * `remote` is everything a packet actually leaves for, and that deliberately
 * includes the LAN: `192.168.1.20:11434` is another machine, and a person
 * asking what left this device is asking about exactly that hop. Only the
 * loopback interface — `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]` — is
 * on-device.
 */
export type EgressScope = "loopback" | "remote";

/** Whether a credential rode along — never which one, and never its value. */
export type EgressCredential = "attached" | "not-attached" | "unknown";

export type EgressOutcome = "in-flight" | "answered" | "refused" | "failed";

export type EgressRecord = Readonly<{
  id: string;
  /** Whether this request left the machine, or stayed on the loopback interface. */
  scope: EgressScope;
  /** Host and port, as the browser resolved them. */
  host: string;
  /** Path without its query: a query string is where an api_key= would be. */
  path: string;
  /** Absent on a resource-timing row, which the browser does not disclose. */
  method?: string;
  /** `fetch`, `image`, `script`, `css`, `xmlhttprequest`, `other`. */
  kind: string;
  witness: EgressWitness;
  credential: EgressCredential;
  /** How the credential travelled, when one did. Never what it was. */
  credentialVia?: string;
  /** Epoch ms. */
  startedAt: number;
  outcome: EgressOutcome;
  status?: number;
  /**
   * Bytes over the wire, when the browser discloses them. Cross-origin
   * responses without `Timing-Allow-Origin` report 0, which is not a
   * measurement, so it is left absent rather than printed as a number.
   */
  bytes?: number;
  /** A named failure, when one was raised. */
  detail?: string;
}>;

export type EgressHostSummary = Readonly<{
  host: string;
  scope: EgressScope;
  requests: number;
  /** How many rows on this host carried a credential. */
  credentialed: number;
  /** How many rows on this host cannot say either way. */
  unknownCredential: number;
  kinds: readonly string[];
  firstAt: number;
  lastAt: number;
  inFlight: number;
  failed: number;
}>;

/**
 * The ledger's own boundary, stated where the ledger is read.
 *
 * A record of egress that does not say what it cannot see is the same class of
 * defect it exists to fix.
 */
export const EGRESS_SCOPE_NOTE = "Three classes, one of them egress. Airship's own origin is not listed at all, including the same-origin localhost token handler where a build has one. Another port on this machine is recorded as on-device and counted separately. The count at the top is only what reached another machine, including one on your own network. Credential values are never read or stored: a row records only that a header carrying one was present.";

/** Said once, by the zero state and by the summary chip's accessible name. */
export const EGRESS_NONE_OBSERVED = "Nothing has left this device in this tab.";

/** The heading over the loopback rows, and the sentence that qualifies them. */
export const EGRESS_LOOPBACK_NOTE = "A server on this machine. The browser treats it as another origin, so it is recorded — but the bytes never reached a network interface, and the count above does not include them.";

/** Beyond this the oldest rows are dropped, and the panel says so. */
const RECORD_LIMIT = 250;

/**
 * Where a URL goes, before any of it is recorded.
 *
 * `not-network` covers `data:`, `blob:` and every other scheme that resolves
 * inside the page: those are not requests to anywhere and are dropped rather
 * than filed under either heading, because a ledger that listed a blob URL as
 * "activity" would be padding the answer to a question about the wire.
 */
export type EgressClass = "same-origin" | "loopback" | "remote" | "not-network";

export function classifyEgressUrl(url: string, origin: string): EgressClass {
  let parsed: URL;
  try {
    parsed = new URL(url, origin || undefined);
  } catch {
    return "not-network";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "not-network";
  if (origin && parsed.origin === origin) return "same-origin";
  return isLoopbackHostname(parsed.hostname) ? "loopback" : "remote";
}

/**
 * Whether a hostname resolves to this machine's loopback interface.
 *
 * Deliberately the same rule as `isLoopbackHost` in
 * `src/inference/local/endpoint-policy.ts`, which decides what the local-model
 * fabric is even allowed to contact — the two answers have to agree or the
 * panel will describe an allowed local probe as egress. It is restated rather
 * than imported: the local-inference pack and this route are separate chunks,
 * and importing across that seam makes Rollup emit a shared chunk the release
 * gate refuses, the same pack-boundary hazard `egress-preflight.ts` documents.
 * `egress-record.test.ts` imports both and fails if they ever disagree.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  // RFC 6761 reserves `localhost` and every name under it for the loopback
  // interface; a browser that resolved `ollama.localhost` sent it nowhere.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped loopback, which `[::ffff:127.0.0.1]` is a legal spelling of.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(host);
  const octets = parseIpv4(mapped ? mapped[1]! : host);
  return octets !== undefined && octets[0] === 127;
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => part === "" ? Number.NaN : Number(part));
  return values.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? values : undefined;
}

type Entry = {
  record: EgressRecord;
  /** Held here rather than on the record: a query string can carry a secret. */
  url: string;
  /** A resource-timing entry may corroborate a request row exactly once. */
  corroborated: boolean;
};

export type EgressResourceEntry = Readonly<{
  name: string;
  initiatorType: string;
  /** Epoch ms, already resolved against `performance.timeOrigin` by the caller. */
  startedAt: number;
  transferSize?: number;
  encodedBodySize?: number;
}>;

export type EgressRecorderOptions = Readonly<{
  /** The origin whose requests are NOT egress: this page's own. */
  origin: string;
  now?: () => number;
}>;

/**
 * The ledger itself, with no dependency on `window`.
 *
 * `installEgressRecorder` below is the only part that touches globals, which is
 * what lets every rule here be tested rather than driven.
 */
export class EgressRecorder {
  private readonly origin: string;
  private readonly now: () => number;
  private entries: Entry[] = [];
  private dropped = 0;
  private truncated = false;
  private sequence = 0;
  private readonly listeners = new Set<() => void>();

  constructor(options: EgressRecorderOptions) {
    this.origin = options.origin;
    this.now = options.now ?? Date.now;
  }

  read(): readonly EgressRecord[] {
    return this.entries.map((entry) => entry.record);
  }

  /** How many rows the limit discarded, so the panel can admit the gap. */
  droppedCount(): number {
    return this.dropped;
  }

  /**
   * Whether the browser stopped keeping resource entries before this ledger
   * read them.
   *
   * The panel says it lists every off-origin resource the document loaded, and
   * that is true only while the browser's own timeline is still recording:
   * `resourcetimingbufferfull` is the moment it stops. A ledger that quietly
   * kept the sentence after the guarantee expired would be exactly the class of
   * claim this whole surface exists to retire.
   */
  timelineTruncated(): boolean {
    return this.truncated;
  }

  noteTimelineTruncation(): void {
    if (this.truncated) return;
    this.truncated = true;
    this.announce();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A request the page is dispatching now. Returns the row id, or `undefined`
   * when the request is same-origin and therefore not egress.
   */
  noteRequest(
    url: string,
    detail: Readonly<{ method?: string; headers?: Headers; credentialsMode?: RequestCredentials }>,
  ): string | undefined {
    const target = parseTarget(url, this.origin);
    if (!target) return undefined;
    const credential = readCredential(target.parsed, detail.headers, detail.credentialsMode);
    return this.push(target.url, {
      scope: target.scope,
      host: target.parsed.host,
      path: target.parsed.pathname,
      method: (detail.method ?? "GET").toUpperCase(),
      kind: "fetch",
      witness: "request",
      credential: credential.credential,
      ...(credential.via ? { credentialVia: credential.via } : {}),
      startedAt: this.now(),
      outcome: "in-flight",
    });
  }

  /** The answer to a row opened by `noteRequest`. */
  settleRequest(id: string, result: Readonly<{ status?: number; error?: string }>): void {
    const entry = this.entries.find((candidate) => candidate.record.id === id);
    if (!entry) return;
    const status = result.status;
    entry.record = Object.freeze({
      ...entry.record,
      outcome: result.error !== undefined
        ? "failed"
        : status !== undefined && status >= 400
          ? "refused"
          : "answered",
      ...(status === undefined ? {} : { status }),
      ...(result.error === undefined ? {} : { detail: result.error }),
    });
    this.announce();
  }

  /**
   * An entry from the browser's resource timeline. When it matches a request
   * row this view already opened it corroborates that row instead of doubling
   * it — a ledger that counts one request twice is not a ledger.
   */
  noteResource(entry: EgressResourceEntry): string | undefined {
    const target = parseTarget(entry.name, this.origin);
    if (!target) return undefined;
    const bytes = disclosedBytes(entry);
    const match = this.entries.find((candidate) =>
      !candidate.corroborated
      && candidate.record.witness === "request"
      && candidate.url === target.url);
    if (match) {
      match.corroborated = true;
      if (bytes !== undefined) {
        match.record = Object.freeze({ ...match.record, bytes });
        this.announce();
      }
      return match.record.id;
    }
    return this.push(target.url, {
      scope: target.scope,
      host: target.parsed.host,
      path: target.parsed.pathname,
      kind: resourceKind(entry.initiatorType),
      witness: "resource-timing",
      // The resource timeline discloses no request headers, so this row may
      // not say a credential was absent — only that it cannot tell.
      credential: "unknown",
      startedAt: entry.startedAt,
      outcome: "answered",
      ...(bytes === undefined ? {} : { bytes }),
    });
  }

  private push(url: string, record: Omit<EgressRecord, "id">): string {
    this.sequence += 1;
    const id = `egress-${this.sequence}`;
    this.entries.push({ record: Object.freeze({ id, ...record }), url, corroborated: false });
    if (this.entries.length > RECORD_LIMIT) {
      this.dropped += this.entries.length - RECORD_LIMIT;
      this.entries = this.entries.slice(-RECORD_LIMIT);
    }
    this.announce();
    return id;
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

function parseTarget(
  url: string,
  origin: string,
): { url: string; parsed: URL; scope: EgressScope } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, origin || undefined);
  } catch {
    return undefined;
  }
  const scope = classifyEgressUrl(parsed.href, origin);
  // `data:` and `blob:` never touch a socket; same-origin is the page itself.
  if (scope === "not-network" || scope === "same-origin") return undefined;
  return { url: parsed.href, parsed, scope };
}

/**
 * Whether a credential rode with this request, and how.
 *
 * Query parameters are inspected because a key in a URL is the case a header
 * check would miss and the case a reader most needs told — the parameter NAME
 * is reported, never its value.
 */
export function readCredential(
  url: URL,
  headers: Headers | undefined,
  credentialsMode: RequestCredentials | undefined,
): Readonly<{ credential: EgressCredential; via?: string }> {
  const header = CREDENTIAL_HEADERS.find((name) => headers?.has(name));
  if (header) return Object.freeze({ credential: "attached", via: `${header} header` });
  const parameter = CREDENTIAL_PARAMETERS.find((name) => url.searchParams.has(name));
  if (parameter) return Object.freeze({ credential: "attached", via: `${parameter} URL parameter` });
  if (credentialsMode === "include") return Object.freeze({ credential: "attached", via: "browser cookies" });
  return Object.freeze({ credential: "not-attached" });
}

const CREDENTIAL_HEADERS = Object.freeze([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "proxy-authorization",
]);

const CREDENTIAL_PARAMETERS = Object.freeze(["key", "api_key", "apikey", "access_token", "token"]);

/**
 * Cross-origin responses report `transferSize: 0` unless the server sends
 * `Timing-Allow-Origin`. Zero is the browser declining to say, not a
 * measurement, and printing it as "0 B" would be a fabricated number.
 */
function disclosedBytes(entry: EgressResourceEntry): number | undefined {
  const transfer = entry.transferSize ?? 0;
  if (transfer > 0) return transfer;
  const encoded = entry.encodedBodySize ?? 0;
  return encoded > 0 ? encoded : undefined;
}

function resourceKind(initiatorType: string): string {
  if (initiatorType === "img" || initiatorType === "image") return "image";
  if (initiatorType === "link" || initiatorType === "css") return "css";
  if (initiatorType === "script") return "script";
  if (initiatorType === "fetch" || initiatorType === "xmlhttprequest") return "fetch";
  return initiatorType || "other";
}

/** The rows that actually left the machine — the answer to the panel's title. */
export function remoteEgress(records: readonly EgressRecord[]): readonly EgressRecord[] {
  return records.filter((record) => record.scope === "remote");
}

/** The rows that stayed on it. Shown, counted separately, never called egress. */
export function loopbackEgress(records: readonly EgressRecord[]): readonly EgressRecord[] {
  return records.filter((record) => record.scope === "loopback");
}

export function summarizeEgressHosts(records: readonly EgressRecord[]): readonly EgressHostSummary[] {
  const byHost = new Map<string, EgressHostSummary>();
  for (const record of records) {
    const prior = byHost.get(record.host);
    const kinds = prior?.kinds.includes(record.kind) ? prior.kinds : [...(prior?.kinds ?? []), record.kind];
    byHost.set(record.host, Object.freeze({
      host: record.host,
      scope: record.scope,
      requests: (prior?.requests ?? 0) + 1,
      credentialed: (prior?.credentialed ?? 0) + (record.credential === "attached" ? 1 : 0),
      unknownCredential: (prior?.unknownCredential ?? 0) + (record.credential === "unknown" ? 1 : 0),
      kinds,
      firstAt: Math.min(prior?.firstAt ?? record.startedAt, record.startedAt),
      lastAt: Math.max(prior?.lastAt ?? record.startedAt, record.startedAt),
      inFlight: (prior?.inFlight ?? 0) + (record.outcome === "in-flight" ? 1 : 0),
      failed: (prior?.failed ?? 0) + (record.outcome === "failed" || record.outcome === "refused" ? 1 : 0),
    }));
  }
  return Object.freeze([...byHost.values()].sort((a, b) => b.lastAt - a.lastAt));
}

export type EgressCounts = Readonly<{
  requests: number;
  credentialed: number;
  unknownCredential: number;
}>;

/**
 * The credential verdict for a set of rows — the chip's and every host row's,
 * written once.
 *
 * The two spellings disagreed: the chip said "no credential attached" about a
 * set that included an `<img>` row whose credential the browser does not
 * disclose, while the row for that same image correctly said it could not tell.
 * A summary may not resolve an unknown into a no.
 */
export function credentialClause(counts: EgressCounts): string {
  if (counts.credentialed > 0) return `${String(counts.credentialed)} carried a credential`;
  if (counts.unknownCredential >= counts.requests) return "Credential not disclosed by the browser";
  if (counts.unknownCredential > 0) {
    return `No credential on the ${String(counts.requests - counts.unknownCredential)} Airship sent · ${String(counts.unknownCredential)} not disclosed`;
  }
  return "No credential attached";
}

export function egressTotals(records: readonly EgressRecord[]): EgressCounts {
  return Object.freeze({
    requests: records.length,
    credentialed: records.filter((record) => record.credential === "attached").length,
    unknownCredential: records.filter((record) => record.credential === "unknown").length,
  });
}

/**
 * The chip's label: a count and the hosts it reached, and nothing else.
 *
 * The credential verdict used to ride here too, which made a 74-character
 * sentence out of a control that is `white-space: nowrap; text-overflow:
 * ellipsis` by design — measured at 390px: 306px of chip holding 453px of text,
 * so the clause that mattered most was the half that got clipped. It is a
 * sentence now, beside the chip, where it can wrap.
 */
export function egressCountLabel(records: readonly EgressRecord[]): string {
  if (records.length === 0) return EGRESS_NONE_OBSERVED;
  const hosts = summarizeEgressHosts(records);
  return `${String(records.length)} ${records.length === 1 ? "request" : "requests"} · ${String(hosts.length)} ${hosts.length === 1 ? "host" : "hosts"}`;
}

/**
 * The seal beside that sentence. Egress is not a fault, so the resting state
 * for observed traffic is `asserted` — recorded, not verified — and only a
 * request that failed or was refused earns attention.
 */
export function egressSummarySeal(records: readonly EgressRecord[]): "none" | "asserted" | "attention" | "checking" {
  if (records.length === 0) return "none";
  if (records.some((record) => record.outcome === "in-flight")) return "checking";
  if (records.some((record) => record.outcome === "failed" || record.outcome === "refused")) return "attention";
  return "asserted";
}

/**
 * The loopback tally, in the same grammar as the chip above it — and never in
 * the chip, because these requests are not what that chip counts.
 */
export function loopbackCountLabel(records: readonly EgressRecord[]): string {
  const rows = loopbackEgress(records);
  if (rows.length === 0) return "";
  const hosts = summarizeEgressHosts(rows);
  return `${String(rows.length)} ${rows.length === 1 ? "request" : "requests"} to ${String(hosts.length)} ${hosts.length === 1 ? "port" : "ports"} on this device`;
}

/**
 * The last host a credential actually reached, for the field caption that has
 * to say whether the user's secret left. Absent means it did not.
 *
 * Remote rows only: a key handed to a model server on `127.0.0.1` has not left
 * the device, and this function is the sole evidence behind a sentence that
 * says it has.
 */
export function lastCredentialEgress(
  records: readonly EgressRecord[],
  since = 0,
): EgressRecord | undefined {
  let latest: EgressRecord | undefined;
  for (const record of records) {
    if (record.scope !== "remote" || record.credential !== "attached" || record.startedAt < since) continue;
    if (!latest || record.startedAt >= latest.startedAt) latest = record;
  }
  return latest;
}

let installed: EgressRecorder | undefined;

/**
 * Wire the ledger to this page, once.
 *
 * Called from the surfaces that can cause egress rather than from a bootstrap
 * this package does not own; `buffered: true` is what makes that late
 * installation honest, because the resource timeline replays everything the
 * document has loaded since page load, not merely what follows the wrapper.
 *
 * The wrapper is pass-through by construction: it never reads a body, never
 * touches the Response, and swallows nothing — a recording failure must not
 * become a request failure, so every observation is wrapped in its own guard.
 */
export function installEgressRecorder(): EgressRecorder | undefined {
  if (installed) return installed;
  if (typeof globalThis.fetch !== "function") return undefined;
  const origin = typeof location === "undefined" ? "" : location.origin;
  if (!origin) return undefined;
  const recorder = new EgressRecorder({ origin });
  installed = recorder;

  const original = globalThis.fetch;
  globalThis.fetch = function airshipRecordedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let id: string | undefined;
    try {
      const headers = requestHeaders(input, init);
      const credentialsMode = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
      id = recorder.noteRequest(requestUrl(input), {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        ...(headers ? { headers } : {}),
        ...(credentialsMode ? { credentialsMode } : {}),
      });
    } catch {
      // An unreadable request is not a reason to fail the request.
      id = undefined;
    }
    const result = original.call(globalThis, input as RequestInfo, init);
    if (!id) return result;
    const settleId = id;
    return result.then(
      (response) => {
        recorder.settleRequest(settleId, { status: response.status });
        return response;
      },
      (caught: unknown) => {
        recorder.settleRequest(settleId, {
          error: caught instanceof Error ? `${caught.name}: ${caught.message}` : "The request failed without naming a cause.",
        });
        throw caught;
      },
    );
  } as typeof globalThis.fetch;

  observeResourceTimeline(recorder);
  return recorder;
}

/** The live ledger, or `undefined` where this page never installed one. */
export function egressRecorder(): EgressRecorder | undefined {
  return installed;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers | undefined {
  if (init?.headers) return new Headers(init.headers);
  if (input instanceof Request) return input.headers;
  return undefined;
}

function observeResourceTimeline(recorder: EgressRecorder): void {
  if (typeof PerformanceObserver !== "function" || typeof performance === "undefined") return;
  const timeOrigin = performance.timeOrigin;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        try {
          recorder.noteResource({
            name: resource.name,
            initiatorType: resource.initiatorType,
            startedAt: Math.round(timeOrigin + resource.startTime),
            transferSize: resource.transferSize,
            encodedBodySize: resource.encodedBodySize,
          });
        } catch {
          // One unreadable entry must not end the observation of the rest.
        }
      }
    });
    // `buffered` is the whole reason a late install is still a complete
    // reading: it replays every resource the document loaded before this call.
    observer.observe({ type: "resource", buffered: true });
    // …up to the point the browser stops keeping them. Past that the panel
    // must stop claiming completeness, so the event is recorded rather than
    // handled by silently raising the buffer and hoping.
    performance.addEventListener?.("resourcetimingbufferfull", () => recorder.noteTimelineTruncation());
  } catch {
    // A browser without resource timing keeps the fetch witness and says so.
  }
}
