import { describe, expect, it, vi } from "vitest";
import {
  CONSOLE_REMOTE_CONNECTIONS_METHOD,
  REMOTE_SSH_SETUP_METHOD,
  RUNTIME_STATUS_METHOD,
} from "@codexhost/shared-contracts";
import { createConsoleRemoteConnections } from "../src/console/remote-connections.js";
import { handleRemoteConnectionsRequest } from "../src/remote-connections-request.js";
import type { RemoteConnectionsControl } from "../src/remote-connections-control.js";

const connection = {
  hostId: "office",
  displayName: "公司",
  source: "codex-managed" as const,
  sshAlias: "office-alias",
  sshHost: "dev@office",
  sshPort: 2222,
  identity: "/keys/id",
  autoConnect: true,
};
const status = {
  runningVersion: "0.12.0",
  installedVersion: "0.12.0",
  restartRequired: false,
  remote: true,
  updateSupported: true,
  update: { phase: "idle" as const, targetVersion: null, error: null },
};
function fixture() {
  const native: RemoteConnectionsControl = {
    ssh: {
      list: vi.fn(async () => [connection]),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      connect: vi.fn(async () => {}),
      state: vi.fn(async () => ({ state: "connected", error: null })),
    },
    setup: vi.fn(async () => ({ state: "installed" as const })),
    runtime: vi.fn(async () => status),
    update: vi.fn(async () => status),
  };
  const sendRequest = vi.fn(async (method: string, params: unknown) => {
    if (method === CONSOLE_REMOTE_CONNECTIONS_METHOD)
      return handleRemoteConnectionsRequest(native, params);
    if (method === RUNTIME_STATUS_METHOD) return { ...status, remote: false };
    if (method === REMOTE_SSH_SETUP_METHOD) return { state: "not-installed" };
    throw new Error("Unexpected method");
  });
  return { native, sendRequest, web: createConsoleRemoteConnections({ sendRequest }) };
}

describe("Web remote connections transport", () => {
  it("uses the embedded settings operations and preserves their errors", async () => {
    const { native, web } = fixture();
    expect(await web.ssh.list()).toEqual([connection]);
    const draft = {
      displayName: "新名称",
      hostname: "dev@office",
      sshPort: 2222,
      identity: "/keys/id",
    };
    await web.ssh.save(draft, connection);
    expect(native.ssh.save).toHaveBeenCalledWith(draft, connection);
    await web.ssh.connect("office", false);
    expect(native.ssh.connect).toHaveBeenCalledWith("office", false);
    expect(await web.ssh.state("office")).toEqual({ state: "connected", error: null });
    await web.ssh.remove(connection);
    expect(native.ssh.remove).toHaveBeenCalledWith(connection);
    vi.mocked(native.ssh.save).mockRejectedValueOnce(
      new Error("SSH connection changed; refresh before saving"),
    );
    await expect(web.ssh.save(draft, connection)).rejects.toThrow("refresh before saving");
    vi.mocked(native.runtime).mockRejectedValueOnce(
      Object.assign(new Error("unsupported"), { code: -32601 }),
    );
    await expect(web.runtime("office")).rejects.toMatchObject({ code: -32601 });
  });

  it("reads local runtime directly, targets remote updates, and forwards every SSH action", async () => {
    const { native, web, sendRequest } = fixture();
    expect((await web.runtime("local")).remote).toBe(false);
    expect(await web.runtime("office")).toEqual(status);
    await web.update("office", "0.12.0");
    expect(native.update).toHaveBeenCalledWith("office", "0.12.0");
    await expect(web.update("local", "0.12.0")).rejects.toThrow();
    for (const action of ["inspect", "install", "update", "repair", "uninstall"] as const) {
      await web.setup(connection, action, "0.12.0", true);
      expect(sendRequest).toHaveBeenLastCalledWith(REMOTE_SSH_SETUP_METHOD, {
        hostname: "office-alias",
        port: 2222,
        identity: "/keys/id",
        action,
        version: "0.12.0",
        ...(action === "uninstall" ? { uninstallPackage: true } : {}),
      });
    }
    await web.setup({ ...connection, sshAlias: null }, "uninstall");
    expect(sendRequest).toHaveBeenLastCalledWith(REMOTE_SSH_SETUP_METHOD, {
      hostname: "dev@office",
      port: 2222,
      identity: "/keys/id",
      action: "uninstall",
      version: null,
      uninstallPackage: false,
    });
    expect(native.setup).not.toHaveBeenCalled();
  });
});
