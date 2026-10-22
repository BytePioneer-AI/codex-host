import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GrokComputerUseSettings } from "@codexhost/shared-contracts";
import { withGrokComputerUseLock } from "./grok-computer-use-lock.js";

export const GROK_CUA_REPL_SERVER = "cua_repl";
/** ChatGPT Desktop does not authorize a Grok-spawned cua_repl for IAB. */
export const GROK_BROWSER_BINDING_SUPPORTED = false;
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
  browserDesktop: string;
}

interface Preference {
  enabled?: boolean;
  browser?: boolean;
  applyError?: string;
}

export interface GrokComputerUseUpdate {
  enabled?: boolean | undefined;
  browser?: boolean | undefined;
}

const COMPUTER_UNAVAILABLE =
  "ChatGPT Desktop Computer Use files were not found. Install ChatGPT.app with Computer Use, then try again.";
const BROWSER_FILES_UNAVAILABLE =
  "ChatGPT Desktop in-app browser files were not found. Update ChatGPT.app, then try again.";
const BROWSER_UNSUPPORTED =
  "ChatGPT Desktop does not authorize Grok to use the in-app browser. The preference is saved as intent until Desktop supports an external Harness.";
const APPLY_FAILED = "Could not apply Grok Computer Use settings to Grok config.";

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

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function launchPaths(
  environment: NodeJS.ProcessEnv,
  platform: string,
): GrokComputerUseLaunch | undefined {
  const app = chatgptApp(environment, platform);
  if (!app) return undefined;
  const resources = path.join(app, "Contents", "Resources");
  const cuaNode = path.join(resources, "cua_node");
  return {
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
    browserDesktop: path.join(cuaNode, "lib", "node_modules", "@oai", "browser-desktop"),
  };
}

async function sharedRuntimePresent(launch: GrokComputerUseLaunch): Promise<boolean> {
  const present = await Promise.all([launch.node, launch.cuaRepl, launch.nodeRepl].map(isFile));
  return present.every(Boolean);
}

async function computerFilesPresent(launch: GrokComputerUseLaunch): Promise<boolean> {
  const present = await Promise.all([isFile(launch.skyApp), isFile(launch.codexCli)]);
  return present.every(Boolean);
}

async function browserFilesPresent(launch: GrokComputerUseLaunch): Promise<boolean> {
  return isFile(path.join(launch.browserDesktop, "package.json"));
}

