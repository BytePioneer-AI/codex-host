import { harnessIdSchema, hostItemIdSchema } from "@codexhost/shared-contracts";
import type { HarnessId, HostItemId } from "@codexhost/shared-contracts";

import { HarnessOutputChannel } from "./output-channel.js";
import type {
  CreateSessionInput,
  HarnessAdapter,
  HarnessError,
  HarnessOutput,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostAgentMessageItem,
  HostCommand,
  TurnStartAccepted,
} from "./text-session.js";

interface ActiveFakeTurn {
  command: HostCommand;
  item: HostAgentMessageItem;
}

const invalidStateError: HarnessError = {
  code: "invalidState",
  message: "Fake Harness Session is closed",
  retryable: false,
};

export class FakeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly initialState: HarnessSessionState = {};
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  #active: ActiveFakeTurn | null = null;
  #closed = false;
  #itemOrdinal = 0;
  #nextRejection: HarnessError | null = null;

  constructor(harnessId: HarnessId) {
    this.harnessId = harnessId;
    this.outputs = this.#channel.outputs;
  }

  rejectNextTurn(error: HarnessError): void {
    this.#nextRejection = error;
  }

  async execute(command: HostCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#closed) return { ok: false, error: invalidStateError };
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
    this.#active = { command, item };
    this.#event({ type: "turn.started", turnId: command.turnId });
    this.#event({ type: "item.started", turnId: command.turnId, item });
    return { ok: true, value: { turnId: command.turnId } };
  }

  appendText(text: string): void {
    const active = this.#requireActive();
    active.item = { ...active.item, text: active.item.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.item.itemId,
      update: { type: "text.append", text },
    });
  }

  succeedTurn(): void {
    const active = this.#requireActive();
    this.#active = null;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome: { status: "succeeded" } },
    });
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome: { status: "succeeded" },
    });
  }

  failTurn(error: HarnessError): void {
    const active = this.#requireActive();
    this.#active = null;
    this.#event({
      type: "item.completed",
      turnId: active.command.turnId,
      snapshot: { item: active.item, outcome: { status: "failed", error } },
    });
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome: { status: "failed", error },
    });
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
  readonly sessions: FakeHarnessSession[] = [];
  #closePromise: Promise<void> | null = null;

  constructor(harnessId: HarnessId = harnessIdSchema.parse("fake")) {
    this.harnessId = harnessId;
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
    const session = new FakeHarnessSession(this.harnessId);
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
