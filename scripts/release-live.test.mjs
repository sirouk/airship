import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import masterConfig, { MASTER_ACCEPTANCE_ORIGIN } from "../playwright.master.config.ts";
import {
  DIRECT_CLOUD_VENDOR_KEYS,
  createLiveAcceptancePlan,
  readLiveAcceptanceConfig,
  runLiveAcceptance,
} from "./release-live.mjs";

describe("live release acceptance infrastructure", () => {
  it("owns a dedicated strict-port server instead of reusing developer state", () => {
    expect(MASTER_ACCEPTANCE_ORIGIN).toBe("http://127.0.0.1:4186");
    expect(masterConfig.use?.baseURL).toBe(MASTER_ACCEPTANCE_ORIGIN);
    expect(masterConfig.webServer).toMatchObject({
      url: MASTER_ACCEPTANCE_ORIGIN,
      reuseExistingServer: false,
    });
    expect(masterConfig.webServer?.command).toContain("--port 4186 --strictPort");
  });

  it("attaches the browser acceptance probes to explicit release scripts", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(masterConfig.testMatch).toEqual(expect.arrayContaining([
      "master-browser-acceptance.spec.ts",
      "live-webcontainer.spec.ts",
    ]));
    expect(pkg.scripts["test:e2e:master"]).toContain("AIRSHIP_LIVE_WEBCONTAINER=1");
    expect(pkg.scripts["test:e2e:master"]).toContain("playwright.master.config.ts");
  });

  it("cannot redirect the master suite through caller-supplied base URLs", () => {
    const source = readFileSync(new URL("../e2e/master-browser-acceptance.spec.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AIRSHIP_(?:ACCEPTANCE|LIVE)_BASE_URL/u);
  });

  it("fails before spawning when no vendor key at all is configured", async () => {
    expect(() => readLiveAcceptanceConfig({})).toThrow(
      /AIRSHIP_OPENAI_API_KEY, AIRSHIP_ANTHROPIC_API_KEY, AIRSHIP_XAI_API_KEY/u,
    );
    let executed = false;
    await expect(runLiveAcceptance({
      environment: {},
      execute: async () => { executed = true; },
      logger: { log() {} },
    })).rejects.toThrow(/No live gate was started/u);
    expect(executed).toBe(false);
  });

  it("passes vendor credentials through the environment, never through commands or logs", async () => {
    const credential = "sk-ant-fixture-memory-only-credential";
    const environment = Object.freeze({
      PATH: process.env.PATH,
      AIRSHIP_ANTHROPIC_API_KEY: credential,
    });
    const config = readLiveAcceptanceConfig(environment);
    expect(config.configuredVendorKeys).toEqual(["AIRSHIP_ANTHROPIC_API_KEY"]);

    const plan = createLiveAcceptancePlan(config, environment);
    expect(plan).toHaveLength(1);
    expect(plan[0].label).toContain("direct cloud vendor wire-contract gate");
    expect(plan[0].label).toContain("no browser CORS validation");
    expect(plan[0].args).toContain("src/inference/providers/browser-cloud.live.test.ts");
    expect(plan[0].environment.AIRSHIP_ANTHROPIC_API_KEY).toBe(credential);
    expect(plan.flatMap((stage) => [stage.command, ...stage.args]).join(" ")).not.toContain(credential);

    const messages = [];
    const executed = [];
    await runLiveAcceptance({
      environment,
      execute: async (stage) => { executed.push(stage.label); },
      logger: { log(message) { messages.push(message); } },
    });
    expect(executed).toEqual(plan.map((stage) => stage.label));
    expect(messages.join("\n")).not.toContain(credential);
  });

  it("names every vendor key the wire-contract suite actually reads", () => {
    const source = readFileSync(new URL("../src/inference/providers/browser-cloud.live.test.ts", import.meta.url), "utf8");
    for (const name of DIRECT_CLOUD_VENDOR_KEYS) {
      expect(source).toContain(name);
    }
  });

  it("keeps the ordinary check independent of live configuration", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.check).not.toMatch(/release-live|API_KEY|acceptance:live/iu);
    expect(pkg.scripts.test).toContain("--exclude '**/*.live.test.ts'");
    expect(pkg.scripts.test).not.toMatch(/API_KEY|release-live/iu);
  });
});
