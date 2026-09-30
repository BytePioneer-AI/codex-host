import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessExecutable } from "./resolve.js";
import { withNodeRuntimeOnPath } from "./node-runtime.js";
import {
  fetchInstallationText,
  installationVersion,
  runInstallationCommand,
} from "./installation.js";

/** Match the CLI's real package, never a different npm prefix found by chance on PATH. */
export async function npmInstallation(
  command: string,
  packages: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  let selected = await realpath(command);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(selected)) {
    const shim = (await readFile(selected, "utf8")).replaceAll("\\", "/");
    const root = path.dirname(selected);
    for (const name of packages) {
      const directory = path.join(root, "node_modules", ...name.split("/"));
      const metadata = await readFile(path.join(directory, "package.json"), "utf8")
        .then((text) => JSON.parse(text) as { bin?: string | Record<string, string> })
        .catch(() => null);
      const bins =
        typeof metadata?.bin === "string" ? [metadata.bin] : Object.values(metadata?.bin ?? {});
      const bin = bins.find(
        (entry) =>
          !entry.includes("..") &&
          shim.includes(`node_modules/${name}/${entry.replace(/^\.\//, "")}`),
      );
      if (bin) {
        selected = await realpath(path.join(directory, bin));
        break;
      }
    }
  }
  let directory = path.dirname(selected);
  for (let depth = 0; depth < 8; depth++) {
    const metadata = await readFile(path.join(directory, "package.json"), "utf8")
      .then((text) => JSON.parse(text) as { name?: string; version?: string })
      .catch(() => null);
    if (metadata?.name && packages.includes(metadata.name)) {
      const name = metadata.name;
      const currentVersion = installationVersion(metadata.version);
      const segments = name.split("/");
      let modules = directory;
      for (let index = 0; index < segments.length; index++) modules = path.dirname(modules);
      const prefix =
        process.platform === "win32" ? path.dirname(modules) : path.dirname(path.dirname(modules));
      const globalRoot =
        process.platform === "win32"
          ? path.join(prefix, "node_modules")
          : path.join(prefix, "lib", "node_modules");
      const env = withNodeRuntimeOnPath(environment);
      const npm = resolveHarnessExecutable(
        { id: "npm", command: "npm", installRoots: { posix: [], windows: [] } },
        { environment: env },
      );
      const canUpdate = modules === globalRoot && !!npm;
      return {
        prefix,
        currentVersion,
        canUpdate,
        latest: async () => {
          const data = JSON.parse(
            await fetchInstallationText(
              `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
            ),
          ) as { version?: string };
          return installationVersion(data.version);
        },
        update: async (version: string) => {
          if (!canUpdate || !npm)
            throw new Error("Use the original package manager to update this installation");
          await runInstallationCommand(
            npm.executable,
            ["install", "--global", "--prefix", prefix, `${name}@${installationVersion(version)}`],
            env,
            300_000,
          );
        },
      };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
