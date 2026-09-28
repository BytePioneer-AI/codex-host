import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeThreadSupportsReferences } from "../src/native-thread-reference-capability.js";
import {
  createFixture,
  readJsonLine,
  requestId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(tools: unknown[], folder = "sessions") {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-reference-"));
  roots.push(root);
  const directory = path.join(root, folder);
  await mkdir(directory);
  const rollout = path.join(directory, "rollout.jsonl");
  await writeFile(
    rollout,
    JSON.stringify({ type: "session_meta", payload: { id: "thread-test", dynamic_tools: tools } }) +
      "\nnot JSON transcript content\n",
  );
  const input = {
    codexHome: root,
    threadId: "thread-test",
    readThread: async () => ({ result: { thread: { id: "thread-test", path: rollout } } }),
  };
  return { input, rollout };
}

it.each(["sessions", "archived_sessions"])(
  "accepts recorded read_thread in %s without parsing transcript",
  async (folder) => {
    const { input } = await fixture(
      [{ type: "namespace", name: "codex_app", tools: [{ name: "read_thread" }] }],
      folder,
    );
    expect(await nativeThreadSupportsReferences(input)).toBe(true);
  },
);
it("accepts the older flat tool format", async () => {
  const { input } = await fixture([{ name: "read_thread" }]);
  expect(await nativeThreadSupportsReferences(input)).toBe(true);
});
it("does not infer support from other thread tools", async () => {
  const { input } = await fixture([{ name: "list_threads" }]);
  expect(await nativeThreadSupportsReferences(input)).toBe(false);
});
it("rejects a rollout outside session directories", async () => {
  const { input } = await fixture([{ name: "read_thread" }], "unrelated");
  expect(await nativeThreadSupportsReferences(input)).toBe(false);
});
it("rejects mismatching official and metadata identities", async () => {
  const { input, rollout } = await fixture([{ name: "read_thread" }]);
  expect(await nativeThreadSupportsReferences({ ...input, threadId: "another" })).toBe(false);
  await writeFile(
    rollout,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "another", dynamic_tools: [{ name: "read_thread" }] },
    }) + "\n",
  );
  expect(await nativeThreadSupportsReferences(input)).toBe(false);
});
it.each(["malformed\n", "x".repeat(1024 * 1024) + "\n"])(
  "fails closed for unreadable metadata",
  async (text) => {
    const { input, rollout } = await fixture([]);
    await writeFile(rollout, text);
    expect(await nativeThreadSupportsReferences(input)).toBe(false);
  },
);
it("does not treat an official RPC error as support", async () => {
  const { input } = await fixture([{ name: "read_thread" }]);
  expect(
    await nativeThreadSupportsReferences({
      ...input,
      readThread: async () => ({ error: { message: "not found" } }),
    }),
  ).toBe(false);
});

it("exposes only proven support through native Thread inspection", async () => {
  const { input, rollout } = await fixture([{ name: "read_thread" }]);
  const host = createFixture({ environment: { CODEX_HOME: input.codexHome } });
  try {
    await host.ready;
    writeRequest(host.desktopInput, {
      id: 900,
      method: "codexhost/thread/inspect",
      params: { threadId: input.threadId, includeReferenceCapability: true },
    });
    const request = await readJsonLine(host.official.stdin);
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: input.threadId, includeTurns: false },
    });
    host.official.stdout.write(
      JSON.stringify({
        id: request.id,
        result: { thread: { id: input.threadId, path: rollout } },
      }) + "\n",
    );
    await expect(host.collector.waitFor((message) => requestId(message, 900))).resolves.toEqual({
      id: 900,
      result: { owner: "codex", locked: true, supportsThreadReferences: true },
    });
  } finally {
    await stopFixture(host);
  }
});
