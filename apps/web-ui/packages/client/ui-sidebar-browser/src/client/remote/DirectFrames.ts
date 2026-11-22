import {
  decodeSidebarBrowserDirectFragment,
  decodeSidebarBrowserFrameHeader,
  encodeSidebarBrowserDirectAck,
  sidebarBrowserFramesChannel,
  type SidebarBrowserFrameHeader,
} from "@codexhost/shared-contracts/sidebar-browser";
import type { DirectReady } from "./DirectSession.ts";

const ACK_PAUSE_BYTES = 128 * 1024;
const ACK_RESUME_BYTES = 64 * 1024;
const FRAME_WINDOW = 2;

type Frame = { data: ArrayBuffer; header: SidebarBrowserFrameHeader };

/** One tab's channel, scoped to one ready generation and one label WebSocket. */
export class DirectFrames {
  binding: number | undefined;
  private readonly lifetime = new AbortController();
  private readonly channel: RTCDataChannel;
  private partial: { sequence: number; offset: number; bytes: Uint8Array<ArrayBuffer> } | undefined;
  private readonly early: Frame[] = [];
  private from: number | undefined;
  private pendingAck: number | undefined;

  constructor(
    readonly ready: DirectReady,
    tab: string,
    bind: () => void,
    private readonly draw: (frame: Frame) => void,
  ) {
    const { signal } = this.lifetime;
    const channel = ready.pc.createDataChannel(sidebarBrowserFramesChannel(tab));
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = ACK_RESUME_BYTES;
    channel.addEventListener("open", bind, { signal });
    for (const event of ["error", "close"] as const)
      channel.addEventListener(event, () => ready.failed(`frames-${event}`), { signal });
    channel.addEventListener("bufferedamountlow", () => this.flushAck(), { signal });
    channel.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        const part =
          event.data instanceof ArrayBuffer && decodeSidebarBrowserDirectFragment(event.data);
        if (!part) {
          ready.failed("frame-fragment");
          return;
        }
        if (part.attempt !== ready.attempt) return;
        if (this.partial === undefined && part.offset === 0)
          this.partial = { sequence: part.sequence, offset: 0, bytes: new Uint8Array(part.total) };
        const frame = this.partial;
        if (
          frame?.offset !== part.offset ||
          frame.sequence !== part.sequence ||
          frame.bytes.length !== part.total
        ) {
          ready.failed("frame-fragment");
          return;
        }
        frame.bytes.set(part.payload, part.offset);
        frame.offset += part.payload.length;
        if (frame.offset !== part.total) return;
        this.partial = undefined;
        const data = frame.bytes.buffer;
        const header = decodeSidebarBrowserFrameHeader(data);
        if (header.sequence !== frame.sequence) {
          ready.failed("frame-sequence");
          return;
        }
        if (this.from !== undefined) this.receive({ data, header });
        // A frame can overtake the bind response because it uses a different connection.
        else if (this.early.length < FRAME_WINDOW) this.early.push({ data, header });
        else ready.failed("frame-window");
      },
      { signal },
    );
  }

  get bound(): boolean {
    return this.from !== undefined;
  }

  confirm(from: number): void {
    this.from = from;
    for (const frame of this.early) this.receive(frame);
    this.early.length = 0;
  }

  acknowledge(sequence: number): void {
    this.pendingAck = Math.max(sequence, this.pendingAck ?? 0);
    this.flushAck();
  }

  dispose(): void {
    this.lifetime.abort();
    this.early.length = 0;
    this.partial = undefined;
    this.channel.close();
  }

  private receive(frame: Frame): void {
    if (frame.header.sequence >= this.from!) this.draw(frame);
    else this.acknowledge(frame.header.sequence);
  }

  private flushAck(): void {
    if (this.pendingAck === undefined) return;
    const message = encodeSidebarBrowserDirectAck(this.pendingAck);
    if (this.channel.bufferedAmount + message.length > ACK_PAUSE_BYTES) return;
    try {
      this.channel.send(message);
      this.pendingAck = undefined;
    } catch {
      this.ready.failed("frame-ack");
    }
  }
}
