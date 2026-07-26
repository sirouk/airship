import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import masterConfig, { MASTER_ACCEPTANCE_ORIGIN } from "../playwright.master.config.ts";
import liveConfig, { LIVE_ACCEPTANCE_ORIGIN } from "../playwright.live.config.ts";
import {
  createLiveAcceptancePlan,
  readLiveAcceptanceConfig,
  runLiveAcceptance,
} from "./release-live.mjs";

const credential = "fixture-memory-only-credential";
const configuredEnvironment = Object.freeze({
  PATH: process.env.PATH,
  AIRSHIP_CHUTES_API_KEY: credential,
  AIRSHIP_CHUTES_TOOL_MODEL: "provider/tool-model",
  AIRSHIP_CHUTES_VISION_MODEL: "provider/vision-model",
});

describe("live release acceptance infrastructure", () => {
  it("owns dedicated strict-port servers instead of reusing developer state", () => {
    expect(MASTER_ACCEPTANCE_ORIGIN).toBe("http://127.0.0.1:4186");
    expect(LIVE_ACCEPTANCE_ORIGIN).toBe("http://127.0.0.1:4188");
    expect(masterConfig.use?.baseURL).toBe(MASTER_ACCEPTANCE_ORIGIN);
    expect(liveConfig.use?.baseURL).toBe(LIVE_ACCEPTANCE_ORIGIN);
    expect(masterConfig.webServer).toMatchObject({
      url: MASTER_ACCEPTANCE_ORIGIN,
      reuseExistingServer: false,
    });
    expect(liveConfig.webServer).toMatchObject({
      url: LIVE_ACCEPTANCE_ORIGIN,
      reuseExistingServer: false,
    });
    expect(liveConfig.use).toMatchObject({ screenshot: "off", trace: "off", video: "off" });
    expect(liveConfig.reporter).toBe("list");
    expect(masterConfig.webServer?.command).toContain("--port 4186 --strictPort");
    expect(liveConfig.webServer?.command).toContain("--port 4188 --strictPort");
  });

  it("cannot redirect the master suite through caller-supplied base URLs", () => {
    const source = readFileSync(new URL("../e2e/master-browser-acceptance.spec.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AIRSHIP_(?:ACCEPTANCE|LIVE)_BASE_URL/u);
  });

  it("fails before spawning when any required live setting is absent", async () => {
    expect(() => readLiveAcceptanceConfig({})).toThrow(
      /AIRSHIP_CHUTES_API_KEY, AIRSHIP_CHUTES_TOOL_MODEL, AIRSHIP_CHUTES_VISION_MODEL/u,
    );
    let executed = false;
    await expect(runLiveAcceptance({
      environment: {},
      execute: async () => { executed = true; },
      logger: { log() {} },
    })).rejects.toThrow(/No live gate was started/u);
    expect(executed).toBe(false);
  });

  it("maps one memory-only credential into both gates without putting it in commands or logs", async () => {
    const config = readLiveAcceptanceConfig(configuredEnvironment);
    const plan = createLiveAcceptancePlan(config, configuredEnvironment);
    expect(plan.map((stage) => stage.label)).toEqual([
      "real Chutes E2EE transport and tool-agent gates",
      "real-browser Chutes E2EE vision and endpoint-attestation gate",
    ]);
    expect(plan[0].environment.CHUTES_TEST_API_KEY).toBe(credential);
    expect(plan[0].environment.CHUTES_TEST_MODEL).toBe("provider/tool-model");
    expect(plan[1].environment.AIRSHIP_CHUTES_API_KEY).toBe(credential);
    expect(plan[1].environment.AIRSHIP_CHUTES_VISION_MODEL).toBe("provider/vision-model");
    expect(plan.flatMap((stage) => [stage.command, ...stage.args]).join(" ")).not.toContain(credential);

    const messages = [];
    const executed = [];
    await runLiveAcceptance({
      environment: configuredEnvironment,
      execute: async (stage) => { executed.push(stage.label); },
      logger: { log(message) { messages.push(message); } },
    });
    expect(executed).toEqual(plan.map((stage) => stage.label));
    expect(messages.join("\n")).not.toContain(credential);
  });

  it("keeps the ordinary check independent of live configuration", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.check).not.toMatch(/release-live|CHUTES|acceptance:live/iu);
    expect(pkg.scripts.test).toContain("--exclude '**/*.live.test.ts'");
    expect(pkg.scripts.test).not.toMatch(/CHUTES|release-live/iu);
  });
});

describe("optional direct-cloud vendor stage", () => {
  it("is absent when no vendor key is configured and present when one is", () => {
    const base = {
      AIRSHIP_CHUTES_API_KEY: "chutes-live-credential-value",
      AIRSHIP_CHUTES_TOOL_MODEL: "org/tool-model",
      AIRSHIP_CHUTES_VISION_MODEL: "org/vision-model",
    };
    const config = readLiveAcceptanceConfig(base);

    expect(createLiveAcceptancePlan(config, base).map((stage) => stage.label))
      .not.toContain("direct cloud vendor wire-contract gate (protocol only; no CORS proof)");

    const withVendor = { ...base, AIRSHIP_ANTHROPIC_API_KEY: "sk-ant-disposable" };
    const plan = createLiveAcceptancePlan(readLiveAcceptanceConfig(withVendor), withVendor);
    const stage = plan.at(-1);
    expect(stage?.label).toContain("direct cloud vendor wire-contract gate");
    expect(stage?.args).toContain("src/inference/providers/browser-cloud.live.test.ts");
    expect(stage?.environment.AIRSHIP_ANTHROPIC_API_KEY).toBe("sk-ant-disposable");
  });
});
