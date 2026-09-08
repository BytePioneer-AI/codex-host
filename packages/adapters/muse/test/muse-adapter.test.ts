import { describe, expect, it } from "vitest";
import type {
  HostApprovalInteraction,
  HostQuestionInteraction,
  TurnCompletedEvent,
} from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import {
  mapMuseApprovalActions,
  museApprovalProjectionReady,
  parseMuseRequirementRef,
} from "../src/approval.js";
import { mapMuseUserInputQuestions } from "../src/user-input.js";
import {
  findMuseChildSessionId,
  mapMuseHostItem,
  mergeMuseHistory,
  museNativeTurnKey,
  snapshotFromMuseHistory,
} from "../src/history.js";
import { MuseRpcError } from "../src/msp-client.js";
import { parseMuseModelCatalog } from "../src/model-catalog.js";
import { MuseAdapter } from "../src/muse-adapter.js";
import type { JsonObject, MuseRpc, MuseRpcNotification } from "../src/msp-client.js";
import {
  decodeMusePermissionModeId,
  musePermissionModeForExecutionPolicy,
} from "../src/permission-modes.js";
import { uuidv7 } from "../src/uuid.js";

class FakeMuseRpc implements MuseRpc {
  notifications: MuseRpcNotification[] = [];
  listeners = new Set<(notification: MuseRpcNotification) => void>();
  requests: Array<{ method: string; params?: JsonObject }> = [];
  sessionId = "muse-session-1";
  closed = false;
  turnBusy = false;
  lastCommandId: string | undefined;
  approvalDecideTerminal = true;
  emitOnTurnStart: MuseRpcNotification[] = [];
  viewPageEvents: Array<{ method: string; params: JsonObject }> = [];
  viewPageNextCursor: string | null = null;
  sessionHistories = new Map<string, JsonObject>();
  cancelThrows = false;
  cursor = 0;
  revisions = new Map<string, number>();

  async handshake(): Promise<JsonObject> {
    return { serverInfo: { name: "muse", version: "1.0.3" } };
  }

  async request(method: string, params?: JsonObject): Promise<JsonObject> {
    this.requests.push({ method, ...(params ? { params } : {}) });
    if (method === "model/list") {
      return {
        models: [
          { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isDefault: false },
          { modelId: "muse-spark-1.3-contributor", displayLabel: "Contributor", isDefault: true },
        ],
      };
    }
    if (method === "session/start" || method === "session/resume" || method === "session/fork") {
      return {
        session: {
          activeTurnId: null,
          status: "idle",
          sessionId: this.sessionId,
          modelId: "muse-spark-1.3-contributor",
          approvalMode: { mode: "onRequest" },
        },
      };
    }
    if (method === "session/read") {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : this.sessionId;
      const override = this.sessionHistories.get(sessionId);
      if (override) return { history: override, session: {}, viewCursor: "c", pendingRequests: [] };
      if (sessionId !== this.sessionId) {
        return {
          history: { mode: "inline", items: [], snapshot: null },
          session: {},
          viewCursor: "c",
          pendingRequests: [],
        };
      }
      const commandId = this.lastCommandId ?? "c1";
      return {
        session: { activeTurnId: null, status: "idle" },
        history: {
          mode: "inline",
          items: [
            { kind: "userMessage", itemId: "u1", commandId, text: "hello" },
            { kind: "agentMessage", itemId: "a1", text: "world" },
          ],
          snapshot: null,
        },
      };
    }
    if (method === "turn/start") {
      this.turnBusy = true;
      const commandId =
        typeof params?.commandId === "string" && params.commandId ? params.commandId : "c1";
      this.lastCommandId = commandId;
      for (const notification of this.emitOnTurnStart) this.emit(notification);
      return {
        turnId: commandId,
        startedNewTurn: true,
        disposition: "started",
        status: "accepted",
        commandId,
      };
    }
    if (method === "turn/cancel") {
      if (this.cancelThrows) {
        throw new MuseRpcError("Muse Turn already completed", -32602, { kind: "invalidParams" });
      }
      this.emit({ method: "turn/completed", params: { terminal: "cancelled" } });
      return { status: "accepted", commandId: params?.commandId, turnId: params?.turnId };
    }
    if (method === "approval/decide") {
      const requirement = params?.requirementId;
      if (
        !requirement ||
        typeof requirement !== "object" ||
        Array.isArray(requirement) ||
        typeof (requirement as JsonObject).approvalId !== "string" ||
        typeof (requirement as JsonObject).sourceIndex !== "number"
      ) {
        throw new MuseRpcError("approvalRequirementStale", -32053, {
          kind: "approvalRequirementStale",
        });
      }
      if (params?.choiceId !== "choice-allow-once" && params?.choiceId !== "choice-deny") {
        throw new MuseRpcError("approvalChoiceInvalid", -32052, { kind: "approvalChoiceInvalid" });
      }
      return {
        approvalId: params?.approvalId,
        commandId: params?.commandId,
        status: "accepted",
        terminal: this.approvalDecideTerminal,
      };
    }
    if (method === "session/setApprovalMode") {
      return {
        applyOutcome: "completed",
        commandId: params?.commandId,
        status: "accepted",
        effectiveMode: { mode: params?.mode, source: "approvalReconfigure" },
      };
    }
    if (method === "view/page") {
      return {
        events: this.viewPageEvents.map((event) => this.scoped(event)),
        nextCursor: this.viewPageNextCursor,
      };
    }
    return {};
  }

