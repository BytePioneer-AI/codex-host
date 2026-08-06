import { fileURLToPath } from "node:url";

import {
  createExternalHarnessAdapters,
  prefetchClaudeCodeModelCatalog,
} from "./adapter-composition.js";
import { AppServerHost } from "./app-server-host.js";
import { createHostUpdateCoordinator } from "./update-coordinator.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";

const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
const defaultAgent = process.env[DEFAULT_AGENT_ENV];
if (defaultAgent !== "codex" && defaultAgent !== "pi") {
  throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
}

const externalAdapters = createExternalHarnessAdapters(process.env);
const updateCoordinator = createHostUpdateCoordinator({
  hostRuntimePath: fileURLToPath(import.meta.url),
  environment: process.env,
});
const host = new AppServerHost({
  stockCodexPath,
  arguments: process.argv.slice(2),
  defaultAgent,
  environment: process.env,
  externalAdapters,
  updateCoordinator,
});

void prefetchClaudeCodeModelCatalog(externalAdapters);
process.exitCode = await host.run();
