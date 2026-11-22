import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { skillsListResultSchema } from "@codexhost/shared-contracts";
import { SkillLibrary } from "@codexhost/skill-library";
import type { JsonObject } from "@codexhost/protocol-core";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import type { SharedThreadPeer } from "../src/shared-thread-peer.js";
import {
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
let home: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "host-skills-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});
const environment = () => ({ HOME: home, CODEX_HOME: join(home, ".codex") });

it("serves ready draft and Thread indexes without file reads or starting/resuming a Harness", async () => {
  const directory = join(home, ".agents/skills/review");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, "SKILL.md"), "---\nname: review\n---\n");
  const fixture = createFixture({ environment: environment() });
  try {
    const open = vi.spyOn(fixture.adapter, "open");
    const send = async (id: number, params: Record<string, string> = {}) => {
      writeRequest(fixture.desktopInput, { id, method: "codexhost/skills/list", params });
      return fixture.collector.waitFor((message) => requestId(message, id));
    };
    expect(skillsListResultSchema.parse((await send(100)).result).skills).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    await send(101, { cwd: home });
    expect(open).not.toHaveBeenCalled();
    const reads = vi.spyOn(fs, "readdir");
    const metadata = vi.spyOn(fs, "stat");
    await send(102, { cwd: home });
    expect(reads).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    const threadId = await startPiThread(fixture);
    const calls = open.mock.calls.length;
    expect(skillsListResultSchema.parse((await send(103, { threadId })).result).complete).toBe(
      true,
    );
    expect(open).toHaveBeenCalledTimes(calls);
    await expect(
      fixture.host.handleClientRequest("codexhost/skills/list", {}),
    ).resolves.toMatchObject({ result: { complete: true } });
  } finally {
    await stopFixture(fixture);
  }
});

it("bounds initial scanning and publishes revisions through Desktop and client notifications", async () => {
  const directory = join(home, ".agents/skills/review");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, "SKILL.md"), "---\nname: review\n---\n");
  const original = fs.readdir;
  const gate = Promise.withResolvers<undefined>();
  vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === join(home, ".agents/skills")) await gate.promise;
    return original(...args);
  });
  const fixture = createFixture({ environment: environment() });
  try {
    writeRequest(fixture.desktopInput, { id: 100, method: "codexhost/skills/list", params: {} });
    const partial = skillsListResultSchema.parse(
      (await fixture.collector.waitFor((message) => requestId(message, 100))).result,
    );
    expect(partial.complete).toBe(false);
    const changed = vi.fn();
    const off = fixture.host.clientEvents.subscribe(changed);
    gate.resolve(undefined);
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ type: "skills-changed" })),
    );
    expect(fixture.collector.messages).toContainEqual(
      expect.objectContaining({ method: "codexhost/skills/changed", params: {} }),
    );
    writeRequest(fixture.desktopInput, { id: 101, method: "codexhost/skills/list", params: {} });
    const complete = skillsListResultSchema.parse(
      (await fixture.collector.waitFor((message) => requestId(message, 101))).result,
    );
    expect(complete.complete).toBe(true);
    expect(complete.skills).toHaveLength(1);
    expect(complete.revision).toBeGreaterThan(partial.revision);
    expect(fixture.adapter.sessions).toHaveLength(0);
    off();
  } finally {
    gate.resolve(undefined);
    await stopFixture(fixture);
  }
});

it("delegates Skill indexes and forwards only the shared owner's change notifications", async () => {
  const start = vi.spyOn(SkillLibrary.prototype, "start");
  const prepare = vi.spyOn(SkillLibrary.prototype, "prepare");
  const list = vi.spyOn(SkillLibrary.prototype, "list");
  const closed = Promise.withResolvers<undefined>();
  let publish: (message: JsonObject) => void = () => {};
  const snapshot: JsonObject = {
    revision: 7,
    complete: true,
    skills: [{ name: "shared-skill", path: "/shared/SKILL.md", scope: "global", source: "Agents" }],
  };
  const request = vi.fn(async (method: string): Promise<JsonObject> => ({
    result: method === "codexhost/skills/list" ? snapshot : { data: [], nextCursor: null },
  }));
  const subscribe = vi.fn((listener: (message: JsonObject) => void) => {
    publish = listener;
    return () => {};
  });
  const peer: SharedThreadPeer = {
    request,
    subscribe,
    respond: async () => {},
    closed: closed.promise,
    close: () => closed.resolve(undefined),
  };
  const bridge = new SharedThreadBridge({
    connect: async () => peer,
    delegateCreates: true,
    diagnose: () => {},
  });
  const fixture = createFixture({ environment: environment(), sharedThreads: bridge });
  try {
    await fixture.ready;
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    for (const [id, params] of [
      [100, {}],
      [101, { cwd: home }],
      [102, { threadId: "shared-thread" }],
    ] as const) {
      writeRequest(fixture.desktopInput, { id, method: "codexhost/skills/list", params });
      expect(await fixture.collector.waitFor((message) => requestId(message, id))).toMatchObject({
        result: snapshot,
      });
      expect(request).toHaveBeenCalledWith("codexhost/skills/list", params);
    }
    const notifications = [
      { method: "codexhost/skills/changed", params: {} },
      { method: "codexhost/skills/changed", params: { cwd: home } },
    ];
    for (const message of notifications) publish(message);
    await vi.waitFor(() =>
      expect(
        fixture.collector.messages.filter(
          (message) => message.method === "codexhost/skills/changed",
        ),
      ).toEqual(notifications),
    );
    expect(start).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(fixture.adapter.sessions).toHaveLength(0);
  } finally {
    await stopFixture(fixture);
  }
});
