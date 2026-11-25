import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Renderer integration state published for the codexhost console.
 *
 * The Controller keeps Codex Desktop running when Renderer installation fails
 * and retries in the background, so the Launcher reports a successful start
 * even though no codexhost UI appears. This file is the only place that
 * failure stays visible after the Controller's stderr is gone.
 */
export interface RendererIntegrationStatus {
  state: "installing" | "installed" | "unavailable";
  /** The current failure; cleared once installed. */
  error: string | null;
  failures: number;
  /** The most recent failure, kept after recovery for diagnosis. */
  lastError: string | null;
  lastFailedAt: number | null;
  lastInstalledAt: number | null;
  updatedAt: number;
}

export interface DesktopControllerStatusDocument {
  schemaVersion: 1;
  pid: number;
  startedAt: number;
  renderer: RendererIntegrationStatus;
}

export const DESKTOP_CONTROLLER_STATUS_FILE = "desktop-controller-v1.json";
const ERROR_MAX_LENGTH = 1_000;

export function defaultControllerStatusPath(environment: NodeJS.ProcessEnv = process.env): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "diagnostics", DESKTOP_CONTROLLER_STATUS_FILE);
}

function errorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ").slice(0, ERROR_MAX_LENGTH) || "Renderer installation failed";
}

export interface RendererStatusReporter {
  installing(): void;
  installed(): void;
  failed(error: unknown): void;
}

/** Publishes only state changes; a healthy session is re-validated every tick. */
export function createRendererStatusReporter(
  publish: (document: DesktopControllerStatusDocument) => void,
  now: () => number = Date.now,
  pid: number = process.pid,
): RendererStatusReporter {
  const startedAt = now();
  let current: RendererIntegrationStatus | undefined;
  const update = (next: Omit<RendererIntegrationStatus, "updatedAt">): void => {
    if (
      current &&
      current.state === next.state &&
      current.error === next.error &&
      current.failures === next.failures
    ) {
      return;
    }
    current = { ...next, updatedAt: now() };
    publish({ schemaVersion: 1, pid, startedAt, renderer: current });
  };
  return {
    installing() {
      update({
        state: "installing",
        error: current?.error ?? null,
        failures: current?.failures ?? 0,
        lastError: current?.lastError ?? null,
        lastFailedAt: current?.lastFailedAt ?? null,
        lastInstalledAt: current?.lastInstalledAt ?? null,
      });
    },
    installed() {
      if (current?.state === "installed") return;
      update({
        state: "installed",
        error: null,
        failures: current?.failures ?? 0,
        lastError: current?.lastError ?? null,
        lastFailedAt: current?.lastFailedAt ?? null,
        lastInstalledAt: now(),
      });
    },
    failed(error) {
      const message = errorMessage(error);
      update({
        state: "unavailable",
        error: message,
        failures: (current?.failures ?? 0) + 1,
        lastError: message,
        lastFailedAt: now(),
        lastInstalledAt: current?.lastInstalledAt ?? null,
      });
    },
  };
}

export async function writeControllerStatusFile(
  filePath: string,
  document: DesktopControllerStatusDocument,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** Serializes writes so a slower earlier write never replaces a newer state. */
export function createControllerStatusPublisher(
  filePath: string = defaultControllerStatusPath(),
): (document: DesktopControllerStatusDocument) => void {
  let queue = Promise.resolve();
  return (document) => {
    queue = queue.then(() => writeControllerStatusFile(filePath, document)).catch(() => undefined);
  };
}
