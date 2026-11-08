import type { FakeChHost } from "./ch-host.ts";

/** Native ownership is independent of the Provider chosen for the original Thread. */
export function nativeCodex<T extends FakeChHost>(host: T): T {
  const request = host.request.bind(host);
  const ownership = host.threadOwnership.bind(host);
  host.threadOwnership = (threadId) =>
    threadId.startsWith("native-") ? { threadId, owner: "codex" } : ownership(threadId);
  host.request = async <R>(method: string, params: Record<string, unknown>): Promise<R> => {
    if (method === "codexhost/harness/inspect" && params.harnessId === "codex") {
      host.requests.push({ method, params });
      return {
        status: "ready",
        catalog: {
          models: [
            { ref: { id: "gpt-5.4" }, label: "GPT-5.4", supportedThinkingOptionIds: ["high"] },
          ],
          defaultModel: { id: "gpt-5.4" },
          thinkingOptions: [{ id: "high", label: "High" }],
        },
        permissionModes: {
          modes: [{ id: ":workspace", label: "Workspace" }],
          defaultModeId: ":workspace",
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: true,
            selectPermissionMode: true,
            permissionModeScope: "live",
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      } as R;
    }
    if (method === "thread/start" && typeof params.model === "object") {
      host.requests.push({ method, params });
      const row = host.add(
        `native-created-${host.threads.size}`,
        typeof params.cwd === "string" ? params.cwd : "/host/generated/first-message",
        "New Codex chat",
        false,
      );
      row.modelProvider = "openai";
      row.turns = [];
      return { thread: structuredClone(row) } as R;
    }
    if (method === "codexhost/thread/ownership/list") {
      host.requests.push({ method, params });
      return {
        threads: (params.threadIds as string[]).map((threadId) =>
          threadId.startsWith("native-")
            ? { threadId, owner: "codex" }
            : { threadId, owner: "external", harnessId: "fake" },
        ),
      } as R;
    }
    if (method === "codexhost/thread/inspect" && String(params.threadId).startsWith("native-")) {
      host.requests.push({ method, params });
      return {
        owner: "codex",
        locked: false,
        effectiveModel: { id: "gpt-5.4" },
        effectiveThinkingOptionId: "high",
        effectivePermissionModeId: ":workspace",
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      } as R;
    }
    return request<R>(method, params);
  };
  return host;
}
