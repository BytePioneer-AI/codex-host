import type { RemoteText } from "./remote-connections-card.js";

/**
 * Chinese text for the failures the remote connections page can show. They are reported in
 * English by the SSH helper, the remote service and the Codex SSH bridge, which have no locale.
 *
 * Each key is the exact English message, or its fixed beginning when a detail follows a colon.
 * `tools/remote-failure-messages.test.mjs` checks that every key still appears in the
 * code that produces it, so rewording a message there cannot silently drop its translation.
 * Anything not listed here (SSH and Codex's own output, for example) is shown as received.
 */
export const REMOTE_FAILURE_CHINESE: Readonly<Record<string, string>> = Object.freeze({
  // SSH helper: installing, updating and repairing over SSH.
  "Invalid SSH address or port": "SSH 地址或端口无效",
  "Install requires a published stable version": "只能安装已发布的正式版本",
  "SSH operation timed out; check the remote computer before retrying":
    "SSH 操作超时，请检查远程电脑后重试",
  "Remote service is already installed. Connect and use its update button":
    "远程服务已经安装，请连接后使用更新按钮",
  "Remote service is not installed. Use Install and connect instead":
    "远程服务尚未安装，请使用「安装并连接」",
  "This release is not published on npm, or the remote computer cannot reach the registry":
    "该版本尚未发布到 npm，或远程电脑无法访问 npm 仓库",
  "codexhost was installed but is not on the remote PATH. Update this remote manually":
    "codexhost 已安装，但不在远程电脑的 PATH 中，请在远程电脑上手动更新",
  "Only Mac and Linux remote computers are supported": "只支持 Mac 和 Linux 远程电脑",
  "Node.js, npm or Codex CLI was not found over SSH. Install them on the remote computer and make sure non-interactive SSH sessions have them on PATH":
    "通过 SSH 找不到 Node.js、npm 或 Codex CLI。请在远程电脑上安装它们，并确保非交互式 SSH 会话的 PATH 中包含它们",
  "npm installation failed. Check network access and global installation permissions":
    "npm 安装失败，请检查网络和全局安装权限",
  "Remote service configuration failed. Check Codex CLI and the remote desktop login":
    "远程服务配置失败，请检查 Codex CLI 以及远程电脑的桌面登录状态",
  "Remote service could not stop. Check the remote service before retrying":
    "远程服务无法停止，请检查远程服务后重试",
  "Remote connection configuration could not be removed. Check file permissions":
    "无法移除远程连接配置，请检查文件权限",
  "Another remote installation is in progress. Wait and check again":
    "另一项远程安装正在进行，请稍后重新检测",
  "Remote service was installed but could not start. Check the remote service and retry connecting":
    "远程服务已安装但无法启动，请检查远程服务后重新连接",
  "SSH failed. Check the address, key authentication and trusted host key":
    "SSH 连接失败，请检查地址、密钥认证以及主机密钥是否已信任",
  "Unexpected SSH inspection response": "SSH 检测返回了无法识别的结果",
  "SSH installation failed; check the remote computer and retry":
    "SSH 安装失败，请检查远程电脑后重试",
  "SSH installation helper is unavailable. Update local codexhost and restart.":
    "SSH 安装组件不可用，请更新本机 codexhost 后重启",
  "SSH installation must run from the local computer": "SSH 安装只能从本机发起",
  "An SSH operation is already running for this connection": "这个连接已有 SSH 操作正在进行",

  // Remote service: updating or restarting itself.
  "Another codexhost update is active; finish it before retrying":
    "另一项 codexhost 更新正在进行，请等它完成后重试",
  "The remote installation changed before the update acquired its lock; refresh and retry":
    "更新开始前远程安装发生了变化，请刷新后重试",
  "Could not identify the global npm installation": "无法识别远程电脑的全局 npm 安装",
  "npm uses a different global installation; update this remote manually":
    "远程电脑的 npm 使用了另一处全局安装，请在远程电脑上手动更新",
  "The requested release is unavailable or npm cannot reach the registry":
    "目标版本不存在，或远程电脑无法访问 npm 仓库",
  "npm installation failed; check remote network access and write permissions":
    "npm 安装失败，请检查远程电脑的网络和写入权限",
  "Installed remote version does not match the requested version":
    "远程安装的版本与请求的版本不一致",
  "Remote stop failed": "更新已安装，但停止旧服务失败",
  "Remote install failed": "更新已安装，但重新配置远程服务失败",
  "Remote start failed": "更新已安装，但启动远程服务失败",
  "The previous remote update was interrupted; retry the update": "上一次远程更新被中断，请重试",
  "Remote updater did not start": "远程更新程序未能启动",
  "Remote updater could not be started": "无法启动远程更新程序",
  "Remote updater is unavailable": "远程更新程序不可用",
  "Another remote update is already pending": "已有另一项远程更新在等待执行",
  "Remote update requires an npm installation with the current updater":
    "远程更新需要通过 npm 安装并带有当前版本的更新程序",
  "Remote downgrades are not automatic; update this computer first":
    "不会自动降低远程版本，请先更新本机",
  "The remote installation changed; refresh versions before retrying":
    "远程安装发生了变化，请刷新版本后重试",
  "Remote service is updating; reconnect shortly": "远程服务正在更新，请稍后重新连接",
  "Runtime version management is unavailable in this build": "当前构建不支持版本管理",

  // This window's bridge to the remote service.
  "Remote service did not respond; reconnect and retry": "远程服务没有响应，请重新连接后重试",
  "SSH installation is unavailable; update local codexhost and restart":
    "SSH 安装不可用，请更新本机 codexhost 后重启",
  "Version management is unavailable; update codexhost on this host and reconnect":
    "版本管理不可用，请更新这台电脑上的 codexhost 后重新连接",
  "Remote update is unavailable; update this remote once and reconnect":
    "远程更新不可用，请先手动更新一次这台远程电脑再重新连接",

  // Codex SSH bridge: reading and saving connections.
  "Codex SSH settings are unavailable in this window": "此窗口无法使用 Codex SSH 设置",
  "Codex SSH request failed; check the native Connections settings":
    "Codex SSH 请求失败，请检查原生的连接设置",
  "Invalid Codex SSH response": "Codex SSH 返回了无法识别的结果",
  "Codex SSH request timed out; refresh before retrying": "Codex SSH 请求超时，请刷新后重试",
  "Invalid Codex SSH connection list": "Codex 返回的 SSH 连接列表无法识别",
  "This Codex version uses an unsupported SSH configuration; open native settings":
    "当前 Codex 版本的 SSH 配置格式不受支持，请在原生设置中管理",
  "This connection changed in Codex. Refresh and edit it again.":
    "这个连接已在 Codex 中被修改，请刷新后重新编辑",
  "Enter a name, SSH hostname (or alias), and a port between 1 and 65535":
    "请填写名称、SSH 主机名（或别名），端口需在 1 到 65535 之间",
  "A connection with this name already exists": "已存在同名的连接",
  "Edit SSH-config connection details in native Codex settings":
    "来自 SSH 配置的连接，请在 Codex 原生设置中修改详细信息",
  "Invalid Codex connection state": "Codex 返回的连接状态无法识别",
});

/** Shows a known failure in the page's language; unknown text is returned unchanged. */
export function localizeRemoteFailure(message: string, t: RemoteText): string {
  // Failures recorded with String(error) carry the error's class name.
  const text = message.replace(/^Error:\s*/u, "");
  const detail = text.indexOf(": ");
  const chinese =
    REMOTE_FAILURE_CHINESE[text] ??
    (detail > 0 ? REMOTE_FAILURE_CHINESE[text.slice(0, detail)] : undefined);
  return chinese ? t(chinese, text) : text;
}
