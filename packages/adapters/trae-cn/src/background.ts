import type { HostTurnId } from "@codexhost/shared-contracts";
import {
  readCommandStatus,
  type NativeBackgroundCommand,
  type NativeCommandStatus,
} from "./commands.js";
import { record, TraeError } from "./errors.js";

interface FollowedCommand {
  ref: NativeBackgroundCommand;
  turnId: HostTurnId;
  active: boolean;
  update(status: NativeCommandStatus): void;
}

/** Follows only commands admitted by this observation scope; never sends model input. */
export class BackgroundCommands {
  #commands = new Map<string, FollowedCommand>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #polling = false;
  constructor(
    private readonly options: {
      snapshot(): Promise<unknown>;
      sessionId(): string | undefined;
      fault(error: unknown): void;
      intervalMs?: number;
    },
  ) {}

  get hasWork(): boolean {
    return this.#commands.size > 0;
  }

  follow(
    ref: NativeBackgroundCommand,
    turnId: HostTurnId,
    update: FollowedCommand["update"],
  ): void {
    if (this.#closed) throw new TraeError("invalidState", "Background observation is closed");
    const previous = this.#commands.get(ref.commandId);
    if (previous) {
      if (
        previous.turnId !== turnId ||
        previous.ref.messageId !== ref.messageId ||
        previous.ref.planItemId !== ref.planItemId
      )
        throw new TraeError("protocolError", "Native background execution changed ownership");
      return;
    }
    this.#commands.set(ref.commandId, { ref, turnId, active: false, update });
  }

  /** Parent native history is now durable; polling may use its exact selectors. */
  activate(turnId: HostTurnId): void {
    for (const command of this.#commands.values())
      if (command.turnId === turnId) command.active = true;
    this.#schedule();
  }

  observe(value: unknown, requireActive = false): void {
    if (this.#closed || !this.#commands.size) return;
    if (
      !record(value) ||
      value.sessionId !== this.options.sessionId() ||
      !Array.isArray(value.items)
    )
      throw new TraeError("protocolError", "Background snapshot belongs to another native Session");
    const statuses = new Map<string, NativeCommandStatus>();
    for (const item of value.items) {
      if (!record(item) || item.commandStatuses === undefined) continue;
      if (!Array.isArray(item.commandStatuses) || item.commandStatuses.length > 100)
        throw new TraeError("protocolError", "Invalid native command status list");
      for (const raw of item.commandStatuses) {
        const status = readCommandStatus(raw);
        if (status.messageId !== item.reply_to_message_id || statuses.has(status.commandId))
          throw new TraeError("protocolError", "Duplicate or foreign native command status");
        statuses.set(status.commandId, status);
      }
    }
    for (const [id, command] of this.#commands) {
      const status = statuses.get(id);
      if (!status) {
        if (requireActive && command.active)
          throw new TraeError("unavailable", "Native background command disappeared from history");
        continue;
      }
      if (
        status.messageId !== command.ref.messageId ||
        status.planItemId !== command.ref.planItemId
      )
        throw new TraeError("protocolError", "Native background result changed ownership");
      if (status.outputTruncated)
        throw new TraeError(
          "unsupported",
          "Native background output exceeds the observable window",
        );
      command.update(status);
      if (status.status !== "running") this.#commands.delete(id);
    }
  }

  #schedule(): void {
    if (
      this.#closed ||
      this.#timer ||
      this.#polling ||
      ![...this.#commands.values()].some((command) => command.active)
    )
      return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#poll();
    }, this.options.intervalMs ?? 1000);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    if (this.#closed) return;
    this.#polling = true;
    try {
      const snapshot = await this.options.snapshot();
      if (!this.#closed) this.observe(snapshot, true);
    } catch (error) {
      if (!this.#closed) {
        this.close();
        this.options.fault(error);
      }
    } finally {
      this.#polling = false;
      this.#schedule();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#commands.clear();
  }
}
