/**
 * The egress relay Airship ships inside its own web client.
 *
 * This CommonJS program is mounted into the browser-hosted Node.js engine
 * (Node.js WebContainer) and executed as a plain process. Inside that engine
 * the browser's cross-origin read restriction does not apply — Node's
 * http/https clients are the network stack, so any public origin answers.
 * That is why fetch_url escalates here when a direct browser fetch is CORS-
 * refused: this program IS the client-side egress proxy, served from the
 * same page, needing no server and no per-site cooperation.
 *
 * Transport contract (bounds here are structural, not policy):
 * - configuration arrives only through environment variables;
 * - the fetched body is written to RESULT_FILE inside the job root, and the
 *   runtime's workspace reconciliation (an 8 MiB channel) carries it back;
 * - stdout carries exactly one JSON envelope: metadata + a bounded preview +
 *   a digest the caller verifies before trusting the file.
 *
 * Environment:
 *   AIRSHIP_EGRESS_TARGET        absolute http(s) URL to fetch (required)
 *   AIRSHIP_EGRESS_MAX_BYTES     stop reading the decoded body past this bound
 *   AIRSHIP_EGRESS_PREVIEW_BYTES text preview carried inside the envelope
 *   AIRSHIP_EGRESS_TIMEOUT_MS    overall deadline, including redirects
 */
export const EGRESS_ENVELOPE_MARKER = "__AIRSHIP_EGRESS_V1__:";
export const NODE_EGRESS_SCRIPT_NAME = "egress-relay.cjs";
export const NODE_EGRESS_RESULT_NAME = "egress-result.txt";
export const NODE_EGRESS_BODY_HARD_LIMIT = 8 * 1024 * 1024;

