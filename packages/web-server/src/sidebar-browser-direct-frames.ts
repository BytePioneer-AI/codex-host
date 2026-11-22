import {
  SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES,
  SIDEBAR_BROWSER_DIRECT_FRAME_BYTES,
  SIDEBAR_BROWSER_DIRECT_IDLE_MS,
  SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES,
  decodeSidebarBrowserDirectAck,
  encodeSidebarBrowserDirectFragment,
} from "@codexhost/shared-contracts/sidebar-browser";
import type { SidebarDirectSession } from "./sidebar-browser-direct.ts";

const HIGH_WATER = 128 * 1024;
const LOW_WATER = 64 * 1024;

export interface SidebarDirectFrame {
  readonly sequence: number;
  readonly frame: Buffer;
}

/** Sends at most one partial frame; admission and the cumulative window belong to the viewer. */
export class SidebarDirectFrames {
  private readonly binding: NonNullable<ReturnType<SidebarDirectSession["bind"]>>;
  private readonly chunkBytes: number;
  private readonly unsubscribe: (() => void)[];
  private active = true;
  private partial: (SidebarDirectFrame & { offset: number }) | undefined;
  private readonly awaiting: { sequence: number; deadline: number }[] = [];
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(
    binding: SidebarDirectFrames["binding"],
    private readonly drain: () => void,
    ack: (sequence: number) => void,
    private readonly written: (bytes: number) => void,
  ) {
    this.binding = binding;
    const { channel } = binding;
    this.chunkBytes =
      Math.min(
        SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES,
        channel.sctp.remoteMaxMessageSize || SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES,
      ) - SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES;
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.unsubscribe = [
      channel.bufferedAmountLow.subscribe(() => this.pump()).unSubscribe,
      channel.onMessage.subscribe((text) => {
        if (!this.active || typeof text !== "string") return;
        const message = decodeSidebarBrowserDirectAck(text);
        if (message) ack(message.sequence);
      }).unSubscribe,
      channel.stateChanged.subscribe((state) => {
        if (state === "closed") this.fail("frames-closed");
      }).unSubscribe,
      channel.error.subscribe(() => this.fail("frames-error")).unSubscribe,
    ];
  }

  get usable(): boolean {
    return this.chunkBytes > 0;
  }

  canSend(frame: SidebarDirectFrame): boolean {
    return (
      this.active &&
      this.partial === undefined &&
      this.binding.channel.bufferedAmount +
        Math.min(this.chunkBytes, frame.frame.length) +
        SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES <=
        HIGH_WATER
    );
  }

  send(frame: SidebarDirectFrame): void {
    if (frame.frame.length > SIDEBAR_BROWSER_DIRECT_FRAME_BYTES) {
      this.fail("frame-size");
      return;
    }
    this.awaiting.push({
      sequence: frame.sequence,
      deadline: performance.now() + SIDEBAR_BROWSER_DIRECT_IDLE_MS,
    });
    if (this.awaiting.length === 1) this.armWatchdog();
    this.partial = { ...frame, offset: 0 };
    this.pump();
  }

  acknowledged(sequence: number): void {
    while (this.awaiting[0] && this.awaiting[0].sequence <= sequence) this.awaiting.shift();
    this.armWatchdog();
  }

  dispose(): void {
    this.active = false;
    this.binding.release();
    for (const off of this.unsubscribe) off();
    clearTimeout(this.watchdog);
    this.binding.channel.close();
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    const first = this.awaiting[0];
    if (first)
      this.watchdog = setTimeout(
        () => this.fail("frames-ack-timeout"),
        Math.max(0, first.deadline - performance.now()),
      );
  }

  private fail(reason: string): void {
    if (this.active) this.binding.fail(reason);
  }

  private pump(): void {
    const { channel, attempt } = this.binding;
    const partial = this.partial;
    if (!this.active) return;
    if (partial) {
      try {
        const { frame, sequence } = partial;
        while (partial.offset < frame.length) {
          const payload = frame.subarray(partial.offset, partial.offset + this.chunkBytes);
          if (
            channel.bufferedAmount + payload.length + SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES >
            HIGH_WATER
          )
            return;
          channel.send(
            Buffer.from(
              encodeSidebarBrowserDirectFragment({
                attempt,
                sequence,
                offset: partial.offset,
                total: frame.length,
                payload,
              }).buffer,
            ),
          );
          if (!this.active) return;
          partial.offset += payload.length;
          this.written(payload.length);
        }
      } catch {
        this.fail("frames-send");
        return;
      }
      this.partial = undefined;
    }
    this.drain();
  }
}
