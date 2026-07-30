import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const [app, access, billing, oauth] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./access-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./billing-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../auth/chutes-oauth.ts", import.meta.url), "utf8"),
]);

describe("offline runtime UI contract", () => {
  it("owns browser connectivity and projects it into desktop and mobile posture", () => {
    expect(app).toContain("observeConnectivity(window, navigator, setOnline)");
    expect(app).toContain('data-connectivity={online ? "online" : "offline"}');
    // Offline used to be a fifth topbar pill on desktop and a separate chip
    // component on a phone, both fed from a bespoke `connectivitySeal`. It is
    // now one claim on the `local` axis, projected into one chip at every
    // width — so this asserts the axis carries the offline label and detail
    // rather than asserting that two components exist. Stronger: the previous
    // assertions passed while the phone chip was gated on being connected,
    // which meant a disconnected phone rendered no posture at all.
    // The axis now also declares the band that owns it. Connectivity is true of
    // this browser tab whichever conversation is open, so it is `tab`-scoped —
    // and asserting the scope here is what keeps a later refactor from moving
    // the offline claim into a band that unmounts with the conversation.
    expect(app).toMatch(/id: "local", scope: "tab", label: online \? "Browser \/ Edge runtime" : OFFLINE_RUNTIME_LABEL/u);
    expect(app).toMatch(/detail: online \? "[^"]+" : OFFLINE_RUNTIME_DETAIL/u);
    expect(app).toContain("<TopbarPostureChip axes={trustAxes} onOpen={() => setTrustSheetOpen(true)} />");
  });

  it("blocks only remote composer sends while retaining local slash execution", () => {
    expect(app).toContain("remoteComposerBlocked(");
    expect(app).toContain('composerPlan.kind !== "chat"');
    expect(app).toContain("disabled={!input.trim()");
    expect(app).toContain("|| composerOfflineBlocked");
    expect(app).toContain("|| modelSwitching");
    expect(app).toContain('turnTransport.id === "chutes-e2ee-v1"');
    expect(app).toContain("prompt preserved");
  });

  it("disables provider discovery and OAuth while preserving the pending OAuth credential", () => {
    expect(access).toContain("if (!online || !oauthBootstrap");
    /*
     * AMENDED — one conjunct added, deliberately.
     *
     * `oauthOrigin.available` answers "is this origin registered to sign in",
     * which is a different question from "can this build actually exchange a
     * code". A localhost-handler deployment whose handler is unconfigured
     * satisfied the first and failed the second, so the lane opened with the
     * OAuth tab marked "Primary" and a filled brass button that returned an
     * operator's restart instruction. The handler is now asked at load, and
     * neither arm may be claimed while the answer is still in flight.
     */
    expect(access).toContain("const chutesSignInAvailable = Boolean(oauthDiagnostic)\n    && oauthOrigin.available\n    && (!localOAuthHandler || handlerReadiness?.state === \"ready\");");
    expect(access).toContain("const signInChecking = localOAuthHandler && !handlerReadiness;");
    /*
     * AMENDED — the invariant is kept and finally satisfied.
     *
     * The OAuth *explanation* renders whenever the method is selected; only the
     * control that would fail is gated on availability. Gating the whole block
     * on `chutesSignInAvailable` made the boundary text, the registration
     * details and the one sentence that says WHY sign-in is unavailable
     * unreachable in exactly the build that needed them.
     *
     * `activeChutesMethod = chutesSignInAvailable ? chutesMethod : "api-key"`
     * reinstated that unreachability by a second route: it pinned the method to
     * `api-key`, and the tab that would change it carried `disabled`. Driven
     * live at 1440×900 against this build, the OAuth tab reported
     * `element is not enabled` and could not be clicked, so the block above was
     * still provable dead code — the fix had no rendering path. The method now
     * *defaults* to what can work and stays selectable, which is the shape
     * `initialConnectMethod()` already uses for the cloud lanes, and the two
     * assertions below pin that: no availability gate on the tab, and the panel
     * keyed on the selected method alone.
     */
    expect(access).toContain('const activeChutesMethod = chutesMethod ?? (chutesSignInAvailable ? "oauth" : "api-key");');
    expect(access).not.toContain("disabled={!chutesSignInAvailable}");
    expect(access).toContain('{activeChutesMethod === "oauth" ? (');
    expect(access).not.toContain('{chutesSignInAvailable && activeChutesMethod === "oauth" ? (');
    expect(access).toContain('{activeChutesMethod === "api-key" ? (');
    expect(access).toMatch(/disabled=\{busy \|\| !online \|\| !chutesSignInAvailable\}/u);
    expect(access).toContain("disabled={!online || !chutesSignInAvailable}");
    expect(access).toContain("disabled={busy || !online}>Discover models with key");
    expect(access).toContain('class="access-network-pause"');
  });

  /*
   * `invalid_client` means one of two opposite things, and the remedy for one
   * is wrong for the other: a localhost bridge has process credentials to
   * repair, a public PKCE client has a registration to re-check. The mapping
   * therefore has to read the mode the tab actually exchanged through, not the
   * mode the reader assumes.
   *
   * The classification lives beside the exchange it describes rather than in
   * App, so this asserts the whole path: App resolves the live mode and hands
   * it to the describer, the describer separates the two codes, and Access
   * renders distinct remedies. Asserting only App's copy of the literals is
   * what let the strings move out from under this test.
   */
  it("maps OAuth rejection to the active token boundary instead of prescribing the wrong client type", () => {
    expect(app).toContain("exchangeMode = oauth.chutesOAuthExchangeMode(registration)");
    expect(app).toContain("oauth?.describeChutesOAuthExchangeError(error, exchangeMode)");
    expect(oauth).toContain('exchangeMode === "local-confidential-bridge" ? "oauth:invalid-local" : "oauth:invalid-public"');
    expect(access).toContain('message === "oauth:invalid-local"');
    expect(access).toContain('message === "oauth:invalid-public"');
    expect(access).toContain("Chutes rejected the localhost app credentials.");
    expect(access).toContain("Chutes rejected this Browser/native registration.");
    expect(access).toContain("registered process credentials");
  });

  it("pauses account reads, retains the last observation, and disables refresh", () => {
    const offlineBranch = billing.slice(billing.indexOf("if (!online)"), billing.indexOf("const controller"));
    expect(offlineBranch).not.toContain("setSnapshot(undefined)");
    expect(billing).toContain("disabled={loading || !online}");
    expect(billing).toContain("Account reads paused");
    expect(billing).toContain("last observation held in page memory");
  });
});

