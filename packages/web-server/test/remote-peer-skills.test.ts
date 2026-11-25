import assert from "node:assert/strict";
import { it } from "node:test";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import { PeerChHostClient, type PeerChTransport } from "../src/peer-ch-host-client.ts";
import { PeerThreadSource } from "../src/peer-thread-source.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamSink,
} from "../src/transport.ts";
import type { ChThread } from "../src/ch-thread-view.ts";

function makeRow(id: string, overrides: Partial<ChThread> = {}): ChThread {
  return {
    id,
    cwd: "/remote/project",
    modelProvider: "codexhost",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    turns: [],
    ...overrides,
  };
}

function makeHarnessInspection(modelId: string) {
  return {
    status: "ready",
    catalog: {
      defaultModel: { id: modelId },
      models: [{ ref: { id: modelId }, label: modelId, supportedThinkingOptionIds: [] }],
      thinkingOptions: [],
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
}

interface TestPeerFixture {
  peerHostId: string;
  remoteControlHostId: string;
  sshHostId: string;
  epoch: string;
  peerOnline: boolean;
  localCalls: string[];
  peerCalls: Array<{ method: string; params: Record<string, unknown> }>;
  emittedEvents: Array<{ event: string; args: unknown[] }>;
  emitPeerUpdate: (update: HostClientUpdate) => void;
  rpc: RpcRegistry;
  remote: RemoteSessions;
  source: PeerThreadSource;
  close: () => void;
}

function createFixture(options: {
  peerRows?: ChThread[];
  peerOwnership?: Array<{ threadId: string; owner: "codex" | "external"; harnessId?: string }>;
  onPeerRpc?: (method: string, params: Record<string, unknown>) => unknown;
}): TestPeerFixture {
  const peerHostId = "remote-peer:peer-1";
  const remoteControlHostId = "remote-control:rc-1";
  const sshHostId = "remote-ssh:dev-box";
  const epoch = "epoch-skills-1";
  const peerRows = options.peerRows ?? [
    makeRow("ext-thread", { modelProvider: "codexhost" }),
    makeRow("codex-thread", { modelProvider: "openai" }),
    makeRow("subagent-thread", { modelProvider: "codexhost", parentThreadId: "ext-thread" }),
    makeRow("readonly-thread", { modelProvider: "codexhost", canAcceptDirectInput: false }),
  ];
  const peerOwnership = options.peerOwnership ?? [
    { threadId: "ext-thread", owner: "external", harnessId: "claude-code" },
    { threadId: "codex-thread", owner: "codex" },
    { threadId: "subagent-thread", owner: "external", harnessId: "claude-code" },
    { threadId: "readonly-thread", owner: "external", harnessId: "claude-code" },
  ];
  const rcRow = makeRow("rc-thread", { modelProvider: "openai" });
  const sshRow = makeRow("ssh-thread", { modelProvider: "codexhost" });

  let peerOnline = true;
  const listeners = new Set<(update: HostClientUpdate) => void>();
  const peerCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const localCalls: string[] = [];
  const emittedEvents: Array<{ event: string; args: unknown[] }> = [];

  const transport: PeerChTransport = {
    manifest: () => ({
      version: "1",
      epoch,
      platform: "linux",
      hostname: "peer-box",
      homeDir: "/home/peer",
      projects: [{ id: "proj-1", name: "App", path: "/remote/project", threadIds: [] }],
    }),
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connection", online: true });
      listener({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });
      return () => {
        listeners.delete(listener);
      };
    },
    async post<T>(_route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      const { method, params = {} } = body as {
        method: string;
        params?: Record<string, unknown>;
      };
      peerCalls.push({ method, params });
      if (options.onPeerRpc) {
        const custom = options.onPeerRpc(method, params);
        if (custom !== undefined) return custom as T;
      }
      if (method === "codexhost/thread/catalog/read") {
        return {
          threads: peerRows,
          ownership: peerOwnership,
          officialCursor: { live: null },
          archivedThreadIds: [],
        } as T;
      }
      if (method === "codexhost/thread/tree/read") return { parents: {} } as T;
      if (method === "codexhost/harness/plugins/list") {
        return {
          plugins: [
            {
              id: "claude-code",
              name: "Claude Code",
              version: "1.0.0",
              icon: "data:image/png;base64,AA==",
            },
          ],
        } as T;
      }
      if (method === "codexhost/harness/inspect") {
        const harnessId = String(params.harnessId ?? "");
        if (harnessId === "codex") return makeHarnessInspection("gpt-5.4") as T;
        if (harnessId === "claude-code") return makeHarnessInspection("claude-sonnet-4-6") as T;
      }
      throw new Error(`Unexpected peer RPC: ${method}`);
    },
  };

  const events = new EventHub("remote-peer-skills-test");
  const eventSink: StreamSink = {
    id: "events-observer",
    closed: false,
    push(value) {
      const frame = value as { type?: string; event?: string; args?: unknown[] };
      if (frame.type === "emit" && typeof frame.event === "string") {
        emittedEvents.push({ event: frame.event, args: frame.args ?? [] });
      }
    },
    end() {},
    fail() {},
    onClose() {},
  };
  events.handler({}, eventSink);

  const provider: {
    source: (hostId: string) => PeerThreadSource | undefined;
    onSkillsChanged?: (hostId: string) => void;
    onConnection?: (hostId: string, online: boolean) => void;
    onCatalogInspectionChanged?: (hostId: string) => void;
    onReset?: (hostId: string, epoch: string, full: boolean) => void;
  } = {
    source: (hostId) => (hostId === peerHostId ? source : undefined),
  };

  const source = new PeerThreadSource({
    hostId: peerHostId,
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onSkillsChanged: () => provider.onSkillsChanged?.(peerHostId),
    onCatalogInspectionChanged: () => provider.onCatalogInspectionChanged?.(peerHostId),
    onConnection: (online) => provider.onConnection?.(peerHostId, online),
    onReset: (nextEpoch, full) => provider.onReset?.(peerHostId, nextEpoch, full),
  });

  const remote = new RemoteSessions(
    events,
    async (op) => {
      if (op.kind === "hosts") {
        return [
          {
            hostId: peerHostId,
            online: peerOnline,
            epoch,
            displayName: "Peer Box",
            projects: [{ id: "proj-1", name: "App", path: "/remote/project", threadIds: [] }],
          },
          {
            hostId: remoteControlHostId,
            online: true,
            epoch: "rc-epoch",
            displayName: "Desktop RC",
            projects: [{ id: "rc-proj", name: "RC", path: "/rc/project", threadIds: [] }],
          },
          {
            hostId: sshHostId,
            online: true,
            epoch: "ssh-epoch",
            displayName: "SSH Box",
            projects: [{ id: "ssh-proj", name: "SSH", path: "/ssh/project", threadIds: [] }],
          },
        ];
      }
      if (op.kind === "list" && op.hostId === remoteControlHostId) {
        return { data: [rcRow], nextCursor: null };
      }
      if (op.kind === "list" && op.hostId === sshHostId) {
        return { data: [sshRow], nextCursor: null };
      }
      throw new Error(`Unexpected desktop op: ${op.kind}`);
    },
    undefined,
    provider,
  );

  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  rpc.register("session/list", () => ({ items: [] }));
  rpc.register("session/create", () => {
    localCalls.push("session/create");
    return {};
  });
  rpc.register("session/selectModel", () => {
    localCalls.push("session/selectModel");
    return {};
  });
  rpc.register("session/projections", () => {
    localCalls.push("session/projections");
    return {};
  });
  rpc.register("codexhost/skills/list", () => {
    localCalls.push("codexhost/skills/list");
    return { revision: 1, complete: true, skills: [] };
  });
  rpc.register("codexhost/threadCommands", () => {
    localCalls.push("codexhost/threadCommands");
    return { commands: [] };
  });
  rpc.register("codexhost/executeThreadCommand", () => {
    localCalls.push("codexhost/executeThreadCommand");
    return { accepted: true };
  });
  remote.install(rpc, streams);

  return {
    peerHostId,
    remoteControlHostId,
    sshHostId,
    epoch,
    get peerOnline() {
      return peerOnline;
    },
    set peerOnline(value: boolean) {
      peerOnline = value;
    },
    localCalls,
    peerCalls,
    emittedEvents,
    emitPeerUpdate(update) {
      for (const listener of [...listeners]) listener(update);
    },
    rpc,
    remote,
    source,
    close() {
      remote.close();
      source.close();
    },
  };
}

it("forwards codexhost/skills/list for remote peer external threads and drafts with schema validation", async (t) => {
  const peerSkills = {
    revision: 3,
    complete: true,
    skills: [
      {
        name: "deploy-check",
        description: "Check peer deployment",
        path: "/remote/project/.agents/skills/deploy-check/SKILL.md",
        scope: "project",
        source: "project",
      },
    ],
  };
  const fx = createFixture({
    onPeerRpc(method) {
      if (method === "codexhost/skills/list") return peerSkills;
      return undefined;
    },
  });
  t.after(() => fx.close());
  await fx.remote.refresh();

  // nativeDiscovery projection: true for editable non-subagent peer threads, false for subagent/read-only/non-peer.
  const listed = await fx.rpc.dispatch("session/list", {});
  assert.equal(listed.ok, true);
  const items = (
    listed.value as {
      items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
    }
  ).items;
  const byId = new Map(items.map((item) => [item.sessionId, item.projections.values]));
  assert.equal(byId.get(remoteSessionId(fx.peerHostId, "ext-thread"))?.nativeDiscovery, true);
  assert.equal(byId.get(remoteSessionId(fx.peerHostId, "codex-thread"))?.nativeDiscovery, true);
  assert.equal(byId.get(remoteSessionId(fx.peerHostId, "subagent-thread"))?.nativeDiscovery, false);
  assert.equal(byId.get(remoteSessionId(fx.peerHostId, "readonly-thread"))?.nativeDiscovery, false);
  assert.equal(
    byId.get(remoteSessionId(fx.remoteControlHostId, "rc-thread"))?.nativeDiscovery,
    false,
  );
  assert.equal(byId.get(remoteSessionId(fx.sshHostId, "ssh-thread"))?.nativeDiscovery, false);

  // External peer thread forwards { threadId }.
  const threadSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: remoteSessionId(fx.peerHostId, "ext-thread") },
  });
  assert.equal(threadSkills.ok, true);
  assert.deepEqual(threadSkills.value, peerSkills);
  assert.deepEqual(
    fx.peerCalls.filter((call) => call.method === "codexhost/skills/list"),
    [{ method: "codexhost/skills/list", params: { threadId: "ext-thread" } }],
  );

  // Codex peer thread returns skills/unavailable without forwarding.
  const codexSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: remoteSessionId(fx.peerHostId, "codex-thread") },
  });
  assert.equal(codexSkills.ok, false);
  assert.equal(codexSkills.error.code, "skills/unavailable");

  // Subagent and read-only peer threads return skills/unavailable.
  for (const threadId of ["subagent-thread", "readonly-thread"]) {
    const blocked = await fx.rpc.dispatch("codexhost/skills/list", {
      args: { sessionId: remoteSessionId(fx.peerHostId, threadId) },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "skills/unavailable");
  }

  // Unsubmitted peer draft with external harness forwards { cwd }.
  const created = await fx.rpc.dispatch("session/create", {
    args: {
      request: {
        workspaceId: `remote-workspace:${Buffer.from(JSON.stringify([fx.peerHostId, "proj-1"])).toString("base64url")}`,
      },
    },
  });
  assert.equal(created.ok, true);
  assert.ok(created.ok);
  const draftId = (created.value as { sessionId: string }).sessionId;

  const selectedExt = await fx.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: draftId, provider: "claude-code", model: "claude-sonnet-4-6" } },
  });
  assert.equal(selectedExt.ok, true);

  const draftSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: draftId },
  });
  assert.equal(draftSkills.ok, true);
  assert.deepEqual(draftSkills.value, peerSkills);
  assert.deepEqual(fx.peerCalls.filter((call) => call.method === "codexhost/skills/list").at(-1), {
    method: "codexhost/skills/list",
    params: { cwd: "/remote/project" },
  });

  // Switching the same draft to Codex returns skills/unavailable.
  const selectedCodex = await fx.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: draftId, provider: "codex", model: "gpt-5.4" } },
  });
  assert.equal(selectedCodex.ok, true);
  const codexDraftSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: draftId },
  });
  assert.equal(codexDraftSkills.ok, false);
  assert.equal(codexDraftSkills.error.code, "skills/unavailable");
  assert.deepEqual(fx.localCalls, []);
});

