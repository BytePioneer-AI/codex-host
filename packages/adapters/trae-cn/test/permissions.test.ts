import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
import { readInspection } from "../src/protocol.js";
const { desktopPermissionSettings, requestedPermission } = createRequire(import.meta.url)(
  "../assets/companion/permissions.cjs",
);
function setup(
  config: unknown = {},
  dynamic: unknown = {
    iCubeApp: {
      autoRunConfig: { useNewPermissionModel: true },
      toolAutoApprove: { visible: true, default: "auto" },
    },
  },
  user: unknown = {},
) {
  const commands = {
    executeCommand: vi.fn(async (name: string) =>
      name === "icube.common.getDynamicConfig"
        ? dynamic
        : name === "icube.userConfiguration.get"
          ? user
          : "/product-data",
    ),
  };
  const fs = {
    stat: vi.fn(async () => ({ size: 128 })),
    readFile: vi.fn(async () => Buffer.from(JSON.stringify(config))),
  };
  return {
    vscode: { env: {}, commands, Uri: { file: vi.fn((file: string) => file) }, workspace: { fs } },
    commands,
    fs,
  };
}
describe("TRAE CN native permission policy", () => {
  it("rejects malformed bridge permission catalogs before public projection", () => {
    const base = {
      application: { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" },
      instanceId: "fixture",
      workspaceFolders: ["/workspace"],
      agentType: "builder_v3",
      models: [],
    };
    const mode = { id: "manual_approval", label: "Manual" };
    expect(
      readInspection({ ...base, permissions: { modes: [mode], defaultModeId: mode.id } })
        .permissions?.defaultModeId,
    ).toBe(mode.id);
    for (const permissions of [
      { modes: [], defaultModeId: mode.id },
      { modes: [mode, mode], defaultModeId: mode.id },
      { modes: [mode], defaultModeId: "full_access" },
      { modes: [{ id: "unknown", label: "Unknown" }], defaultModeId: "unknown" },
      { modes: [{ ...mode, dangerous: "true" }], defaultModeId: mode.id },
    ])
      expect(() => readInspection({ ...base, permissions })).toThrow("permission");
  });
  it("reads only the menu and active profile, keeping rules and resource grants inside Desktop", async () => {
    const test = setup({
      activeProfileId: "defaultCustomProfile",
      customProfiles: { defaultCustomProfile: { commands: "private-rule" } },
      resourceAuthorization: { token: "private-token" },
    });
    const settings = await desktopPermissionSettings(test.vscode);
    expect(settings).toEqual({
      modes: [
        { id: "manual_approval", label: "Manual Approval" },
        { id: "auto_approval", label: "Auto Approval" },
        { id: "full_access", label: "Full Access", dangerous: true },
        { id: "defaultCustomProfile", label: "Custom" },
      ],
      defaultModeId: "defaultCustomProfile",
    });
    expect(JSON.stringify(settings)).not.toMatch(/private|resourceAuthorization/);
    expect(requestedPermission(settings, undefined)).toBe("defaultCustomProfile");
    expect(() => requestedPermission(settings, "removed")).toThrow("no longer available");
    expect(() => requestedPermission(settings, null)).toThrow("no longer available");
    expect(test.commands.executeCommand.mock.calls.map(([name]) => name)).toEqual([
      "icube.common.getDynamicConfig",
      "icube.userConfiguration.get",
      "icube.common.commands.getProductDataFolderPath",
    ]);
  });
  it("uses native defaults and normalizes a hidden auto mode or removed custom profile", async () => {
    const initial = setup();
    expect((await desktopPermissionSettings(initial.vscode)).defaultModeId).toBe("auto_approval");
    const hidden = setup(
      { activeProfileId: "auto_approval" },
      {
        iCubeApp: {
          autoRunConfig: { useNewPermissionModel: true },
          toolAutoApprove: { visible: false },
        },
      },
    );
    expect(await desktopPermissionSettings(hidden.vscode)).toEqual({
      modes: [
        { id: "manual_approval", label: "Manual Approval" },
        { id: "full_access", label: "Full Access", dangerous: true },
      ],
      defaultModeId: "manual_approval",
    });
    const removed = setup({ activeProfileId: "defaultCustomProfile" });
    expect((await desktopPermissionSettings(removed.vscode)).defaultModeId).toBe("auto_approval");
  });
  it("does not advertise a disabled feature or remote filesystem", async () => {
    for (const test of [
      setup({}, {}),
      setup({}, { is2b: true, iCubeApp: { autoRunConfig: { useNewPermissionModel: true } } }),
      setup({}, undefined, { new_permission_model: { enabled: false } }),
    ]) {
      expect(await desktopPermissionSettings(test.vscode)).toBeUndefined();
      expect(test.fs.stat).not.toHaveBeenCalled();
    }
    const remote = setup();
    Object.assign(remote.vscode.env, { remoteName: "ssh" });
    expect(await desktopPermissionSettings(remote.vscode)).toBeUndefined();
    expect(remote.commands.executeCommand).not.toHaveBeenCalled();
    expect(() => requestedPermission(undefined, "full_access")).toThrow("disabled");
    await expect(
      desktopPermissionSettings(setup({ activeProfileId: "unknown" }).vscode),
    ).rejects.toMatchObject({ code: "configurationRequired" });
  });
  it("bounds configuration reads and preserves corrupt or inaccessible state as errors", async () => {
    const large = setup();
    large.fs.stat.mockResolvedValue({ size: 1024 * 1024 + 1 });
    await expect(desktopPermissionSettings(large.vscode)).rejects.toThrow("1 MiB");
    expect(large.fs.readFile).not.toHaveBeenCalled();
    const corrupt = setup();
    corrupt.fs.readFile.mockResolvedValue(Buffer.from("{"));
    await expect(desktopPermissionSettings(corrupt.vscode)).rejects.toThrow();
    const missing = setup();
    missing.fs.stat.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "FileNotFound" }),
    );
    expect((await desktopPermissionSettings(missing.vscode)).defaultModeId).toBe("auto_approval");
  });
});
