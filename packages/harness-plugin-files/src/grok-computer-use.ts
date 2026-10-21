import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GrokComputerUseSettings } from "@codexhost/shared-contracts";

export const GROK_CUA_REPL_SERVER = "cua_repl";
const PREFERENCE_FILE = "grok-computer-use.json";
const TABLE = "[mcp_servers.cua_repl]";
const ENV_TABLE = "[mcp_servers.cua_repl.env]";

export interface GrokComputerUseLaunch {
  node: string;
  cuaRepl: string;
  nodeRepl: string;
  nodeModules: string;
  codexCli: string;
  skyApp: string;
  codexHome: string;
}

export class GrokComputerUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokComputerUseError";
  }
}

function dataDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
}

function grokHome(environment: NodeJS.ProcessEnv): string {
  return environment.GROK_HOME
    ? path.resolve(environment.GROK_HOME)
    : path.join(environment.HOME ?? os.homedir(), ".grok");
}

function chatgptApp(environment: NodeJS.ProcessEnv, platform: string): string | undefined {
  if (environment.CODEXHOST_CHATGPT_APP) return path.resolve(environment.CODEXHOST_CHATGPT_APP);
  if (platform === "darwin") return "/Applications/ChatGPT.app";
  return undefined;
}

async function isFile(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function discoverGrokComputerUseLaunch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseLaunch | undefined> {
  const app = chatgptApp(environment, platform);
  if (!app) return undefined;
  const resources = path.join(app, "Contents", "Resources");
  const cuaNode = path.join(resources, "cua_node");
  const launch: GrokComputerUseLaunch = {
    node: path.join(cuaNode, "bin", "node"),
    cuaRepl: path.join(cuaNode, "lib", "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs"),
    nodeRepl: path.join(cuaNode, "bin", "node_repl"),
    nodeModules: path.join(cuaNode, "lib", "node_modules"),
    codexCli: path.join(resources, "codex-cli", "bin", "codex"),
    skyApp: path.join(
      environment.HOME ?? os.homedir(),
      ".codex",
      "computer-use",
      "Codex Computer Use.app",
    ),
    codexHome: path.join(environment.HOME ?? os.homedir(), ".codex"),
  };
  const required = [launch.node, launch.cuaRepl, launch.nodeRepl, launch.codexCli, launch.skyApp];
  for (const file of required) {
    if (!(await isFile(file))) return undefined;
  }
  return launch;
}

function tableRange(text: string, header: string): { start: number; end: number } | undefined {
  const lines = text.split(/\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === header) {
      start = index;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("[") && line.endsWith("]")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function removeTables(text: string, headers: string[]): string {
  let current = text;
  for (const header of headers) {
    const range = tableRange(current, header);
    if (!range) continue;
    const lines = current.split(/\n/);
    lines.splice(range.start, range.end - range.start);
    current = lines.join("\n");
  }
  return current.replace(/\n{3,}/g, "\n\n");
}

function cuaReplEnabledInToml(text: string): boolean {
  const range = tableRange(text, TABLE);
  if (!range) return false;
  const body = text.split(/\n/).slice(range.start, range.end);
  for (const line of body) {
    if (/^enabled\s*=\s*false\b/u.test(line)) return false;
    if (/^enabled\s*=\s*true\b/u.test(line)) return true;
  }
  return true;
}

function stanza(launch: GrokComputerUseLaunch, enabled: boolean): string {
  const trusted = `${launch.codexHome}:${launch.nodeModules}`;
  return `${TABLE}
command = ${JSON.stringify(launch.node)}
args = [${JSON.stringify(launch.cuaRepl)}]
enabled = ${enabled ? "true" : "false"}
startup_timeout_sec = 120

${ENV_TABLE}
NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify('{"sky":"@oai/sky/service"}')}
NODE_REPL_TRUSTED_CODE_PATHS = ${JSON.stringify(trusted)}
NODE_REPL_NODE_PATH = ${JSON.stringify(launch.node)}
CODEX_HOME = ${JSON.stringify(launch.codexHome)}
CUA_REPL_NODE_REPL_PATH = ${JSON.stringify(launch.nodeRepl)}
NODE_REPL_NODE_MODULE_DIRS = ${JSON.stringify(launch.nodeModules)}
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"
SKY_CUA_SERVICE_PATH = ${JSON.stringify(launch.skyApp)}
CODEX_CLI_PATH = ${JSON.stringify(launch.codexCli)}
CUA_REPL_ENABLED_SURFACES = "computer"
`;
}

async function readPreference(environment: NodeJS.ProcessEnv): Promise<boolean | undefined> {
  try {
    const document = JSON.parse(
      await readFile(path.join(dataDirectory(environment), PREFERENCE_FILE), "utf8"),
    ) as { enabled?: unknown };
    return typeof document.enabled === "boolean" ? document.enabled : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new GrokComputerUseError("Could not read Grok Computer Use settings");
  }
}

async function writePreference(environment: NodeJS.ProcessEnv, enabled: boolean): Promise<void> {
  const directory = dataDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, PREFERENCE_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readGrokConfig(environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await readFile(path.join(grokHome(environment), "config.toml"), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw new GrokComputerUseError("Could not read Grok config");
  }
}

async function writeGrokConfig(environment: NodeJS.ProcessEnv, text: string): Promise<void> {
  const home = grokHome(environment);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.toml");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function getGrokComputerUseSettings(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseSettings> {
  const launch = await discoverGrokComputerUseLaunch(environment, platform);
  const preference = await readPreference(environment);
  const toml = await readGrokConfig(environment);
  const enabled = preference ?? cuaReplEnabledInToml(toml);
  if (launch) return { enabled, available: true };
  return {
    enabled,
    available: false,
    unavailableReason:
      "ChatGPT Desktop Computer Use files were not found. Install ChatGPT.app with Computer Use, then try again.",
  };
}

export async function setGrokComputerUseEnabled(
  enabled: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseSettings> {
  const launch = await discoverGrokComputerUseLaunch(environment, platform);
  if (enabled && !launch) {
    throw new GrokComputerUseError(
      "ChatGPT Desktop Computer Use files were not found. Install ChatGPT.app with Computer Use, then try again.",
    );
  }
  await writePreference(environment, enabled);
  const current = await readGrokConfig(environment);
  const had = tableRange(current, TABLE) !== undefined;
  if (!enabled && !had) return getGrokComputerUseSettings(environment, platform);
  if (!launch) {
    const range = tableRange(current, TABLE);
    if (!range) return getGrokComputerUseSettings(environment, platform);
    const lines = current.split(/\n/);
    const body = lines.slice(range.start, range.end);
    const replaced = body.map((line) => (/^enabled\s*=/u.test(line) ? "enabled = false" : line));
    if (!replaced.some((line) => /^enabled\s*=/u.test(line))) {
      replaced.splice(1, 0, "enabled = false");
    }
    lines.splice(range.start, range.end - range.start, ...replaced);
    await writeGrokConfig(environment, lines.join("\n"));
    return getGrokComputerUseSettings(environment, platform);
  }
  const stripped = removeTables(current, [ENV_TABLE, TABLE]).replace(/\s+$/u, "\n");
  await writeGrokConfig(environment, `${stripped.trimEnd()}\n\n${stanza(launch, enabled)}`);
  return getGrokComputerUseSettings(environment, platform);
}

/** Apply the CodexHost preference to Grok config for a new session. Missing preference is a no-op. */
export async function applyGrokComputerUsePreference(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<void> {
  const preference = await readPreference(environment);
  if (preference === undefined) return;
  await setGrokComputerUseEnabled(preference, environment, platform);
}
