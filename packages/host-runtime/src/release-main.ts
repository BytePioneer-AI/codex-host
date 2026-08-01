import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

import { AppServerHost } from "./app-server-host.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";
const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";

const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
const defaultAgent = process.env[DEFAULT_AGENT_ENV];
if (defaultAgent !== "codex" && defaultAgent !== "pi") {
  throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
}

const externalAdapters = new Map<ExternalHarnessId, HarnessAdapter>();
externalAdapters.set(
  "pi",
  new PiAdapter({
    ...(process.env[PI_COMMAND_ENV] ? { command: process.env[PI_COMMAND_ENV] } : {}),
    environment: process.env,
  }),
);

const host = new AppServerHost({
  stockCodexPath,
  arguments: process.argv.slice(2),
  defaultAgent,
  environment: process.env,
  externalAdapters,
});

process.exitCode = await host.run();
