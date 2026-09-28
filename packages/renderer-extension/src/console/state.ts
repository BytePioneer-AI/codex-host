import { consoleGet, consolePost } from "./api.js";

export interface StartupStage {
  name: string;
  elapsedMs: number;
}

export interface StartupRecord {
  id: string;
  launcherVersion: string;
  startedAtMs: number;
  outcome: "ready" | "attached" | "failed";
  error: string | null;
  stages: StartupStage[];
  desktop: { version: string; build: string; installRoot: string } | null;
}

export interface ConsoleOverview {
  console: {
    version: string;
    appDirectory: string;
    distribution: { version: string; distribution: "npm" | "installer"; target: string } | null;
  };
  homeDirectory: string;
  inspect: {
    desktop: { version: string; build: string; installRoot: string } | null;
    desktopError: string | null;
    runtime: { running: boolean };
  } | null;
  inspectError: string | null;
  startup: StartupRecord[];
  controller: {
    renderer: {
      state: "installing" | "installed" | "unavailable";
      error: string | null;
      failures: number;
      lastError?: string | null;
      lastFailedAt?: number | null;
      updatedAt: number;
    };
  } | null;
  controllerAlive: boolean;
  logs: { name: string; size: number; modifiedAt: number }[];
  launchAvailable: boolean;
  summary: {
    state: "running" | "integration-unavailable" | "startup-failed" | "desktop-missing" | "stopped";
    detail: string | null;
  };
  issueUrl: string;
  hostAvailable: boolean;
}

export interface UpdateSummary {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error: string | null;
}

type Listener = () => void;

/** One polled view of the console state shared by the sidebar and pages. */
export class ConsoleState {
  overview: ConsoleOverview | null = null;
  update: UpdateSummary | null = null;
  offline = false;
  readonly #listeners = new Set<Listener>();
  #timer: number | undefined;

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    try {
      this.overview = await consoleGet<ConsoleOverview>("/api/overview");
      this.offline = false;
    } catch {
      this.offline = true;
    }
    this.#emit();
  }

  async checkUpdate(): Promise<void> {
    try {
      this.update = await consolePost<UpdateSummary | null>("/api/update/check");
    } catch {
      this.update = null;
    }
    this.#emit();
  }

  start(intervalMs = 5_000): void {
    void this.refresh().then(() => this.checkUpdate());
    this.#timer = window.setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
