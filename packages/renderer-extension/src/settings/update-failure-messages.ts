import type { RendererSettingsMessages } from "./localization.js";

/**
 * Chinese text for the codexhost update failures a person can act on. The Updater and the
 * update manager report them in English because they have no locale.
 *
 * Each key is the fixed beginning of the English message; details such as paths and exit
 * statuses may follow it. `tools/update-failure-messages.test.mjs` checks that every key still
 * appears in the code that produces it, so rewording a message there cannot silently drop its
 * translation. Unlisted failures fall back to the generic failure text.
 */
export const UPDATE_FAILURE_CHINESE: Readonly<Record<string, string>> = Object.freeze({
  // Before anything stops.
  "Another update operation is already active": "另一项更新正在进行，请等它完成后重试。",
  "The selected update is no longer the current GitHub Release":
    "所选版本已不是 GitHub 上的最新版本，请刷新后重试。",
  "update artifact SHA-256 mismatch": "下载的更新文件校验失败，未进行安装。",
  "Background Updater did not confirm handoff before the startup timeout":
    "后台更新程序未能按时接手更新，未进行安装。",
  "Background Updater exited before completing handoff":
    "后台更新程序在接手更新前退出，未进行安装。",
  "active update lock was not transferred to the Updater before timeout":
    "更新交接超时，未进行安装。",
  "npm registry does not have codexhost":
    "你使用的 npm 源还没有同步这个版本，未进行安装，请稍后再试。",
  "npm could not download the update": "npm 无法下载更新，未进行安装，请检查网络后重试。",
  "Could not identify the global npm installation": "无法识别全局 npm 安装位置，未进行安装。",
  "npm uses a different global installation than":
    "当前 npm 的全局目录不是 codexhost 的安装位置，无法自动更新。请用安装 codexhost 的那个 npm 手动更新。",
  "Launcher did not exit before the update timeout": "应用未能按时退出，未进行安装。",
  "Launcher exited before the background Updater started":
    "应用在后台更新程序启动前已退出，未进行安装。",
  "pre-update service shutdown failed": "更新前停止 codexhost 服务失败，未进行安装。",
  // While installing.
  "npm update failed with": "npm 安装失败，请检查网络和全局 npm 目录的写入权限。",
  "npm update did not replace the platform package at":
    "npm 安装已完成，但重启要用的平台包没有被替换为新版本。",
  "installed distribution metadata does not match": "安装后的版本与目标版本不一致。",
  // While restarting.
  "codexhost restart exited with": "新版本已安装，但重新启动 codexhost 失败。",
  "codexhost services did not become ready after restart":
    "新版本已安装，但服务未能在 2 分钟内以新版本就绪。",
  "another installation owns the running services": "正在运行的服务属于另一份 codexhost 安装。",
  "another installation owns the running Desktop": "正在运行的 Desktop 属于另一份 codexhost 安装。",
});

const RECOVERY_SUCCEEDED = "; service recovery succeeded";
const RECOVERY_FAILED = "; service recovery failed";

/**
 * The headline for a failed update: what went wrong, in the page's language when the failure
 * is known, followed by whether the Updater restarted the previous version.
 */
export function describeUpdateFailure(
  error: string | null,
  messages: RendererSettingsMessages,
): string {
  const text = (error ?? "").replace(/^Error:\s*/u, "");
  const recovery = text.includes(RECOVERY_SUCCEEDED)
    ? messages.updateRecoverySucceeded
    : text.includes(RECOVERY_FAILED)
      ? messages.updateRecoveryFailed
      : null;
  const known =
    messages.locale === "zh-CN"
      ? Object.entries(UPDATE_FAILURE_CHINESE)
          .filter(([english]) => text.startsWith(english))
          .sort(([left], [right]) => right.length - left.length)[0]?.[1]
      : undefined;
  const reason = known ?? messages.updateFailed;
  if (!recovery) return reason;
  return messages.locale === "zh-CN" ? `${reason}${recovery}` : `${reason} ${recovery}`;
}
