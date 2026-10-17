/** Native Codex execution belongs to an explicitly configured, isolated Web home. */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CODEX_COMMAND_ENV = "CODEXHOST_CODEX_COMMAND";
export const CODEX_HOME_ENV = "CODEXHOST_CODEX_HOME";

/** Resolve existing ancestors too, so a not-yet-created home cannot hide behind a symlink. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function nativeCodexLaunch(environment: NodeJS.ProcessEnv): {
  command: string;
  home: string;
  environment: NodeJS.ProcessEnv;
} {
  const configuredCommand = environment[CODEX_COMMAND_ENV];
  if (!configuredCommand || !isAbsolute(configuredCommand)) {
    throw new Error("Web Codex requires an absolute native CLI path (--codex-command)");
  }
  const command = realpathSync(configuredCommand);
  if (
    !statSync(command).isFile() ||
    /codexhost|(?:^|[-_.])shim(?:[-_.]|$)/iu.test(basename(command)) ||
    (environment.CODEX_CLI_PATH && canonicalPath(environment.CODEX_CLI_PATH) === command)
  ) {
    throw new Error("Web Codex must use a native CLI, not a Desktop proxy or shim");
  }
  const configuredHome = environment[CODEX_HOME_ENV];
  if (!configuredHome || !isAbsolute(configuredHome)) {
    throw new Error("Web Codex requires an absolute isolated home (--codex-home)");
  }
  const home = canonicalPath(configuredHome);
  const desktopHomes = [
    join(homedir(), ".codex"),
    ...(environment.HOME ? [join(environment.HOME, ".codex")] : []),
    environment.CODEX_HOME,
    environment.CODEXHOST_GUI_CODEX_HOME,
  ].filter((value): value is string => Boolean(value));
  if (
    desktopHomes.some((path) => {
      const desktopHome = canonicalPath(path);
      return contains(desktopHome, home) || contains(home, desktopHome);
    })
  ) {
    throw new Error("Web Codex home must be separate from the GUI Codex home");
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !name.startsWith("CODEXHOST_") &&
        !["CODEX_CLI_PATH", "CODEX_THREAD_ID", "NODE_OPTIONS", "NODE_PATH"].includes(name)
      );
    }),
  );
  mkdirSync(home, { recursive: true });
  childEnvironment.CODEX_HOME = home;
  return { command, home, environment: childEnvironment };
}
