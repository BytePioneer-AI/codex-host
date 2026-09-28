import type { OpenCodeClient } from "@opencode/client";
import { v2Catalog } from "./state.js";

/** v2's HTTP listener becomes ready before its configuration plugins activate. */
export async function readCatalog(client: OpenCodeClient, cwd: string, timeoutMs: number) {
  const location = { directory: cwd };
  const deadline = Date.now() + timeoutMs;
  const required = ["opencode.config.provider", "opencode.config.agent", "opencode.config.policy"];
  while (true) {
    const { data: plugins } = await client.plugin.list({ location });
    const config = required.map((id) => plugins.find((plugin) => plugin.id === id));
    const failed = config.find((plugin) => plugin?.state.status === "failed");
    if (failed?.state.status === "failed")
      throw new Error(`OpenCode configuration failed: ${failed.state.error}`);
    if (config.every((plugin) => plugin?.state.status === "active")) break;
    if (Date.now() >= deadline)
      throw new Error("OpenCode v2 configuration plugins did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [models, selected] = await Promise.all([
    client.model.list({ location }),
    client.model.default({ location }),
  ]);
  return v2Catalog(models.data, selected.data);
}
