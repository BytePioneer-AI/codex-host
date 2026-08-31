import { describe, expect, it } from "vitest";

import {
  provisionRemoteSshGrokHost,
  remoteGrokProvisionScript,
  resolveRemoteSshProvisionTarget,
} from "../src/remote-ssh-provision.js";

function occupancyJson(ownerCommand: string | null): string {
  return `${JSON.stringify({ grokPath: "/usr/bin/grok", ownerCommand })}\n`;
}

describe("remote SSH Grok provisioning", () => {
  it("resolves the SSH target from the Desktop Host ID", () => {
    expect(resolveRemoteSshProvisionTarget({ hostId: "remote-ssh-discovered:uts" })).toBe("uts");
  });

  it("refuses to run on a managed remote Host", async () => {
    await expect(
      provisionRemoteSshGrokHost({
        params: { hostId: "remote-ssh-discovered:uts" },
        environment: { CODEXHOST_REMOTE_SSH_MANAGED: "1" },
      }),
    ).rejects.toThrow("本机 Desktop");
  });

  it("rewrites the native wrapper to a Node entrypoint when glibc is too old", () => {
    const script = remoteGrokProvisionScript(false);
    expect(script).toContain("原生入口需要更高 glibc，已改用 Node 入口");
    expect(script).toContain("// codexhost remote SSH node entrypoint v1");
  });

  it("blocks automatic install when an official remote-control daemon owns the socket", async () => {
    const result = await provisionRemoteSshGrokHost({
      params: { hostId: "remote-ssh-discovered:uts" },
      environment: { HOME: "/tmp" },
      dependencies: {
        async spawnSsh(_sshTarget, script, onChunk) {
          expect(script).toContain("ownerCommand");
          onChunk(occupancyJson("codex app-server --remote-control --listen unix://"));
          return 0;
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "official-remote-control",
      reconnectRequired: false,
    });
  });

  it("does not write a remote install when occupancy is unknown", async () => {
    let installed = false;
    await provisionRemoteSshGrokHost({
      params: { hostId: "remote-ssh-discovered:uts" },
      environment: { HOME: "/tmp" },
      dependencies: {
        async spawnSsh(_sshTarget, script, onChunk) {
          if (script.includes("codexhost remote install")) installed = true;
          onChunk(occupancyJson("some-other-listener"));
          return 0;
        },
      },
    });
    expect(installed).toBe(false);
  });

  it("rolls back if remote start fails after install", () => {
    const script = remoteGrokProvisionScript(false);
    expect(script).toContain("codexhost remote uninstall");
    expect(script).toContain("正在回滚远程 Host 安装");
    expect(script).not.toContain("Install finished. Reopen this remote project to attach");
  });

  it("stops the official daemon only when replace is requested", () => {
    expect(remoteGrokProvisionScript(false)).not.toContain("--remote-control");
    expect(remoteGrokProvisionScript(true)).toContain("--remote-control");
  });

  it("restores the official Codex SSH daemon if a replace install rolls back", () => {
    const replace = remoteGrokProvisionScript(true);
    expect(replace).toContain("codex app-server daemon start");
    expect(replace).toContain("正在恢复这条 SSH 连接的官方 Codex SSH daemon");
    expect(remoteGrokProvisionScript(false)).not.toContain("codex app-server daemon start");
  });

  it("streams SSH output and reports reconnect after a successful idle install", async () => {
    const logs: string[] = [];
    const result = await provisionRemoteSshGrokHost({
      params: { hostId: "remote-ssh-discovered:uts" },
      environment: { HOME: "/tmp" },
      onLog: (chunk) => {
        logs.push(chunk);
      },
      dependencies: {
        async spawnSsh(_sshTarget, script, onChunk) {
          if (script.includes("ownerCommand")) {
            onChunk(occupancyJson(null));
            return 0;
          }
          expect(script).toContain("codexhost remote install");
          onChunk("npm install ok\n");
          return 0;
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reconnectRequired).toBe(true);
    expect(logs.join("")).toContain("npm install ok");
  });
});