/**
 * A credential lifecycle nothing constructs reads as the one production runs.
 *
 * `ChutesCredentialBroker` was 500 lines of token custody, one-time refresh
 * rotation, retired-token replay defence and RFC 7009 sign-out revocation, with
 * 390 lines of passing unit tests — and no importer outside its own test. App
 * had grown a separate inline `oauthTokens` ref path that revoked nothing, and
 * the gap was invisible from the call site because teardown did call something
 * named `revokeCredential` (the transport's in-page abort). The broker's
 * existence is what made "revocation is handled" look true; sign-out left a
 * 30-day refresh token live at the provider. Revocation is now wired into
 * `releaseChutesAuthority` (pinned in connection-continuity.test.ts) and the
 * broker is deleted rather than left standing as a second, unrun answer.
 *
 * So the guard is reachability, not that one name: a module under `src/auth`
 * that declares behaviour must have a non-test importer somewhere in `src`, or
 * not be in the tree. Pure re-export barrels are exempt on purpose — they hold
 * no code, so an unimported one asserts nothing about what runs.
 */
describe("every credential module under src/auth is reachable from production", () => {
  /** Runtime edges only: `import type` is erased, so it constructs nothing. */
  const STATIC_EDGE = /(?:^|[\s;}])(?:import|export)\s+(?!type\s)(?:[^'"();]*?\sfrom\s+)?["']([^"']+)["']/gmu;
  /** App reaches `chutes-oauth` this way, so a static-only scan would miss it. */
  const DYNAMIC_EDGE = /\bimport\s*\(\s*["']([^"']+)["']/gu;
  const RESOLUTION_SUFFIXES = Object.freeze(["", ".ts", ".tsx", "/index.ts", "/index.tsx"]);
  const DECLARES_BEHAVIOUR = /^export\s+(?:async\s+function|function|class|abstract\s+class|const|let|var|default)\s/mu;
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

  function isTest(file: string): boolean {
    return /\.test\.tsx?$/u.test(file);
  }

  async function* sourceFiles(directory: string): AsyncGenerator<string> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(child);
      else if (/\.tsx?$/u.test(entry.name)) yield child;
    }
  }

  async function resolveModule(fromFile: string, specifier: string): Promise<string | undefined> {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(fromFile), specifier);
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  it("has no auth module whose only importer is its own test", async () => {
    const importedByProduction = new Set<string>();
    for await (const file of sourceFiles(sourceRoot)) {
      if (isTest(file)) continue;
      const source = await readFile(file, "utf8");
      for (const edge of [STATIC_EDGE, DYNAMIC_EDGE]) {
        for (const match of source.matchAll(edge)) {
          const target = await resolveModule(file, match[1]!);
          if (target) importedByProduction.add(target);
        }
      }
    }

    const orphans: string[] = [];
    for await (const file of sourceFiles(join(sourceRoot, "auth"))) {
      if (isTest(file) || importedByProduction.has(file)) continue;
      // A barrel declares nothing of its own, so it cannot be a lifecycle that
      // looks implemented while nothing runs it.
      if (!DECLARES_BEHAVIOUR.test(await readFile(file, "utf8"))) continue;
      orphans.push(relative(sourceRoot, file));
    }
    expect(orphans, "wire it into production or delete it — a tested, unmounted credential lifecycle reads as the live one").toEqual([]);
  });

  it("finds the orphan it exists to find, and does not flag a re-export barrel", async () => {
    // The scan is the whole guarantee, so both halves of its rule are exercised
    // here rather than by waiting for the next unmounted module.
    const broker = 'import { revokeChutesToken } from "./chutes-oauth";\nexport class ChutesCredentialBroker {}\n';
    const barrel = 'export { revokeChutesToken, type ChutesOAuthTokenSet } from "./chutes-oauth";\n';
    expect(DECLARES_BEHAVIOUR.test(broker)).toBe(true);
    expect(DECLARES_BEHAVIOUR.test(barrel)).toBe(false);
    // And the edge scan reads a dynamic import, which is how App reaches auth.
    const app = 'const { revokeChutesToken } = await import("../auth/chutes-oauth");';
    expect([...app.matchAll(DYNAMIC_EDGE)].map((match) => match[1])).toEqual(["../auth/chutes-oauth"]);
    // A type-only edge names a module without running any of it.
    const typeOnly = 'import type { ChutesOAuthTokenSet } from "../auth/chutes-oauth";';
    expect([...typeOnly.matchAll(STATIC_EDGE)]).toEqual([]);
    // The module the guard was written for is gone, not merely unimported.
    await expect(stat(join(sourceRoot, "auth/chutes-credential-broker.ts"))).rejects.toThrow();
  });
});
