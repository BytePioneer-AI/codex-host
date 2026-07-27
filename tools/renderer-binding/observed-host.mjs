import fs from "node:fs";
import path from "node:path";

import { AppServerHost } from "../../packages/host-runtime/dist/index.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";
const OBSERVATION_PATH_ENV = "CODEXHOST_ROUTE_OBSERVATION_PATH";

const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
const defaultAgent = process.env[DEFAULT_AGENT_ENV];
if (defaultAgent !== "codex" && defaultAgent !== "pi") {
  throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
}
const observationPath = process.env[OBSERVATION_PATH_ENV];
if (!observationPath || !path.isAbsolute(observationPath)) {
  throw new Error(`${OBSERVATION_PATH_ENV} must be an absolute path`);
}

const environment = { ...process.env };
delete environment[OBSERVATION_PATH_ENV];

const host = new AppServerHost({
  stockCodexPath,
  arguments: process.argv.slice(2),
  defaultAgent,
  environment,
  ...(process.env[PI_COMMAND_ENV] ? { piCommand: process.env[PI_COMMAND_ENV] } : {}),
  onCreateRequestRoute(observation) {
    fs.appendFileSync(
      observationPath,
      `${JSON.stringify({ schemaVersion: 1, ...observation })}\n`,
      "utf8",
    );
  },
});

process.exitCode = await host.run();
