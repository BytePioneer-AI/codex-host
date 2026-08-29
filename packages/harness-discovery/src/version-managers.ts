import { environmentValue, newestFirst, subdirectoryNames, targetPath } from "./environment.js";

export interface VersionManagerContext {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  /** Injectable for tests; defaults to a real directory listing. */
  readonly subdirectories?: (directory: string) => string[];
}

/**
 * Directories where a Node.js version manager keeps globally installed
 * binaries. A harness installed under a runtime that is not currently active
 * lives here and is invisible to PATH, which is the whole point: codexhost and
 * the harness are routinely installed under different Node.js versions.
 *
 * Concrete version directories are listed before shim directories because a
 * shim is a wrapper that needs its manager's environment to work, while a
 * version directory holds the real executable.
 */
export function versionManagerBinaryDirectories(context: VersionManagerContext): string[] {
  const { platform, environment, home } = context;
  const list = context.subdirectories ?? subdirectoryNames;
  const pathFlavor = targetPath(platform);
  const value = (name: string): string | undefined => environmentValue(environment, name);
  const directories: string[] = [];

  const versioned = (root: string, ...tail: string[]): void => {
    for (const version of newestFirst(list(root))) {
      directories.push(pathFlavor.join(root, version, ...tail));
    }
  };

  if (platform === "win32") {
    const appData = value("APPDATA") ?? pathFlavor.join(home, "AppData", "Roaming");
    const localAppData = value("LOCALAPPDATA") ?? pathFlavor.join(home, "AppData", "Local");
    // nvm-windows keeps global npm shims directly inside each version directory.
    versioned(pathFlavor.join(appData, "nvm"));
    versioned(value("FNM_DIR") ?? pathFlavor.join(appData, "fnm", "node-versions"), "installation");
    directories.push(pathFlavor.join(localAppData, "Volta", "bin"));
    directories.push(pathFlavor.join(home, ".bun", "bin"));
    const pnpmHome = value("PNPM_HOME");
    if (pnpmHome) directories.push(pnpmHome);
    directories.push(pathFlavor.join(localAppData, "pnpm"));
    return directories;
  }

  versioned(
    pathFlavor.join(value("NVM_DIR") ?? pathFlavor.join(home, ".nvm"), "versions", "node"),
    "bin",
  );

  const fnmRoots = [
    value("FNM_DIR"),
    pathFlavor.join(home, ".local", "share", "fnm"),
    pathFlavor.join(home, "Library", "Application Support", "fnm"),
  ].filter((root): root is string => root !== undefined);
  for (const root of fnmRoots) {
    versioned(pathFlavor.join(root, "node-versions"), "installation", "bin");
  }

  const voltaHome = value("VOLTA_HOME") ?? pathFlavor.join(home, ".volta");
  versioned(pathFlavor.join(voltaHome, "tools", "image", "node"), "bin");
  directories.push(pathFlavor.join(voltaHome, "bin"));

  const asdfHome = value("ASDF_DATA_DIR") ?? pathFlavor.join(home, ".asdf");
  versioned(pathFlavor.join(asdfHome, "installs", "nodejs"), "bin");
  directories.push(pathFlavor.join(asdfHome, "shims"));

  const nodenvHome = value("NODENV_ROOT") ?? pathFlavor.join(home, ".nodenv");
  versioned(pathFlavor.join(nodenvHome, "versions"), "bin");
  directories.push(pathFlavor.join(nodenvHome, "shims"));

  versioned(pathFlavor.join(value("N_PREFIX") ?? "/usr/local", "n", "versions", "node"), "bin");

  directories.push(pathFlavor.join(home, ".bun", "bin"));

  const pnpmHome = value("PNPM_HOME");
  if (pnpmHome) directories.push(pnpmHome);
  directories.push(pathFlavor.join(home, "Library", "pnpm"));
  directories.push(pathFlavor.join(home, ".local", "share", "pnpm"));

  // Homebrew keg-only Node.js formulae (node@22, node@24) are never on PATH.
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const formula of newestFirst(list(prefix).filter((name) => name.startsWith("node@")))) {
      directories.push(pathFlavor.join(prefix, formula, "bin"));
    }
  }

  return directories;
}
