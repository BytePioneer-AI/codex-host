import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  InputTriggerCandidate,
  InputTriggerSource,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { afterEach, expect, it, vi } from "vitest";
import { HARNESS_COMMAND_SOURCE } from "../src/client/harness-command-reference.ts";
import { registerHarnessDiscovery } from "../src/client/harness-discovery.tsx";

const commands = [
  { id: "native.compact", invocation: "/compact", label: "Compact", argumentMode: "text" },
  { id: "native.cost", invocation: "/cost", label: "Cost", argumentMode: "none" },
];

afterEach(() => vi.unstubAllGlobals());

it.each(commands)(
  "lists and executes $invocation directly in a remote Peer session",
  async (command) => {
    const sessionId = "web-remote:session" as SessionId;
    const row = {
      blank: false,
      running: false,
      projectionValues: {
        nativeDiscovery: true,
        remoteHost: { state: "connected" },
        threadReference: { hostId: "remote-peer:peer-1" },
      },
    };
    const requests: Array<{ method: string; args: unknown }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { method, payload } = JSON.parse(String(init.body));
      requests.push({ method, args: payload.args });
      const value = method === "codexhost/threadCommands" ? { commands } : { accepted: true };
      return Response.json({ result: { ok: true, value } });
    });
    const noopSubscribe = () => () => {};
    const notify = vi.fn();
    const composer = { state: { getSnapshot: () => ({ draftRev: 1 }) }, notify };
    const scope = { get: () => ({ input: { for: () => composer } }) };
    const sources = new Map<string, InputTriggerSource>();
    registerHarnessDiscovery({
      get: () => ({ generation: { getSnapshot: () => ({}), subscribe: noopSubscribe } }),
      locale: { bind: () => (key: string) => key },
      sessions: {
        list: { getSnapshot: () => ({ byId: { [sessionId]: row } }), subscribe: noopSubscribe },
        subagentAddress: () => undefined,
        scope: () => scope,
      },
      commandUi: { reservedNames: async () => new Set(["/permission"]) },
      effect: (start: () => void) => start(),
      remote: { $on: noopSubscribe },
      inputTriggers: {
        registerSource: (source: InputTriggerSource) => sources.set(source.name, source),
      },
    } as unknown as Context);

    const source = sources.get(HARNESS_COMMAND_SOURCE)!;
    const session = { sessionId };
    const req = {
      menuEpoch: {},
      query: "",
      position: "leading" as const,
      drilled: false,
      signal: new AbortController().signal,
    };
    const candidates = await source.candidates(session, req);
    expect(candidates.map((item) => item.name)).toEqual(["/compact", "/cost"]);
    const candidate = candidates.find((item) => item.value === command.id)!;
    expect(candidate.disabledReason).toBeUndefined();
    const pick = (item: InputTriggerCandidate) =>
      source.onPick({
        candidate: item,
        session,
        position: "leading",
        via: "menu",
        action: "pick",
        span: { start: 0, end: 0, draftRev: 1 },
      });

    row.projectionValues.remoteHost.state = "disconnected";
    expect(pick(candidate)).toBe("handled");
    expect(notify).toHaveBeenLastCalledWith("error", "discovery.offline");
    row.projectionValues.remoteHost.state = "connected";
    row.running = true;
    expect(pick(candidate)).toBe("handled");
    expect(notify).toHaveBeenLastCalledWith("error", "discovery.busy");
    row.running = false;
    expect(pick(candidate)).toBe("handled");
    expect(pick(candidate)).toBe("handled");
    expect(notify).toHaveBeenLastCalledWith("error", "discovery.pending");
    expect(requests).toEqual([
      { method: "codexhost/threadCommands", args: { request: { sessionId } } },
      {
        method: "codexhost/executeThreadCommand",
        args: { request: { sessionId, commandId: command.id } },
      },
    ]);
  },
);