  notify(): void {}

  subscribe(handler: (notification: MuseRpcNotification) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  subscribeFailure(): () => void {
    return () => undefined;
  }

  scoped(notification: MuseRpcNotification): MuseRpcNotification {
    const params: JsonObject = {
      sessionId: this.sessionId,
      viewCursor: `fake-${++this.cursor}`,
      ...notification.params,
    };
    const turnId = this.lastCommandId ?? "c1";
    if (
      notification.method.startsWith("turn/") ||
      notification.method === "approval/requested" ||
      notification.method === "approval/resolved" ||
      notification.method === "userInput/requested"
    ) {
      params.turnId ??= turnId;
    }
    if (params.item && typeof params.item === "object" && !Array.isArray(params.item)) {
      const item = params.item as JsonObject;
      const itemId = String(item.itemId);
      const revision =
        notification.method === "item/started" ? 1 : (this.revisions.get(itemId) ?? 1) + 1;
      this.revisions.set(itemId, revision);
      params.item = { turnId, revision, ...item };
    }
    return { ...notification, params };
  }

  emit(notification: MuseRpcNotification): void {
    const scoped = this.scoped(notification);
    this.notifications.push(scoped);
    for (const listener of this.listeners) listener(scoped);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const NATIVE_APPROVAL_CHOICES = [
  {
    choiceId: "choice-allow-once",
    decision: "approved",
    label: "Allow once",
    scope: "once",
  },
  {
    choiceId: "choice-deny",
    decision: "denied",
    label: "Deny",
    scope: "once",
  },
];

describe("muse adapter", () => {
  it("maps native approval choices onto Host actions", () => {
    const actions = mapMuseApprovalActions([
      ...NATIVE_APPROVAL_CHOICES,
      {
        choiceId: "choice-session",
        decision: "approvedForSession",
        label: "Allow for session",
        scope: "session",
      },
    ]);
    expect(actions.map((action) => action.effect)).toEqual([
      "allowOnce",
      "allowForSession",
      "deny",
    ]);
    expect(
      museApprovalProjectionReady(
        mapMuseApprovalActions([
          {
            choiceId: "choice-always",
            decision: "approvedPolicyAmendment",
            label: "Always allow",
            scope: "localPersistent",
          },
          {
            choiceId: "choice-deny",
            decision: "denied",
            label: "Deny",
            scope: "once",
          },
        ]),
      ),
    ).toBe(true);
    expect(actions[0]?.id).toBe("choice-allow-once");
    expect(museApprovalProjectionReady(actions)).toBe(true);
    expect(parseMuseRequirementRef({ approvalId: "appr-1", sourceIndex: 0 })).toEqual({
      approvalId: "appr-1",
      sourceIndex: 0,
    });
    expect(parseMuseRequirementRef("appr-1")).toBeUndefined();
  });

  it("maps Always + Deny without inventing an Allow once id", () => {
    const actions = mapMuseApprovalActions([
      {
        choiceId: "choice-always",
        decision: "approvedPolicyAmendment",
        label: "Always allow",
        scope: "localPersistent",
      },
      {
        choiceId: "choice-deny",
        decision: "denied",
        label: "Deny",
        scope: "once",
      },
    ]);
    expect(actions.map((action) => action.effect)).toEqual(["allowAlways", "deny"]);
    expect(museApprovalProjectionReady(actions)).toBe(true);
  });

  it("uses commandId as the snapshot Native Turn key", () => {
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "muse",
      nativeSessionId: "session-1",
      formatVersion: 1,
    });
    const item = {
      kind: "userMessage",
      commandId: "cmd-1",
      itemId: "u1",
      turnId: "cmd-1",
      text: "hello",
    };
    expect(museNativeTurnKey(item, 0)).toBe("cmd-1");
    const snapshot = snapshotFromMuseHistory(nativeRef, {
      items: [item, { kind: "agentMessage", itemId: "a1", text: "ok" }],
    });
    expect(snapshot.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("cmd-1");
    expect(snapshot.turns[0]?.input[0]?.text).toBe("hello");
    const childOnly = snapshotFromMuseHistory(nativeRef, {
      items: [{ kind: "agentMessage", itemId: "a2", text: "child reply", turnId: "t-child" }],
    });
    expect(childOnly.turns[0]?.items[0]?.item).toMatchObject({
      type: "agentMessage",
      text: "child reply",
    });
    expect(
      findMuseChildSessionId(
        {
          items: [
            {
              kind: "subagent",
              itemId: "child-1",
              subagentId: "sub-1",
              childSessionId: "sess-child",
            },
          ],
        },
        "sub-1",
      ),
    ).toBe("sess-child");
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({ type: "agentMessage", text: "ok" });
    const merged = mergeMuseHistory(
      {
        items: [
          { kind: "userMessage", itemId: "u1", commandId: "cmd-1", text: "hello" },
          { kind: "toolCall", itemId: "t1", tool: "bash" },
        ],
      },
      [{ kind: "agentMessage", itemId: "a1", text: "folded answer" }],
    );
    expect(snapshotFromMuseHistory(nativeRef, merged).turns[0]?.items.at(-1)?.item).toMatchObject({
      type: "agentMessage",
      text: "folded answer",
    });
  });

  it("parses the native model catalog and permission modes", () => {
    const catalog = parseMuseModelCatalog([
      { modelId: "muse-spark-1.3-contributor", displayLabel: "Contributor", isDefault: true },
    ]);
    expect(catalog.defaultModel?.id).toBe("muse-spark-1.3-contributor");
    expect(catalog.thinkingOptions.map((option) => option.id)).toContain("high");
    expect(decodeMusePermissionModeId(harnessPermissionModeIdSchema.parse("allowAll"))).toBe(
      "allowAll",
    );
    expect(musePermissionModeForExecutionPolicy("unattended-full-access")).toBe("allowAll");
  });

  it("mints UUIDv7 command ids", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("reports notInstalled when the CLI is missing", async () => {
    const adapter = new MuseAdapter({
      command: "muse-missing-binary",
      environment: { PATH: "/missing" },
    });
    const inspection = await adapter.inspect({ cwd: process.cwd() });
    expect(inspection.status).toBe("notInstalled");
  });

  it("omits default approvalMode on session/start so serve's sealed mode applies", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    const started = hosts.at(-1)?.requests.find((request) => request.method === "session/start");
    expect(started?.params).not.toHaveProperty("approvalMode");
    await adapter.close();
  });

  it("inspects, creates, turns, snapshots, and rejects rollback", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const inspection = await adapter.inspect({ cwd: process.cwd() });
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("expected ready");
    expect(inspection.catalog.models.length).toBeGreaterThan(0);

    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const outputs: string[] = [];
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event") outputs.push(output.event.type);
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-live" } },
    });
    sessionRpc.emit({ method: "item/delta", params: { itemId: "a-live", delta: "hi" } });
    sessionRpc.emit({
      method: "item/completed",
      params: { item: { kind: "agentMessage", itemId: "a-live", text: "hi" } },
    });
    sessionRpc.emit({ method: "turn/completed", params: { terminal: "completed" } });
    await completed;
    expect(outputs).toContain("turn.started");
    expect(outputs).toContain("item.started");
    expect(outputs).toContain("turn.completed");
    const commandId = sessionRpc.lastCommandId;
    if (!commandId) throw new Error("expected Muse commandId");
    expect(completedEvent?.nativeTurnRef?.nativeTurnKey).toBe(commandId);
    expect(completedEvent?.outcome.checkpoint?.checkpointId).toBe(commandId);
    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected snapshot");
    expect(snapshot.value.turns).toHaveLength(1);
    expect(snapshot.value.turns[0]?.nativeTurnRef.nativeTurnKey).toBe(commandId);
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("expected native session identity");
    const rollback = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: nativeRef,
      cwd: process.cwd(),
    });
    expect(rollback.ok).toBe(false);
    if (!rollback.ok) expect(rollback.error.code).toBe("unsupported");
    await session.close();
    await adapter.close();
    expect(hosts.some((host) => host.closed)).toBe(true);
  });

  it("maps MSP turn/completed.terminal failed onto a failed Host outcome", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-failed"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "turn/completed",
      params: {
        terminal: "failed",
        error: {
          kind: "modelError",
          message: "model `muse-spark-1.3-contributor` does not exist or you lack access",
          retryable: false,
        },
      },
    });
    await completed;
    expect(completedEvent?.outcome.status).toBe("failed");
    if (completedEvent?.outcome.status !== "failed") throw new Error("expected failed outcome");
    expect(completedEvent.outcome.error.message).toContain("does not exist or you lack access");
    expect(completedEvent.nativeTurnRef?.nativeTurnKey).toBe(sessionRpc.lastCommandId);
    await session.close();
    await adapter.close();
  });

  it("forwards native approval choiceId and requirementId on Allow once", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let interaction: HostApprovalInteraction | undefined;
    const seen = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "interaction" && output.interaction.type === "approval") {
            interaction = output.interaction;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-approve"),
      input: [{ type: "text", text: "run a tool" }],
    });
    expect(accepted.ok).toBe(true);
    const permission = await session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("allowAll"),
    });
    expect(permission.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    expect(
      sessionRpc.requests.some(
        (request) =>
          request.method === "session/setApprovalMode" && request.params?.mode === "allowAll",
      ),
    ).toBe(true);
    sessionRpc.emit({
      method: "approval/requested",
      params: {
        approvalId: "appr-1",
        availableChoices: NATIVE_APPROVAL_CHOICES,
        currentRequirementId: { approvalId: "appr-1", sourceIndex: 0 },
        toolName: "bash",
        rawArgs: "ls",
      },
    });
    await seen;
    expect(interaction?.actions.map((action) => action.id)).toEqual([
      "choice-allow-once",
      "choice-deny",
    ]);
    const responded = await session.execute({
      type: "interaction.respond",
      interactionId: hostInteractionIdSchema.parse(interaction?.interactionId ?? ""),
      response: { type: "approval", actionId: "choice-allow-once" },
    });
    expect(responded.ok).toBe(true);
    const decide = sessionRpc.requests.find((request) => request.method === "approval/decide");
    expect(decide?.params).toMatchObject({
      approvalId: "appr-1",
      choiceId: "choice-allow-once",
      requirementId: { approvalId: "appr-1", sourceIndex: 0 },
    });
    expect(typeof decide?.params?.requirementId).toBe("object");
    await session.close();
    await adapter.close();
  });

  it("does not invent Allow once when native approval choices are missing", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const interactions: string[] = [];
    void (async () => {
      for await (const output of session.outputs) {
        if (output.kind === "interaction") interactions.push(output.interaction.type);
      }
    })();
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-skip-approval"),
      input: [{ type: "text", text: "run a tool" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "approval/requested",
      params: { approvalId: "appr-missing" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(interactions).toEqual([]);
    await session.close();
    await adapter.close();
  });

  it("maps MSP userInput questions onto Host choice questions", () => {
    const questions = mapMuseUserInputQuestions([
      {
        id: "q1",
        header: "Pick",
        question: "Which file?",
        options: [{ label: "a.ts" }, { label: "b.ts" }],
        selection: { mode: "single" },
      },
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: "q1",
      type: "choice",
      prompt: "Which file?",
      multiple: false,
    });
    if (questions[0]?.type !== "choice") throw new Error("expected choice");
    expect(questions[0].options.map((option) => option.value)).toEqual(["a.ts", "b.ts"]);
  });

  it("answers Muse userInput with selectedLabel instead of freeText", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let interaction: HostQuestionInteraction | undefined;
    const seen = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "interaction" && output.interaction.type === "question") {
            interaction = output.interaction;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-ask"),
      input: [{ type: "text", text: "ask me" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "userInput/requested",
      params: {
        userInputId: "ask-1",
        toolName: "ask",
        questions: [
          {
            id: "q1",
            header: "Pick",
            question: "Which file?",
            options: [{ label: "a.ts" }, { label: "b.ts" }],
            selection: { mode: "single" },
          },
        ],
      },
    });
    await seen;
    const responded = await session.execute({
      type: "interaction.respond",
      interactionId: hostInteractionIdSchema.parse(interaction?.interactionId ?? ""),
      response: { type: "question", answers: { q1: ["a.ts"] } },
    });
    expect(responded.ok).toBe(true);
    const answered = sessionRpc.requests.find((request) => request.method === "userInput/answer");
    expect(answered?.params?.answers).toEqual([{ questionId: "q1", selectedLabel: "a.ts" }]);
    await session.close();
    await adapter.close();
  });

  it("keeps a multi-stage approval open until Muse resolves it", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.approvalDecideTerminal = false;
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let interaction: HostApprovalInteraction | undefined;
    const closed: string[] = [];
    const seen = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "interaction" && output.interaction.type === "approval") {
            interaction = output.interaction;
            resolve();
          }
          if (output.kind === "event" && output.event.type === "interaction.closed") {
            closed.push(output.event.reason);
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-stage"),
      input: [{ type: "text", text: "run a tool" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "approval/requested",
      params: {
        approvalId: "appr-1",
        availableChoices: NATIVE_APPROVAL_CHOICES,
        currentRequirementId: { approvalId: "appr-1", sourceIndex: 0 },
        toolName: "bash",
      },
    });
    await seen;
    const responded = await session.execute({
      type: "interaction.respond",
      interactionId: hostInteractionIdSchema.parse(interaction?.interactionId ?? ""),
      response: { type: "approval", actionId: "choice-allow-once" },
    });
    expect(responded.ok).toBe(true);
    expect(closed).toEqual([]);
    sessionRpc.emit({
      method: "approval/resolved",
      params: { approvalId: "appr-1", decision: "approved" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toEqual(["responded"]);
    await session.close();
    await adapter.close();
  });

  it("does not drop Muse notifications that arrive before turn/start acks", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.emitOnTurnStart = [
          {
            method: "item/started",
            params: { item: { kind: "agentMessage", itemId: "a-early", text: "" } },
          },
          { method: "item/delta", params: { itemId: "a-early", delta: "hi" } },
          { method: "turn/completed", params: { terminal: "completed" } },
        ];
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-early"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    await completed;
    expect(completedEvent?.outcome.status).toBe("succeeded");
    expect(completedEvent?.nativeTurnRef?.nativeTurnKey).toBe(hosts.at(-1)?.lastCommandId);
    await session.close();
    await adapter.close();
  });

  it("projects Muse subagent items as Host subagentDelegation", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let startedType: string | undefined;
    const seen = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "item.started") {
            startedType = output.event.item.type;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-subagent"),
      input: [{ type: "text", text: "spawn" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: {
        item: {
          kind: "subagent",
          itemId: "child-1",
          subagentId: "sub-1",
          objective: "inspect files",
          role: "explorer",
          controlStatus: "running",
          status: "inProgress",
        },
      },
    });
    await seen;
    expect(startedType).toBe("subagentDelegation");
    const mapped = mapMuseHostItem(
      {
        kind: "subagent",
        itemId: "child-1",
        subagentId: "sub-1",
        objective: "inspect files",
        result: { summary: "done", artifactRefs: [], evidenceRefs: [] },
        status: "completed",
      },
      "child-1",
    );
    expect(mapped).toMatchObject({
      type: "subagentDelegation",
      subagents: [{ nativeSubagentId: "sub-1", status: "completed", resultSummary: "done" }],
    });
    const workflow = mapMuseHostItem(
      {
        kind: "workflow",
        itemId: "wf-1",
        message: "finished",
        children: [{ childId: "c1", label: "step", status: "completed", terminal: "completed" }],
      },
      "wf-1",
    );
    expect(workflow).toMatchObject({
      type: "subagentDelegation",
      subagents: [{ nativeSubagentId: "c1", status: "completed" }],
    });
    const recovering = mapMuseHostItem(
      {
        kind: "subagent",
        itemId: "child-2",
        subagentId: "sub-2",
        controlStatus: "recoveryPending",
        status: "failed",
        failureReason: "provider-private history is incompatible with the active route",
      },
      "child-2",
    );
    expect(recovering).toMatchObject({
      type: "subagentDelegation",
      subagents: [{ nativeSubagentId: "sub-2", status: "running" }],
    });
    expect(
      recovering && "subagents" in recovering ? recovering.subagents[0]?.resultSummary : undefined,
    ).toBeUndefined();
    const failed = mapMuseHostItem(
      {
        kind: "subagent",
        itemId: "child-3",
        subagentId: "sub-3",
        controlStatus: "closed",
        status: "failed",
        failureReason: "provider-private history is incompatible with the active route",
        result: { errorKind: "nativeFailure", artifactRefs: [], evidenceRefs: [] },
      },
      "child-3",
    );
    expect(failed).toMatchObject({
      type: "subagentDelegation",
      subagents: [
        {
          subagentId: "sub-3",
          status: "failed",
          resultSummary: "provider-private history is incompatible with the active route",
        },
      ],
    });
    expect(
      failed && "subagents" in failed ? failed.subagents[0]?.nativeSubagentId : "present",
    ).toBe(undefined);
    await session.close();
    await adapter.close();
  });

  it("resumes a recovering Muse subagent while the native parent Turn remains active", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const states: string[] = [];
    let completedEvent: TurnCompletedEvent | undefined;
    let completedItemStatus: string | undefined;
    let completedSummary: string | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "subagent.state.changed") {
            states.push(output.event.status);
          }
          if (
            output.kind === "event" &&
            output.event.type === "item.completed" &&
            output.event.snapshot.item.type === "subagentDelegation"
          ) {
            completedItemStatus = output.event.snapshot.item.subagents[0]?.status;
            completedSummary = output.event.snapshot.item.subagents[0]?.resultSummary;
          }
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-subagent-recover"),
      input: [{ type: "text", text: "spawn" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: {
        item: {
          kind: "subagent",
          itemId: "child-1",
          subagentId: "sub-1",
          objective: "inspect files",
          controlStatus: "running",
          status: "inProgress",
        },
      },
    });
    sessionRpc.emit({
      method: "item/updated",
      params: {
        item: {
          kind: "subagent",
          itemId: "child-1",
          subagentId: "sub-1",
          objective: "inspect files",
          controlStatus: "recoveryPending",
          status: "failed",
          failureReason: "reasoning replay",
        },
      },
    });
    await Promise.resolve();
    expect(sessionRpc.requests.some((request) => request.method === "subagent/resume")).toBe(true);
    expect(completedEvent).toBeUndefined();
    sessionRpc.emit({
      method: "item/completed",
      params: {
        item: {
          kind: "subagent",
          itemId: "child-1",
          subagentId: "sub-1",
          childSessionId: "muse-child-session",
          objective: "inspect files",
          controlStatus: "resultReady",
          status: "completed",
          result: { summary: "read execute()", artifactRefs: [], evidenceRefs: [] },
        },
      },
    });
    sessionRpc.emit({ method: "turn/completed", params: { terminal: "completed" } });
    await completed;
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("completed");
    expect(completedItemStatus).toBe("completed");
    expect(completedSummary).toBe("read execute()");
    expect(completedEvent?.outcome.status).toBe("succeeded");
    await session.close();
    await adapter.close();
  });

  it("replays dropped view/gap events from view/page", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.viewPageEvents = [
          {
            method: "item/started",
            params: {
              item: { kind: "agentMessage", itemId: "gap-agent" },
              viewCursor: "c3",
            },
          },
          {
            method: "item/delta",
            params: { itemId: "gap-agent", delta: "recovered", viewCursor: "c4" },
          },
        ];
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const recovered: string[] = [];
    const seen = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event") recovered.push(output.event.type);
          if (output.kind === "event" && output.event.type === "item.updated") resolve();
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-gap"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "view/gap",
      params: { after: "c1", next: "c9", sessionId: sessionRpc.sessionId },
    });
    await seen;
    expect(recovered).toEqual(expect.arrayContaining(["item.started", "item.updated"]));
    expect(
      sessionRpc.requests.some(
        (request) =>
          request.method === "view/page" &&
          request.params?.cursor === "c1" &&
          request.params?.direction === "forward",
      ),
    ).toBe(true);
    await session.close();
    await adapter.close();
  });

  it("reads a Muse child session transcript through subagents.readSnapshot", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.sessionHistories.set("muse-session-1", {
          items: [
            {
              kind: "subagent",
              itemId: "i1",
              subagentId: "sub-1",
              childSessionId: "sess-child",
            },
          ],
        });
        rpc.sessionHistories.set("sess-child", {
          items: [
            { kind: "userMessage", itemId: "u1", commandId: "c1", text: "inspect" },
            { kind: "agentMessage", itemId: "a1", text: "child done" },
          ],
        });
        hosts.push(rpc);
        return rpc;
      },
    });
    const snapshot = await adapter.subagents.readSnapshot({
      parent: nativeSessionRefSchema.parse({
        harnessId: "muse",
        nativeSessionId: "muse-session-1",
        formatVersion: 1,
      }),
      nativeSubagentId: "sub-1",
      cwd: process.cwd(),
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected child snapshot");
    expect(snapshot.value.turns[0]?.input[0]?.text).toBe("inspect");
    expect(snapshot.value.turns[0]?.items[0]?.item).toMatchObject({
      type: "agentMessage",
      text: "child done",
    });
    await adapter.close();
  });

  it("does not drop turn.completed after a duplicate item/started", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-dup"),
      input: [{ type: "text", text: "hello" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-dup" }, viewCursor: "c-start" },
    });
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-dup" }, viewCursor: "c-start-dup" },
    });
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-dup" }, viewCursor: "c-start" },
    });
    sessionRpc.emit({
      method: "turn/completed",
      params: { terminal: "completed", viewCursor: "c-end" },
    });
    await completed;
    expect(completedEvent?.outcome.status).toBe("succeeded");
    await session.close();
    await adapter.close();
  });

  it("merges view/page agentMessage into snapshots when session/read omits it", async () => {
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.sessionHistories.set("muse-session-1", {
          items: [
            { kind: "userMessage", itemId: "u1", commandId: "c1", text: "hello" },
            { kind: "toolCall", itemId: "t1", tool: "bash", status: "completed" },
          ],
        });
        rpc.viewPageEvents = [
          {
            method: "item/completed",
            params: { item: { kind: "agentMessage", itemId: "a1", text: "from page" } },
          },
        ];
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const snapshot = await opened.value.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected snapshot");
    expect(snapshot.value.turns[0]?.items.at(-1)?.item).toMatchObject({
      type: "agentMessage",
      text: "from page",
    });
    await opened.value.close();
    await adapter.close();
  });

  it("keeps a native Turn active after a failed cancel", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        rpc.cancelThrows = true;
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const texts: string[] = [];
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "item.updated") {
            const update = output.event.update;
            if (update.type === "text.append") texts.push(update.text);
          }
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-hello"),
      input: [{ type: "text", text: "你好" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-hi", text: "" } },
    });
    sessionRpc.emit({ method: "item/delta", params: { itemId: "a-hi", delta: "你好" } });
    const cancelled = await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-hello"),
    });
    expect(cancelled.ok).toBe(false);
    expect(completedEvent).toBeUndefined();
    sessionRpc.emit({ method: "turn/completed", params: { terminal: "completed" } });
    await completed;
    expect(texts.join("")).toBe("你好");
    expect(completedEvent?.outcome.status).toBe("succeeded");
    await session.close();
    await adapter.close();
  });

  it("keeps streamed agent text when native completion snapshot is shorter", async () => {
    const hosts: FakeMuseRpc[] = [];
    const adapter = new MuseAdapter({
      command: process.execPath,
      environment: process.env,
      createRpc: async () => {
        const rpc = new FakeMuseRpc();
        hosts.push(rpc);
        return rpc;
      },
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected session");
    const session = opened.value;
    const texts: string[] = [];
    let completedText = "";
    let completedEvent: TurnCompletedEvent | undefined;
    const completed = new Promise<void>((resolve) => {
      void (async () => {
        for await (const output of session.outputs) {
          if (output.kind === "event" && output.event.type === "item.updated") {
            const update = output.event.update;
            if (update.type === "text.append") texts.push(update.text);
          }
          if (output.kind === "event" && output.event.type === "item.completed") {
            const item = output.event.snapshot.item;
            if (item.type === "agentMessage") completedText = item.text;
          }
          if (output.kind === "event" && output.event.type === "turn.completed") {
            completedEvent = output.event;
            resolve();
          }
        }
      })();
    });
    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-hello"),
      input: [{ type: "text", text: "你好" }],
    });
    expect(accepted.ok).toBe(true);
    const sessionRpc = hosts.at(-1);
    if (!sessionRpc) throw new Error("expected session rpc");
    sessionRpc.emit({
      method: "item/started",
      params: { item: { kind: "agentMessage", itemId: "a-hi", text: "" } },
    });
    sessionRpc.emit({ method: "item/delta", params: { itemId: "a-hi", delta: "你好" } });
    sessionRpc.emit({ method: "item/delta", params: { itemId: "a-hi", delta: "！" } });
    sessionRpc.emit({
      method: "item/completed",
      params: { item: { kind: "agentMessage", itemId: "a-hi", text: "你好" } },
    });
    sessionRpc.emit({ method: "turn/completed", params: { terminal: "completed" } });
    await completed;
    expect(texts.join("")).toBe("你好！");
    expect(completedText).toBe("你好！");
    expect(completedEvent?.outcome.status).toBe("succeeded");
    await session.close();
    await adapter.close();
  });
});
