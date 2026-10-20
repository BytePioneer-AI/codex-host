export interface RestartStatus {
  phase: "idle" | "restarting" | "succeeded" | "failed";
  error: string | null;
}

export interface RestartObservation {
  launcherPid: number | null;
  controllerPid: number | null;
  installed: boolean;
  failure: string | null;
}

/** The Launcher owns shutdown. Completion requires a different ready Controller. */
export class ConsoleRestart {
  status: RestartStatus = { phase: "idle", error: null };
  constructor(
    private readonly run: () => Promise<void>,
    private readonly observe: () => Promise<RestartObservation>,
    private readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly now = Date.now,
    private readonly timeoutMs = 120_000,
  ) {}

  start(previous: RestartObservation): void {
    if (this.status.phase === "restarting") throw new Error("Restart is already in progress");
    this.status = { phase: "restarting", error: null };
    void this.restart(previous);
  }

  private async restart(previous: RestartObservation): Promise<void> {
    try {
      await this.run();
      const deadline = this.now() + this.timeoutMs;
      while (this.now() < deadline) {
        const current = await this.observe();
        if (current.failure) throw new Error(current.failure);
        if (
          current.launcherPid !== null &&
          current.launcherPid !== previous.launcherPid &&
          current.controllerPid !== null &&
          current.controllerPid !== previous.controllerPid &&
          current.installed
        ) {
          this.status = { phase: "succeeded", error: null };
          return;
        }
        await this.sleep(250);
      }
      throw new Error("Restart timed out. Check startup diagnostics before retrying.");
    } catch (error) {
      this.status = {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