/** Shared cua_node runtime. Sky and browser-desktop are checked separately. */
export async function discoverGrokComputerUseLaunch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseLaunch | undefined> {
  const launch = launchPaths(environment, platform);
  if (!launch || !(await sharedRuntimePresent(launch))) return undefined;
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

function inferredSurfaces(text: string): { enabled: boolean; browser: boolean } {
  if (!cuaReplEnabledInToml(text)) return { enabled: false, browser: false };
  const range = tableRange(text, ENV_TABLE);
  const body = range ? text.split(/\n/).slice(range.start, range.end).join("\n") : "";
  const literal = /^CUA_REPL_ENABLED_SURFACES\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?$/mu.exec(body);
  if (!literal) return { enabled: true, browser: false };
  const surfaces = new Set(literal[2]?.split(",").map((surface) => surface.trim()));
  return { enabled: surfaces.has("computer"), browser: surfaces.has("browser") };
}

function stanza(
  launch: GrokComputerUseLaunch,
  state: Required<Pick<Preference, "enabled" | "browser">>,
): string {
  const trusted = `${launch.codexHome}:${launch.nodeModules}`;
  const services: Record<string, string> = {};
  if (state.browser) services.browser = "@oai/browser-desktop/service";
  if (state.enabled) services.sky = "@oai/sky/service";
  const surfaces = [state.browser ? "browser" : "", state.enabled ? "computer" : ""]
    .filter(Boolean)
    .join(",");
  const backends = state.browser ? 'BROWSER_USE_AVAILABLE_BACKENDS = "iab"\n' : "";
  const active = state.enabled || state.browser;
  return `${TABLE}
command = ${JSON.stringify(launch.node)}
args = [${JSON.stringify(launch.cuaRepl)}]
enabled = ${active ? "true" : "false"}
startup_timeout_sec = 120

${ENV_TABLE}
NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify(services))}
NODE_REPL_TRUSTED_CODE_PATHS = ${JSON.stringify(trusted)}
NODE_REPL_NODE_PATH = ${JSON.stringify(launch.node)}
CODEX_HOME = ${JSON.stringify(launch.codexHome)}
CUA_REPL_NODE_REPL_PATH = ${JSON.stringify(launch.nodeRepl)}
NODE_REPL_NODE_MODULE_DIRS = ${JSON.stringify(launch.nodeModules)}
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"
SKY_CUA_SERVICE_PATH = ${JSON.stringify(launch.skyApp)}
CODEX_CLI_PATH = ${JSON.stringify(launch.codexCli)}
${backends}CUA_REPL_ENABLED_SURFACES = ${JSON.stringify(surfaces)}
`;
}

async function readPreference(environment: NodeJS.ProcessEnv): Promise<Preference | undefined> {
  try {
    const document = JSON.parse(
      await readFile(path.join(dataDirectory(environment), PREFERENCE_FILE), "utf8"),
    ) as { enabled?: unknown; browser?: unknown; applyError?: unknown };
    return {
      ...(typeof document.enabled === "boolean" ? { enabled: document.enabled } : {}),
      ...(typeof document.browser === "boolean" ? { browser: document.browser } : {}),
      ...(typeof document.applyError === "string" && document.applyError
        ? { applyError: document.applyError }
        : {}),
    };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new GrokComputerUseError("Could not read Grok Computer Use settings");
  }
}

async function writePreference(environment: NodeJS.ProcessEnv, state: Preference): Promise<void> {
  const document: Preference = {
    ...(typeof state.enabled === "boolean" ? { enabled: state.enabled } : {}),
    ...(typeof state.browser === "boolean" ? { browser: state.browser } : {}),
    ...(state.applyError ? { applyError: state.applyError } : {}),
  };
  await writeAtomically(
    path.join(dataDirectory(environment), PREFERENCE_FILE),
    `${JSON.stringify(document)}\n`,
  );
}

async function readGrokConfig(environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await readFile(path.join(grokHome(environment), "config.toml"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw new GrokComputerUseError("Could not read Grok config");
  }
}

async function writeGrokConfig(environment: NodeJS.ProcessEnv, text: string): Promise<void> {
  await writeAtomically(
    path.join(grokHome(environment), "config.toml"),
    text.endsWith("\n") ? text : `${text}\n`,
  );
}

async function currentState(
  environment: NodeJS.ProcessEnv,
  preference?: Preference,
): Promise<{
  enabled: boolean;
  browser: boolean;
  applyError?: string;
}> {
  const resolved = preference ?? (await readPreference(environment));
  const inferred =
    resolved?.enabled === undefined
      ? inferredSurfaces(await readGrokConfig(environment))
      : undefined;
  return {
    enabled: resolved?.enabled ?? inferred?.enabled ?? false,
    browser: resolved ? (resolved.browser ?? false) : (inferred?.browser ?? false),
    ...(resolved?.applyError ? { applyError: resolved.applyError } : {}),
  };
}

function settingsFrom(
  state: { enabled: boolean; browser: boolean; applyError?: string },
  files: { computer: boolean; browser: boolean },
): GrokComputerUseSettings {
  const bindable = files.browser && GROK_BROWSER_BINDING_SUPPORTED;
  return {
    enabled: state.enabled,
    available: files.computer,
    ...(files.computer ? {} : { unavailableReason: COMPUTER_UNAVAILABLE }),
    browser: state.browser,
    browserFilesPresent: files.browser,
    browserAvailable: bindable,
    ...(bindable
      ? {}
      : {
          browserUnavailableReason: files.browser ? BROWSER_UNSUPPORTED : BROWSER_FILES_UNAVAILABLE,
        }),
    ...(state.applyError ? { applyFailed: true, applyError: state.applyError } : {}),
  };
}

async function surfaceFiles(
  launch: GrokComputerUseLaunch | undefined,
): Promise<{ computer: boolean; browser: boolean }> {
  if (!launch) return { computer: false, browser: false };
  const [computer, browser] = await Promise.all([
    computerFilesPresent(launch),
    browserFilesPresent(launch),
  ]);
  return { computer, browser };
}

export async function getGrokComputerUseSettings(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseSettings> {
  const launch = await discoverGrokComputerUseLaunch(environment, platform);
  return settingsFrom(await currentState(environment), await surfaceFiles(launch));
}

async function writeConfigForState(
  state: { enabled: boolean; browser: boolean },
  launch: GrokComputerUseLaunch | undefined,
  files: { computer: boolean; browser: boolean },
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const current = await readGrokConfig(environment);
  const range = tableRange(current, TABLE);
  const effective = {
    enabled: state.enabled && files.computer,
    browser: state.browser && files.browser && GROK_BROWSER_BINDING_SUPPORTED,
  };
  if (!effective.enabled && !effective.browser && !range) return;
  if (!launch) {
    if (!range) return;
    const lines = current.split(/\n/);
    const body = lines.slice(range.start, range.end);
    const replaced = body.map((line) => (/^enabled\s*=/u.test(line) ? "enabled = false" : line));
    if (!replaced.some((line) => /^enabled\s*=/u.test(line))) {
      replaced.splice(1, 0, "enabled = false");
    }
    lines.splice(range.start, range.end - range.start, ...replaced);
    await writeGrokConfig(environment, lines.join("\n"));
    return;
  }
  const stripped = removeTables(current, [ENV_TABLE, TABLE]).replace(/\s+$/u, "\n");
  await writeGrokConfig(environment, `${stripped.trimEnd()}\n\n${stanza(launch, effective)}`);
}

export async function setGrokComputerUse(
  update: GrokComputerUseUpdate,
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseSettings> {
  return withGrokComputerUseLock(dataDirectory(environment), grokHome(environment), async () => {
    const launch = await discoverGrokComputerUseLaunch(environment, platform);
    const files = await surfaceFiles(launch);
    if (update.enabled && !files.computer) {
      throw new GrokComputerUseError(COMPUTER_UNAVAILABLE);
    }
    if (update.browser && !files.browser) {
      throw new GrokComputerUseError(BROWSER_FILES_UNAVAILABLE);
    }
    const previous = await currentState(environment);
    const state = {
      enabled: update.enabled ?? previous.enabled,
      browser: update.browser ?? previous.browser,
    };
    try {
      await writeConfigForState(state, launch, files, environment);
      await writePreference(environment, state);
    } catch (error) {
      await writeConfigForState(previous, launch, files, environment).catch(() => undefined);
      const applyError = error instanceof GrokComputerUseError ? error.message : APPLY_FAILED;
      await writePreference(environment, { ...previous, applyError }).catch(() => undefined);
      if (error instanceof GrokComputerUseError) throw error;
      throw new GrokComputerUseError(APPLY_FAILED);
    }
    return settingsFrom(state, files);
  });
}

export function setGrokComputerUseEnabled(
  enabled: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<GrokComputerUseSettings> {
  return setGrokComputerUse({ enabled }, environment, platform);
}

/** Apply the saved CodexHost preference to Grok config for a new session. Missing preference is a no-op. */
export async function applyGrokComputerUsePreference(
  environment: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<void> {
  await withGrokComputerUseLock(dataDirectory(environment), grokHome(environment), async () => {
    const preference = await readPreference(environment);
    if (preference === undefined) return;
    const launch = await discoverGrokComputerUseLaunch(environment, platform);
    const files = await surfaceFiles(launch);
    const state = await currentState(environment, preference);
    try {
      await writeConfigForState(state, launch, files, environment);
      if (state.applyError)
        await writePreference(environment, { enabled: state.enabled, browser: state.browser });
    } catch (error) {
      const applyError = error instanceof GrokComputerUseError ? error.message : APPLY_FAILED;
      await writePreference(environment, {
        enabled: state.enabled,
        browser: state.browser,
        applyError,
      }).catch(() => undefined);
      throw error instanceof GrokComputerUseError ? error : new GrokComputerUseError(APPLY_FAILED);
    }
  });
}
