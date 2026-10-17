import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { IsolatedSessions } from "@codexhost/session-runtime";
import { SharedWebCodexOwner } from "../src/web-codex-owner.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";

it("retains pending submission identities at capacity and retires them only after settling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-codex-receipts-"));
  const plugins = path.join(root, "plugins");
  await mkdir(path.join(plugins, "codex"), { recursive: true });
  await writeFile(
    path.join(plugins, "codex/manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "codex",
      name: "Receipt fixture",
      version: "1.0.0",
      adapterApiVersion: 1,
      entry: "./plugin.mjs",
    }),
  );
  await writeFile(
    path.join(plugins, "codex/plugin.mjs"),
    `export function createHarnessAdapter() {
    return { harnessId:'codex', close:async()=>{}, inspect:async()=>({status:'ready',catalog:{models:[{ref:{id:'test'},label:'Test'}],defaultModel:{id:'test'},thinkingOptions:[]},capabilities:{configuration:{selectModel:true,selectThinkingOption:false,selectPermissionMode:false},history:{fork:false,forkAcrossCwd:false,rollbackLastTurn:false}}}),open:async()=>{throw new Error('Never open native sessions in receipt test')}};
  }`,
  );
  const events = new ClientChannelEvents();
  const owner = new SharedWebCodexOwner(
    { HOME: path.join(root, "user"), CODEXHOST_DATA_DIR: path.join(root, "data") },
    events,
    async () => false,
    async (_method, input) => ({ scope: input.scope, revision: 0, values: { favorites: {} } }),
  );
  const pending = Promise.withResolvers<{ accepted: boolean }>();
  const prompt = vi
    .spyOn(IsolatedSessions.prototype, "prompt")
    .mockImplementation(() => pending.promise);
  try {
    const configured = await owner.configure({
      home: path.join(root, "home"),
      command: process.execPath,
      pluginRoots: [plugins],
    });
    const created = (await owner.request({
      epoch: events.epoch,
      address: { scope: configured.scope },
      operation: "create",
      input: { cwd: root },
    })) as { sessionId: string };
    const submit = (requestId: string) =>
      owner.request({
        epoch: events.epoch,
        address: { scope: configured.scope, sessionId: created.sessionId },
        operation: "prompt",
        input: { requestId, mode: "steer", content: [{ type: "text", text: requestId }] },
      });
    const inFlight = Array.from({ length: 256 }, (_, index) => submit(`pending-${index}`));
    const overflow = submit("overflow");
    void overflow.catch(() => {});
    expect(prompt).toHaveBeenCalledTimes(256);
    await expect(overflow).rejects.toThrow("session-busy");
    const duplicate = submit("pending-0");
    expect(prompt).toHaveBeenCalledTimes(256);
    pending.resolve({ accepted: true });
    await Promise.all([...inFlight, duplicate]);
    await expect(submit("after-settled")).resolves.toEqual({ accepted: true });
    expect(prompt).toHaveBeenCalledTimes(257);
  } finally {
    pending.resolve({ accepted: true });
    prompt.mockRestore();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
