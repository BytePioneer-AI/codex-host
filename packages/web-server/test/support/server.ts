/** Isolated server process shared by browser and packed-distribution checks. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { FakeChHost, startFakeChDebugger } from "./ch-host.ts";
import { seedWebExtension } from "./web-extension.ts";
import { defined } from "./defined.ts";
import { fakeTailscale } from "./tailscale.ts";

/**
 * Start the real entry point on an OS-assigned port with disposable data and workspace directories.
 * @param t - test owner of the child process and its data.
 * @param cwd - server working directory.
 * @param entry - Node arguments preceding server options (source or packed entry).
 * @param args - additional server options.
 * @returns the listening URL.
 */
export async function startServer(
  t: TestContext,
  cwd: string,
  entry: string[],
  args: string[],
  options: {
    authenticated?: boolean;
    /** Exercise the entry point's default rather than supplying a temporary --data. */
    useDefaultData?: boolean;
    environment?: NodeJS.ProcessEnv;
    onSpawn?: (child: ChildProcess) => void;
  } = {},
): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), "codexhost-web-test-"));
  // UI-only checks may target an already packaged server, without compiling
  // unrelated runtime work in progress. Distribution tests keep their own entry.
  const bundle = process.env.CODEXHOST_TEST_WEB_BUNDLE;
  const packedEntry = bundle && entry.includes("src/main.ts") ? resolve(bundle) : undefined;
  const serverEntry = packedEntry ? [packedEntry] : entry;
  const hostArgs: string[] = [];
  if (!["--ch-cdp", "--ch-control-directory", "--ch-data"].some((flag) => args.includes(flag))) {
    const debuggerServer = await startFakeChDebugger(new FakeChHost());
    t.after(() => debuggerServer.close());
    hostArgs.push("--ch-cdp", debuggerServer.endpoint);
  }
  const extension = process.env.CODEXHOST_TEST_WEB_EXTENSION_DIRECTORY;
  const fixtureData = args.includes("--data")
    ? defined(args[args.lastIndexOf("--data") + 1])
    : data;
  const extensionId = extension ? seedWebExtension(fixtureData, extension).id : undefined;
  const tailscale = options.environment?.PATH === undefined ? fakeTailscale(t) : undefined;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CODEXHOST_") && key !== "NODE_OPTIONS" && key !== "NODE_PATH",
    ),
  );
  const child = spawn(
    process.execPath,
    [
      ...serverEntry,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      ...(options.useDefaultData ? [] : ["--data", data]),
      "--workspace",
      join(data, "workspace"),
      ...(options.authenticated || extension ? [] : ["--no-auth"]),
      ...hostArgs,
      ...args,
    ],
    {
      cwd: packedEntry ? dirname(packedEntry) : cwd,
      env: {
        ...environment,
        ...tailscale?.environment,
        HOME: data,
        USERPROFILE: data,
        LOCALAPPDATA: data,
        XDG_RUNTIME_DIR: data,
        CODEXHOST_DATA_DIR: join(data, "host"),
        CODEX_HOME: join(data, "codex"),
        CODEXHOST_CONSOLE_PORT: "4499",
        SSH_CONNECTION: "smoke",
        PATH: tailscale?.environment.PATH ?? "/usr/bin:/bin",
        ...options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  options.onSpawn?.(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      await exited;
      clearTimeout(timeout);
    }
    rmSync(data, { recursive: true, force: true });
  });
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(
      () => reject(new Error(`Server startup timed out: ${output}`)),
      15_000,
    );
    const finish = (): void => {
      clearTimeout(timeout);
      lines.close();
      child.stdout.resume();
    };
    lines.on("line", (line) => {
      const match = /^codexhost web: (http:\/\/\S+)/u.exec(line);
      if (match !== null) {
        finish();
        resolve(match[1] as string);
      }
    });
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", () => {
      finish();
      reject(new Error(`Server exited before listening: ${output}`));
    });
  });
  if (extensionId) {
    const token = new URL(url).searchParams.get("token");
    const method = "codexhost/uiExtensions/list";
    const response = await fetch(new URL(`/api/${method}`, url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "fixture",
        method,
        payload: { args: {} },
      }),
    });
    const reply = (await response.json()) as { result: { value?: { loadedIds: string[] } } };
    if (!reply.result.value?.loadedIds.includes(extensionId))
      throw new Error(`Extension fixture failed to load: ${JSON.stringify(reply)}`);
  }
  return url;
}
