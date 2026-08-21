import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Arriving at a conversation's own address shows that conversation, or says it
 * is opening. It never shows a different one, and it never mints one.
 *
 * Measured in Chromium on a real browser restart at a saved conversation's
 * address, with an encrypted Local Device Vault adopted: at 166ms the screen
 * held one conversation labelled Ephemeral, at 682ms a second labelled
 * encrypted, and at 8,375ms the requested one — while the address bar named the
 * right one for the whole 8.4 seconds. The second of those was minted on the
 * spot: vault adoption asks whether the addressed conversation can resume, a
 * conversation pinned to a provider this page has not reconnected yet cannot,
 * and the mint stood in for it. The library grew from 2 rows to 3 to 4 across
 * three visits, each new row an empty "General · encrypted vault" nobody asked
 * for.
 *
 * Source-shape, for the reason `concurrent-turns.test.ts` states beside it:
 * both facts are decisions inside one closure over the app's storage-adoption
 * transaction, and neither can be lifted out of `app.tsx` to be driven
 * directly. `e2e/saved-conversation-opens-tomorrow.spec.ts` drives the same two
 * facts through a real browser restart against a real build.
 */
function appSource(): string {
  return readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
}

describe("an address is answered by the conversation it names", () => {
  it("mints nothing when the boot address names a conversation", () => {
    const app = appSource();
    const adoption = app.slice(
      app.indexOf("const addressedConversation = typeof window === \"undefined\""),
      app.indexOf("workspaceRefreshCoordinator.invalidate();", app.indexOf("const addressedConversation")),
    );
    expect(adoption).not.toBe("");
    // The mint is reachable only when this journal does not hold the
    // conversation the address names. A page-memory id left in the hash by the
    // Vault ceremony is not one of those, and still gets its conversation.
    expect(adoption).toContain("const nextSession = resumableSession ?? (candidateSessions.some((session) => session.id === addressedConversation)\n      ? undefined\n      : await createProfileSession(");
    // And the address still leads the candidate shelf, so a conversation that
    // CAN resume is resumed rather than merely opened later.
    expect(adoption).toContain("compatibleProfileConversations(nextRuntime, profile, nextCatalog, addressedConversation)");
  });

  it("publishes no conversation at all rather than a substitute", () => {
    const app = appSource();
    const publish = app.slice(
      app.indexOf("const activated = nextSession ? await activateSession(nextSession) : undefined;"),
      app.indexOf("setEventCount(activated?.headSequence ?? 0);"),
    );
    expect(publish).not.toBe("");
    for (const line of [
      "activeSessionIdentity.current = undefined;",
      "setSessionId(undefined);",
      "setActiveSessionRecord(undefined);",
    ]) expect(publish).toContain(line);
    // No transcript is drawn for a conversation that was not published.
    expect(publish).toContain("setMessages(!activated\n      ? []");
  });

  it("says the conversation is opening, in the transcript and in the title", () => {
    const app = appSource();
    expect(app).toContain("const openingAddressedConversation = chatRouteRequest !== undefined\n    && chatRouteRequest !== sessionId\n    && chatRouteRequest !== unopenableAddress;");
    // The transcript states it where the substituted conversation used to be
    // drawn, ahead of the first-run intro and instead of any message rows.
    expect(app).toContain("{openingAddressedConversation ? (\n                  <div class=\"transcript-boundary\" role=\"status\">");
    expect(app).toContain("<strong>{OPENING_ADDRESSED_CONVERSATION}</strong>");
    expect(app).toContain("Airship is opening the conversation this address names. No other conversation is shown in its place.");
    expect(app).toContain("{firstRunTranscript && !openingAddressedConversation ?");
    // And the session bar stops naming whatever conversation is underneath it,
    // in the same words the band uses, from one constant.
    expect(app).toContain('const OPENING_ADDRESSED_CONVERSATION = "Opening this conversation";');
    expect(app).toContain("title={openingAddressedConversation\n                  ? OPENING_ADDRESSED_CONVERSATION");
  });

  /*
   * A request that failed is not a request still in flight. The URL is kept
   * intact on purpose — the conversation is durable and its journal is whole —
   * so "a request is outstanding" cannot be the whole test, or the transcript
   * would promise an open that is not happening over the sentence saying why it
   * did not.
   */
  it("stops promising an open once the open has failed", () => {
    const app = appSource();
    const resolver = app.match(
      /void inspectSessionForNavigation\(requestedSessionId\)[\s\S]*?\n      \.finally\(/u,
    )?.[0] ?? "";
    expect(resolver).toContain("setUnopenableAddress(requestedSessionId);");
    expect(resolver.indexOf("setUnopenableAddress(requestedSessionId);"))
      .toBeGreaterThan(resolver.indexOf("Keep the URL intact"));
  });
});
