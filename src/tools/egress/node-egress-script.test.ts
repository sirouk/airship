import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EGRESS_ENVELOPE_MARKER,
  NODE_EGRESS_RELAY_SCRIPT,
  NODE_EGRESS_RESULT_NAME,
  NODE_EGRESS_SCRIPT_NAME,
} from "./node-egress-script";

/**
 * The egress relay ships as an embedded program string. These tests run that
 * exact string under the host's Node (the same engine generation WebContainer
 * delivers) against a real loopback HTTP server, so what is proven here is
 * what the client runtime executes.
 */

const EMBEDDED_PROGRAM_SIZE_LIMIT = 24 * 1_024;

describe("shipped node egress relay program", () => {
  let server: Server;
  let base = "";
  let workdir = "";
  let scriptPath = "";
  let compatibilityResets = 0;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "airship-egress-relay-"));
    scriptPath = join(workdir, NODE_EGRESS_SCRIPT_NAME);
    writeFileSync(scriptPath, NODE_EGRESS_RELAY_SCRIPT, "utf8");
    server = createServer((request, response) => {
      const path = request.url ?? "/";
      const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "text/plain", ...headers });
        response.end(body);
      };
      if (path === "/text") return send(200, "hello egress relay");
      if (path === "/compatibility-reset") {
        compatibilityResets += 1;
        // Model the provider/origin reset seen in live WebContainer egress. The
        // first negotiated request is dropped; the bare Node https-style retry
        // (no optional request headers) must use the same relay and recover.
        if (request.headers["accept-encoding"]) {
          request.socket.destroy();
          return;
        }
        return send(200, "compatibility retry answered");
      }
      if (path === "/gzip") return send(200, gzipSync("gzipped egress content ✓"), { "content-encoding": "gzip" });
      if (path === "/redirect") return send(302, "", { location: "/text" });
      if (path === "/redirect-invalid") return send(302, "", { location: "ftp://example.com/x" });
      if (path === "/loop") return send(302, "", { location: "/loop" });
      if (path === "/big") return send(200, "x".repeat(1_000_000));
      if (path === "/missing") return send(404, "nope body");
      if (path === "/drip") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial");
        // Intentionally never ends: the relay's own deadline must cut this.
        const drip = setInterval(() => response.write("x"), 250);
        response.on("close", () => clearInterval(drip));
        return;
      }
      return send(400, "unknown");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "object" && !("port" in address)) throw new Error("No test server address.");
    base = `http://127.0.0.1:${(address as { port: number }).port}`;
  });

  afterAll(async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workdir, { recursive: true, force: true });
  });

  async function runRelay(target: string, environment: Record<string, string> = {}) {
    const stagedPath = join(workdir, NODE_EGRESS_RESULT_NAME);
    if (existsSync(stagedPath)) rmSync(stagedPath);
    const completed = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [scriptPath], {
        cwd: workdir,
        env: { ...process.env, AIRSHIP_EGRESS_TARGET: target, ...environment },
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 512 * 1_024,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Embedded relay process failed: ${error.message}; stderr=${String(stderr).slice(-1_000)}`));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
    const lines = completed.stdout.split("\n").filter((line) => line.startsWith(EGRESS_ENVELOPE_MARKER));
    const envelope = lines.length ? JSON.parse(lines[lines.length - 1]!.slice(EGRESS_ENVELOPE_MARKER.length)) : null;
    const staged = existsSync(stagedPath) ? readFileSync(stagedPath, "utf8") : undefined;
    return { envelope, staged, completed };
  }

  function stagedDigest(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("base64url")}`;
  }

  it("fits inside its own mount and result-envelope budget", () => {
    expect(NODE_EGRESS_RELAY_SCRIPT.length).toBeLessThan(EMBEDDED_PROGRAM_SIZE_LIMIT);
  });

  it("returns a digest-matched staged body for a plain text page", async () => {
    const { envelope, staged } = await runRelay(`${base}/text`);
    expect(envelope).toMatchObject({ ok: true, status: 200, contentType: "text/plain", truncated: false, redirects: 0 });
    expect(envelope.preview).toBe("hello egress relay");
    expect(staged).toBe("hello egress relay");
    expect(envelope.resultSha256).toBe(stagedDigest(staged!));
  });

  it("retries a transient reset with the bare Node request profile", async () => {
    const before = compatibilityResets;
    const { envelope, staged } = await runRelay(`${base}/compatibility-reset`);
    expect(envelope).toMatchObject({ ok: true, status: 200, transportAttempts: 2 });
    expect(staged).toBe("compatibility retry answered");
    expect(compatibilityResets - before).toBe(2);
  });

  it("decodes a gzip body before staging it", async () => {
    const { envelope, staged } = await runRelay(`${base}/gzip`);
    expect(envelope.ok).toBe(true);
    expect(staged).toBe("gzipped egress content ✓");
    expect(envelope.resultSha256).toBe(stagedDigest(staged!));
  });

  it("follows redirects to the textual hop and names the final URL", async () => {
    const { envelope, staged } = await runRelay(`${base}/redirect`);
    expect(envelope).toMatchObject({ ok: true, status: 200, redirects: 1 });
    expect(envelope.finalUrl).toBe(`${base}/text`);
    expect(staged).toBe("hello egress relay");
  });

  it("stops on a redirect loop instead of following forever", async () => {
    const { envelope } = await runRelay(`${base}/loop`);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("redirect-limit");
  });

  it("caps the body at the byte budget and marks truncation with a matched digest", async () => {
    const { envelope, staged } = await runRelay(`${base}/big`, { AIRSHIP_EGRESS_MAX_BYTES: "4096" });
    expect(envelope).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(staged!.length).toBe(4_096);
    expect(envelope.resultSha256).toBe(stagedDigest(staged!));
    expect(envelope.preview.length).toBeGreaterThan(1_000);
    expect(envelope.resultBytes).toBe(4_096);
  });

  it("passes HTTP error statuses through with the body, transport-ok", async () => {
    const { envelope, staged } = await runRelay(`${base}/missing`);
    expect(envelope).toMatchObject({ ok: true, status: 404 });
    expect(staged).toBe("nope body");
  });

  it("turns a stalling origin into a clean timeout", async () => {
    const { envelope } = await runRelay(`${base}/drip`, { AIRSHIP_EGRESS_TIMEOUT_MS: "1500" });
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("timeout");
  });

  it("refuses non-HTTPS non-loopback targets before connecting", async () => {
    const { envelope } = await runRelay("ftp://example.com/file");
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("url");
  });

  it("refuses credential-bearing URLs", async () => {
    const { envelope } = await runRelay("https://user:secret@example.com/");
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("url");
  });

  it("reports a failed redirect target instead of crashing", async () => {
    const { envelope } = await runRelay(`${base}/redirect-invalid`);
    expect(envelope).toMatchObject({ ok: false, code: "redirect" });
  });
});
