/** Serializes native pin snapshots and commands, not Thread execution. No persistent Web pin copy. */
import type { ChHostClient, ChPinChange } from "./ch-host-client.ts";
import type { Workspaces } from "./workspaces.ts";

export class ChPinnedThreads {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: ChHostClient,
    private readonly workspaces: Workspaces,
    private readonly visible: (threadId: string) => boolean,
  ) {
    // Ignore legacy Web-only pins from the moment shared mode starts.
    workspaces.setReferencePins([]);
  }

  sync(change?: ChPinChange): Promise<string[]> {
    const next = this.pending.then(async () => {
      const ids = (await this.host.pins(change)).filter(this.visible);
      this.workspaces.setReferencePins(ids);
      return ids;
    });
    // Failure preserves the previous projection but cannot poison subsequent reads/commands.
    this.pending = next.catch(() => undefined);
    return next;
  }
}
