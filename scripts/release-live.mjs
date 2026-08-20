import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Live release acceptance exercises real provider endpoints with
 * operator-supplied keys. Every stage is vendor-generic: a key's presence
 * opts its provider into the wire-contract run, and the run is skipped as a
 * configuration error — never silently — when no key at all is present.
 */
export const DIRECT_CLOUD_VENDOR_KEYS = Object.freeze([
  "AIRSHIP_OPENAI_API_KEY",
  "AIRSHIP_ANTHROPIC_API_KEY",
  "AIRSHIP_XAI_API_KEY",
]);

const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

export function readLiveAcceptanceConfig(environment = process.env) {
  const configured = DIRECT_CLOUD_VENDOR_KEYS.filter((name) => environment[name]?.trim());
  if (configured.length === 0) {
    throw new Error(`Live release acceptance is not configured. Provide at least one of: ${DIRECT_CLOUD_VENDOR_KEYS.join(", ")}. No live gate was started.`);
  }
  return Object.freeze({ configuredVendorKeys: Object.freeze(configured) });
}

export function createLiveAcceptancePlan(config, environment = process.env) {
  /*
   * Node performs no CORS enforcement, so this stage checks the HTTP wire
   * contract only; browser reachability is the master acceptance lane's job.
   */
  return Object.freeze([
    Object.freeze({
      label: `direct cloud vendor wire-contract gate (${config.configuredVendorKeys.join(", ")}; protocol only, no CORS proof)`,
      command: process.execPath,
      args: Object.freeze([
        vitestCli,
        "run",
        "src/inference/providers/browser-cloud.live.test.ts",
        "--reporter=verbose",
      ]),
      environment: Object.freeze({ ...environment }),
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runLiveAcceptance().catch((error) => {
    console.error(error instanceof Error ? error.message : "Live release acceptance failed.");
    process.exitCode = 1;
  });
}
