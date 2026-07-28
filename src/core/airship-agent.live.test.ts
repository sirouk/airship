import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BrowserGitClient } from "../git";
import { MemoryGitAdapter } from "../git/memory-adapter";
import { WasmChutesE2eeCrypto } from "../inference/chutes/crypto";
import { ChutesInferenceTransport } from "../inference/chutes/transport";
import { createAirshipToolRegistry } from "../tools/airship-tools";
import { allowAllForTests } from "../tools/registry";
import { MemoryWorkspace } from "../workspace/memory";
import { AIRSHIP_CORE_CHARTER } from "./operating-charter";
import { MemoryJournalBackend } from "./memory-journal";
import { EventJournal } from "./journal";
import { createSessionManifest, runTurn } from "./agent";

const apiKey = process.env.CHUTES_TEST_API_KEY?.trim();
const requestedModel = process.env.CHUTES_TEST_MODEL?.trim() || "zai-org/GLM-5.2-TEE";
if (process.env.AIRSHIP_CHUTES_LIVE === "1" && !apiKey) {
  throw new Error("Live Chutes acceptance requires CHUTES_TEST_API_KEY.");
}
const liveDescribe = apiKey ? describe : describe.skip;

liveDescribe("live fully tooled Airship agent", () => {
  it("uses browser workspace tools and verifies the resulting artifact", async () => {
    const wasm = await readFile(new URL("../inference/chutes/wasm/chutes_e2ee_wasm_bg.wasm", import.meta.url));
    const transport = new ChutesInferenceTransport({
      apiKey: apiKey!,
      attestationMode: "optional",
      crypto: new WasmChutesE2eeCrypto({ module_or_path: wasm }),
    });
    const model = (await transport.listModels()).find((candidate) => candidate.id === requestedModel);
    expect(model, `Live Chutes did not return ${requestedModel}.`).toBeDefined();

    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "# Live Airship capability proof\n");
    const git = new BrowserGitClient(await MemoryGitAdapter.create([{
      id: "live-workspace",
      name: "Live workspace",
      files: { "README.md": "# Live Airship capability proof\n" },
    }]));
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = await createAirshipToolRegistry({ workspace, journal, git });
    const manifest = await createSessionManifest({
      systemPrompt: `${AIRSHIP_CORE_CHARTER}\n\n[Airship profile]\nYou are an outcome-owning systems engineer. Use the provided browser executors, act rather than merely advise, and verify mutations before answering.`,
      providerId: transport.id,
      model: model!.id,
      tools: tools.definitions(),
      workspaceId: "memory://airship-live-capability",
      securityPosture: transport.posture,
      capabilityTier: "web-enhanced",
    });
    const session = await journal.createSession("Live full agent proof", manifest);
    const expected = "airship browser tools are live";
    const result = await runTurn({
      sessionId: session.id,
      content: `Use tools now. Create /workspace/notes/live-capability.txt containing exactly: ${expected}\nThen read that exact file back to verify it. Do not merely describe the steps. After verification, answer concisely.`,
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      maxSteps: 12,
    });

    expect((await workspace.read("notes/live-capability.txt"))?.content.trim()).toBe(expected);
    const toolNames = result.events
      .filter((event) => event.type === "tool.resulted")
      .map((event) => event.payload && !Array.isArray(event.payload) && typeof event.payload === "object" ? event.payload.name : undefined);
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("read_file");
    expect(result.content.trim().length).toBeGreaterThan(0);
  }, 180_000);
});
