// Explicit isolated acceptance entry; never starts the installed Desktop or reads its auth.
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { startNativeServer } from "./native-session.mjs";
import { startSyntheticHost } from "./synthetic-host.mjs";
import { startRealHost } from "./real-host.mjs";
import {
  startModelPickerProbe,
  installSyntheticReplies,
  configureReadonlyProbe,
} from "./model-picker-probe.mjs";
import { syntheticControl } from "./synthetic-controls.mjs";

const [mode, argument] = process.argv.slice(2);
if (
  !["prepare", "start", "start-real", "start-models"].includes(mode) ||
  !argument ||
  !path.isAbsolute(argument)
) {
  console.log(
    "Usage: node tools/mobile-remote/phone-probe.mjs prepare /absolute/patched-binary\n       node tools/mobile-remote/phone-probe.mjs start|start-real|start-models /absolute/probe-home",
  );
  process.exitCode = 2;
} else if (mode === "prepare") {
  const sha256 = createHash("sha256")
    .update(await readFile(argument))
    .digest("hex");
  const home = await mkdtemp("/tmp/ch-phone-probe-");
  await chmod(home, 0o700);
  await writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', {
    mode: 0o600,
  });
  await writeFile(
    path.join(home, "probe.json"),
    JSON.stringify({ binary: argument, sha256, source: "rust-v0.160.0", synthetic: true }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        home,
        next: "Complete official login with this isolated CODEX_HOME, then run start. No login or enrollment has been performed.",
      },
      null,
      2,
    ),
  );
} else {
  const home = argument;
  const manifest = JSON.parse(await readFile(path.join(home, "probe.json"), "utf8"));
  const hash = createHash("sha256")
    .update(await readFile(manifest.binary))
    .digest("hex");
  if (hash !== manifest.sha256) throw new Error("Probe binary changed; prepare a new probe");
  // Existence only: credentials are consumed exclusively by the official server.
  await import("node:fs/promises").then(({ access }) => access(path.join(home, "auth.json")));
  let native;
  let picker;
  let stopReplies;
  let host;
  let environmentId;
  let mayRevoke = false;
  let stopped = false;
  const stop = Promise.withResolvers();
  const requestStop = () => {
    stopped = true;
    stop.resolve();
  };
  const lifetime = mode === "start-models" ? setTimeout(requestStop, 15 * 60 * 1000) : undefined;
  lifetime?.unref();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const input = createInterface({ input: process.stdin });
  let controls = Promise.resolve();
  input.on("line", (line) => {
    const command = line.trim();
    if (command === "stop") return requestStop();
    controls = controls.then(async () => {
      if (stopped) return;
      try {
        if (mode === "start-models") {
          if (command !== "status") throw new Error("Model probe accepts status or stop");
          console.log(JSON.stringify(picker.observations, null, 2));
        } else if (mode === "start-real") {
          if (command !== "status")
            throw new Error(
              "Real Harness accepts status or stop; replies must come from the model",
            );
          console.log(
            JSON.stringify(
              await host.desktop.request("thread/read", {
                threadId: host.threadId,
                includeTurns: true,
              }),
              null,
              2,
            ),
          );
        } else console.log(JSON.stringify(await syntheticControl(host, command), null, 2));
      } catch (error) {
        console.error(error.message);
      }
    });
  });
  input.once("close", requestStop);
  input.once("error", (error) => {
    console.error(`Test terminal disconnected: ${error.code ?? "unknown"}`);
    requestStop();
  });
  try {
    host = await (mode === "start-real" ? startRealHost : startSyntheticHost)({
      allowAdditionalSessions: mode === "start-models",
      onReady: async (socketPath, adapter) => {
        if (mode === "start-models") {
          picker = await startModelPickerProbe({
            upstream: socketPath,
            socketPath: path.join(path.dirname(socketPath), "picker.sock"),
            adapter,
            report: path.join(home, "model-picker-observations.jsonl"),
          });
          socketPath = path.join(path.dirname(socketPath), "picker.sock");
        }
        native = await startNativeServer({
          binary: manifest.binary,
          home,
          hostSocket: socketPath,
          diagnosticFile: path.join(home, "app-server.log"),
        });
        void native.closed.then(requestStop);
      },
      createOfficialConnection: () => native.connect(),
    });
    host.adapter?.sessions[0].completeCancellationOnRequest();
    if (mode === "start-models") {
      stopReplies = installSyntheticReplies(host.adapter);
      console.log(
        JSON.stringify({ readonlyProbe: await configureReadonlyProbe(native, host.directory) }),
      );
    }
    const deadline = Date.now() + 60000;
    while (!stopped && Date.now() < deadline) {
      const status = await native.request("remoteControl/status/read");
      if (status.status === "connected" && status.environmentId) {
        environmentId = status.environmentId;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!environmentId || stopped)
      throw new Error(
        "Isolated Remote Control did not become ready; inspect private diagnostic log",
      );
    const clients = await native.request("remoteControl/client/list", {
      environmentId,
      limit: 100,
      order: "asc",
    });
    if (clients.data.length || clients.nextCursor)
      throw new Error("Environment already has paired clients; stopped without revoking them");
    mayRevoke = true;
    const pairing = await native.request("remoteControl/pairing/start", { manualCode: true });
    if (pairing.environmentId !== environmentId) throw new Error("Pairing environment mismatch");
    console.log(
      JSON.stringify(
        {
          title: host.title,
          threadId: host.threadId,
          manualPairingCode: pairing.manualPairingCode,
          expiresAt: pairing.expiresAt,
          instruction:
            mode === "start-models"
              ? "模型协议探针：查看测试 A/B 的显示名称，选择测试 B 并发送一条文字；回复为合成，不调用真实模型。"
              : mode === "start-real"
                ? "真实 Harness 测试：在手机打开会话，要求只回复指定文字、不使用工具。终端输入 status 检查，stop 结束。"
                : "在手机中配对此测试入口并打开合成会话。先检查历史；测试终端可输入 status 查看、reply 回复、stop 结束。真实 Harness 尚未接入此试机。",
        },
        null,
        2,
      ),
    );
    await stop.promise;
  } finally {
    clearTimeout(lifetime);
    input.close();
    if (native && environmentId && mayRevoke) {
      try {
        const clients = await native.request("remoteControl/client/list", {
          environmentId,
          limit: 100,
          order: "asc",
        });
        for (const client of clients.data)
          await native.request("remoteControl/client/revoke", {
            environmentId,
            clientId: client.clientId,
          });
        if (clients.nextCursor) console.error("Additional test pairings require manual cleanup");
      } catch {
        console.error("Could not revoke test pairing; remove this test computer on the phone.");
      }
    }
    if (native) {
      try {
        await native.request("remoteControl/disable", { ephemeral: true });
      } catch {
        /* Closing the owned process below also disconnects this test server. */
      }
      console.log(JSON.stringify({ cleanup: await native.close() }));
    }
    stopReplies?.();
    await picker?.close();
    await host?.close();
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}
