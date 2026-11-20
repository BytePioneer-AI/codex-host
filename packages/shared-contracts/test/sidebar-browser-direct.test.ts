import { describe, expect, it } from "vitest";
import {
  SIDEBAR_BROWSER_DIRECT_FRAME_BYTES,
  SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES,
  SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES,
  decodeSidebarBrowserDirectAck,
  decodeSidebarBrowserDirectFragment,
  encodeSidebarBrowserDirectAck,
  encodeSidebarBrowserDirectFragment,
  parseSidebarBrowserClientMessage,
  parseSidebarBrowserDirectClientMessage,
  parseSidebarBrowserDirectServerMessage,
  parseSidebarBrowserTransport,
} from "../src/sidebar-browser.ts";

describe("sidebar browser direct protocol", () => {
  it("separates signaling directions and requires the offer's restart flag", () => {
    const offer = { type: "direct-offer", attempt: 2, sdp: "v=0", restart: true };
    expect(parseSidebarBrowserDirectClientMessage(offer)).toEqual(offer);
    expect(
      parseSidebarBrowserDirectClientMessage({ ...offer, restart: undefined }),
    ).toBeUndefined();
    expect(parseSidebarBrowserDirectServerMessage(offer)).toBeUndefined();
    const end = { type: "direct-candidate", attempt: 2, candidate: null };
    expect(parseSidebarBrowserDirectServerMessage(end)).toEqual(end);
    expect(
      parseSidebarBrowserDirectClientMessage({ ...end, candidate: { candidate: 42 } }),
    ).toBeUndefined();
    expect(parseSidebarBrowserDirectServerMessage({ ...end, attempt: 2 ** 32 })).toBeUndefined();
    expect(
      parseSidebarBrowserDirectServerMessage({
        type: "direct-hello",
        peer: "peer",
        target: "target",
        boot: "boot",
        offered: true,
        iceServers: ["turn:relay.example"],
      }),
    ).toBeUndefined();
  });

  it("encodes cumulative ACKs and validates the label switch boundary", () => {
    expect(decodeSidebarBrowserDirectAck(encodeSidebarBrowserDirectAck(2 ** 32))).toEqual({
      type: "ack",
      sequence: 2 ** 32,
    });
    expect(decodeSidebarBrowserDirectAck('{"type":"ack","sequence":1.5}')).toBeUndefined();
    expect(decodeSidebarBrowserDirectAck("{")).toBeUndefined();
    expect(parseSidebarBrowserClientMessage({ type: "transport", binding: 1 })).toEqual({
      type: "transport",
      binding: 1,
    });
    expect(parseSidebarBrowserClientMessage({ type: "transport", peer: "peer" })).toBeUndefined();
    expect(
      parseSidebarBrowserClientMessage({ type: "transport", binding: 1, peer: "" }),
    ).toBeUndefined();
    const bound = { type: "transport", binding: 2, via: "direct", from: 8 };
    expect(parseSidebarBrowserTransport(bound)).toEqual(bound);
    expect(parseSidebarBrowserTransport({ ...bound, from: undefined })).toBeUndefined();
    expect(parseSidebarBrowserTransport({ type: "transport", via: "socket" })).toBeUndefined();
    expect(
      parseSidebarBrowserTransport({ type: "transport", via: "socket", binding: 0 }),
    ).toBeUndefined();
  });

  it("round trips a full-size fragment without truncating sequence or accepting out-of-bounds bytes", () => {
    const payload = new Uint8Array(
      SIDEBAR_BROWSER_DIRECT_MESSAGE_BYTES - SIDEBAR_BROWSER_DIRECT_FRAGMENT_HEADER_BYTES,
    ).fill(42);
    const fragment = {
      attempt: 3,
      sequence: 2 ** 32 + 1,
      offset: 9,
      total: payload.length + 9,
      payload,
    };
    const bytes = encodeSidebarBrowserDirectFragment(fragment);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    expect(decodeSidebarBrowserDirectFragment(padded.subarray(1))).toEqual(fragment);
    expect(decodeSidebarBrowserDirectFragment(padded)).toBeUndefined();
    expect(decodeSidebarBrowserDirectFragment(bytes.subarray(0, 20))).toBeUndefined();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, SIDEBAR_BROWSER_DIRECT_FRAME_BYTES + 1);
    expect(decodeSidebarBrowserDirectFragment(bytes)).toBeUndefined();
    view.setUint32(16, fragment.total - 1);
    expect(decodeSidebarBrowserDirectFragment(bytes)).toBeUndefined();
  });
});