it("forwards codexhost/threadCommands for peer threads and Codex drafts while skipping non-Codex drafts and blocking execute", async (t) => {
  const threadCatalog = {
    source: "live",
    commands: [
      {
        id: "skill:review",
        invocation: "/skill:review",
        label: "review",
        argumentMode: "text",
        kind: "skill",
      },
      {
        id: "cmd:compact",
        invocation: "/compact",
        label: "compact",
        argumentMode: "none",
        kind: "command",
      },
    ],
  };
  const draftCatalog = {
    source: "live",
    commands: [
      {
        id: "skill:plan",
        invocation: "/skill:plan",
        label: "plan",
        argumentMode: "text",
        kind: "skill",
      },
    ],
  };
  const fx = createFixture({
    onPeerRpc(method) {
      if (method === "codexhost/thread/commands/inspect") return threadCatalog;
      if (method === "codexhost/harness/commands/inspect") return draftCatalog;
      return undefined;
    },
  });
  t.after(() => fx.close());
  await fx.remote.refresh();

  // Submitted peer Codex thread forwards codexhost/thread/commands/inspect.
  const threadResult = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: remoteSessionId(fx.peerHostId, "codex-thread") } },
  });
  assert.equal(threadResult.ok, true);
  assert.deepEqual(threadResult.value, threadCatalog);
  assert.deepEqual(
    fx.peerCalls.filter((call) => call.method === "codexhost/thread/commands/inspect"),
    [{ method: "codexhost/thread/commands/inspect", params: { threadId: "codex-thread" } }],
  );

  // Remote draft: non-Codex draft must NOT call codexhost/harness/commands/inspect.
  const created = await fx.rpc.dispatch("session/create", {
    args: {
      request: {
        workspaceId: `remote-workspace:${Buffer.from(JSON.stringify([fx.peerHostId, "proj-1"])).toString("base64url")}`,
      },
    },
  });
  assert.equal(created.ok, true);
  assert.ok(created.ok);
  const draftId = (created.value as { sessionId: string }).sessionId;

  await fx.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: draftId, provider: "claude-code", model: "claude-sonnet-4-6" } },
  });
  const nonCodexDraftResult = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(nonCodexDraftResult.ok, true);
  assert.deepEqual(nonCodexDraftResult.value, { commands: [] });
  assert.equal(
    fx.peerCalls.some((call) => call.method === "codexhost/harness/commands/inspect"),
    false,
  );

  // Switching draft to Codex forwards codexhost/harness/commands/inspect with { harnessId: "codex", cwd }.
  await fx.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: draftId, provider: "codex", model: "gpt-5.4" } },
  });
  const codexDraftResult = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(codexDraftResult.ok, true);
  assert.deepEqual(codexDraftResult.value, draftCatalog);
  assert.deepEqual(
    fx.peerCalls.filter((call) => call.method === "codexhost/harness/commands/inspect"),
    [
      {
        method: "codexhost/harness/commands/inspect",
        params: { harnessId: "codex", cwd: "/remote/project" },
      },
    ],
  );

  // Direct execution remains rejected on remote peer sessions and drafts.
  for (const sessionId of [remoteSessionId(fx.peerHostId, "codex-thread"), draftId]) {
    const execResult = await fx.rpc.dispatch("codexhost/executeThreadCommand", {
      args: { request: { sessionId, commandId: "cmd:compact" } },
    });
    assert.equal(execResult.ok, false);
    assert.equal(execResult.error.code, "remote/unsupported");
  }
  assert.deepEqual(fx.localCalls, []);
});

