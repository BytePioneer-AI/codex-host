/** Native command metadata and receipts, without launching any Harness. */
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";
import { RpcError } from "../../src/transport.ts";
import type { FakeChHost } from "./ch-host.ts";

export function withDiscovery(host: FakeChHost) {
  const state = {
    catalog: harnessCommandCatalogSchema.parse({
      source: "live",
      commands: [
        { id: "fake.compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
        { id: "fake.none", invocation: "/native-info", label: "Native info", argumentMode: "none" },
        {
          id: "fake.skill",
          invocation: "/native-skill",
          label: "Native skill",
          argumentMode: "text",
          kind: "skill",
        },
        {
          id: "fake.bare-skill",
          invocation: "/bare-skill",
          label: "Bare skill",
          argumentMode: "none",
          kind: "skill",
        },
        { id: "fake.model", invocation: "/model", label: "Native model", argumentMode: "none" },
      ],
    }),
    failure: "",
    executionFailure: "",
    beforeInspect: async () => {},
    beforeExecute: async () => {},
    extraHarnesses: false,
    withdrawn: false,
  };
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/commands/inspect") {
      host.requests.push({ method, params });
      const catalog = structuredClone(state.catalog);
      await state.beforeInspect();
      if (state.failure) throw new RpcError("host/unavailable", state.failure);
      return catalog as T;
    }
    if (method === "codexhost/thread/command/execute") {
      host.requests.push({ method, params });
      await state.beforeExecute();
      if (state.executionFailure) throw new RpcError("host/disconnected", state.executionFailure);
      const thread = host.threads.get(String(params.threadId));
      if (thread?.status.type === "active") throw new RpcError("session/busy", "Host is busy");
      return { accepted: true, turnId: "native-command-turn" } as T;
    }
    if (state.extraHarnesses && method === "codexhost/harness/inspect") {
      if (params.harnessId === "missing") {
        host.requests.push({ method, params });
        return {
          status: "notInstalled",
          error: { code: "not-installed", message: "Missing CLI", retryable: false },
        } as T;
      }
    }
    const result = await request<T>(method, params);
    if (state.extraHarnesses && method === "codexhost/harness/plugins/list") {
      const base = (result as { plugins: object[] }).plugins[0];
      return {
        plugins: [
          { ...base, id: "fake", name: "Twin" },
          ...(!state.withdrawn ? [{ ...base, id: "codex-cli", name: "Codex" }] : []),
          { ...base, id: "other", name: "Twin" },
          { ...base, id: "missing", name: "Missing" },
          { ...base, id: "usage", name: "Usage", kind: "usage" },
        ],
      } as T;
    }
    return result;
  };
  return state;
}
