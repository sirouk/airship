import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  modelControlActivity,
  modelControlOptions,
  safeModelControlErrorMessage,
} from "./model-control";

const source = readFileSync(new URL("./model-control.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

describe("active model summary", () => {
  it("keeps the active shape to provider and model only", () => {
    expect(source).not.toContain("boundaryLabel");
    expect(source).not.toContain("activeConnectionProofLabel");
  });

  it("keeps switching as the control's own live region", () => {
    expect(source).not.toContain("E2EE");
    expect(source).not.toContain("proof");
    expect(source).not.toContain("attestation");
    expect(source).toContain('<span class="runtime-posture" role="status">Switching…</span>');
  });
});

describe("provider-neutral model control", () => {
  it("never disables model selection during inference and does not claim the model is switching", () => {
    expect(modelControlActivity(true, false)).toEqual({
      disabled: false,
      switching: false,
    });
  });

  it("announces only an actual route transition or pending model selection as switching", () => {
    expect(modelControlActivity(false, true)).toEqual({
      disabled: true,
      switching: true,
    });
    expect(modelControlActivity(false, false, "next-model")).toEqual({
      disabled: true,
      switching: true,
    });
  });

  it("passes inference busy and model transition state independently from Chat", () => {
    expect(appSource).toContain("busy={busy}\n                    switching={modelSwitching}");
    expect(appSource).not.toContain("busy={busy || modelSwitching}");
  });

  it("shows a connected catalog in Chat before a model is pinned", () => {
    expect(appSource).toContain("standbyExternalModels");
    expect(appSource).toContain("selectStandbyExternalModel");
    expect(appSource).toContain("standbyExternalModels.length > 0");
    expect(appSource).toContain("The selected model is no longer in the connected catalog");
    expect(appSource).not.toContain("soleTextGenerationModel");
  });

  it("retains a pinned model when a refreshed catalog no longer lists it", () => {
    expect(modelControlOptions([
      { id: "new-model", label: "New model", detail: "Vision" },
    ], "pinned-model")).toEqual([
      {
        value: "pinned-model",
        label: "pinned-model",
        description: "Current pinned model · catalog details unavailable",
      },
      {
        value: "new-model",
        label: "New model",
        description: "Vision · starts a new pinned conversation",
      },
    ]);
  });

  it("does not duplicate a pinned model already present in the live catalog", () => {
    const options = modelControlOptions([
      { id: "pinned-model", label: "Pinned model" },
      { id: "other-model", label: "Other model" },
    ], "pinned-model");
    expect(options).toHaveLength(2);
    expect(options[0]?.value).toBe("pinned-model");
  });

  it("names in-place semantics when the visible thread pins the same connection", () => {
    expect(modelControlOptions([
      { id: "model-b", label: "Model B", detail: "Vision" },
    ], "model-a", true)).toEqual([
      {
        value: "model-a",
        label: "model-a",
        description: "Current conversation model · catalog details unavailable",
      },
      {
        value: "model-b",
        label: "Model B",
        description: "Vision · changes this conversation in place",
      },
    ]);
  });

  it("keeps fork semantics the default so a caller cannot promise in place by accident", () => {
    expect(modelControlOptions([
      { id: "model-b", label: "Model B" },
    ], "model-a")).toEqual([
      {
        value: "model-a",
        label: "model-a",
        description: "Current pinned model · catalog details unavailable",
      },
      {
        value: "model-b",
        label: "Model B",
        description: "Starts a new pinned conversation",
      },
    ]);
  });

  it("keeps non-chat catalog rows visible but disabled", () => {
    expect(modelControlOptions([
      { id: "embedding-model", label: "Embedding model", detail: "Embeddings", disabled: true },
      { id: "chat-model", label: "Chat model", detail: "Tools" },
    ])).toEqual([
      {
        value: "embedding-model",
        label: "Embedding model",
        disabled: true,
        description: "Embeddings · not a chat model",
      },
      {
        value: "chat-model",
        label: "Chat model",
        description: "Tools · starts a new pinned conversation",
      },
    ]);
  });

  it("redacts credential-shaped failure text", () => {
    const secret = "sk-examplecredential123456789";
    const message = safeModelControlErrorMessage(new Error(`Bearer token-value ${secret}`));
    expect(message).not.toContain(secret);
    expect(message).not.toContain("token-value");
    expect(message).toContain("[credential]");
  });

  it("opens the session model menu into the available stage instead of above the header", () => {
    expect(source).toContain('placement="down"');
  });
});
