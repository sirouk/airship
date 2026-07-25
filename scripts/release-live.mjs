import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_ACCEPTANCE_ENVIRONMENT = Object.freeze({
  credential: "AIRSHIP_CHUTES_API_KEY",
  toolModel: "AIRSHIP_CHUTES_TOOL_MODEL",
  visionModel: "AIRSHIP_CHUTES_VISION_MODEL",
});

const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));

export function readLiveAcceptanceConfig(environment = process.env) {
  const missing = Object.values(LIVE_ACCEPTANCE_ENVIRONMENT)
    .filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Live release acceptance is not configured. Missing: ${missing.join(", ")}. No live gate was started.`);
  }

  const credential = boundedSecret(environment[LIVE_ACCEPTANCE_ENVIRONMENT.credential]);
  const toolModel = boundedModel(environment[LIVE_ACCEPTANCE_ENVIRONMENT.toolModel], "tool model");
  const visionModel = boundedModel(environment[LIVE_ACCEPTANCE_ENVIRONMENT.visionModel], "vision model");
  return Object.freeze({ credential, toolModel, visionModel });
}

export function createLiveAcceptancePlan(config, environment = process.env) {
  const sharedEnvironment = {
    ...environment,
    AIRSHIP_CHUTES_API_KEY: config.credential,
  };
  return Object.freeze([
    Object.freeze({
      label: "real Chutes E2EE transport and tool-agent gates",
      command: process.execPath,
      args: Object.freeze([
        vitestCli,
        "run",
        "src/inference/chutes/transport.live.test.ts",
        "src/core/airship-agent.live.test.ts",
        "--reporter=verbose",
      ]),
      environment: Object.freeze({
        ...sharedEnvironment,
        CHUTES_TEST_API_KEY: config.credential,
        CHUTES_TEST_MODEL: config.toolModel,
      }),
    }),
    Object.freeze({
      label: "real-browser Chutes E2EE vision and endpoint-attestation gate",
      command: process.execPath,
      args: Object.freeze([
        playwrightCli,
        "test",
        "--config=playwright.live.config.ts",
      ]),
      environment: Object.freeze({
        ...sharedEnvironment,
        AIRSHIP_CHUTES_VISION_MODEL: config.visionModel,
      }),
    }),
  ]);
}

export async function runLiveAcceptance({
  environment = process.env,
  execute = executeStage,
  logger = console,
} = {}) {
  const config = readLiveAcceptanceConfig(environment);
  const stages = createLiveAcceptancePlan(config, environment);
  logger.log("Live release acceptance configured. Credentials stay out of command arguments and wrapper output.");
  for (const stage of stages) {
    logger.log(`Running ${stage.label}...`);
    await execute(stage);
  }
  logger.log("Live release acceptance passed.");
}

async function executeStage(stage) {
  await new Promise((resolve, reject) => {
    const child = spawn(stage.command, stage.args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: stage.environment,
      stdio: "inherit",
    });
    child.once("error", () => reject(new Error(`${stage.label} could not start.`)));
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      const outcome = signal ? `signal ${signal}` : `exit status ${code ?? "unknown"}`;
      reject(new Error(`${stage.label} failed with ${outcome}.`));
    });
  });
}

function boundedSecret(value) {
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 4_096 || /\s/u.test(normalized)) {
    throw new Error("AIRSHIP_CHUTES_API_KEY is malformed. The supplied value was not logged.");
  }
  return normalized;
}

function boundedModel(value, label) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(normalized)) {
    throw new Error(`The configured Chutes ${label} identifier is malformed.`);
  }
  return normalized;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runLiveAcceptance().catch((error) => {
    console.error(error instanceof Error ? error.message : "Live release acceptance failed.");
    process.exitCode = 1;
  });
}
