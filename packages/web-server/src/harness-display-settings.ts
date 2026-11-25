/** Display preferences are owned by Host; Web only projects its confirmed snapshots. */
import {
  HARNESS_DISPLAY_CAPABILITIES_METHOD,
  HARNESS_DISPLAY_GET_METHOD,
  HARNESS_DISPLAY_SET_METHOD,
  harnessDisplayCapabilitiesSchema,
  harnessDisplaySettingsSchema,
  harnessDisplaySetSchema,
  type HarnessDisplaySettings,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { readHarnessDisplayEntries } from "./harness-display-order.ts";
import { type EventHub, type RpcRegistry, RpcError } from "./transport.ts";

export class WebHarnessDisplaySettings {
  private stop: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private support: Promise<boolean> | undefined;
  private generation = 0;
  private closed = false;
  private eventMode = false;
  private latest: HarnessDisplaySettings | undefined;
  private fingerprint: string | undefined;

  constructor(
    private readonly host: ChHostClient,
    private readonly directory: string,
    private readonly events: EventHub,
  ) {
    this.stop = host.realtime?.subscribe((event) => {
      if (this.closed) return;
      if (event.type === "display-settings-changed")
        events.emit("codexhost/display-settings-changed");
      else if (event.type === "hello") {
        void this.negotiate().catch(() => {});
        events.emit("codexhost/display-settings-changed");
      } else if (event.type === "connection" && !event.online) {
        this.generation++;
        this.support = undefined;
        this.clearTimer();
      }
    });
    if (!this.support) void this.negotiate().catch(() => {});
  }

  private clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private valid(generation: number) {
    if (this.closed || generation !== this.generation)
      throw new RpcError(
        "display-settings/obsolete-reply",
        "Display settings connection changed; refresh before continuing.",
      );
  }
  private negotiate(): Promise<boolean> {
    const generation = ++this.generation;
    this.clearTimer();
    this.eventMode = false;
    const operation = (async () => {
      if (!this.host.realtime) {
        this.legacy(generation);
        return false;
      }
      let enabled: boolean;
      try {
        enabled = harnessDisplayCapabilitiesSchema.parse(
          await this.host.request(HARNESS_DISPLAY_CAPABILITIES_METHOD, {}),
        ).events;
      } catch (error) {
        if (
          (error as { code?: unknown }).code !== -32601 &&
          !(
            error instanceof RpcError &&
            (error.details as { hostCode?: unknown }).hostCode === -32601
          )
        )
          throw error;
        enabled = false;
      }
      this.valid(generation);
      this.eventMode = enabled;
      if (!enabled) this.legacy(generation);
      return enabled;
    })();
    this.support = operation;
    return operation;
  }

  private legacy(generation: number) {
    if (this.closed || generation !== this.generation) return;
    let busy = false;
    const refresh = async () => {
      if (busy || this.closed) return;
      busy = true;
      try {
        const value = await this.get();
        if (this.closed || generation !== this.generation) return;
        const next = JSON.stringify(value.entries);
        if (this.fingerprint !== undefined && this.fingerprint !== next)
          this.events.emit("codexhost/display-settings-changed");
        this.fingerprint = next;
      } catch {
        /* Keep the last confirmed ordering; the compatibility tick retries. */
      } finally {
        busy = false;
      }
    };
    // The first pass seeds the comparison; only explicitly legacy transports poll.
    this.timer = setInterval(() => {
      void refresh();
    }, 3000);
    this.timer.unref();
    queueMicrotask(() => {
      void refresh();
    });
  }

  async get(): Promise<HarnessDisplaySettings> {
    const generation = this.generation;
    this.valid(generation);
    try {
      const value = harnessDisplaySettingsSchema.parse(
        await this.host.request(HARNESS_DISPLAY_GET_METHOD, {}),
      );
      this.valid(generation);
      this.latest = value;
      return value;
    } catch (error) {
      if (
        (error as { code?: unknown }).code === -32601 ||
        (error instanceof RpcError && (error.details as { hostCode?: unknown }).hostCode === -32601)
      ) {
        this.valid(generation);
        const entries = await readHarnessDisplayEntries(this.directory);
        this.valid(generation);
        return { entries };
      }
      throw error;
    }
  }

  async entries() {
    const generation = this.generation;
    try {
      const result = await this.get();
      this.valid(generation);
      return result.entries ?? [];
    } catch (error) {
      this.valid(generation);
      if (error instanceof RpcError && error.code === "display-settings/obsolete-reply")
        throw error;
      const entries = this.latest?.entries ?? (await readHarnessDisplayEntries(this.directory));
      this.valid(generation);
      return entries;
    }
  }

  register(rpc: RpcRegistry) {
    rpc.register("codexhost/display-settings/get", () => this.get());
    rpc.register("codexhost/display-settings/capabilities", async () => {
      const support = this.support ?? this.negotiate();
      const generation = this.generation;
      this.valid(generation);
      const events = await support;
      this.valid(generation);
      return { events };
    });
    rpc.register("codexhost/display-settings/set", async (args) => {
      const generation = this.generation;
      this.valid(generation);
      const request = harnessDisplaySetSchema.parse(args.request);
      const result = harnessDisplaySettingsSchema.parse(
        await this.host.request(HARNESS_DISPLAY_SET_METHOD, request),
      );
      this.valid(generation);
      this.latest = result;
      if (!this.eventMode) this.events.emit("codexhost/display-settings-changed");
      return result;
    });
  }

  close() {
    this.closed = true;
    this.generation++;
    this.clearTimer();
    this.stop?.();
  }
}
