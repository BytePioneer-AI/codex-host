import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { environmentValue, installationVersion } from "@codexhost/harness-discovery";
import type { HarnessInstallationState } from "@codexhost/shared-contracts";
import { discoverBridges, type BridgeOptions } from "./discovery.js";
import { record, TraeError } from "./errors.js";

async function installedVersion(root: string): Promise<string | undefined> {
  try {
    const file = path.join(root, "product.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return;
    const product: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(product) || product.applicationName !== "trae-cn") return;
    return installationVersion(product.appVersion);
  } catch {
    return undefined;
  }
}

function selectedRoots(selected: string): string[] {
  const directory = /\.exe$/iu.test(selected) ? path.dirname(selected) : selected;
  return [
    directory,
    path.join(directory, "resources", "app"),
    path.join(directory, "Contents", "Resources", "app"),
  ];
}

/** Application metadata only: no Agent request, desktop launch or silent updater. */
export function createTraeCnInstallation(options: Omit<BridgeOptions, "cwd">) {
  const environment = { ...(options.environment ?? process.env) };
  const selected = options.app ?? environmentValue(environment, "CODEXHOST_TRAE_CN_APP");
  const check = async (): Promise<HarnessInstallationState> => {
    let roots: string[];
    if (selected) {
      if (!path.isAbsolute(selected))
        throw new TraeError(
          "configurationRequired",
          "The TRAE CN application path must be absolute",
        );
      roots = selectedRoots(selected);
    } else {
      // A version check is not scoped to the Host's current working directory.
      // Discovery still validates owner-private metadata, a live PID and product identity.
      const bridges = await discoverBridges({ ...options, environment, cwd: process.cwd() }, false);
      const activeRoots = [...new Set(bridges.map((bridge) => bridge.application.root))];
      if (activeRoots.length > 1)
        throw new TraeError(
          "configurationRequired",
          "Select one TRAE CN installation before checking its version",
        );
      const home =
        environmentValue(environment, process.platform === "win32" ? "USERPROFILE" : "HOME") ??
        os.homedir();
      const local = environmentValue(environment, "LOCALAPPDATA");
      roots = activeRoots.length
        ? activeRoots
        : process.platform === "darwin"
          ? [
              "/Applications/Trae CN.app/Contents/Resources/app",
              path.join(home, "Applications", "Trae CN.app", "Contents", "Resources", "app"),
            ]
          : process.platform === "win32" && local
            ? [path.join(local, "Programs", "Trae CN", "resources", "app")]
            : [];
    }
    let currentVersion: string | undefined;
    for (const root of roots) {
      currentVersion = await installedVersion(root);
      if (currentVersion) break;
    }
    if (!currentVersion)
      throw new TraeError(
        "notInstalled",
        "The selected TRAE CN application metadata was not found",
      );
    return {
      currentVersion,
      versionKind: "application",
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: false,
      canUpdate: false,
      manualUpdateUrl: "https://www.trae.cn/",
      notice: {
        en: "This is the installed TRAE CN desktop application version. Check and install updates inside TRAE CN or through its official installer. The latest release for this installation channel is unknown here. Update the CodexHost Bridge VSIX separately and finish active work before reloading Desktop.",
        "zh-CN":
          "此处显示已安装的 TRAE CN 桌面应用版本。请在 TRAE CN 内检查更新，或使用官方安装器；此处无法确定当前安装渠道的最新版本。CodexHost Bridge VSIX 需单独更新，重新加载桌面前请完成活动任务。",
      },
    };
  };
  return async (action: "check" | "update"): Promise<HarnessInstallationState> => {
    if (action === "update")
      throw new TraeError(
        "unsupported",
        "Update TRAE CN using its own desktop updater or official installer",
      );
    return check();
  };
}
