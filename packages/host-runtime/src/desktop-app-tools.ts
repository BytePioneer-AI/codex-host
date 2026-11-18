import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import type { desktopStdioConfig } from "./desktop-mcp-config.js";
import { DESKTOP_APP_TOOLS_PIPE_ENV } from "./desktop-context-environment.js";

const PLUGIN_PATH = "plugins/openai-bundled/plugins/codex-app-tools";
const LAUNCHER_PATH = "scripts/launch_codex_app_tools_mcp";
const SERVER_PATH = "server.mjs";

function matchesBundle(file: string, shipped: Buffer): boolean {
  const stat = statSync(file);
  return stat.isFile() && stat.size === shipped.length && readFileSync(file).equals(shipped);
}

export interface DesktopToolLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** Selects only the app-tools server shipped with the Desktop that owns this connection. */
export function desktopAppToolsLaunch(
  resourcesPath: string | undefined,
  environment: NodeJS.ProcessEnv,
): ((definition: z.infer<typeof desktopStdioConfig>) => DesktopToolLaunch | undefined) | undefined {
  const pipe = environment[DESKTOP_APP_TOOLS_PIPE_ENV];
  if (!resourcesPath || !pipe || !path.isAbsolute(pipe)) return;
  let bundledRoot: string;
  try {
    bundledRoot = realpathSync(resourcesPath);
  } catch {
    return;
  }
  const packaged = [
    path.join(bundledRoot, PLUGIN_PATH),
    path.join(bundledRoot, "app.asar.unpacked", PLUGIN_PATH),
  ];
  let bundle: { cwd: string; launcher: Buffer; server: Buffer } | undefined;
  for (const cwd of packaged) {
    try {
      const launcher = path.join(cwd, LAUNCHER_PATH);
      const server = path.join(cwd, SERVER_PATH);
      if (realpathSync(launcher) !== launcher || realpathSync(server) !== server) continue;
      bundle = { cwd, launcher: readFileSync(launcher), server: readFileSync(server) };
      break;
    } catch {
      // Older Desktop bundles may have no app-tools server in this layout.
    }
  }
  if (!bundle) return;
  const shipped = bundle;
  const codexHome = environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex");
  const cache = path.join(codexHome, "plugins/cache/openai-bundled/codex-app-tools");
  return (definition) => {
    const [argument] = definition.args;
    if (
      definition.enabled === false ||
      !definition.cwd ||
      !path.isAbsolute(definition.cwd) ||
      !path.isAbsolute(definition.command) ||
      definition.args.length !== 1 ||
      !argument
    )
      return;
    try {
      const cwd = realpathSync(definition.cwd);
      const launcher = path.join(cwd, LAUNCHER_PATH);
      const server = path.join(cwd, SERVER_PATH);
      if (
        realpathSync(definition.command) !== launcher ||
        realpathSync(path.resolve(cwd, argument)) !== server
      )
        return;
      if (cwd !== shipped.cwd) {
        const version = path.relative(realpathSync(cache), cwd);
        if (
          !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/u.test(version) ||
          !matchesBundle(launcher, shipped.launcher) ||
          !matchesBundle(server, shipped.server)
        )
          return;
      }
      // Desktop's own process environment selects the socket. Config supplies only the mode.
      return {
        command: process.execPath,
        args: [path.join(shipped.cwd, SERVER_PATH)],
        env: {
          [DESKTOP_APP_TOOLS_PIPE_ENV]: pipe,
          CODEX_APP_TOOLS_DEFERRED: definition.env.CODEX_APP_TOOLS_DEFERRED === "1" ? "1" : "0",
        },
        cwd: shipped.cwd,
      };
    } catch {
      return;
    }
  };
}
