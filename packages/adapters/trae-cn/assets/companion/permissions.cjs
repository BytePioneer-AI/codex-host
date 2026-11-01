const path = require("node:path");

const labels = {
  manual_approval: "Manual Approval",
  auto_approval: "Auto Approval",
  full_access: "Full Access",
  defaultCustomProfile: "Custom",
};

/** Match PermissionFeatureGuardService and PermissionModePort; never write rules. */
async function desktopPermissionSettings(vscode) {
  if (vscode.env.remoteName) return undefined;
  const dynamic = await vscode.commands.executeCommand("icube.common.getDynamicConfig");
  if (dynamic?.is2b === true) return undefined;
  if (dynamic?.iCubeApp?.autoRunConfig?.useNewPermissionModel !== true) return undefined;
  let user;
  try {
    user = await vscode.commands.executeCommand("icube.userConfiguration.get");
  } catch {
    // The native guard defaults its beta flag to enabled when this read fails.
  }
  if (user?.new_permission_model?.enabled === false) return undefined;
  const folder = await vscode.commands.executeCommand(
    "icube.common.commands.getProductDataFolderPath",
  );
  if (typeof folder !== "string" || !folder)
    throw new Error("Cannot resolve the TRAE CN permission configuration directory");
  // The app command returns a URI-style /c:/ path on Windows.
  const local = /^\/[a-z]:\//i.test(folder) ? folder.slice(1) : folder;
  if (!path.isAbsolute(local)) throw new Error("Invalid TRAE CN product data directory");
  const uri = vscode.Uri.file(path.join(local, "permission", "global.json"));
  let config = {};
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > 1024 * 1024) throw new Error("TRAE CN permission configuration exceeds 1 MiB");
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > 1024 * 1024)
      throw new Error("TRAE CN permission configuration exceeds 1 MiB");
    config = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Invalid TRAE CN permission configuration");
  } catch (error) {
    if (error.code !== "FileNotFound" && error.code !== "ENOENT") throw error;
  }
  const auto = dynamic.iCubeApp?.toolAutoApprove;
  if (
    config.activeProfileId &&
    (typeof config.activeProfileId !== "string" || !Object.hasOwn(labels, config.activeProfileId))
  )
    throw Object.assign(new Error("Unknown TRAE CN active permission profile"), {
      code: "configurationRequired",
    });
  const ids = [
    "manual_approval",
    ...(auto?.visible === true ? ["auto_approval"] : []),
    "full_access",
  ];
  if (config.customProfiles?.defaultCustomProfile) ids.push("defaultCustomProfile");
  const fallback =
    auto?.visible === true && (auto.default === undefined || auto.default === "auto")
      ? "auto_approval"
      : "manual_approval";
  const selected = ids.includes(config.activeProfileId) ? config.activeProfileId : fallback;
  return {
    modes: ids.map((id) => ({
      id,
      label: labels[id],
      ...(id === "full_access" ? { dangerous: true } : {}),
    })),
    defaultModeId: selected,
  };
}

function requestedPermission(settings, id) {
  if (!settings)
    throw Object.assign(new Error("TRAE CN native permission selection is disabled"), {
      code: "unsupported",
    });
  const selected = id === undefined ? settings.defaultModeId : id;
  if (!settings.modes.some((mode) => mode.id === selected))
    throw Object.assign(new Error("Permission mode is no longer available in TRAE CN"), {
      code: "invalidRequest",
    });
  return selected;
}

module.exports = { desktopPermissionSettings, requestedPermission };