export const NODE_EGRESS_RELAY_SCRIPT = String.raw`"use strict";

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const fs = require("node:fs");

const MARKER = "__AIRSHIP_EGRESS_V1__:";
const RESULT_FILE = "egress-result.txt";
const MAX_REDIRECTS = 5;
const MAX_TRANSPORT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [125, 375];
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "ERR_STREAM_PREMATURE_CLOSE",
]);
const BODY_HARD_LIMIT = 8 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Single-flight script: one module-level deadline flag read by every handler.
let timedOut = false;

function clampedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function emit(envelope) {
  process.stdout.write("\n" + MARKER + JSON.stringify(envelope) + "\n");
}

function targetUrl(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("AIRSHIP_EGRESS_TARGET must be an absolute URL.");
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Only HTTPS targets are allowed, except HTTP loopback during local development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http: and https: targets are allowed.");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  return url;
}

function timeoutError() {
  return Object.assign(new Error("The egress request exceeded its deadline."), { code: "timeout" });
}

function retryableTransportError(error) {
  const code = String(error && error.code || "").toUpperCase();
  const message = String(error && error.message || error || "");
  return RETRYABLE_TRANSPORT_CODES.has(code) || /socket hang up|premature close/iu.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, trackRequest, countAttempt) {
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
    if (timedOut) throw timeoutError();
    countAttempt();
    try {
      const hop = await fetchOnce(url, trackRequest, attempt > 1);
      trackRequest(null);
      return hop;
    } catch (error) {
      trackRequest(null);
      if (timedOut) throw timeoutError();
      if (attempt >= MAX_TRANSPORT_ATTEMPTS || !retryableTransportError(error)) throw error;
      await delay(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
  }
  throw new Error("The egress transport retry loop ended without a result.");
}

async function main() {
  let url;
  try {
    url = targetUrl(rawTarget);
  } catch (error) {
    emit({ ok: false, code: "url", message: error.message });
    return;
  }
  // Never present a previous run's body as this run's answer.
  try { fs.rmSync(RESULT_FILE, { force: true }); } catch { /* first run */ }
  let activeRequest = null;
  let transportAttempts = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (activeRequest) activeRequest.destroy(); } catch { /* already settled */ }
  }, timeoutMs);
  try {
    let redirects = 0;
    for (;;) {
      if (timedOut) throw timeoutError();
      const hop = await fetchWithRetry(
        url,
        (req) => { activeRequest = req; },
        () => { transportAttempts += 1; },
      );
      if (hop.location) {
        if (redirects >= MAX_REDIRECTS) {
          throw Object.assign(new Error("Too many redirects."), { code: "redirect-limit" });
        }
        try {
          url = targetUrl(new URL(hop.location, url).toString());
        } catch (error) {
          throw Object.assign(new Error("Refusing redirect: " + error.message), { code: "redirect" });
        }
        redirects += 1;
        continue;
      }
      let resultBytes = 0;
      let resultSha256 = null;
      let preview = "";
      try {
        fs.writeFileSync(RESULT_FILE, hop.body);
        resultBytes = hop.body.byteLength;
        resultSha256 = "sha256:" + crypto.createHash("sha256").update(hop.body).digest("base64url");
        preview = hop.body.subarray(0, previewBytes).toString("utf8");
      } catch (error) {
        throw Object.assign(new Error("Could not stage the fetched body: " + error.message), { code: "staging" });
      }
      emit({
        ok: true,
        status: hop.status,
        finalUrl: url.toString(),
        contentType: hop.contentType,
        bytes: hop.received,
        truncated: hop.truncated,
        redirects,
        transportAttempts,
        elapsedMs: Date.now() - startedAt,
        resultFile: RESULT_FILE,
        resultBytes,
        resultSha256,
        preview,
      });
      return;
    }
  } catch (error) {
    if (error && typeof error === "object") error.transportAttempts = transportAttempts;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fetchOnce(url, trackRequest, compatibilityProfile) {
  return new Promise((resolve, reject) => {
    let truncated = false;
    let settled = false;
    let result = null;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const transport = url.protocol === "https:" ? https : http;
    // First use full content negotiation. A transient provider/origin reset is
    // retried with Node's bare request profile — the same core http/https path,
    // but without optional headers that some intermediaries reject.
    const requestOptions = compatibilityProfile ? { method: "GET" } : {
      method: "GET",
      headers: {
        "user-agent": "airship-client-egress/1 (browser-hosted node)",
        "accept": "text/*, application/json, application/xml, application/xhtml+xml, */*;q=0.1",
        "accept-encoding": "gzip, deflate, br",
      },
    };
    const req = transport.request(url, requestOptions, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        result = { status, location: response.headers.location ? String(response.headers.location) : null };
        response.resume();
        response.on("end", succeed);
        response.on("error", succeed);
        return;
      }
      const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
      let stream = response;
      let decoding = null;
      if (encoding.includes("br")) decoding = zlib.createBrotliDecompress();
      else if (encoding.includes("gzip")) decoding = zlib.createGunzip();
      else if (encoding.includes("deflate")) decoding = zlib.createInflate();
      if (decoding) {
        stream = response.pipe(decoding);
        decoding.on("error", (error) => {
          if (timedOut) { fail(timeoutError()); return; }
          fail(Object.assign(error, { code: "decode" }));
        });
      }
      const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      let received = 0;
      let truncatedSeen = false;
      const chunks = [];
      const collectResult = () => ({ status, contentType, received, truncated: truncatedSeen, body: Buffer.concat(chunks) });
      stream.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          // Keep the slice that fits the cap, then end the read: reaching the
          // cap is a successful bounded answer, not a transport failure.
          const room = maxBytes - (received - chunk.length);
          if (room > 0) chunks.push(chunk.slice(0, room));
          truncatedSeen = true;
          truncated = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => { result = collectResult(); succeed(); });
      stream.on("close", () => { if (truncatedSeen) { result = collectResult(); succeed(); } });
      stream.on("error", (error) => {
        // A socket torn down by our own byte cap still yields its partial body.
        if (timedOut) { fail(timeoutError()); return; }
        if (truncatedSeen) { result = collectResult(); succeed(); }
        else fail(error);
      });
      response.on("error", (error) => {
        if (timedOut) { fail(timeoutError()); return; }
        if (truncatedSeen) { result = collectResult(); succeed(); }
        else fail(error);
      });
    });
    req.on("error", (error) => {
      if (timedOut) { fail(timeoutError()); return; }
      if (truncated && result === null) {
        // Destroyed by the byte cap before the response stream reported back.
        result = { status: 0, contentType: "", received: 0, truncated: true, body: Buffer.alloc(0) };
        succeed();
        return;
      }
      if (truncated) { succeed(); return; }
      fail(error);
    });
    trackRequest(req);
    req.end();
  });
}

const rawTarget = process.env.AIRSHIP_EGRESS_TARGET || "";
const maxBytes = clampedInteger(process.env.AIRSHIP_EGRESS_MAX_BYTES, BODY_HARD_LIMIT, 1024, BODY_HARD_LIMIT);
const previewBytes = clampedInteger(process.env.AIRSHIP_EGRESS_PREVIEW_BYTES, 16 * 1024, 1024, 32 * 1024);
const timeoutMs = clampedInteger(process.env.AIRSHIP_EGRESS_TIMEOUT_MS, 25000, 1000, 55000);
const startedAt = Date.now();

if (!rawTarget) {
  emit({ ok: false, code: "config", message: "AIRSHIP_EGRESS_TARGET is not set." });
} else {
  main().catch((error) => {
    const transportAttempts = Number(error && error.transportAttempts) || 0;
    const baseMessage = String((error && error.message) || error || "The egress request failed.");
    emit({
      ok: false,
      code: error && error.code ? String(error.code).toLowerCase() : "transport",
      message: transportAttempts > 1
        ? baseMessage + " (after " + transportAttempts + " transport attempts)."
        : baseMessage,
      transportAttempts,
      elapsedMs: Date.now() - startedAt,
    });
  });
}
`;
