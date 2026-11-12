/** Native command metadata and receipts, without launching any Harness. */
import { harnessCommandCatalogSchema, skillsListResultSchema } from "@codexhost/shared-contracts";
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
        },
        {
          id: "fake.bare-skill",
          invocation: "/bare-skill",
          label: "Bare skill",
          argumentMode: "none",
        },
        { id: "fake.model", invocation: "/model", label: "Native model", argumentMode: "none" },
      ],
    }),
    skills: skillsListResultSchema.parse({
      revision: 1,
      complete: true,
      skills: [
        {
          name: "library-review",
          path: "/computer/skills/review/SKILL.md",
          scope: "global",
          source: "Agents",
          description: "Review with care",
        },
        {
          name: "eli5",
          path: "/computer/skills/explain (simple)/SKILL.md",
          scope: "project",
          source: "Pi",
          description: "Explain simply",
        },
      ],
    }),
    skillFailure: "",
    beforeSkills: async () => {},
    official: false,
    failure: "",
    executionFailure: "",
    beforeInspect: async () => {},
    beforeExecute: async () => {},
    extraHarnesses: false,
    withdrawn: false,
  };
  const ownership = host.threadOwnership.bind(host);
  host.threadOwnership = (threadId) =>
    state.official ? { threadId, owner: "codex" } : ownership(threadId);
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (state.official && method === "codexhost/thread/inspect")
      return { owner: "codex", locked: false, effectiveModel: { id: "native" } } as T;
    if (state.official && method === "codexhost/harness/inspect" && params.harnessId === "codex")
      return host.inspection as T;
    if (method === "codexhost/skills/list") {
      host.requests.push({ method, params: structuredClone(params) });
      await state.beforeSkills();
      if (state.skillFailure) throw new RpcError("skills/unavailable", state.skillFailure);
      return structuredClone(state.skills) as T;
    }
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
          ...(!state.withdrawn ? [{ ...base, id: "alpha-agent", name: "Alpha" }] : []),
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
