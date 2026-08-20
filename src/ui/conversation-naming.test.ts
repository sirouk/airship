import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conversationTitleFromPrompt } from "../core/conversation-title";
import { isAppMintedConversationTitle } from "./app";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

describe("conversation naming", () => {
  it("uses the deterministic first prompt and never starts a naming inference", () => {
    expect(conversationTitleFromPrompt("  Draft the\nQ3   pricing memo  ")).toBe("Draft the Q3 pricing memo");
    expect(source).toContain("title: conversationTitleFromPrompt(content)");
    expect(source).toContain("runTurnBeforeNaming(() => runTurn({");
    expect(source.indexOf("runTurnBeforeNaming(() => runTurn({")).toBeLessThan(
      source.indexOf("turnRuntime.journal.renameSession("),
    );
    expect(source).not.toContain("conversationTitleFromModel");
    expect(source).not.toContain('source: "conversation-naming"');
    expect(source).not.toContain("naming-request-");
  });

  it("recognises every default the app mints", () => {
    expect(isAppMintedConversationTitle("General conversation", "General")).toBe(true);
    expect(isAppMintedConversationTitle("General · encrypted vault", "General")).toBe(true);
    expect(isAppMintedConversationTitle("General · ephemeral", "General")).toBe(true);
    expect(isAppMintedConversationTitle("Research · encrypted vault", "Research")).toBe(true);
  });

  it("does not overwrite a person or fork title", () => {
    expect(isAppMintedConversationTitle("Draft the Q3 pricing memo", "General")).toBe(false);
    expect(isAppMintedConversationTitle("Fork of General · encrypted vault", "General")).toBe(false);
    expect(isAppMintedConversationTitle("General · encrypted vault · edit", "General")).toBe(false);
    expect(isAppMintedConversationTitle("General conversation", "Research")).toBe(false);
  });

  it("keeps minting and matching on the same helpers", () => {
    expect(source).toContain('appMintedConversationTitle(profile.name, "vault")');
    expect(source).toContain('appMintedConversationTitle(profile.name, "ephemeral")');
    expect(source).toContain("isAppMintedConversationTitle(activeSessionRecord.title, activeProfile.name)");
  });
});
