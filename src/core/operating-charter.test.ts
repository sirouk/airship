import { describe, expect, it } from "vitest";
import { sha256 } from "./hash";
import {
  AIRSHIP_CORE_CHARTER,
  AIRSHIP_CORE_CHARTER_VERSION,
  composeAirshipOperatingPrompt,
} from "./operating-charter";

describe("Airship core operating charter", () => {
  it("is versioned, deterministic, and byte-stable", async () => {
    expect(AIRSHIP_CORE_CHARTER_VERSION).toBe(8);
    expect(AIRSHIP_CORE_CHARTER).not.toMatch(/\{\{|\$\{|20\d\d-/u);
    expect(await sha256(AIRSHIP_CORE_CHARTER)).toBe(
      "sha256:SFCfMgOIeiiprrSYJ-bOX5ododEmD-SxbnY4PP0lkT4",
    );
  });

  it("defines the edge environment and its honest capability boundaries", () => {
    for (const contract of [
      "browser-native edge agent runtime",
      "inspect-act-verify",
      "current tool manifest",
      "only a runtime whose current state is ready can execute",
      "continue the task immediately in this same conversation",
      "Never ask for a fork or a new conversation merely because a page-local runtime became ready",
      "use the interactive Workspace Terminal for a long-running development server",
      "it is not a Rust compiler or Bash shell",
      "optional bounded virtual-workspace snapshot and revision-checked writeback",
      "virtual filesystem rooted at /workspace",
      "append-only, content-addressed conversation",
      "Context is selected client-side retrieval material",
      "Memory is a derived, provenance-bearing view of available state",
      "Explicit episodic memory belongs only to this session's pinned profile",
      "Workspace files, sources, and their hybrid index are shared",
      "Local Device, Google Drive, or S3-compatible storage receives encrypted objects directly from the client",
      "several page-memory provider authorities at once",
      // Same-thread model switching shipped; the charter used to tell the model
      // the thread had to be discarded to change models, and it is the
      // highest-authority text in the prompt.
      "never tell someone the thread must be discarded to change models",
      "do not assume adoption, synchronization, durability, or freshness",
      "Do not equate a local receipt",
      "reliable execution while suspended",
      "discover before concluding",
    ]) {
      expect(AIRSHIP_CORE_CHARTER).toContain(contract);
    }
  });

  it("layers profile and skill behavior after the invariant charter", () => {
    const prompt = composeAirshipOperatingPrompt("PROFILE-CANARY", [
      { skillId: "first", systemPrompt: "SKILL-ONE-CANARY" },
      { skillId: "second", systemPrompt: "SKILL-TWO-CANARY" },
    ]);

    expect(prompt).toBe(
      `${AIRSHIP_CORE_CHARTER}\n\n` +
      "[Airship profile]\nPROFILE-CANARY\n\n" +
      "[Airship skill: first]\nSKILL-ONE-CANARY\n\n" +
      "[Airship skill: second]\nSKILL-TWO-CANARY",
    );
    expect(prompt.indexOf("PROFILE-CANARY")).toBeGreaterThan(prompt.indexOf("discover before concluding"));
    expect(prompt.indexOf("SKILL-ONE-CANARY")).toBeGreaterThan(prompt.indexOf("PROFILE-CANARY"));
  });

  it("pins only exact installed tool contracts without promoting optional runtimes", () => {
    const prompt = composeAirshipOperatingPrompt("PROFILE", [], [
      { name: "read_file", effect: "read", description: "Read one workspace file." },
      { name: "inspect_execution_runtimes", effect: "read", description: "Report live runtime readiness." },
    ]);

    expect(prompt).toContain("[Airship installed tool manifest]");
    expect(prompt).toContain("- inspect_execution_runtimes [read]: Report live runtime readiness.");
    expect(prompt).toContain("- read_file [read]: Read one workspace file.");
    expect(prompt).not.toContain("execute_node_project [network]");
  });

  it("pins only observed browser capabilities and keeps them separate from activation", () => {
    const prompt = composeAirshipOperatingPrompt("PROFILE", [], [
      { name: "inspect_browser_capabilities", effect: "read", description: "Report live device state." },
    ], [
      { id: "wasm-simd", evidence: "probe-passed", detail: "The minimal SIMD module validated." },
      { id: "webtransport", evidence: "api-exposed", detail: "The constructor was observed; no connection exists." },
    ]);

    expect(prompt).toContain("[Airship observed browser capability pin]");
    expect(prompt).toContain("not an execution grant");
    expect(prompt).toContain("- wasm-simd [probe-passed]: The minimal SIMD module validated.");
    expect(prompt).toContain("- webtransport [api-exposed]: The constructor was observed; no connection exists.");
    expect(prompt.indexOf("[Airship observed browser capability pin]")).toBeLessThan(prompt.indexOf("[Airship profile]"));
  });

  it("pins a bounded credential-free provider roster without granting route changes", () => {
    const secret = "sk-this-must-never-enter-the-prompt";
    const prompt = composeAirshipOperatingPrompt("PROFILE", [], [], [], {
      active: {
        connectionId: "ollama-primary",
        providerId: "ollama",
        modelId: "gemma3:latest",
      },
      providers: [{
        connectionId: "ollama-primary",
        providerId: "ollama",
        label: "Ollama",
        state: "connected",
        authority: "local-service",
        models: [{
          id: "gemma3:latest",
          inputModalities: ["text", "image"],
          features: ["tools"],
        }],
        modelCount: 1,
      }, {
        connectionId: "openai-primary",
        providerId: "openai",
        label: "OpenAI",
        state: "degraded",
        authority: "api-key",
        models: [],
        modelCount: 4,
      }],
    });

    expect(prompt).toContain("[Airship inference roster pin]");
    expect(prompt).toContain("Credential values are deliberately absent");
    expect(prompt).toContain("Active: ollama-primary :: ollama :: gemma3:latest");
    expect(prompt).toContain("gemma3:latest [input=text+image;features=tools]");
    expect(prompt).toContain("4 more discoverable in the model control");
    expect(prompt).not.toContain(secret);
    expect(prompt.indexOf("[Airship inference roster pin]")).toBeLessThan(prompt.indexOf("[Airship profile]"));
  });
});