it("rejects SSH and remote-control sessions without falling back to the Hub", async (t) => {
  const fx = createFixture({});
  t.after(() => fx.close());
  await fx.remote.refresh();

  for (const [hostId, threadId, projectId] of [
    [fx.remoteControlHostId, "rc-thread", "rc-proj"],
    [fx.sshHostId, "ssh-thread", "ssh-proj"],
  ] as const) {
    const threadSessionId = remoteSessionId(hostId, threadId);
    const skillsRes = await fx.rpc.dispatch("codexhost/skills/list", {
      args: { sessionId: threadSessionId },
    });
    assert.equal(skillsRes.ok, false);
    assert.equal(skillsRes.error.code, "skills/unavailable");

    const commandsRes = await fx.rpc.dispatch("codexhost/threadCommands", {
      args: { request: { sessionId: threadSessionId } },
    });
    assert.equal(commandsRes.ok, false);
    assert.equal(commandsRes.error.code, "command/unavailable");

    const draftRes = await fx.rpc.dispatch("session/create", {
      args: {
        request: {
          workspaceId: `remote-workspace:${Buffer.from(JSON.stringify([hostId, projectId])).toString("base64url")}`,
        },
      },
    });
    assert.equal(draftRes.ok, true);
    const draftId = (draftRes.value as { sessionId: string }).sessionId;

    const draftSkillsRes = await fx.rpc.dispatch("codexhost/skills/list", {
      args: { sessionId: draftId },
    });
    assert.equal(draftSkillsRes.ok, false);
    assert.equal(draftSkillsRes.error.code, "skills/unavailable");

    const draftCommandsRes = await fx.rpc.dispatch("codexhost/threadCommands", {
      args: { request: { sessionId: draftId } },
    });
    assert.equal(draftCommandsRes.ok, false);
    assert.equal(draftCommandsRes.error.code, "command/unavailable");
  }

  assert.deepEqual(fx.localCalls, []);
});

