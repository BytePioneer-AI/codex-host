import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  hostItemIdSchema,
} from "@codexhost/shared-contracts";
import type {
  HarnessId,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessModelRef,
  HostItemId,
  JsonValue,
} from "@codexhost/shared-contracts";

import { HarnessOutputChannel } from "./output-channel.js";
import type {
  CreateSessionInput,
  HarnessAdapter,
  HarnessError,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  InspectHarnessInput,
  HostAgentMessageItem,
  HostCommand,
  HostCommandExecutionItem,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemUpdate,
  HostToolExecutionItem,
  HostToolOutput,
  ModelSelectCommand,
  ModelSelectCompleted,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnStartAccepted,
  TurnStartCommand,
} from "./text-session.js";

interface ActiveFakeTurn {
  command: TurnStartCommand;
  items: Map<HostItemId, HostItem>;
  cancellationRequested: boolean;
}

const invalidStateError: HarnessError = {
  code: "invalidState",
  message: "Fake Harness Session is closed",
  retryable: false,
};

const defaultFakeCatalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: { id: "fake-model-v1.primary" }, label: "Fake Primary" },
    { ref: { id: "fake-model-v1.secondary" }, label: "Fake Secondary" },
  ],
  defaultModel: { id: "fake-model-v1.primary" },
});

