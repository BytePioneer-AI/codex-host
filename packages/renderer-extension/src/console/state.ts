import { consoleGet, consolePost } from "./api.js";

export interface StartupStage {
  name: string;
  elapsedMs: number;
}

export interface StartupRecord {
  id: string;
  launcherVersion: string;
  startedAtMs: number;
  outcome: "starting" | "ready" | "attached" | "failed";
  error: string | null;
  stages: StartupStage[];
  desktop: { version: string; build: string; installRoot: string } | null;
}

export interface ConsoleOverview {
  console: {
    version: string;
    distribution: { version: string; distribution: "npm" | "installer"; target: string } | null;
  };
  inspect: {
    desktop: { version: string; build: string; installRoot: string } | null;
    desktopError: string | null;
    runtime: { running: boolean };
  } | null;
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
  launchAvailable: boolean;
  liveVoice: {
    inject: boolean;
    savedInject?: boolean;
    envOverride: "0" | "1" | null;
    activeInject?: boolean | null;
    activeEnvOverride?: "0" | "1" | null;
  };
  restart?: { phase: "idle" | "restarting" | "succeeded" | "failed"; error: string | null };
  summary: {
    state:
      | "starting"
      | "running"
      | "integration-unavailable"
      | "startup-failed"
      | "desktop-missing"
      | "stopped";
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
  restartConfirm = false;
  restartSubmitting = false;
  restartError: string | null = null;
  readonly #listeners = new Set<Listener>();
  #timer: number | undefined;

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  confirmRestart(confirm: boolean): void {
    this.restartConfirm = confirm;
    this.#emit();
  }

  async restart(): Promise<void> {
    if (!this.restartConfirm || this.restartSubmitting) return;
    this.restartConfirm = false;
    this.restartSubmitting = true;
    this.restartError = null;
    this.#emit();
    try {
      await consolePost("/api/restart", { confirm: true });
      await this.refresh();
    } catch (error) {
      this.restartError = error instanceof Error ? error.message : String(error);
    } finally {
      this.restartSubmitting = false;
      this.#emit();
    }
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
