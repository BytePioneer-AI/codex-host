import path from "node:path";
import { fileURLToPath } from "node:url";

import { createConsoleHarnesses, harnessPluginRoots } from "./harnesses.js";
import { createConsoleHostClient } from "./host-client.js";
import { resolveInstallation } from "./installation.js";
import { consoleBuildId, ensureConsole, openConsole } from "./open.js";
import { loadConsoleBundle } from "./page.js";
import { consolePaths, consolePort } from "./paths.js";
import { startConsoleServer, type RunningConsoleServer } from "./server.js";
import { createConsoleUpdates } from "./updates.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HANDOFF_EXIT_DELAY_MS = 500;

const entryPath = fileURLToPath(import.meta.url);
const appDirectory = path.dirname(entryPath);

function usage(): never {
  console.error(
    "usage: console-server open [--reason <reason>] [--no-browser] | console-server ensure | console-server serve",
  );
  process.exit(2);
}

async function serve(): Promise<void> {
  const paths = consolePaths();
  const port = consolePort();
  const installation = await resolveInstallation(appDirectory);
  const state: { running?: RunningConsoleServer } = {};
  const exit = (): void => {
    void (state.running?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  const updates = createConsoleUpdates({
    onHandedOff: () => setTimeout(exit, HANDOFF_EXIT_DELAY_MS),
  });
  state.running = await startConsoleServer({
    port,
    buildId: await consoleBuildId(entryPath),
    version: installation.distribution?.version ?? "source",
    installation,
    paths,
    updates,
    host: createConsoleHostClient(paths.hostDescriptorDirectory),
    pageScript: await loadConsoleBundle(appDirectory),
    harnesses: createConsoleHarnesses(
      harnessPluginRoots(appDirectory, installation.distribution === null),
    ),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    onExit: exit,
  });
}

interface OpenArguments {
  reason?: string;
  browser: boolean;
}

function parseOpenArguments(arguments_: string[]): OpenArguments {
  const parsed: OpenArguments = { browser: true };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--reason" && value) {
      parsed.reason = value;
      index += 1;
    } else if (argument === "--no-browser") {
      parsed.browser = false;
    } else {
      usage();
    }
  }
  return parsed;
}

async function open(arguments_: string[]): Promise<void> {
  const parsed = parseOpenArguments(arguments_);
  const installation = await resolveInstallation(appDirectory);
  const url = await openConsole({
    appDirectory,
    entryPath,
    launcherExecutable: installation.launcherExecutable,
    browser: parsed.browser,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  });
  console.log(`codexhost console: ${url}`);
}

async function ensure(arguments_: string[]): Promise<void> {
  if (arguments_.length > 0) usage();
  const { port } = await ensureConsole({ appDirectory, entryPath });
  console.log(`codexhost console: http://127.0.0.1:${port}/`);
}

const [command, ...rest] = process.argv.slice(2);
const run =
  command === "serve"
    ? serve()
    : command === "open"
      ? open(rest)
      : command === "ensure"
        ? ensure(rest)
        : usage();
run.catch((error: unknown) => {
  console.error(`codexhost console: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
