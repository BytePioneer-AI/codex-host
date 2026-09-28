import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import {
  HarnessOutputChannel,
  type HarnessSession,
  type HarnessOutput,
  type HarnessResult,
  type HostCommand,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnCancelCommand,
  type TurnCancelAccepted,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type HostEvent,
  type HostItem,
  type HostTurnSnapshot,
  type HostItemSnapshot,
  type HarnessExecutionPolicy,
  type HarnessCommandCapability,
  type HarnessError,
  type HarnessSessionCapabilities,
} from "@codexhost/harness-adapter";
import type { HarnessModelCatalog, HostTurnId } from "@codexhost/shared-contracts";
import { decodeOpenCodeModelRef, decodeOpenCodeVariant } from "../model-catalog.js";
import { openCodeCommandCatalog } from "../opencode-adapter.js";
import type { V2Connection } from "./connection.js";
import { contentId, readHistory, terminalItemOutcome } from "./history.js";
import { errorResult, failure, harnessId, v2Permissions, v2State, v2Usage } from "./state.js";
import {
  formInteraction,
  permissionInteraction,
  replyInteraction,
  type V2Interaction,
} from "./interactions.js";

interface ActiveTurn {
  turnId: HostTurnId;
  admitted: boolean;
  compact: boolean;
  baseline: Set<string>;
  live: Map<string, HostItem>;
  assistants: Set<string>;
  transient: Map<string, Extract<HostItem, { type: "agentMessage" | "reasoning" }>>;
  interactions: Map<string, V2Interaction>;
  replying: Set<string>;
  settledInteractions: Set<string>;
  done: Promise<void>;
  resolve(): void;
}

export function v2Capabilities(catalog: HarnessModelCatalog): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: catalog.models.length > 0,
      selectThinkingOption: catalog.thinkingOptions.length > 1,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
  };
}

export class V2Session implements HarnessSession {
  readonly harnessId = harnessId;
  readonly capabilities;
  readonly initialState;
  readonly initialUsage;
  readonly commands: HarnessCommandCapability;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #abort = new AbortController();
  #active: ActiveTurn | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #pump: Promise<void> | undefined;
  #reconciling: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #configuring = false;

