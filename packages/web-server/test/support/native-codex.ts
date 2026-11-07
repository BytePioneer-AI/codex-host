import type { FakeChHost } from "./ch-host.ts";

/** Native ownership is independent of the Provider chosen for the original Thread. */
export function nativeCodex<T extends FakeChHost>(host: T): T {
  const request = host.request.bind(host);
  host.request = async <R>(method: string, params: Record<string, unknown>): Promise<R> => {
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
      return { owner: "codex", locked: true } as R;
    }
    return request<R>(method, params);
  };
  return host;
}
