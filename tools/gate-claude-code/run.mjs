import { spawnSync } from "node:child_process";
import path from "node:path";

import { runInspectScenario } from "./inspect.mjs";
import { runModelCatalogScenario } from "./models.mjs";
import { runWarmScenario } from "./warm.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function hermetic() {
  const vitest = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "tools/gate-claude-code",
      "--config",
      "tests/vitest.config.js",
      "--exclude",
      "tools/gate-claude-code/run.test.mjs",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function inspect() {
  const { result } = runInspectScenario();
  print(result);
  if (result.status !== "PASS") process.exitCode = result.status === "FAIL" ? 1 : 2;
  return result;
}

async function models() {
  const result = await runModelCatalogScenario({ repositoryRoot });
  print(result);
  if (result.status !== "PASS") process.exitCode = result.status === "FAIL" ? 1 : 2;
  return result;
}

async function warm() {
  const result = await runWarmScenario({ repositoryRoot });
  print(result);
  if (result.status !== "PASS") process.exitCode = result.status === "FAIL" ? 1 : 2;
  return result;
}

async function gate() {
  hermetic();
  if (process.exitCode) return;
  const inspection = inspect();
  if (inspection.status !== "PASS") return;
  const catalog = await models();
  if (catalog.status !== "PASS") return;
  await warm();
}

const [command = "hermetic", scenario] = process.argv.slice(2);
switch (command) {
  case "hermetic":
    hermetic();
    break;
  case "inspect":
    inspect();
    break;
  case "models":
    await models();
    break;
  case "warm":
    await warm();
    break;
  case "model-live": {
    const { runModelSwitchScenario } = await import("./model-live.mjs");
    const result = await runModelSwitchScenario({ repositoryRoot });
    print(result);
    if (result.status !== "PASS") process.exitCode = result.status === "FAIL" ? 1 : 2;
    break;
  }
  case "live": {
    const { runLiveProfile } = await import("./live.mjs");
    const result = await runLiveProfile({ repositoryRoot, scenario });
    print(result);
    if (result.status !== "PASS") process.exitCode = result.status === "FAIL" ? 1 : 2;
    break;
  }
  case "gate":
    await gate();
    break;
  default:
    throw new Error(`unknown Claude Probe command '${command}'`);
}
