import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conversationTitleFromPrompt } from "../core/conversation-title";
import { conversationDisplayTitle, isAppMintedConversationTitle } from "./app";

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

  /*
   * P4. Two conversations nobody has named yet carry the same minted title, so
   * an approval scoped to one of them named both.
   *
   * Measured in Chromium: two untitled conversations, each holding an
   * unanswered `/write`, produced the eyebrow
   * "CAPABILITY REQUEST · GENERAL CONVERSATION · CHANGE" in both dialogs and
   * one indistinguishable "Review write_file in General conversation" button.
   */
  it("tells two unnamed conversations apart without renaming either", () => {
    const first = "0f1e2d3c-aaaa-4bbb-8ccc-000000000001";
    const second = "9a8b7c6d-eeee-4fff-8000-000000000002";
    expect(conversationDisplayTitle(first, "General conversation", "General")).toBe("General conversation 0f1e2d3c");
    expect(conversationDisplayTitle(second, "General conversation", "General")).toBe("General conversation 9a8b7c6d");
    expect(conversationDisplayTitle(first, "General conversation", "General"))
      .not.toBe(conversationDisplayTitle(second, "General conversation", "General"));
    // Every default the app mints, not just the plain one.
    expect(conversationDisplayTitle(first, "General · encrypted vault", "General"))
      .toBe("General · encrypted vault 0f1e2d3c");
  });

  it("leaves a name a person chose exactly as they wrote it", () => {
    const id = "0f1e2d3c-aaaa-4bbb-8ccc-000000000001";
    expect(conversationDisplayTitle(id, "Draft the Q3 pricing memo", "General")).toBe("Draft the Q3 pricing memo");
    expect(conversationDisplayTitle(id, "General conversation", "Research")).toBe("General conversation");
    // No record at all is still the fallback it always was.
    expect(conversationDisplayTitle(id, undefined, "General")).toBe("conversation 0f1e2d3c");
  });

  it("keeps the approval dock reading through that one helper", () => {
    expect(source).toContain("return conversationDisplayTitle(");
    expect(source).toContain("<ApprovalDockView broker={approvalBroker} conversationName={conversationDisplayName} />");
  });

  it("keeps minting and matching on the same helpers", () => {
    expect(source).toContain('appMintedConversationTitle(profile.name, "vault")');
    expect(source).toContain('appMintedConversationTitle(profile.name, "ephemeral")');
    expect(source).toContain("isAppMintedConversationTitle(activeSessionRecord.title, activeProfile.name)");
  });
});
