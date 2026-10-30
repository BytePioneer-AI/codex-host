import path from "node:path";

/**
 * Guarantees the harness child process can resolve `node`, which a
 * `#!/usr/bin/env node` entrypoint needs and a GUI-launched PATH rarely has.
 *
 * The Host runtime is a fallback: preserve an existing Node.js selection so
 * package-manager shims continue to use the Node.js installation they belong to.
 */
export function withNodeRuntimeOnPath(
  environment: NodeJS.ProcessEnv,
  runtimeExecutable = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const runtimeDirectory = path.dirname(runtimeExecutable);
  const directories = (environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  const equal =
    platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (!directories.some((directory) => equal(directory) === equal(runtimeDirectory))) {
    directories.push(runtimeDirectory);
  }
  return { ...environment, [pathKey]: directories.join(delimiter) };
}
