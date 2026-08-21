import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, providerConnections] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./provider-connections-view.tsx", import.meta.url), "utf8"),
]);

describe("offline runtime UI contract", () => {
  it("binds one browser connectivity observer at the app shell", () => {
    expect([...app.matchAll(/observeConnectivity\(window, navigator, setOnline\)/gu)]).toHaveLength(1);
    expect(app).toContain("const composerOfflineBlocked = remoteComposerBlocked(");
  });

  it("blocks only remote chat sends and leaves local slash tools on their own path", () => {
    expect(app).toContain('const commands = commandModule.createSlashCommandRegistry({ tools });');
    expect(app).toContain('slashModule.planSlashCommand(input.trim(), slashRegistry)');
    expect(app).toContain('Boolean(composerPlan && composerPlan.kind !== "chat")');
    expect(app).toContain('const localCommandPolicy = sessionId ? sessionLocalCommandPolicy(sessionId) : undefined;');
    expect(app).toContain('disabled={!input.trim()');
    expect(app).toContain('|| composerOfflineBlocked');
    expect(app).toContain('"Send unavailable while remote inference is offline"');
  });

  it("keeps pending composer text when a pinned remote route turns read-only", () => {
    expect(app).toContain("Your prompt remains here.");
    expect(app).toContain('setRuntimeStatus("Pinned inference route unavailable · prompt preserved")');
    expect(app).toContain("your prompt, messages, journal, and workspace remain here.");
  });

  it("pauses cloud provider setup offline without blocking local provider checks", () => {
    expect(providerConnections).toContain('<h3 id="cloud-provider-setup-title">Cloud providers</h3>');
    expect(providerConnections).toContain('<h3 id="local-provider-setup-title">Local model servers</h3>');
    expect(providerConnections).toContain('setNotice(`Reading the live ${provider.label} model catalog…`)');
    expect(providerConnections).toContain('disabled={connected || !online || disabled || !accepted || !hasKey}');
    expect(providerConnections).toContain('setNotice(`Checking ${provider.label} at ${endpoint} and reading its installed model catalog…`)');
    expect(providerConnections).toContain('disabled={connected || disabled || !endpoint.trim()}');
    expect(providerConnections).toContain('if (!online) return "Offline · remote provider checks are paused; local state was kept."');
  });

  it("keeps generic provider setup state and says why cloud sign-in stays unavailable here", () => {
    expect(providerConnections).toContain("No account sign-in flow is wired into this build for {provider.label}.");
    expect(providerConnections).toContain("This card accepts an API key, keeps it only in this page");
    expect(providerConnections).toContain("Your credential and acknowledgement were kept. Correct the problem, then try again.");
  });
});
