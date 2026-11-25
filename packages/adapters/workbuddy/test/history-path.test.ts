import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeBuddyNativeHistory, type CodeBuddyClientFactory } from "@codexhost/adapter-codebuddy";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { WORKBUDDY_RUNTIME_PROFILE } from "../src/common.js";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const roots: string[] = [];
const adapters: WorkBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ref = nativeSessionRefSchema.parse({
  harnessId: "workbuddy",
  nativeSessionId: "native-path-regression",
  formatVersion: 1,
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-path-")));
  roots.push(root);
  const cwd = path.join(root, "Users-Case.Name-项目 Space_Name");
  await mkdir(cwd);
  const environment = { WORKBUDDY_CONFIG_DIR: path.join(root, "config") };
  // Native PathUtils.compressPath fixture; never use the adapter's path builder here.
  const directory = path.join(
    environment.WORKBUDDY_CONFIG_DIR,
    "projects",
    `${root.split(path.sep).filter(Boolean).join("-").replace(/:/gu, "")}-Users-Case.Name-项目 Space_Name`,
  );
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${ref.nativeSessionId}.jsonl`);
  await writeFile(file, "");
  const persist = async (rowCwd = cwd) =>
    writeFile(
      file,
      [
        {
          id: "user",
          type: "message",
          role: "user",
          sessionId: ref.nativeSessionId,
          cwd: rowCwd,
          content: "hello",
        },
        {
          id: "assistant",
          parentId: "user",
          type: "message",
          role: "assistant",
          sessionId: ref.nativeSessionId,
          cwd: rowCwd,
          content: "OK",
          status: "completed",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
  const open = vi.fn(async (_requestedCwd: string, sessionId?: string) => ({
    sessionId: sessionId ?? ref.nativeSessionId,
    configOptions: [
      { id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] },
      { id: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    ],
  }));
  const prompt = vi.fn(async () => {
    await persist();
    return { stopReason: "end_turn" };
  });
  const clientFactory: CodeBuddyClientFactory = () => ({
    initialize: async () => ({}),
    open,
    prompt,
    configure: async () => ({}),
    cancel: async () => {},
    answer: async () => {},
    close: async () => {},
  });
  const adapter = new WorkBuddyAdapter({ environment, clientFactory });
  adapters.push(adapter);
  return { root, cwd, environment, directory, file, persist, open, prompt, adapter };
}

describe("WorkBuddy native history path", () => {
  it.each([
    ["/Users/Case.Name/Project", "Users-Case.Name-Project"],
    ["/Users/Name/项目 Space_Name", "Users-Name-项目 Space_Name"],
    ["/Work/one--two/", "Work-one-two"],
    ["C:\\Users\\Case.Name\\Project", "C-Users-Case.Name-Project"],
    ["\\\\Server\\Share\\Project", "Server-Share-Project"],
    ["/", ""],
  ])("matches native project encoding for %s", (cwd, expected) => {
    expect(WORKBUDDY_RUNTIME_PROFILE.projectDirectoryName?.(cwd)).toBe(expected);
  });

  it("sends the first Turn from an empty native file and resumes the same Desktop cwd", async () => {
    const f = await fixture();
    const opened = await f.adapter.open({ kind: "create", cwd: f.cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await opened.value.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    expect(f.open).toHaveBeenCalledWith(f.cwd, undefined);
    const completed = (async () => {
      for await (const output of opened.value.outputs)
        if (output.kind === "event" && output.event.type === "turn.completed") return output.event;
      throw new Error("Turn did not complete");
    })();
    void completed.catch(() => {});
    expect(
      await opened.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-path"),
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: true });
    expect(await completed).toMatchObject({ outcome: { status: "succeeded" } });
    expect(f.prompt).toHaveBeenCalledOnce();
    const before = await opened.value.readSnapshot();
    expect(before).toMatchObject({ ok: true, value: { turns: [{ input: [{ text: "hello" }] }] } });
    await opened.value.close();
    const resumed = await f.adapter.open({ kind: "resume", cwd: f.cwd, nativeRef: ref });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(f.open).toHaveBeenLastCalledWith(f.cwd, ref.nativeSessionId);
    const after = await resumed.value.readSnapshot();
    expect(after.ok && after.value.turns).toEqual(before.ok && before.value.turns);
  });

  it("uses the canonical directory for storage while preserving the requested cwd for ACP", async () => {
    const f = await fixture();
    await f.persist();
    const alias = path.join(f.root, "Desktop-Link");
    await symlink(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const opened = await f.adapter.open({ kind: "resume", cwd: alias, nativeRef: ref });
    expect(opened.ok).toBe(true);
    expect(f.open).toHaveBeenCalledWith(alias, ref.nativeSessionId);
  });

  it("still rejects a Session found only in a different project's directory", async () => {
    const f = await fixture();
    const otherCwd = path.join(f.root, "Other.Project");
    await mkdir(otherCwd);
    await expect(
      codeBuddyNativeHistory(otherCwd, ref, f.environment, WORKBUDDY_RUNTIME_PROFILE),
    ).rejects.toMatchObject({
      code: "invalidRequest",
      message: "Native Session is not stored in the requested working directory",
    });
  });

  it("still rejects foreign cwd records even when the filename is in the expected directory", async () => {
    const f = await fixture();
    const otherCwd = path.join(f.root, "Other.Project");
    await mkdir(otherCwd);
    await f.persist(otherCwd);
    await expect(
      codeBuddyNativeHistory(f.cwd, ref, f.environment, WORKBUDDY_RUNTIME_PROFILE),
    ).rejects.toMatchObject({
      code: "invalidRequest",
      message: "Native Session belongs to a different working directory",
    });
  });
});
