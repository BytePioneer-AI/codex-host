import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const harnessId = harnessIdSchema.parse("pi");
const hostThreadId = hostThreadIdSchema.parse("side-chat");
const directories: string[] = [];
const stores: MappingStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function open(directory: string): Promise<MappingStore> {
  const store = new MappingStore({ directory });
  stores.push(store);
  await store.initialize();
  return store;
}

async function setup(): Promise<{ directory: string; store: MappingStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-injected-"));
  directories.push(directory);
  const store = await open(directory);
  await store.createProvisional({
    hostThreadId,
    createRequestId: "create-side-chat",
    harnessId,
    cwd: "/synthetic",
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "paginated",
  });
  await store.commitReady({
    hostThreadId,
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "side-chat-session",
      formatVersion: 1,
    }),
  });
  return { directory, store };
}

function prefix(turn: number) {
  return { hostTurnId: hostTurnIdSchema.parse(`turn-${turn}`), length: 9, sha256: "a".repeat(64) };
}

describe("Injected text held for the next Turn", () => {
  it("keeps the held texts when an append would pass the limit", async () => {
    const { store } = await setup();
    const texts = Array.from({ length: 64 }, (_, index) => `context ${index}`);
    await store.appendPendingInjectedText(hostThreadId, texts);
    await expect(store.appendPendingInjectedText(hostThreadId, ["one more"])).rejects.toMatchObject(
      { code: "INVALID_RECORD" },
    );
    expect((await store.getThread(hostThreadId))?.pendingInjectedText).toEqual(texts);
  });

  it("releases only the held texts a Turn carried, even when the same text is held again", async () => {
    const { store } = await setup();
    await store.appendPendingInjectedText(hostThreadId, ["A"]);
    // Two Turns carried A. The first release frees it; A is held again, and B, before the second.
    await store.consumePendingInjectedText(hostThreadId, 1, prefix(1));
    await store.appendPendingInjectedText(hostThreadId, ["A", "B"]);
    const record = await store.consumePendingInjectedText(hostThreadId, 1, prefix(2));
    expect(record.pendingInjectedText).toEqual(["A", "B"]);
    expect(record.releasedInjectedTexts).toBe(1);
    expect(record.injectedTurnPrefixes?.map(({ hostTurnId }) => hostTurnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("keeps the prefix of every Turn that delivered injected text", async () => {
    const { directory, store } = await setup();
    for (let turn = 1; turn <= 70; turn++) {
      await store.appendPendingInjectedText(hostThreadId, ["context"]);
      await store.consumePendingInjectedText(hostThreadId, turn, prefix(turn));
    }
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await open(directory);
    const record = await reopened.getThread(hostThreadId);
    expect(record?.injectedTurnPrefixes).toHaveLength(70);
    expect(record?.pendingInjectedText).toBeUndefined();
  });
});
