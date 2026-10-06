import fs from "node:fs";
import path from "node:path";

import {
  AppServerHost,
  installedHarnessPluginOptions,
} from "../../packages/host-runtime/dist/index.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const OBSERVATION_PATH_ENV = "CODEXHOST_ROUTE_OBSERVATION_PATH";

const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
const observationPath = process.env[OBSERVATION_PATH_ENV];
if (!observationPath || !path.isAbsolute(observationPath)) {
  throw new Error(`${OBSERVATION_PATH_ENV} must be an absolute path`);
}

const environment = { ...process.env };
delete environment[OBSERVATION_PATH_ENV];

const host = new AppServerHost({
  stockCodexPath,
  arguments: process.argv.slice(2),
  environment,
  ...installedHarnessPluginOptions(environment),
  onRequestRoute(observation) {
    fs.appendFileSync(
      observationPath,
      `${JSON.stringify({ schemaVersion: 2, ...observation })}\n`,
      "utf8",
    );
  },
});

process.exitCode = await host.run();
