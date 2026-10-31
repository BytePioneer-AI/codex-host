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

/** One view of Host availability shared by the sidebar and all settings pages. */
export class ConsoleState {
  overview: ConsoleOverview | null = null;
  update: UpdateSummary | null = null;
  offline = false;
  readonly #listeners = new Set<Listener>();
  #timer: number | undefined;
  #running = false;
  #generation = 0;
  #intervalMs = 5_000;
  #refreshing: Promise<void> | undefined;
  readonly #visible = (): void => {
    if (document.visibilityState === "hidden") this.#clearTimer();
    else void this.refresh();
  };

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    const generation = this.#generation;
    this.#clearTimer();
    const operation = (async () => {
      try {
        const overview = await consoleGet<ConsoleOverview>(
          "/api/overview",
          AbortSignal.timeout(8_000),
        );
        if (generation !== this.#generation) return;
        this.overview = overview;
        this.offline = false;
      } catch {
        if (generation !== this.#generation) return;
        this.offline = true;
      }
      this.#emit();
    })().finally(() => {
      if (this.#refreshing !== operation) return;
      this.#refreshing = undefined;
      this.#schedule();
    });
    this.#refreshing = operation;
    return operation;
  }

  async checkUpdate(): Promise<void> {
    const generation = this.#generation;
    try {
      const update = await consolePost<UpdateSummary | null>("/api/update/check");
      if (generation !== this.#generation) return;
      this.update = update;
    } catch {
      if (generation !== this.#generation) return;
      this.update = null;
    }
    this.#emit();
  }

  start(intervalMs = 5_000): void {
    if (this.#running) return;
    this.#running = true;
    this.#intervalMs = intervalMs;
    document.addEventListener("visibilitychange", this.#visible);
    const generation = this.#generation;
    void this.refresh().then(() => {
      if (this.#running && generation === this.#generation) return this.checkUpdate();
    });
  }

  stop(): void {
    this.#running = false;
    this.#generation++;
    this.#refreshing = undefined;
    this.#clearTimer();
    document.removeEventListener("visibilitychange", this.#visible);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#clearTimer();
    if (!this.#running || document.visibilityState === "hidden") return;
    const fast = this.offline || !this.overview || this.overview.summary.state === "starting";
    this.#timer = window.setTimeout(() => void this.refresh(), fast ? this.#intervalMs : 30_000);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
