import type { HarnessInstallationState } from "@codexhost/shared-contracts";

export interface HarnessVersionMessages {
  readonly unknown: string;
  readonly trackingBranch: string;
  readonly notes: Readonly<Record<string, string>>;
}

export const harnessVersionEnglish: HarnessVersionMessages = Object.freeze({
  unknown: "Unknown",
  trackingBranch: "Tracking branch (new commits)",
  notes: Object.freeze({
    "original-installer":
      "Use the original installer, package manager, or launcher to update this installation.",
    "claude-policy-restricted":
      "Claude updates are restricted by the installation's settings or policy.",
    "codebuddy-npm-required":
      "Use CodeBuddy's native updater or original package manager. Latest-version checks here require an identified npm installation.",
    "deepseek-original-installer":
      "Update with the original installer. Python, desktop, and project-local installations are not upgraded through global npm.",
    "kiro-native-updater":
      "Use Kiro CLI's original installer or native updater to check for and install updates.",
    "zcode-desktop-updater":
      "The CLI ships inside ZCode Desktop. Update ZCode Desktop itself to update it.",
    "qoder-check-unavailable":
      "This Qoder China release does not expose a non-installing update check. Use its original installer.",
    "hermes-update-plan-unavailable":
      "This Hermes release does not expose a safe update plan. Use the original installer.",
    "hermes-externally-managed":
      "This Hermes installation is managed externally. Update it through its desktop app, container, or original package manager.",
    "hermes-update-channel":
      "Uses Hermes's configured update channel. Gateway restarts are deferred; existing processes keep their running code.",
    "hermes-manual-update":
      "Use the native updater manually. Safe non-interactive updates require a clean source checkout, commit identity, and Gateway restart deferral.",
  }),
});

export const harnessVersionChinese: HarnessVersionMessages = Object.freeze({
  unknown: "未知",
  trackingBranch: "跟踪分支（有新提交）",
  notes: Object.freeze({
    "original-installer": "请使用原安装程序、包管理器或启动器更新此安装。",
    "claude-policy-restricted": "此 Claude 安装的设置或策略限制了更新。",
    "codebuddy-npm-required":
      "请使用 CodeBuddy 原生更新器或原包管理器更新。此处仅能查询已识别的 npm 安装的最新版本。",
    "deepseek-original-installer":
      "请使用原安装方式更新。Python、桌面应用及项目内安装不会通过全局 npm 更新。",
    "kiro-native-updater": "请使用 Kiro CLI 原安装程序或原生更新器检查并安装更新。",
    "zcode-desktop-updater": "CLI 随 ZCode Desktop 一起发布，请直接更新 ZCode Desktop。",
    "qoder-check-unavailable":
      "此 Qoder 中国版尚不支持只检查、不安装的更新查询，请使用原安装方式更新。",
    "hermes-update-plan-unavailable": "此 Hermes 版本不提供安全的更新计划，请使用原安装方式更新。",
    "hermes-externally-managed":
      "此 Hermes 安装由外部工具管理，请通过其桌面应用、容器或原包管理器更新。",
    "hermes-update-channel":
      "使用 Hermes 配置的更新渠道，暂不重启 Gateway；现有进程继续运行原有代码。",
    "hermes-manual-update":
      "请手动使用原生更新器。安全的非交互更新要求源码目录无未提交修改、可识别当前提交，并支持推迟 Gateway 重启。",
  }),
});

export function harnessVersionLabel(
  state: HarnessInstallationState | undefined,
  messages: HarnessVersionMessages,
): string {
  if (!state) return "—";
  // Legacy plugins used these sentinel strings before structured presentation hints existed.
  if (state.latestVersionKind === "unknown" || state.latestVersion === "Unknown")
    return messages.unknown;
  if (
    state.latestVersionKind === "tracking-branch" ||
    state.latestVersion === "Tracking branch (new commits)"
  )
    return messages.trackingBranch;
  return state.latestVersion;
}

export function harnessVersionNote(
  state: HarnessInstallationState | undefined,
  messages: HarnessVersionMessages,
): string | undefined {
  const code = state?.messageCode;
  // Unknown/legacy plugin diagnostics stay out of the localized UI.
  return code && Object.hasOwn(messages.notes, code) ? messages.notes[code] : undefined;
}
