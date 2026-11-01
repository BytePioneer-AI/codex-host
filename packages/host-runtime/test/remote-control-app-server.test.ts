import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { officialEnvironment } from "../src/app-server-host.js";
import { createRemoteAppServerWebSocketListener } from "../src/remote-app-server.js";
import {
  REMOTE_CONTROL_BRIDGE_NODE_ENV,
  REMOTE_CONTROL_BRIDGE_PIPE_ENV,
  REMOTE_CONTROL_BRIDGE_RUNTIME_ENV,
  createRemoteControlAppServerPlan,
  nodeCompatibleWindowsPath,
  publishRemoteControlAppServerDescriptor,
  remoteControlBridgeDescriptorPath,
  remoteControlBridgePipePath,
} from "../src/remote-control-app-server.js";

describe("Remote Control app-server bridge", () => {
  it("publishes Node-compatible equivalents of Win32 extended-length paths", () => {
    expect(nodeCompatibleWindowsPath("\\\\?\\C:\\Program Files\\nodejs\\node.exe")).toBe(
      "C:\\Program Files\\nodejs\\node.exe",
    );
    expect(nodeCompatibleWindowsPath("\\\\?\\UNC\\server\\share\\host-runtime.mjs")).toBe(
      "\\\\server\\share\\host-runtime.mjs",
    );
    expect(nodeCompatibleWindowsPath("C:\\codexhost\\host-runtime.mjs")).toBe(
      "C:\\codexhost\\host-runtime.mjs",
    );
  });

  it("removes extended-length prefixes from the published Windows plan", () => {
    const plan = createRemoteControlAppServerPlan({
      arguments: ["-c", "features.code_mode_host=true", "app-server"],
      environment: {
        CODEXHOST_HOST_NODE_PATH: "\\\\?\\C:\\Program Files\\nodejs\\node.exe",
        CODEXHOST_HOST_RUNTIME_PATH: "\\\\?\\C:\\codexhost\\host-runtime.mjs",
        LOCALAPPDATA: path.resolve("fixture", "local-app-data"),
      },
      platform: "win32",
      processId: 41,
      instanceId: "extended-paths",
    });

    expect(plan?.descriptor.nodePath).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(plan?.descriptor.runtimePath).toBe("C:\\codexhost\\host-runtime.mjs");
    expect(plan?.officialArguments).toEqual(["-c", "features.code_mode_host=true", "app-server"]);
    expect(plan?.environment).toMatchObject({
      [REMOTE_CONTROL_BRIDGE_NODE_ENV]: "C:\\Program Files\\nodejs\\node.exe",
      [REMOTE_CONTROL_BRIDGE_RUNTIME_ENV]: "C:\\codexhost\\host-runtime.mjs",
    });
  });

  it("creates a private Windows named-pipe plan from launcher-owned runtime paths", () => {
    const nodePath = path.resolve("fixture", "node.exe");
    const runtimePath = path.resolve("fixture", "host-runtime.mjs");
    const environment = {
      CODEXHOST_HOST_NODE_PATH: nodePath,
      CODEXHOST_HOST_RUNTIME_PATH: runtimePath,
      CODEX_HOME: path.resolve("fixture", "codex-home"),
      LOCALAPPDATA: path.resolve("fixture", "local-app-data"),
    };

    const plan = createRemoteControlAppServerPlan({
      arguments: ["app-server", "--analytics-default-enabled"],
      environment,
      platform: "win32",
      processId: 42,
      instanceId: "fixture-id",
    });

    expect(plan).not.toBeNull();
    expect(plan?.pipePath).toBe("\\\\.\\pipe\\codexhost-remote-control-42-fixture-id");
    expect(plan?.descriptorPath).toBe(
      path.join(environment.LOCALAPPDATA, "codexhost", "remote-control-bridge-v1.json"),
    );
    expect(plan?.descriptor).toEqual({
      schemaVersion: 1,
      ownerPid: 42,
      pipePath: plan?.pipePath,
      nodePath,
      runtimePath,
    });
    expect(plan?.officialArguments).toEqual(["app-server", "--analytics-default-enabled"]);
    expect(plan?.environment).toEqual({
      ...environment,
      [REMOTE_CONTROL_BRIDGE_PIPE_ENV]: plan?.pipePath,
      [REMOTE_CONTROL_BRIDGE_NODE_ENV]: nodePath,
      [REMOTE_CONTROL_BRIDGE_RUNTIME_ENV]: runtimePath,
    });
    expect(environment).not.toHaveProperty(REMOTE_CONTROL_BRIDGE_PIPE_ENV);
  });

  it("does not expose the bridge on non-Windows Hosts", () => {
    expect(
      createRemoteControlAppServerPlan({
        arguments: ["app-server"],
        environment: {
          CODEXHOST_HOST_NODE_PATH: "/opt/codexhost/node",
          CODEXHOST_HOST_RUNTIME_PATH: "/opt/codexhost/host-runtime.mjs",
        },
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("advertises only the restricted bridge endpoint to the stock app-server child", () => {
    const plan = createRemoteControlAppServerPlan({
      arguments: ["app-server"],
      environment: {
        CODEXHOST_HOST_NODE_PATH: path.resolve("fixture", "node.exe"),
        CODEXHOST_HOST_RUNTIME_PATH: path.resolve("fixture", "host-runtime.mjs"),
        LOCALAPPDATA: path.resolve("fixture", "local-app-data"),
      },
      platform: "win32",
      processId: 11,
      instanceId: "child-env",
    });
    expect(plan).not.toBeNull();

    const childEnvironment = officialEnvironment(plan?.environment ?? {});
    expect(childEnvironment).not.toHaveProperty("CODEXHOST_HOST_NODE_PATH");
    expect(childEnvironment).not.toHaveProperty("CODEXHOST_HOST_RUNTIME_PATH");
    expect(childEnvironment).toMatchObject({
      [REMOTE_CONTROL_BRIDGE_PIPE_ENV]: plan?.pipePath,
      [REMOTE_CONTROL_BRIDGE_NODE_ENV]: path.resolve("fixture", "node.exe"),
      [REMOTE_CONTROL_BRIDGE_RUNTIME_ENV]: path.resolve("fixture", "host-runtime.mjs"),
    });
  });

  it("fails closed when launcher-owned executable paths are missing or relative", () => {
    expect(
      createRemoteControlAppServerPlan({
        arguments: ["app-server"],
        environment: {
          CODEXHOST_HOST_NODE_PATH: "node.exe",
          CODEXHOST_HOST_RUNTIME_PATH: "host-runtime.mjs",
          LOCALAPPDATA: path.resolve("fixture", "local-app-data"),
        },
        platform: "win32",
      }),
    ).toBeNull();
  });

  it("requires a private absolute Windows rendezvous directory", () => {
    expect(remoteControlBridgeDescriptorPath({})).toBeNull();
    expect(remoteControlBridgeDescriptorPath({ LOCALAPPDATA: "relative" })).toBeNull();
  });

  it("atomically publishes the current Host Runtime rendezvous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-control-descriptor-"));
    try {
      const plan = createRemoteControlAppServerPlan({
        arguments: ["app-server"],
        environment: {
          CODEXHOST_HOST_NODE_PATH: path.resolve("fixture", "node.exe"),
          CODEXHOST_HOST_RUNTIME_PATH: path.resolve("fixture", "host-runtime.mjs"),
          LOCALAPPDATA: root,
        },
        platform: "win32",
        processId: 71,
        instanceId: "descriptor",
      });
      expect(plan).not.toBeNull();
      if (plan === null) throw new Error("Expected a Windows Remote Control plan");
      await publishRemoteControlAppServerDescriptor(plan);
      expect(JSON.parse(await readFile(plan.descriptorPath, "utf8"))).toEqual(plan.descriptor);

      const replacement = createRemoteControlAppServerPlan({
        arguments: ["app-server"],
        environment: {
          CODEXHOST_HOST_NODE_PATH: path.resolve("fixture", "node.exe"),
          CODEXHOST_HOST_RUNTIME_PATH: path.resolve("fixture", "host-runtime.mjs"),
          LOCALAPPDATA: root,
        },
        platform: "win32",
        processId: 72,
        instanceId: "replacement",
      });
      expect(replacement).not.toBeNull();
      if (replacement === null) throw new Error("Expected a replacement Remote Control plan");
      await publishRemoteControlAppServerDescriptor(replacement);
      expect(JSON.parse(await readFile(replacement.descriptorPath, "utf8"))).toEqual(
        replacement.descriptor,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes the random pipe identity without accepting an empty identity", () => {
    expect(remoteControlBridgePipePath(7, "safe:fixture/id")).toBe(
      "\\\\.\\pipe\\codexhost-remote-control-7-safefixtureid",
    );
    expect(() => remoteControlBridgePipePath(7, "///")).toThrow(
      "Remote Control bridge instance ID is invalid",
    );
  });

  it.runIf(process.platform === "win32")(
    "carries LF app-server frames through a real named-pipe bridge process",
    async () => {
      const pipePath = remoteControlBridgePipePath(
        process.pid,
        `integration-${Date.now().toString(16)}`,
      );
      const listener = createRemoteAppServerWebSocketListener({
        socketPath: pipePath,
        diagnosticOutput: new PassThrough(),
        createSession: ({ input, output }) => ({
          async run() {
            for await (const chunk of input) output.write(chunk);
            output.end();
            return 0;
          },
          disconnect() {
            (input as PassThrough).end();
          },
          close() {
            input.destroy();
          },
        }),
      });
      await listener.listen();
      const child = spawn(
        process.execPath,
        [path.resolve("packages/host-runtime/dist/main.js"), "--codexhost-remote-control-bridge"],
        {
          env: { ...process.env, [REMOTE_CONTROL_BRIDGE_PIPE_ENV]: pipePath },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      try {
        await vi.waitFor(
          () =>
            expect({ stdout, stderr, exitCode: child.exitCode }).toMatchObject({
              stdout: expect.stringContaining('"codexhost/remote-control-bridge/ready"'),
              exitCode: null,
            }),
          { timeout: 10_000 },
        );
        child.stdin.write('{"id":7,"method":"fixture/echo"}\n');
        await vi.waitFor(
          () =>
            expect({ stdout, stderr, exitCode: child.exitCode }).toMatchObject({
              stdout: expect.stringContaining('{"id":7,"method":"fixture/echo"}'),
              exitCode: null,
            }),
          { timeout: 10_000 },
        );
        child.stdin.end();
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
      } finally {
        child.kill();
        await listener.close();
      }
    },
  );
});