it("degrades gracefully on legacy peer -32601, remembers per connection, resets on hello, and reports remote/offline", async (t) => {
  let skillsSupported = false;
  let threadCommandsSupported = false;
  let harnessCommandsSupported = false;
  const fx = createFixture({
    onPeerRpc(method) {
      if (method === "codexhost/skills/list") {
        if (!skillsSupported) {
          throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
        }
        return {
          revision: 2,
          complete: true,
          skills: [
            {
              name: "recovered-skill",
              path: "/remote/project/.agents/skills/recovered-skill/SKILL.md",
              scope: "project",
              source: "project",
            },
          ],
        };
      }
      if (method === "codexhost/thread/commands/inspect") {
        if (!threadCommandsSupported) {
          throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
        }
        return {
          source: "live",
          commands: [
            {
              id: "skill:recovered",
              invocation: "/skill:recovered",
              label: "recovered",
              argumentMode: "text",
              kind: "skill",
            },
          ],
        };
      }
      if (method === "codexhost/harness/commands/inspect") {
        if (!harnessCommandsSupported) {
          throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
        }
        return {
          source: "live",
          commands: [
            {
              id: "skill:draft-recovered",
              invocation: "/skill:draft-recovered",
              label: "draft-recovered",
              argumentMode: "text",
              kind: "skill",
            },
          ],
        };
      }
      return undefined;
    },
  });
  t.after(() => fx.close());
  await fx.remote.refresh();

  const extId = remoteSessionId(fx.peerHostId, "ext-thread");
  const codexId = remoteSessionId(fx.peerHostId, "codex-thread");
  const created = await fx.rpc.dispatch("session/create", {
    args: {
      request: {
        workspaceId: `remote-workspace:${Buffer.from(JSON.stringify([fx.peerHostId, "proj-1"])).toString("base64url")}`,
      },
    },
  });
  assert.ok(created.ok);
  const draftId = (created.value as { sessionId: string }).sessionId;
  await fx.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: draftId, provider: "codex", model: "gpt-5.4" } },
  });

  // First calls get -32601 and degrade cleanly.
  const degradedSkills1 = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: extId },
  });
  assert.equal(degradedSkills1.ok, true);
  assert.deepEqual(degradedSkills1.value, { revision: 0, complete: true, skills: [] });

  const degradedCmds1 = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: codexId } },
  });
  assert.equal(degradedCmds1.ok, true);
  assert.deepEqual(degradedCmds1.value, { commands: [] });

  const degradedDraftCmds1 = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(degradedDraftCmds1.ok, true);
  assert.deepEqual(degradedDraftCmds1.value, { commands: [] });

  // Second calls in the same connection use the remembered degradation without re-hitting Peer.
  const countBefore = fx.peerCalls.length;
  await fx.rpc.dispatch("codexhost/skills/list", { args: { sessionId: extId } });
  await fx.rpc.dispatch("codexhost/threadCommands", { args: { request: { sessionId: codexId } } });
  await fx.rpc.dispatch("codexhost/threadCommands", { args: { request: { sessionId: draftId } } });
  assert.equal(fx.peerCalls.length, countBefore);

  // Peer reconnects with hello -> resets method-unavailable cache and emits codexhost/skills/changed.
  skillsSupported = true;
  threadCommandsSupported = true;
  harnessCommandsSupported = true;
  const eventsBefore = fx.emittedEvents.length;
  fx.emitPeerUpdate({
    type: "hello",
    version: 1,
    cursor: { epoch: fx.epoch, sequence: 2 },
    reset: false,
  });
  assert.equal(
    fx.emittedEvents.slice(eventsBefore).some((item) => item.event === "codexhost/skills/changed"),
    true,
  );

  const recoveredSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: extId },
  });
  assert.equal(recoveredSkills.ok, true);
  assert.equal(
    (recoveredSkills.value as { skills: Array<{ name: string }> }).skills[0]?.name,
    "recovered-skill",
  );

  const recoveredCmds = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: codexId } },
  });
  assert.equal(recoveredCmds.ok, true);
  assert.equal(
    (recoveredCmds.value as { commands: Array<{ id: string }> }).commands[0]?.id,
    "skill:recovered",
  );

  const recoveredDraftCmds = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(recoveredDraftCmds.ok, true);
  assert.equal(
    (recoveredDraftCmds.value as { commands: Array<{ id: string }> }).commands[0]?.id,
    "skill:draft-recovered",
  );

  // Peer offline throws remote/offline and reflects disconnected state on draft remoteHost projection.
  fx.peerOnline = false;
  fx.emitPeerUpdate({ type: "connection", online: false });

  const draftProj = await fx.rpc.dispatch("session/projections", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(draftProj.ok, true);
  assert.equal(
    (draftProj.value as { values: { remoteHost: { state: string } } }).values.remoteHost.state,
    "disconnected",
  );

  const offlineSkills = await fx.rpc.dispatch("codexhost/skills/list", {
    args: { sessionId: extId },
  });
  assert.equal(offlineSkills.ok, false);
  assert.equal(offlineSkills.error.code, "remote/offline");

  const offlineDraftCmds = await fx.rpc.dispatch("codexhost/threadCommands", {
    args: { request: { sessionId: draftId } },
  });
  assert.equal(offlineDraftCmds.ok, false);
  assert.equal(offlineDraftCmds.error.code, "remote/offline");
  assert.deepEqual(fx.localCalls, []);
});

it("bridges peer skills-changed realtime events to Hub codexhost/skills/changed", async (t) => {
  const fx = createFixture({});
  t.after(() => fx.close());

  const before = fx.emittedEvents.length;
  fx.emitPeerUpdate({
    type: "skills-changed",
    cursor: { epoch: fx.epoch, sequence: 5 },
    cwd: "/remote/project",
  });
  const emitted = fx.emittedEvents
    .slice(before)
    .filter((item) => item.event === "codexhost/skills/changed");
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0]?.args, []);
});