function catalogHasModel(catalog: HarnessModelCatalog, model: HarnessModelRef): boolean {
  return catalog.models.some((candidate) => candidate.ref.id === model.id);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

export class FakeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities = {
    configuration: { selectModel: true },
  };
  readonly initialState: HarnessSessionState;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #catalog: HarnessModelCatalog;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  #active: ActiveFakeTurn | null = null;
  #closed = false;
  #completeCancellationDuringRequest = false;
  #itemOrdinal = 0;
  #nextModelRejection: HarnessError | null = null;
  #nextRejection: HarnessError | null = null;
  #state: HarnessSessionState;

  constructor(
    harnessId: HarnessId,
    catalog: HarnessModelCatalog = defaultFakeCatalog,
    initialModel: HarnessModelRef | undefined = catalog.defaultModel,
  ) {
    this.harnessId = harnessId;
    this.#catalog = catalog;
    this.initialState = initialModel ? { effectiveModel: initialModel } : {};
    this.#state = this.initialState;
    this.outputs = this.#channel.outputs;
  }

  get state(): HarnessSessionState {
    return this.#state;
  }

  rejectNextTurn(error: HarnessError): void {
    this.#nextRejection = error;
  }

  rejectNextModelSelection(error: HarnessError): void {
    this.#nextModelRejection = error;
  }

  completeCancellationOnRequest(): void {
    this.#completeCancellationDuringRequest = true;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<HarnessResult<TurnStartAccepted | TurnCancelAccepted | ModelSelectCompleted>> {
    if (this.#closed) return { ok: false, error: invalidStateError };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (this.#nextRejection) {
      const error = this.#nextRejection;
      this.#nextRejection = null;
      return { ok: false, error };
    }
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session already has an active Turn",
          retryable: true,
        },
      };
    }
    const text = command.input.map((input) => input.text).join("\n");
    if (text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Text Turn input must not be empty",
          retryable: false,
        },
      };
    }
    const item: HostAgentMessageItem = {
      type: "agentMessage",
      itemId: this.#nextItemId(),
      text: "",
    };
    this.#active = {
      command,
      items: new Map([[item.itemId, item]]),
      cancellationRequested: false,
    };
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    return { ok: true, value: { turnId: command.turnId } };
  }

  appendText(text: string): void {
    const active = this.#requireActive();
    const item = [...active.items.values()].find(
      (candidate): candidate is HostAgentMessageItem => candidate.type === "agentMessage",
    );
    if (!item) throw new Error("Fake Harness Session has no Agent Message Item");
    const updated = { ...item, text: item.text + text };
    active.items.set(item.itemId, updated);
    this.#updateItem(item.itemId, { type: "text.append", text });
  }

  startCommandExecution(command: string, cwd?: string): HostItemId {
    const item: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: this.#nextItemId(),
      command,
      ...(cwd ? { cwd } : {}),
    };
    this.#startItem(item);
    return item.itemId;
  }

  appendCommandOutput(itemId: HostItemId, text: string): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "commandExecution") {
      throw new Error("Fake Harness Item is not a Command Execution");
    }
    active.items.set(itemId, { ...item, output: (item.output ?? "") + text });
    this.#updateItem(itemId, { type: "output.append", text });
  }

  startToolExecution(toolName: string, arguments_: JsonValue, namespace?: string): HostItemId {
    const item: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: this.#nextItemId(),
      toolName,
      arguments: arguments_,
      ...(namespace ? { namespace } : {}),
    };
    this.#startItem(item);
    return item.itemId;
  }

  replaceToolOutput(itemId: HostItemId, output: HostToolOutput): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (item?.type !== "toolExecution") {
      throw new Error("Fake Harness Item is not a Generic Tool");
    }
    active.items.set(itemId, { ...item, output });
    this.#updateItem(itemId, { type: "output.replace", output });
  }

  completeItem(itemId: HostItemId, outcome: HostItemOutcome): void {
    const active = this.#requireActive();
    const item = active.items.get(itemId);
    if (!item) throw new Error("Fake Harness Item is not active");
    active.items.delete(itemId);
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item, outcome },
    });
  }

  emitFileChange(changes: HostFileChange[]): HostItemId {
    const itemId = this.#nextItemId();
    this.#startItem({ type: "fileChange", itemId, changes });
    this.completeItem(itemId, { status: "succeeded" });
    return itemId;
  }

  succeedTurn(): void {
    const active = this.#requireActive();
    const unfinishedTools = [...active.items.values()].filter(
      (item) => item.type !== "agentMessage",
    );
    if (unfinishedTools.length > 0) {
      throw new Error("Fake Harness Session cannot succeed with active Tool Items");
    }
    this.#completeItems(active, { status: "succeeded" });
    this.#finishTurn(active, { status: "succeeded" });
  }

  completeCancellation(reason = "Cancelled by user"): void {
    const active = this.#requireActive();
    if (!active.cancellationRequested) {
      throw new Error("Fake Harness Turn has no cancellation request");
    }
    const outcome = { status: "cancelled" as const, reason };
    this.#completeItems(active, outcome);
    this.#finishTurn(active, outcome);
  }

  failTurn(error: HarnessError): void {
    const active = this.#requireActive();
    const outcome = { status: "failed" as const, error };
    this.#completeItems(active, outcome);
    this.#finishTurn(active, outcome);
  }

  fault(error: HarnessError): void {
    if (this.#active) this.failTurn(error);
    this.#closed = true;
    this.#event({ type: "session.faulted", error });
    this.#channel.end();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#active) this.failTurn(invalidStateError);
    this.#closed = true;
    this.#channel.end();
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Fake Harness Session cannot select a Model during an active Turn",
          retryable: true,
        },
      };
    }
    if (this.#nextModelRejection) {
      const error = this.#nextModelRejection;
      this.#nextModelRejection = null;
      return { ok: false, error };
    }
    if (!catalogHasModel(this.#catalog, command.model)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Harness Model Ref is not in the current catalog",
          retryable: false,
        },
      };
    }
    this.#state = { ...this.#state, effectiveModel: command.model };
    this.#event({ type: "session.state.changed", state: this.#state });
    return { ok: true, value: { completed: true } };
  }

  #cancel(command: TurnCancelCommand): HarnessResult<TurnCancelAccepted> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("Turn Cancel must reference the active Turn") };
    }
    active.cancellationRequested = true;
    if (this.#completeCancellationDuringRequest) {
      this.#completeCancellationDuringRequest = false;
      this.completeCancellation();
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  #startItem(item: HostItem): void {
    const active = this.#requireActive();
    active.items.set(item.itemId, item);
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
  }

  #updateItem(itemId: HostItemId, update: HostItemUpdate): void {
    const active = this.#requireActive();
    this.#event({ type: "item.updated", turnId: active.command.turnId, itemId, update });
  }

  #completeItems(active: ActiveFakeTurn, outcome: HostItemOutcome): void {
    for (const item of [...active.items.values()].reverse()) {
      active.items.delete(item.itemId);
      this.#event({
        type: "item.completed",
        turnId: active.command.turnId,
        snapshot: { item, outcome },
      });
    }
  }

  #finishTurn(active: ActiveFakeTurn, outcome: HostItemOutcome): void {
    if (this.#active !== active) return;
    this.#active = null;
    this.#event({ type: "turn.completed", turnId: active.command.turnId, outcome });
  }

  #event(event: HarnessOutput["event"]): void {
    this.#channel.emit({ kind: "event", event });
  }

  #nextItemId(): HostItemId {
    this.#itemOrdinal += 1;
    return hostItemIdSchema.parse(`fake-item-${this.#itemOrdinal}`);
  }

  #requireActive(): ActiveFakeTurn {
    if (!this.#active) throw new Error("Fake Harness Session has no active Turn");
    return this.#active;
  }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly catalog: HarnessModelCatalog;
  readonly sessions: FakeHarnessSession[] = [];
  inspectionCalls = 0;
  #closePromise: Promise<void> | null = null;

  constructor(
    harnessId: HarnessId = harnessIdSchema.parse("fake"),
    catalog: HarnessModelCatalog = defaultFakeCatalog,
  ) {
    this.harnessId = harnessId;
    this.catalog = catalog;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    void input;
    this.inspectionCalls += 1;
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: {
          code: "invalidState",
          message: "Fake Harness Adapter is closed",
          retryable: false,
        },
      };
    }
    return {
      status: "ready",
      catalog: this.catalog,
      capabilities: { configuration: { selectModel: true } },
    };
  }

  async open(input: CreateSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closePromise) return { ok: false, error: invalidStateError };
    if (input.kind !== "create" || input.cwd.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Adapter requires a create input with cwd",
          retryable: false,
        },
      };
    }
    if (input.model && !catalogHasModel(this.catalog, input.model)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Fake Adapter create Model is not in the current catalog",
          retryable: false,
        },
      };
    }
    const session = new FakeHarnessSession(this.harnessId, this.catalog, input.model);
    this.sessions.push(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = Promise.all(this.sessions.map((session) => session.close())).then(
        () => undefined,
      );
    }
    return this.#closePromise;
  }
}
