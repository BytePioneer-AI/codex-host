import { AppServerHost } from "./app-server-host.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";

const stockCodexPath = process.env[STOCK_CODEX_PATH_ENV];
if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
const defaultAgent = process.env[DEFAULT_AGENT_ENV];
if (defaultAgent !== "codex" && defaultAgent !== "pi") {
  throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
}

const host = new AppServerHost({
  stockCodexPath,
  arguments: process.argv.slice(2),
  defaultAgent,
  environment: process.env,
  ...(process.env[PI_COMMAND_ENV] ? { piCommand: process.env[PI_COMMAND_ENV] } : {}),
});

process.exitCode = await host.run();
