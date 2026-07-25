import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSessionManifest, runTurn } from "../../core/agent";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { auditSessionHistory } from "../../core/session-audit";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { WasmChutesE2eeCrypto } from "./crypto";
import { ChutesInferenceTransport } from "./transport";

const apiKey = process.env.CHUTES_TEST_API_KEY?.trim();
const requestedModel = process.env.CHUTES_TEST_MODEL?.trim() || "zai-org/GLM-5.2-TEE";
const liveDescribe = apiKey ? describe : describe.skip;
const stressDescribe = apiKey && process.env.AIRSHIP_CHUTES_STRESS === "1" ? describe : describe.skip;

liveDescribe("live Airship Chutes E2EE transport", () => {
  it("streams a real encrypted turn into a clean auditable journal", async () => {
    const wasm = await readFile(new URL("./wasm/chutes_e2ee_wasm_bg.wasm", import.meta.url));
    const transport = new ChutesInferenceTransport({
      apiKey: apiKey!,
      attestationMode: "optional",
      crypto: new WasmChutesE2eeCrypto({ module_or_path: wasm }),
    });
    const models = await transport.listModels();
    const model = models.find((candidate) => candidate.id === requestedModel);
    expect(model, `Live Chutes did not return ${requestedModel}.`).toBeDefined();

    const tools = new ToolRegistry();
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "Reply concisely and do not call tools.",
      providerId: transport.id,
      model: model!.id,
      tools: tools.definitions(),
      workspaceId: "memory://airship-live-chutes-smoke",
      securityPosture: transport.posture,
    });
    const session = await journal.createSession("Live Chutes smoke", manifest);
    const result = await runTurn({
      sessionId: session.id,
      content: "Reply with exactly: airship live e2ee ok",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(result.content.trim().length).toBeGreaterThan(0);
    expect(result.receipt).toMatchObject({
      provider: transport.id,
      model: model!.id,
      claims: {
        encryption: { status: "partial" },
        conversation: {
          status: "partial",
          verifier: "airship-client",
          details: {
            commitment: "airship-chutes-e2e-response-sha256-chain-v1",
            authority: "local-client",
          },
        },
      },
      bindings: {
        requestDigest: expect.stringMatching(/^sha256:/u),
        responseDigest: expect.stringMatching(/^sha256:/u),
        requestCiphertextDigest: expect.stringMatching(/^sha256:/u),
        responseCiphertextDigest: expect.stringMatching(/^sha256:/u),
      },
      verifications: expect.arrayContaining([
        expect.objectContaining({
          verifier: "airship-client",
          status: "partial",
          claim: "conversation",
        }),
      ]),
    });

    const persisted = await journal.getSession(session.id);
    expect(persisted).toBeDefined();
    const audit = await auditSessionHistory({
      session: persisted!,
      events: await journal.readEvents(session.id),
    });
    expect(audit.status).toBe("verified");
    expect(audit.findings).toEqual([]);
  }, 180_000);
});

stressDescribe("live Airship Chutes E2EE transport reliability", () => {
  it("completes repeated encrypted turns through one long-lived transport", async () => {
    const wasm = await readFile(new URL("./wasm/chutes_e2ee_wasm_bg.wasm", import.meta.url));
    const transport = new ChutesInferenceTransport({
      apiKey: apiKey!,
      attestationMode: "optional",
      crypto: new WasmChutesE2eeCrypto({ module_or_path: wasm }),
    });
    const model = (await transport.listModels()).find((candidate) => candidate.id === requestedModel);
    expect(model, `Live Chutes did not return ${requestedModel}.`).toBeDefined();

    for (let turn = 1; turn <= 8; turn += 1) {
      const events = [];
      const turnId = crypto.randomUUID();
      for await (const event of transport.stream({
        requestId: crypto.randomUUID(),
        sessionId: `live-stress-${turn}`,
        turnId,
        model: model!.id,
        systemPrompt: "Follow the user's exact response instruction.",
        messages: [{ role: "user", content: `Reply with exactly: airship e2ee turn ${turn}` }],
        tools: [],
        idempotencyKey: `live-stress-${turnId}`,
      }, new AbortController().signal)) {
        events.push(event);
      }
      const text = events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.type === "text-delta" ? event.text : "")
        .join("");
      expect(text.toLowerCase()).toContain(`airship e2ee turn ${turn}`);
      expect(events.at(-1)?.type).toBe("completed");
    }
  }, 300_000);
});
