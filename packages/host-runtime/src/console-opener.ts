import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const OPEN_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 16 * 1024;
const CONSOLE_URL_PREFIX = "codexhost console: ";

export interface HostConsoleOpener {
  open(): Promise<{ url: string }>;
}

/**
 * The console ships beside the Host Runtime in a release (`app/`); a source
 * checkout builds it in its own package.
 */
export function consoleEntrypoint(
  hostRuntimePath: string,
  exists: (filePath: string) => boolean = existsSync,
): string | null {
  const candidate =
    path.basename(hostRuntimePath) === "host-runtime.mjs"
      ? path.join(path.dirname(hostRuntimePath), "console-server.mjs")
      : path.resolve(
          path.dirname(hostRuntimePath),
          "..",
          "..",
          "console-server",
          "dist",
          "main.js",
        );
  return exists(candidate) ? candidate : null;
}

/** The console root address printed by `console-server open`. */
export function parseConsoleAddress(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .reverse()
    .find((candidate) => candidate.startsWith(CONSOLE_URL_PREFIX));
  if (!line) return null;
  try {
    const url = new URL(line.slice(CONSOLE_URL_PREFIX.length).trim());
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      return null;
    }
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

export interface CreateHostConsoleOpenerOptions {
  entrypoint: string;
  environment: NodeJS.ProcessEnv;
  nodePath?: string;
  spawnProcess?: typeof spawn;
}

/**
 * Runs `console-server open`, which reuses or starts the single console and
 * opens it in the default browser through the Launcher.
 */
export function createHostConsoleOpener(
  options: CreateHostConsoleOpenerOptions,
): HostConsoleOpener {
  const spawnProcess = options.spawnProcess ?? spawn;
  return {
    open() {
      return new Promise((resolve, reject) => {
        const child = spawnProcess(
          options.nodePath ?? process.execPath,
          [options.entrypoint, "open"],
          {
            env: options.environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        let stdout = "";
        let stderr = "";
        const append = (current: string, chunk: Buffer): string =>
          (current + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
        child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
        child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("codexhost console did not open in time"));
        }, OPEN_TIMEOUT_MS);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          const url = parseConsoleAddress(stdout);
          if (code === 0 && url) {
            resolve({ url });
            return;
          }
          const detail = stderr.trim().split(/\r?\n/u).at(-1);
          reject(new Error(detail || "codexhost console could not be opened"));
        });
      });
    },
  };
}
