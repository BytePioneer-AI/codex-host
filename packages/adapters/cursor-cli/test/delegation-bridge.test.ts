import { mkdtemp, writeFile, chmod, rm, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import { PassThrough } from "node:stream";
import { runDelegationCli } from "@codexhost/host-runtime";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCursorDelegationBridge } from "../src/delegation-bridge.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function setup(thread = "parent-one", timeoutMs?: number) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cursor-delegation-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const cli = path.join(cwd, "host-cli");
  await writeFile(
    cli,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),parent:process.env.CODEXHOST_THREAD_ID,endpoint:process.env.CODEXHOST_RUNTIME_ENDPOINT,cwd:process.cwd()}));\n`,
  );
  await chmod(cli, 0o755);
  const bridge = await createCursorDelegationBridge(
    cwd,
    {
      ...process.env,
      CODEXHOST_CLI_PATH: cli,
      CODEXHOST_RUNTIME_ENDPOINT: "http://synthetic-host.invalid",
      CODEXHOST_RUNTIME_TOKEN: "synthetic-secret",
      CODEXHOST_THREAD_ID: thread,
    },
    timeoutMs,
  );
  if (!bridge || !("url" in bridge.descriptor)) throw new Error("missing bridge");
  cleanup.push(() => bridge.close());
  const client = new Client({ name: "cursor-bridge-test", version: "1" });
  cleanup.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(bridge.descriptor.url), {
    requestInit: {
      headers: Object.fromEntries(
        bridge.descriptor.headers.map(({ name, value }) => [name, value]),
      ),
    },
  });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return { cwd, bridge, client, cli };
}

describe.skipIf(process.platform === "win32")("Cursor native MCP delegation bridge", () => {
  it("advertises bounded tools and preserves exact arguments, parent and session environment", async () => {
    const f = await setup();
    const { tools } = await f.client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "delegate_start",
      "harness_inspect",
      "harness_list",
      "thread_cancel",
      "thread_read",
      "thread_send",
      "thread_wait",
    ]);
    const text = "Inspect $(touch injected) and `echo unsafe` exactly";
    const result = await f.client.callTool({
      name: "delegate_start",
      arguments: { harness: "pi", task: text, requestId: "once" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"parent":"parent-one"') }],
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual({
      args: [
        "delegate",
        "start",
        "--harness",
        "pi",
        "--task",
        text,
        "--request-id",
        "once",
        "--format",
        "compact",
      ],
      parent: "parent-one",
      endpoint: "http://synthetic-host.invalid",
      cwd: await realpath(f.cwd),
    });
  });
  it("passes a positive bounded wait through the actual Host CLI parser", async () => {
    const f = await setup();
    const result = await f.client.callTool({
      name: "thread_wait",
      arguments: { thread: "child", timeoutMs: 1 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const received = JSON.parse(content[0]?.text ?? "null") as { args: string[] };
    let body: unknown;
    const code = await runDelegationCli({
      arguments: received.args,
      environment: {
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:4321",
        CODEXHOST_RUNTIME_TOKEN: "synthetic",
      },
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl: async (_url, input) => {
        body = JSON.parse(String(input?.body));
        return new Response(
          JSON.stringify({
            threadId: "child",
            harnessId: "pi",
            status: "completed",
            progress: [],
            result: { availability: "available", text: "done" },
          }),
        );
      },
    });
    expect(code).toBe(0);
    expect(body).toEqual({ threadId: "child", view: "result", timeoutMs: 1 });
  });
  it("isolates independent sessions, rejects unauthenticated calls and removes its listener on close", async () => {
    const [a, b] = await Promise.all([setup("parent-a"), setup("parent-b")]);
    if (!("url" in a.bridge.descriptor)) throw new Error("missing URL");
    expect((await fetch(a.bridge.descriptor.url, { method: "POST" })).status).toBe(403);
    const results = await Promise.all([
      a.client.callTool({ name: "harness_list", arguments: {} }),
      b.client.callTool({ name: "harness_list", arguments: {} }),
    ]);
    expect(JSON.stringify(results[0])).toContain("parent-a");
    expect(JSON.stringify(results[1])).toContain("parent-b");
    await a.bridge.close();
    await expect(fetch(a.bridge.descriptor.url)).rejects.toThrow();
    expect(await b.client.callTool({ name: "harness_list", arguments: {} })).toMatchObject({
      content: expect.any(Array),
    });
  });
  it("refuses unbounded waits and unsupported operations before spawning a CLI", async () => {
    const f = await setup();
    expect(
      await f.client.callTool({ name: "thread_wait", arguments: { thread: "task", timeoutMs: 0 } }),
    ).toMatchObject({ isError: true });
    expect(
      await f.client.callTool({
        name: "thread_wait",
        arguments: { thread: "task", timeoutMs: 60_001 },
      }),
    ).toMatchObject({ isError: true });
    expect(
      await f.client.callTool({ name: "shell", arguments: { command: "anything" } }),
    ).toMatchObject({ isError: true });
  });
  it("redacts failed CLI output and terminates requests on timeout and bridge shutdown", async () => {
    const failed = await setup();
    await writeFile(
      failed.cli,
      "#!/usr/bin/env node\nconsole.error(process.env.CODEXHOST_RUNTIME_TOKEN);process.exit(1);\n",
    );
    const result = await failed.client.callTool({ name: "harness_list", arguments: {} });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    const timed = await setup("timeout", 50);
    await writeFile(timed.cli, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n");
    expect(await timed.client.callTool({ name: "harness_list", arguments: {} })).toMatchObject({
      isError: true,
    });
    const closing = await setup();
    const receipt = path.join(closing.cwd, "pid");
    await writeFile(
      closing.cli,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000);\n`,
    );
    const call = closing.client
      .callTool({ name: "harness_list", arguments: {} })
      .catch(() => undefined);
    let pid: number | undefined;
    for (let index = 0; index < 100 && !pid; index++) {
      pid = await readFile(receipt, "utf8")
        .then(Number)
        .catch(() => undefined);
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!pid) throw new Error("CLI never started");
    await closing.bridge.close();
    await call;
    for (let index = 0; index < 100; index++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Owned CLI survived bridge shutdown");
  });
  it("omits the bridge when delegation is unavailable and refuses a relative CLI path", async () => {
    expect(await createCursorDelegationBridge(process.cwd(), {})).toBeUndefined();
    await expect(
      createCursorDelegationBridge(process.cwd(), {
        CODEXHOST_CLI_PATH: "codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "e",
        CODEXHOST_RUNTIME_TOKEN: "t",
        CODEXHOST_THREAD_ID: "p",
      }),
    ).rejects.toThrow("absolute");
  });
});
