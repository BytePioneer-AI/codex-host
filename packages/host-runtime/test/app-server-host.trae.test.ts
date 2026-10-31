import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  answerOfficialParentCwd,
  closeFixture,
  createFixture,
  stopFixture,
} from "./app-server-host-fixture.js";

it("loads relocated Trae and receives, reads and continues a delegated Thread across Host restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trae-host-plugin-"));
  const plugins = path.join(root, "plugins");
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  await cp(path.resolve("packages/host-runtime/dist/plugins/trae"), path.join(plugins, "trae"), {
    recursive: true,
  });
  await writeFile(
    path.join(plugins, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["trae"] }),
  );
  const native = path.resolve("packages/adapters/trae/test/fixtures/app-server.mjs");
  const command = path.join(root, process.platform === "win32" ? "traecli.cmd" : "traecli");
  await writeFile(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${native}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${native}' "$@"\n`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    CODEXHOST_TRAE_COMMAND: command,
    TRAE_TEST_STORE: path.join(root, "native.json"),
    TRAE_TEST_LOG: path.join(root, "requests.jsonl"),
  };
  let control: DelegationControlApi | undefined;
  const options = {
    pluginDirectory: plugins,
    environment,
    onDelegationApi: (api: DelegationControlApi) => {
      control = api;
      return undefined;
    },
  };
  let fixture = createFixture(options);
  try {
    await fixture.ready;
    if (!control) throw new Error("Missing public delegation API");
    expect((await control.inspect({ harnessId: "trae", cwd })).inspection.status).toBe("ready");
    const accepting = control.start({
      harnessId: "trae",
      cwd,
      parentThreadId: "parent-thread",
      task: "Reply hello",
    });
    await answerOfficialParentCwd(fixture);
    const started = await accepting;
    const read = { threadId: started.threadId, view: "result" as const };
    const first = await control.wait({ ...read, timeoutMs: 10000 });
    expect(first.status).toBe("completed");
    expect(first.result.text).toContain("Hello 世界");
    const before = JSON.parse(await readFile(environment.TRAE_TEST_STORE, "utf8"));
    expect(Object.keys(before)).toHaveLength(1);
    const store = fixture.mappingStoreDirectory;
    await closeFixture(fixture);
    fixture = createFixture({ ...options, mappingStoreDirectory: store });
    await fixture.ready;
    if (!control) throw new Error("Missing restarted delegation API");
    await control.send({ threadId: started.threadId, message: "Continue hello" });
    const second = await control.wait({ ...read, timeoutMs: 10000 });
    expect(second.status).toBe("completed");
    expect((await control.read(read)).result.text).toContain("Hello 世界");
    const after = JSON.parse(await readFile(environment.TRAE_TEST_STORE, "utf8"));
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.values(after)).toEqual([
      expect.objectContaining({ turns: [expect.anything(), expect.anything()] }),
    ]);
    // Host starts its official peer, but the external prompt stays on Trae.
    expect(fixture.spawnOfficial.mock.calls.length).toBe(1);
    expect(String(fixture.official.stdin.read() ?? "").includes('"method":"turn/start"')).toBe(
      false,
    );
  } finally {
    await stopFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
