import { localizeHarnessText, type HarnessInstallationState } from "@codexhost/shared-contracts";

export interface HarnessVersionMessages {
  readonly locale: string;
  readonly unknown: string;
  readonly trackingBranch: string;
  readonly notes: Readonly<Record<string, string>>;
}

export const harnessVersionEnglish: HarnessVersionMessages = Object.freeze({
  locale: "en",
  unknown: "Unknown",
  trackingBranch: "Tracking branch (new commits)",
  notes: Object.freeze({
    "original-installer":
      "Use the original installer, package manager, or launcher to update this installation.",
  }),
});

export const harnessVersionChinese: HarnessVersionMessages = Object.freeze({
  locale: "zh-CN",
  unknown: "未知",
  trackingBranch: "跟踪分支（有新提交）",
  notes: Object.freeze({
    "original-installer": "请使用原安装程序、包管理器或启动器更新此安装。",
  }),
});

export function harnessVersionLabel(
  state: HarnessInstallationState | undefined,
  messages: HarnessVersionMessages,
): string {
  if (!state) return "—";
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
  if (state?.notice) return localizeHarnessText(state.notice, messages.locale);
  const code = state?.messageCode;
  // Only generic legacy codes are public vocabulary. Never expose raw diagnostics.
  return code && Object.hasOwn(messages.notes, code) ? messages.notes[code] : undefined;
}
