import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import type { BrowserContext, Frame } from "playwright-core";
import type { WebSocket } from "ws";
import {
  SIDEBAR_BROWSER_FRAME_HEADER_BYTES,
  decodeSidebarBrowserFrameHeader,
  type SidebarBrowserServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import { DEFAULT_SIDEBAR_BROWSER_QUALITY, SidebarBrowserTab } from "../src/sidebar-browser-tab.ts";

/** Only the Chrome and socket boundaries are substituted; the tab owns all scheduling. */
async function openTab(t: TestContext, frames: () => Frame[] = () => []) {
  const cdp = Object.assign(new EventEmitter(), {
    send: async (command: string) => {
      if (command === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (command === "Page.getNavigationHistory") return { entries: [], currentIndex: 0 };
      if (command === "Page.captureScreenshot") return { data: "" };
    },
  });
  const context = { newCDPSession: async () => cdp, newPage: async () => page };
  let editableChanged!: () => void;
  const page = Object.assign(new EventEmitter(), {
    close: async () => undefined,
    context: () => context,
    frames,
    mainFrame: () => frames()[0],
    exposeBinding: async (_name: string, notify: () => void) => {
      editableChanged = notify;
    },
    goto: async () => undefined,
    url: () => "https://example.test/",
    title: async () => "Example",
  });
  const tab = new SidebarBrowserTab(
    "test",
    async () => context as unknown as BrowserContext,
    DEFAULT_SIDEBAR_BROWSER_QUALITY,
  );
  t.after(() => tab.close());
  const attach = async () => {
    const frames: Buffer[] = [];
    const messages: SidebarBrowserServerMessage[] = [];
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string | Buffer) => {
        if (Buffer.isBuffer(data)) frames.push(data);
        else messages.push(JSON.parse(data) as SidebarBrowserServerMessage);
      },
      close: () => socket.emit("close"),
    });
    tab.attach(socket as unknown as WebSocket);
    const receive = (data: object) => socket.emit("message", JSON.stringify(data), false);
    receive({ type: "visible", visible: true });
    return { frames, messages, receive, disconnect: socket.close };
  };
  const viewer = await attach();
  viewer.receive({ type: "navigate", url: page.url() });
  await setImmediate();
  const paint = async (id: number, size = 1) => {
    cdp.emit("Page.screencastFrame", {
      data: Buffer.alloc(size, id).toString("base64"),
      sessionId: 1,
    });
    await setImmediate();
  };
  return { viewer, attach, paint, changeContent: () => editableChanged() };
}

function header(frame: Buffer | undefined) {
  assert.ok(frame, "Expected a browser frame");
  return decodeSidebarBrowserFrameHeader(Uint8Array.from(frame).buffer);
}
const sequence = (frame: Buffer | undefined): number => header(frame).sequence;
const pictures = (frames: Buffer[]) =>
  frames.map((frame) => frame[SIDEBAR_BROWSER_FRAME_HEADER_BYTES]);

it("pipelines two pictures, accepts cumulative ACKs and sends only the newest waiting picture", async (t) => {
  const { viewer, attach, paint } = await openTab(t);
  await paint(1);
  await paint(2);
  await paint(3);
  assert.deepEqual(pictures(viewer.frames), [undefined, 1]);

  const [first, second] = viewer.frames.map(sequence);
  assert.ok(first !== undefined && second !== undefined && first < second);
  viewer.receive({ type: "ack", sequence: second + 1 }); // Not sent to this viewer.
  assert.equal(viewer.frames.length, 2);
  viewer.receive({ type: "ack", sequence: second });
  await paint(4);
  await paint(5);
  viewer.receive({ type: "ack", sequence: first }); // Already cumulatively acknowledged.
  assert.deepEqual(pictures(viewer.frames), [undefined, 1, 3, 4]);
  const last = sequence(viewer.frames[3]);

  viewer.disconnect();
  const reconnected = await attach();
  await setImmediate();
  await paint(6);
  await paint(7);
  assert.deepEqual(pictures(reconnected.frames), [undefined, 6]);
  reconnected.receive({ type: "ack", sequence: last });
  assert.equal(reconnected.frames.length, 2);
  reconnected.receive({ type: "ack", sequence: sequence(reconnected.frames[0]) });
  assert.deepEqual(pictures(reconnected.frames), [undefined, 6, 7]);
});

it("bounds outstanding bytes without starving an oversized picture", async (t) => {
  const { viewer, paint } = await openTab(t);
  const ackLatest = () => viewer.receive({ type: "ack", sequence: sequence(viewer.frames.at(-1)) });
  ackLatest();
  await paint(1, 300 * 1024);
  await paint(2, 300 * 1024);
  assert.deepEqual(pictures(viewer.frames), [undefined, 1]);
  ackLatest();
  assert.deepEqual(pictures(viewer.frames), [undefined, 1, 2]);
  await paint(3, 600 * 1024);
  ackLatest();
  await paint(4);
  assert.deepEqual(pictures(viewer.frames), [undefined, 1, 2, 3]);
  ackLatest();
  assert.deepEqual(pictures(viewer.frames), [undefined, 1, 2, 3, 4]);
});

it("keeps editable areas valid while streaming during scans", { timeout: 3000 }, async (t) => {
  const region = { x: 15, y: 20, width: 40, height: 25 };
  const regions = [region];
  const nextScan = () => ({
    started: Promise.withResolvers<undefined>(),
    result: Promise.withResolvers<{ regions: typeof regions; width: number; height: number }>(),
  });
  let scan = nextScan();
  const main = {
    evaluate: () => {
      scan.started.resolve(undefined);
      return scan.result.promise;
    },
  } as unknown as Frame;
  const { viewer, paint, changeContent } = await openTab(t, () => [main]);
  const latestEditable = () => viewer.messages.findLast((message) => message.type === "editable");
  const latestFrame = () => header(viewer.frames.at(-1));
  const ackLatest = () => viewer.receive({ type: "ack", sequence: latestFrame().sequence });
  const finishScan = async (result: typeof regions) => {
    scan.result.resolve({ regions: result, width: 1000, height: 800 });
    await setImmediate();
  };

  await scan.started.promise;
  await paint(1);
  assert.deepEqual(pictures(viewer.frames), [undefined, 1]);
  assert.deepEqual(latestEditable()?.regions, []);
  await finishScan(regions);
  const metadata = latestEditable();
  assert.ok(metadata);
  assert.deepEqual(metadata.regions, regions);
  ackLatest();
  await paint(2);
  assert.equal(latestFrame().generation, metadata.generation);

  scan = nextScan();
  changeContent();
  await scan.started.promise;
  assert.deepEqual(latestEditable(), metadata, "a pending content scan must not clear hit areas");
  changeContent(); // Another mutation during the scan queues a refresh without invalidating it.
  const moved = [{ ...region, x: 35 }];
  await finishScan(moved);
  assert.deepEqual(latestEditable(), { ...metadata, regions: moved });
  await paint(3);
  assert.equal(pictures(viewer.frames).at(-1), 3);
  assert.equal(latestFrame().generation, metadata.generation);

  scan = nextScan();
  await scan.started.promise;
  await finishScan([]);
  assert.deepEqual(latestEditable(), { ...metadata, regions: [] });

  ackLatest();
  viewer.receive({ type: "viewport", width: 900, height: 800 });
  const resized = latestEditable();
  assert.ok(resized && resized.generation > metadata.generation);
  assert.deepEqual(resized.regions, []);
  await setImmediate();
  await paint(4);
  assert.equal(latestFrame().width, 900);
  assert.equal(latestFrame().generation, resized.generation);
});
