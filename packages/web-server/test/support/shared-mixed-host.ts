/** Real authenticated channel/isolated owner, with synthetic external protocol facts. */
import type { TestContext } from "node:test";
import { join } from "node:path";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import { clientThreadSnapshotSchema } from "@codexhost/shared-contracts";
import {
  ClientChannelEvents,
  SharedWebCodexOwner,
  startClientChannelServer,
} from "@codexhost/host-runtime";
import type { MixedChHost } from "./web-codex.ts";

export async function startMixedSharedHost(
  t: TestContext,
  root: string,
  plugins: string,
  host: MixedChHost,
) {
  const hostRoot = join(root, "host");
  const environment = {
    HOME: root,
    CODEX_HOME: join(root, "gui-home"),
    CODEXHOST_DATA_DIR: hostRoot,
  };
  const events = new ClientChannelEvents();
  const preferences = new HarnessPreferencesStore(hostRoot);
  const preference = (method: string, params: Record<string, unknown>) =>
    method.endsWith("/get")
      ? preferences.get(params.scope as Parameters<HarnessPreferencesStore["get"]>[0])
      : preferences.patch(params as Parameters<HarnessPreferencesStore["patch"]>[0]);
  const owner = new SharedWebCodexOwner(
    environment,
    events,
    async (id) => host.threads.has(id),
    preference,
  );
  const channel = await startClientChannelServer({
    environment,
    owner: "service",
    target: {
      clientEvents: events,
      webCodex: owner,
      async handleClientRequest(method, params) {
        const input = params as Record<string, unknown>;
        if (method.startsWith("codexhost/harness/preferences/"))
          return { result: await preference(method, input) };
        if (method === "codexhost/workspace/read")
          return { result: { ...(await host.projects()), pinned: await host.pins() } };
        if (method.endsWith("display-settings/get")) return { result: { entries: null } };
        if (method.endsWith("display-settings/capabilities")) return { result: { events: true } };
        const result = await host.request(method, input);
        if (
          ["turn/start", "thread/name/set", "thread/archive", "thread/unarchive"].includes(
            method,
          ) &&
          typeof input.threadId === "string"
        )
          events.changed(input.threadId, method);
        return { result };
      },
      async clientSnapshot(id) {
        const thread = host.threads.get(id);
        if (!thread || thread.modelProvider !== "codexhost")
          throw Error("Official Thread must remain hidden");
        return clientThreadSnapshotSchema.parse({
          cursor: events.cursor,
          thread: { ...structuredClone(thread), turns: [] },
          turnsPage: { data: structuredClone([...thread.turns].reverse()), nextCursor: null },
          configuration: {
            effectiveModel: { id: "native" },
            effectivePermissionModeId: host.modes.get(id) ?? "ask",
          },
          interactions: [],
        });
      },
      async respondClient() {
        throw Error("Synthetic external fixture has no pending interaction");
      },
    },
  });
  t.after(async () => {
    await channel.close();
    await owner.close();
    await preferences.close();
  });
  return {
    owner,
    args: [
      "--session-source",
      "codexhost",
      "--ch-data",
      hostRoot,
      "--ch-control-directory",
      join(hostRoot, "client-hosts"),
      "--harness",
      "codex",
      "--adapters",
      plugins,
      "--codex-home",
      join(root, "web-home"),
      "--codex-command",
      process.execPath,
    ],
  };
}
