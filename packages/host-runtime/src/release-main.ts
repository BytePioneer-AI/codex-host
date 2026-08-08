import { fileURLToPath } from "node:url";

import {
  createExternalHarnessAdapters,
  prefetchClaudeCodeModelCatalog,
} from "./adapter-composition.js";
import { AppServerHost } from "./app-server-host.js";
import { createHostUpdateCoordinator, startCompatibilityUpdate } from "./update-coordinator.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";
const COMPATIBILITY_UPDATE_ARGUMENT = "--codexhost-compatibility-update";

const arguments_ = process.argv.slice(2);
const updateCoordinator = createHostUpdateCoordinator({
  hostRuntimePath: fileURLToPath(import.meta.url),
  environment: process.env,
});

if (arguments_.length === 1 && arguments_[0] === COMPATIBILITY_UPDATE_ARGUMENT) {
  process.stdout.write(`${await startCompatibilityUpdate(updateCoordinator)}\n`);
} else {
  const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
  if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
  const defaultAgent = process.env[DEFAULT_AGENT_ENV];
  if (defaultAgent !== "codex" && defaultAgent !== "pi") {
    throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
  }

  const externalAdapters = createExternalHarnessAdapters(process.env);
  const host = new AppServerHost({
    stockCodexPath,
    arguments: arguments_,
    defaultAgent,
    environment: process.env,
    externalAdapters,
    updateCoordinator,
  });

  void prefetchClaudeCodeModelCatalog(externalAdapters);
  process.exitCode = await host.run();
}
