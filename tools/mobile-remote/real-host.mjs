// Isolated Host store and working directory; native Harness keeps its own authentication.
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { MappingStore } from "@codexhost/mapping-store";
import { startLocalSharedHost } from "../../packages/host-runtime/dist/local-shared-host.js";
import { connectHost } from "./synthetic-host.mjs";

export async function startRealHost({
  createOfficialConnection,
  onReady,
  dataDirectory,
  threadId,
  harness = "opencode",
} = {}) {
  if (!["opencode", "claude-code"].includes(harness))
    throw new Error("Unsupported validation Harness");
  const directory =
    dataDirectory ??
    (await mkdtemp(path.resolve(".codexhost/mobile-remote-implementation/real-host-")));
  // Keep the Unix socket short enough for macOS sockaddr_un.
  const socketDirectory = await mkdtemp("/tmp/ch-real-socket-");
  const socketPath = path.join(socketDirectory, "host.sock");
  let runtime;
  let desktop;
  try {
    const plugins = path.join(directory, "plugins");
    await mkdir(plugins, { recursive: true });
    for (const id of ["opencode", "claude-code"])
      await cp(path.resolve("packages/host-runtime/dist/plugins", id), path.join(plugins, id), {
        recursive: true,
      });
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["opencode", "claude-code"] }),
    );
    const cwd = path.join(directory, "work");
    await mkdir(cwd, { recursive: true });
    const environment = { ...process.env, CODEXHOST_DATA_DIR: directory };
    runtime = await startLocalSharedHost({
      socketPath,
      common: {
        stockCodexPath: "/nonexistent/explicit-native-connection",
        externalOnly: !createOfficialConnection,
        arguments: [],
        environment,
        mappingStore: new MappingStore({ directory: path.join(directory, "store") }),
        pluginRoots: [plugins],
        pluginContext: { environment, platform: process.platform, managedRemoteHost: false },
        createOfficialConnection,
        diagnosticOutput: process.stderr,
      },
    });
    await onReady?.(socketPath);
    desktop = await connectHost(socketPath, "real-harness-validation", 30000);
    const { thread } = threadId
      ? await desktop.request("thread/resume", { threadId })
      : await desktop.request("thread/start", { model: `codexhost/${harness}-native`, cwd });
    const title = `${harness} 手机验证（真实）${thread.id.slice(-8)}`;
    await desktop.request("thread/name/set", { threadId: thread.id, name: title });
    return {
      directory,
      socketPath,
      threadId: thread.id,
      title,
      desktop,
      async close() {
        await desktop.close();
        await runtime.close();
        await rm(socketDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await desktop?.close();
    await runtime?.close();
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
}
