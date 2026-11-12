import { skillsListResultSchema, type SkillsListParams } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { EventHub, RpcRegistry } from "./transport.ts";

/** Web only resolves local ownership; the shared Host owns indexing and freshness. */
export class WebSkills {
  private readonly unsubscribe: (() => void) | undefined;
  constructor(
    private readonly host: ChHostClient,
    events: EventHub,
    private readonly resolve: (sessionId: string) => Promise<SkillsListParams>,
  ) {
    this.unsubscribe = host.realtime?.subscribe((event) => {
      if (event.type === "skills-changed") events.emit("codexhost/skills/changed", event.cwd);
      if (event.type === "hello") events.emit("codexhost/skills/changed");
    });
  }
  register(rpc: RpcRegistry): void {
    rpc.register("codexhost/skills/list", async (args) => {
      const params = await this.resolve(String(args.sessionId ?? ""));
      return skillsListResultSchema.parse(await this.host.request("codexhost/skills/list", params));
    });
  }
  prepare(cwd: string): void {
    void this.host.request("codexhost/skills/list", { cwd }).catch(() => undefined);
  }
  close(): void {
    this.unsubscribe?.();
  }
}