  constructor(
    readonly client: OpenCodeClient,
    readonly connection: Pick<V2Connection, "options" | "close">,
    private info: SessionInfo,
    readonly catalog: HarnessModelCatalog,
    readonly policy: HarnessExecutionPolicy,
    readonly limit: number,
    readonly onClosed: () => void,
  ) {
    this.initialState = v2State(info, catalog, policy);
    this.initialUsage = v2Usage(info);
    this.capabilities = v2Capabilities(catalog);
    this.commands = {
      list: async () => ({ ok: true, value: openCodeCommandCatalog }),
      execute: async (command) => {
        if (command.commandId !== "opencode.compact" || Object.keys(command.arguments ?? {}).length)
          return { ok: false, error: failure("Unsupported OpenCode command", "unsupported") };
        return this.#start({ type: "turn.start", turnId: command.turnId, input: [] }, true);
      },
    };
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("OpenCode v2 event subscription timed out")),
        this.connection.options.startupTimeoutMs ?? 20_000,
      );
      this.#pump = (async () => {
        try {
          for await (const event of this.client.event.subscribe({ signal: this.#abort.signal })) {
            if (this.#abort.signal.aborted) break;
            if (event.type === "server.connected") {
              clearTimeout(timer);
              resolve();
            }
            this.#onEvent(event);
          }
          if (!this.#abort.signal.aborted) throw new Error("OpenCode v2 event stream disconnected");
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          if (!this.#closed)
            await this.#fault(
              failure(error instanceof Error ? error.message : String(error), "processExited"),
            );
        }
      })();
    });
    this.#timer = setInterval(() => {
      void this.#refresh();
    }, 400);
  }

  async readSnapshot() {
    if (this.#closed)
      return { ok: false as const, error: failure("OpenCode Session is closed", "invalidState") };
    if (this.#active || this.#configuring)
      return { ok: false as const, error: failure("OpenCode Session is busy", "sessionBusy") };
    try {
      this.info = await this.client.session.get({ sessionID: this.info.id });
      const { snapshot } = await readHistory(this.client, this.info, this.limit);
      return {
        ok: true as const,
        value: { ...snapshot, state: v2State(this.info, this.catalog, this.policy) },
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted | ModelSelectCompleted
    >
  > {
    if (this.#closed)
      return { ok: false, error: failure("OpenCode Session is closed", "invalidState") };
    if (command.type === "turn.start") return this.#start(command, false);
    if (command.type === "turn.cancel") {
      const active = this.#active;
      if (!active?.admitted || active.turnId !== command.turnId)
        return { ok: false, error: failure("No matching OpenCode Turn", "invalidState") };
      try {
        await this.client.session.interrupt({ sessionID: this.info.id, resume: false });
        // Only the durable idle record finishes the Turn, never this HTTP acknowledgement.
        await this.#refresh();
        return { ok: true, value: { cancellationRequested: true } };
      } catch (error) {
        return errorResult(error);
      }
    }
    if (command.type === "interaction.respond") {
      const active = this.#active;
      const pending = active?.interactions.get(command.interactionId);
      if (!active || !pending || active.replying.has(command.interactionId))
        return {
          ok: false,
          error: failure("OpenCode interaction is no longer pending", "invalidState"),
        };
      active.replying.add(command.interactionId);
      try {
        await replyInteraction(this.client, pending, command);
        this.#closeInteraction(
          active,
          command.interactionId,
          command.response.type === "question" && command.response.cancelled
            ? "cancelled"
            : "responded",
        );
        return { ok: true, value: { accepted: true } };
      } catch (error) {
        return errorResult(error);
      } finally {
        active.replying.delete(command.interactionId);
      }
    }
    if (this.#active || this.#configuring)
      return { ok: false, error: failure("OpenCode Session is busy", "sessionBusy") };
    this.#configuring = true;
    try {
      if ((await this.client.session.active())[this.info.id])
        throw new Error("OpenCode Session is running");
      if (command.type === "permissionMode.select") {
        await this.client.session.update({
          sessionID: this.info.id,
          permissions: v2Permissions(this.info.permissions, command.permissionModeId),
        });
      } else {
        let model = this.info.model;
        if (command.type === "model.select") {
          if (!this.catalog.models.some((m) => m.ref.id === command.model.id))
            throw new Error("OpenCode Model is not available");
          const decoded = decodeOpenCodeModelRef(command.model);
          model = { providerID: decoded.providerID, id: decoded.modelID };
        } else {
          if (!model) throw new Error("Select a Model before a Thinking option");
          const state = v2State(this.info, this.catalog, this.policy);
          if (!state.availableThinkingOptions?.some((v) => v.id === command.thinkingOptionId))
            throw new Error("Thinking option is unavailable for this Model");
          const variant = decodeOpenCodeVariant(command.thinkingOptionId);
          model = { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) };
        }
        await this.client.session.switchModel({ sessionID: this.info.id, model });
      }
      this.info = await this.client.session.get({ sessionID: this.info.id });
      this.#emit({
        type: "session.state.changed",
        state: v2State(this.info, this.catalog, this.policy),
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      return errorResult(error);
    } finally {
      this.#configuring = false;
    }
  }

  async #start(
    command: TurnStartCommand,
    compact: boolean,
  ): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#closed || this.#active || this.#configuring)
      return {
        ok: false,
        error: failure(
          "OpenCode Session is closed or busy",
          this.#closed ? "invalidState" : "sessionBusy",
        ),
      };
    if (!compact && !command.input.some((p) => p.text.trim()))
      return { ok: false, error: failure("OpenCode requires text input", "invalidRequest") };
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const active: ActiveTurn = {
      turnId: command.turnId,
      compact,
      admitted: false,
      baseline: new Set(),
      live: new Map(),
      assistants: new Set(),
      transient: new Map(),
      interactions: new Map(),
      replying: new Set(),
      settledInteractions: new Set(),
      done,
      resolve,
    };
    this.#active = active;
    let attempted = false;
    try {
      if ((await this.client.session.active())[this.info.id])
        throw new Error("OpenCode Session is already running");
      this.info = await this.client.session.get({ sessionID: this.info.id });
      const before = await readHistory(this.client, this.info, this.limit);
      if (before.snapshot.turns.some((turn) => turn.outcome.status === "unknown"))
        throw new Error("OpenCode history contains an incomplete execution");
      active.baseline = new Set(before.snapshot.turns.map((t) => t.nativeTurnRef.nativeTurnKey));
      attempted = true;
      if (compact) await this.client.session.compact({ sessionID: this.info.id });
      else
        await this.client.session.prompt({
          sessionID: this.info.id,
          text: command.input.map((p) => p.text).join("\n"),
          delivery: "queue",
          metadata: { "codexhost.turnId": active.turnId },
        });
      if (this.#closed) {
        await this.client.session.interrupt({ sessionID: this.info.id, resume: false });
        throw new Error("OpenCode Session closed during admission");
      }
      active.admitted = true;
      this.#emit({ type: "turn.started", turnId: active.turnId });
      for (const item of active.transient.values())
        this.#projectItem(active, { item, outcome: { status: "succeeded" } }, false);
      void this.#refresh();
      return { ok: true, value: { turnId: active.turnId } };
    } catch (error) {
      // A lost admission response must not leave native work running after a rejected Host command.
      if (attempted)
        await this.client.session
          .interrupt({ sessionID: this.info.id, resume: false })
          .catch((interruptError: unknown) => this.#fault(errorResult(interruptError).error));
      if (this.#active === active) this.#active = undefined;
      active.resolve();
      return errorResult(error);
    }
  }

  #onEvent(event: OpenCodeEvent) {
    const active = this.#active;
    if (
      !active ||
      !("data" in event) ||
      !("sessionID" in event.data) ||
      event.data.sessionID !== this.info.id
    )
      return;
    if (event.type === "session.step.started") active.assistants.add(event.data.assistantMessageID);
    if (
      (event.type === "session.text.delta" || event.type === "session.reasoning.delta") &&
      active.assistants.has(event.data.assistantMessageID)
    ) {
      const itemId = contentId(event.data.assistantMessageID, event.data.ordinal);
      const type = event.type === "session.text.delta" ? "agentMessage" : "reasoning";
      const previous = active.transient.get(itemId);
      const item: Extract<HostItem, { type: "agentMessage" | "reasoning" }> = {
        type,
        itemId,
        text: (previous?.text ?? "") + event.data.delta,
      };
      active.transient.set(itemId, item);
      if (active.admitted)
        this.#projectItem(active, { item, outcome: { status: "succeeded" } }, false);
    }
    // Read the durable projection for tool state and terminals, including events missed during admission.
    if (!event.type.endsWith(".delta")) void this.#refresh();
  }

  #refresh(): Promise<void> {
    if (this.#closed || !this.#active?.admitted) return Promise.resolve();
    return (this.#reconciling ??= this.#reconcile()
      .catch(async (error) => {
        await this.#fault(
          failure(error instanceof Error ? error.message : String(error), "protocolError"),
        );
      })
      .finally(() => {
        this.#reconciling = undefined;
      }));
  }

  async #reconcile() {
    const active = this.#active;
    if (!active?.admitted) return;
    const info = await this.client.session.get({ sessionID: this.info.id });
    const { snapshot, messages } = await readHistory(this.client, info, this.limit);
    if (this.#active !== active || this.#closed) return;
    this.info = info;
    const turns = snapshot.turns.filter((t) => !active.baseline.has(t.nativeTurnRef.nativeTurnKey));
    if (turns.length > 1)
      throw new Error("Concurrent native prompts cannot be assigned to one Host Turn");
    const turn = turns[0];
    if (turn) {
      const prompt = messages.find((message) => message.id === turn.nativeTurnRef.nativeTurnKey);
      if (
        active.compact
          ? turn.input.length !== 0
          : prompt?.type !== "user" ||
            prompt.metadata?.["codexhost.turnId"] !== active.turnId ||
            turn.input.length !== 1
      )
        throw new Error("Concurrent native input cannot be assigned to this Host Turn");
      const terminal = turn.outcome.status !== "unknown";
      for (const item of turn.items)
        this.#projectItem(
          active,
          item,
          terminal,
          turn.outcome.status === "cancelled" || turn.outcome.status === "failed",
        );
      if (terminal) {
        // A durable idle closes the execution; reject a racing external writer instead of stealing its work.
        if ((await this.client.session.active())[info.id]) return;
        if (this.#active === active) this.#finish(active, turn);
        return;
      }
    }
    const [permissions, forms] = await Promise.all([
      this.client.permission.list({ sessionID: info.id }),
      this.client.session.form.list({ sessionID: info.id }),
    ]);
    if (this.#active !== active || this.#closed) return;
    const current = new Map<string, V2Interaction>();
    for (const request of permissions) {
      const pending = permissionInteraction(request, active.turnId);
      current.set(pending.interaction.interactionId, pending);
    }
    for (const form of forms) {
      const pending = formInteraction(form, active.turnId);
      current.set(pending.interaction.interactionId, pending);
    }
    for (const [id, pending] of current)
      if (!active.interactions.has(id) && !active.settledInteractions.has(id)) {
        active.interactions.set(id, pending);
        this.#channel.emit({ kind: "interaction", interaction: pending.interaction });
      }
    for (const id of active.interactions.keys())
      if (!current.has(id) && !active.replying.has(id))
        this.#closeInteraction(active, id, "expired");
  }

  #projectItem(
    active: ActiveTurn,
    snapshot: HostItemSnapshot,
    terminal: boolean,
    interrupted = false,
  ) {
    const item = snapshot.item;
    const old = active.live.get(item.itemId);
    if (!old) {
      active.live.set(item.itemId, item);
      this.#emit({ type: "item.started", turnId: active.turnId, item });
      return;
    }
    if ((item.type === "agentMessage" || item.type === "reasoning") && "text" in old) {
      if (old.text.startsWith(item.text) && !terminal) return; // Durable text can trail transient deltas.
      if (terminal && interrupted && old.text.startsWith(item.text)) {
        // v2 deltas are transient; an interrupted text block may never receive text.ended.
        // Complete with the native durable value, which is also what cold history will show.
        active.live.set(item.itemId, item);
        return;
      }
      if (!item.text.startsWith(old.text))
        throw new Error("OpenCode v2 streamed text differs from durable history");
      const delta = item.text.slice(old.text.length);
      if (delta)
        this.#emit({
          type: "item.updated",
          turnId: active.turnId,
          itemId: item.itemId,
          update: { type: "text.append", text: delta },
        });
    } else if (
      item.type === "toolExecution" &&
      item.output &&
      JSON.stringify(item) !== JSON.stringify(old)
    ) {
      this.#emit({
        type: "item.updated",
        turnId: active.turnId,
        itemId: item.itemId,
        update: { type: "output.replace", output: item.output },
      });
    }
    active.live.set(item.itemId, item);
  }

  #finish(active: ActiveTurn, turn: HostTurnSnapshot) {
    if (this.#active !== active || turn.outcome.status === "unknown") return;
    for (const id of active.interactions.keys()) this.#closeInteraction(active, id, "cancelled");
    for (const [id, item] of active.live) {
      const snapshot = turn.items.find((entry) => entry.item.itemId === id) ?? {
        item,
        outcome: terminalItemOutcome(turn.outcome),
      };
      this.#emit({ type: "item.completed", turnId: active.turnId, snapshot });
    }
    this.#emit({
      type: "session.state.changed",
      state: v2State(this.info, this.catalog, this.policy),
    });
    this.#emit({
      type: "session.usage.changed",
      usage: v2Usage(this.info),
      observedForTurnId: active.turnId,
    });
    this.#active = undefined;
    this.#emit({
      type: "turn.completed",
      turnId: active.turnId,
      nativeTurnRef: turn.nativeTurnRef,
      outcome: { ...turn.outcome, ...(turn.checkpoint ? { checkpoint: turn.checkpoint } : {}) },
    });
    active.resolve();
  }

  #closeInteraction(active: ActiveTurn, id: string, reason: "responded" | "cancelled" | "expired") {
    const pending = active.interactions.get(id);
    if (!pending) return;
    active.interactions.delete(id);
    active.settledInteractions.add(id);
    this.#emit({
      type: "interaction.closed",
      interactionId: pending.interaction.interactionId,
      turnId: active.turnId,
      reason,
    });
  }
  #emit(event: HostEvent) {
    this.#channel.emit({ kind: "event", event });
  }

  async #fault(error: HarnessError) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#abort.abort();
    const active = this.#active;
    if (active?.admitted) {
      for (const id of active.interactions.keys()) this.#closeInteraction(active, id, "cancelled");
      for (const item of active.live.values())
        this.#emit({
          type: "item.completed",
          turnId: active.turnId,
          snapshot: { item, outcome: { status: "failed", error } },
        });
      this.#emit({
        type: "turn.completed",
        turnId: active.turnId,
        outcome: { status: "failed", error },
      });
    }
    this.#active = undefined;
    active?.resolve();
    this.#emit({ type: "session.faulted", error });
    this.#channel.end();
    await this.client.session
      .interrupt({ sessionID: this.info.id, resume: false })
      .catch(() => undefined);
    await this.connection.close();
    this.onClosed();
  }

  close(): Promise<void> {
    return (this.#closePromise ??= (async () => {
      const active = this.#active;
      if (active?.admitted && !this.#closed) {
        await this.client.session
          .interrupt({ sessionID: this.info.id, resume: false })
          .catch(() => undefined);
        await this.#refresh();
        if (this.#active) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            active.done,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, this.connection.options.closeTimeoutMs ?? 3000);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
        }
        if (this.#active)
          await this.#fault(
            failure(
              "OpenCode Session closed before native completion was confirmed",
              "processExited",
            ),
          );
      }
      this.#closed = true;
      if (this.#timer) clearInterval(this.#timer);
      this.#abort.abort();
      await this.connection.close();
      await this.#pump;
      this.#channel.end();
      this.onClosed();
    })());
  }
}
