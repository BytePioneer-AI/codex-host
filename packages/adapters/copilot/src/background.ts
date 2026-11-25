import type { CopilotSession } from "@github/copilot-sdk";
import { bounded } from "./errors.js";

/** Native task invalidation is not an idle notification. Keep the lease until a fresh read. */
export class CopilotBackground {
  private revision = 0;
  private pending: Promise<void> | undefined;
  private work = false;
  private dirty = false;
  private closed = false;

  hasWork(): boolean {
    return this.dirty || this.work;
  }

  invalidate(): void {
    this.dirty = true;
    this.revision++;
  }

  refresh(session: CopilotSession): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.read(session).finally(() => {
      this.pending = undefined;
    }));
  }

  private async read(session: CopilotSession): Promise<void> {
    do {
      const revision = this.revision;
      const { tasks } = await bounded(session.rpc.tasks.list());
      if (this.closed) return;
      this.work = tasks.some((task) => task.status === "running" || task.status === "idle");
      this.dirty = revision !== this.revision;
    } while (this.dirty);
  }

  close(): void {
    this.closed = true;
  }
}
