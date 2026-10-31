/** Web command routing; Host owns catalog filtering, admission and execution. */
import {
  harnessCommandCatalogSchema,
  threadCommandExecuteResultSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThread } from "./ch-thread-view.ts";
import { RpcError } from "./transport.ts";

export class ChHarnessCommands {
  private readonly pending = new Set<string>();
  constructor(
    private readonly host: ChHostClient,
    private readonly resolve: (sessionId: string) => Promise<ChThread>,
  ) {}
  async inspect(sessionId: string): Promise<HarnessCommandCatalog> {
    const thread = await this.resolve(sessionId);
    return harnessCommandCatalogSchema.parse(
      await this.host.request("codexhost/thread/commands/inspect", { threadId: thread.id }),
    );
  }
  async execute(sessionId: string, commandId: string) {
    // Resolve canonical identity before fencing duplicates; Host owns cross-client admission.
    const thread = await this.resolve(sessionId);
    if (this.pending.has(thread.id) || thread.status.type === "active")
      throw new RpcError("session/busy", "The Thread is busy. Direct commands cannot be queued.");
    this.pending.add(thread.id);
    try {
      const catalog = await this.inspect(sessionId);
      const command = catalog.commands.find((item) => item.id === commandId);
      if (!command || (command.argumentMode !== "none" && command.invocation !== "/compact"))
        throw new RpcError("command/unavailable", "Select an available direct command again.");
      return threadCommandExecuteResultSchema.parse(
        await this.host.request("codexhost/thread/command/execute", {
          threadId: thread.id,
          commandId: command.id,
        }),
      );
    } finally {
      this.pending.delete(thread.id);
    }
  }
}
