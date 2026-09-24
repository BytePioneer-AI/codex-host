import {
  credentialImportEnglish,
  credentialImportChinese,
  type CredentialImportMessages,
} from "./credential-import-messages.js";
import type { DefaultRendererSettingsPageId } from "./pages.js";

export const RENDERER_SETTINGS_LOCALES = ["en", "zh-CN"] as const;
export type RendererSettingsLocale = (typeof RENDERER_SETTINGS_LOCALES)[number];

export const RENDERER_SETTINGS_LANGUAGE_SELECTIONS = ["automatic", "en", "zh-CN", "other"] as const;
export type RendererSettingsLanguageSelection =
  (typeof RENDERER_SETTINGS_LANGUAGE_SELECTIONS)[number];
export type RendererSettingsWritableLanguageSelection = Exclude<
  RendererSettingsLanguageSelection,
  "other"
>;

export interface RendererSettingsLanguageControl {
  readonly available: boolean;
  readonly selection: RendererSettingsLanguageSelection;
  setSelection(selection: RendererSettingsWritableLanguageSelection): Promise<void>;
}

export interface RendererSettingsMessages {
  readonly credentialImports: CredentialImportMessages;
  readonly locale: RendererSettingsLocale;
  readonly title: string;
  readonly close: string;
  readonly starOnGitHub: string;
  readonly sectionsLabel: string;
  readonly generalSection: string;
  readonly otherSection: string;
  readonly appearanceDescription: string;
  readonly appearanceGroup: string;
  readonly loadedSessions: {
    title: string;
    description: string;
    columns: readonly string[];
    empty: string;
    failed: string;
    unavailable: string;
    loading: string;
    minutes: string;
    states: Record<"idle" | "running" | "busy" | "closing" | "failed" | "blocked", string>;
    reasons: Record<
      | "none"
      | "disabled"
      | "timeout"
      | "operation"
      | "background"
      | "identity"
      | "persistence"
      | "closeFailed",
      string
    >;
  };
  readonly idleReleaseSection: string;
  readonly idleReleaseTitle: string;
  readonly idleReleaseDescription: string;
  readonly idleReleaseHelpLabel: string;
  readonly idleReleaseHelp: readonly string[];
  readonly idleReleaseTimeout: string;
  readonly idleReleaseTimeoutDescription: string;
  readonly idleReleaseMinutes: string;
  readonly idleReleaseInvalid: string;
  readonly idleReleasePending: string;
  readonly idleReleaseUnavailable: string;
  readonly idleReleaseFailed: string;
  readonly reasoningSoftWrapTitle: string;
  readonly reasoningSoftWrapDescription: string;
  readonly pageUnavailable: string;
  readonly inDevelopment: string;
  readonly notAvailable: string;
  readonly runtimeCapabilityNotInstalled: string;
  readonly sessionImportHarness: string;
  readonly sessionImportDescription: string;
  readonly sessionImportAvailabilityNote: string;
  readonly sessionImportRefresh: string;
  readonly sessionImportRefreshing: string;
  readonly sessionImportUnavailable: string;
  readonly sessionImportEmpty: string;
  readonly sessionImportSearch: string;
  readonly sessionImportSearchPlaceholder: string;
  readonly sessionImportNoMatches: string;
  readonly sessionImportPageSize: string;
  readonly sessionImportPrevious: string;
  readonly sessionImportNext: string;
  readonly sessionImportPageSummary: string;
  readonly sessionImportLoadFailed: string;
  readonly sessionImportFailed: string;
  readonly sessionImportUntitled: string;
  readonly sessionImportUpdatedAt: string;
  readonly sessionImportSessionId: string;
  readonly sessionImportRunning: string;
  readonly sessionImportRunningHint: string;
  readonly sessionImportAction: string;
  readonly sessionImportImporting: string;
  readonly sessionImportImported: string;
  readonly sessionImportOpenFailed: string;
  readonly sessionImportCopyProjectPath: string;
  readonly sessionImportPathCopied: string;
  readonly sessionImportPathCopyFailed: string;
  readonly sessionImportRetryOpen: string;
  readonly sessionImportRetrying: string;
  readonly connectionsDescription: string;
  readonly accountColumnAccount: string;
  readonly accountConnected: string;
  readonly accountDefaultBadge: string;
  readonly accountSearch: string;
  readonly accountEmpty: string;
  readonly accountNoMatches: string;
  readonly accountNativeManagementHint: string;
  readonly accountDefaultHint: string;
  readonly accountCreditsRemaining: string;
  readonly accountCreditsLoading: string;
  readonly accountCreditsEmpty: string;
  readonly accountCreditsFailed: string;
  readonly accountCreditsRetry: string;
  readonly accountCreditsRefresh: string;
  readonly accountLoadFailed: string;
  readonly accountCreditsUsed: string;
  readonly accountCreditsResetAt: string;
  readonly accountCreditsResetIn: string;
  readonly accountCreditsResetPending: string;
  readonly accountCreditsResetPendingHint: string;
  readonly accountCreditsPeriodWeekly: string;
  readonly accountCreditsPeriodMonthly: string;
  readonly accountCreditsPeriodFiveHour: string;
  readonly accountCreditsPeriodSevenDay: string;
  readonly accountCreditsPeriodUnknown: string;
  readonly accountCreditsBuild: string;
  readonly accountResetCredits: string;
  readonly accountResetCreditsDetails: string;
  readonly accountResetCreditsCardExpiry: string;
  readonly connectionAdapter: string;
  readonly connectionHosts: string;
  readonly connectionLocalHost: string;
  readonly connectionRemoteHost: string;
  readonly connectionActiveHost: string;
  readonly connectionReason: string;
  readonly connectionRefresh: string;
  readonly connectionRefreshing: string;
  readonly connectionViewError: string;
  readonly connectionCopyDetails: string;
  readonly connectionCopied: string;
  readonly connectionCopyFailed: string;
  readonly connectionErrorCode: string;
  readonly connectionErrorMessage: string;
  readonly connectionRetryable: string;
  readonly connectionFailureStage: string;
  readonly connectionDuration: string;
  readonly connectionDiagnostic: string;
  readonly connectionNoRuntime: string;
  readonly connectionStatusReady: string;
  readonly connectionStatusChecking: string;
  readonly connectionStatusNotInstalled: string;
  readonly connectionStatusUnavailable: string;
  readonly connectionStatusError: string;
  readonly connectionStatusInstalling: string;
  readonly connectionStatusUnsupported: string;
  readonly connectionComponent: string;
  readonly connectionStatus: string;
  readonly connectionHostsScrollLeft: string;
  readonly connectionHostsScrollRight: string;
  readonly launchPathLabel: string;
  readonly launchPathPlaceholder: string;
  readonly launchPathWorkbuddyHelp: string;
  readonly launchPathSave: string;
  readonly launchPathReset: string;
  readonly launchPathRestart: string;
  readonly launchPathSaved: string;
  readonly launchPathAutomatic: string;
  readonly launchPathSaving: string;
  readonly launchPathLoading: string;
  readonly launchPathLoadError: string;
  readonly launchPathSaveError: string;
  readonly connectionOpenInstallation: string;
  readonly connectionOpenHarnessWeb: string;
  readonly connectionDeepSeekTestedVersions: string;
  readonly connectionInstall: string;
  readonly connectionInstallDescription: string;
  readonly connectionErrorTitle: string;
  readonly connectionErrorLog: string;
  readonly connectionOpenIssue: string;
  readonly connectionIssueDescription: string;
  readonly connectionReadyDescription: string;
  readonly connectionUnavailableDescription: string;
  readonly connectionGroupMoreLabel: string;
  readonly connectionGroupMoreHintTitle: string;
  readonly connectionGroupMoreHintBody: string;
  readonly connectionGroupMoveToMore: string;
  readonly connectionGroupMoveToMain: string;
  readonly connectionGroupDragHandle: string;
  readonly connectionGroupReset: string;
  readonly pickerMoreAgentsLabel: string;
  readonly pickerManageLink: string;
  readonly pickerHideUnusedAgentsCta: string;
  readonly enabled: string;
  readonly disabled: string;
  readonly openSettings: string;
  readonly settingsButtonTitle: string;
  readonly settingsUnavailableTitle: string;
  readonly updateCurrentVersion: string;
  readonly updateInstallation: string;
  readonly updateInstallationNpm: string;
  readonly updateInstallationWindowsInstaller: string;
  readonly updateInstallationMacOsDmg: string;
  readonly updateInstallationUnknown: string;
  readonly updateLatestVersion: string;
  readonly updateUpToDate: string;
  readonly updateAvailable: string;
  readonly updateWindowsManualRequired: string;
  readonly updateAndRestart: string;
  readonly updateChecking: string;
  readonly updateDownloading: string;
  readonly updatePreparing: string;
  readonly updateWaitingForExit: string;
  readonly updateInstalling: string;
  readonly updateInstallingNpm: string;
  readonly updateRequestTimeout: string;
  readonly updateServiceUnavailable: string;
  readonly updateRestarting: string;
  readonly updateSucceeded: string;
  readonly updateFailed: string;
  readonly updateRetry: string;
  readonly updateManualNpmDescription: string;
  readonly updateWindowsNpmDescription: string;
  readonly updateWindowsInstallerDescription: string;
  readonly updateManualTitle: string;
  readonly updateManualFallbackDescription: string;
  readonly updateCopyCommand: string;
  readonly updateCommandCopied: string;
  readonly updateCopyFailed: string;
  readonly updateDownloadFromReleases: string;
  readonly updateDownloadWindowsInstaller: string;
  readonly updateStarCallout: string;
  readonly updateStarLink: string;
  readonly aboutTagline: string;
  readonly aboutParagraphs: readonly string[];
  readonly aboutOpenSource: string;
  readonly aboutStarCallout: string;
  readonly aboutRepository: string;
  readonly pageLabels: Readonly<Record<DefaultRendererSettingsPageId, string>>;
}

const ENGLISH_MESSAGES: RendererSettingsMessages = Object.freeze({
  credentialImports: credentialImportEnglish,
  locale: "en",
  title: "Settings",
  close: "Close settings",
  starOnGitHub: "Star to support",
  sectionsLabel: "Settings sections",
  generalSection: "General",
  otherSection: "Other",
  appearanceDescription: "Conversation display and local resource management.",
  appearanceGroup: "Appearance",
  loadedSessions: {
    title: "Loaded sessions",
    description:
      "Local external Harnesses only. Refreshes every 10 seconds without waking sessions or resetting activity. Released sessions disappear from this list.",
    columns: ["Session", "Harness", "State", "Since last activity", "Release constraint"],
    empty: "No loaded external sessions.",
    failed: "Could not load session status.",
    unavailable: "Local Host does not support session status or is unavailable.",
    loading: "Loading session status…",
    minutes: "{minutes} min",
    states: {
      idle: "Idle",
      running: "Running",
      busy: "Busy",
      closing: "Releasing",
      failed: "Release failed",
      blocked: "Blocked",
    },
    reasons: {
      none: "—",
      disabled: "Automatic release is off",
      timeout: "Timeout not reached",
      operation: "Turn or Host operation in progress",
      background: "Subagent, steering, command or interaction pending",
      identity: "Session identity unavailable or snapshot-only session",
      persistence: "Persistence or output error",
      closeFailed: "Restart Desktop before retrying",
    },
  },
  idleReleaseSection: "Resource management",
  idleReleaseTitle: "Release idle sessions",
  idleReleaseDescription:
    "Close background instances after the idle timeout; they resume on next use.",
  idleReleaseHelpLabel: "About releasing idle sessions",
  idleReleaseHelp: Object.freeze([
    "After an Agent finishes replying, its background process may continue running and using memory. Keeping more sessions open may increase resource usage.",
    "When enabled, codexhost periodically checks sessions and closes background instances once the idle timeout is reached and no tasks or interactions are pending, reducing resource usage. Chat history is not deleted. Opening the session again or sending a message restarts the process.",
  ]),
  idleReleaseTimeout: "Idle timeout",
  idleReleaseTimeoutDescription: "5–1440 minutes.",
  idleReleaseMinutes: "min",
  idleReleaseInvalid: "Enter a whole number from 5 to 1440.",
  idleReleasePending: "Syncing…",
  idleReleaseUnavailable: "Not supported by this Host",
  idleReleaseFailed: "Sync failed, try again",
  reasoningSoftWrapTitle: "Wrap thinking text",
  reasoningSoftWrapDescription: "Wrap long lines in thinking blocks. Shell output is unaffected.",
  pageUnavailable: "Page unavailable",
  inDevelopment: "In development",
  notAvailable: "Not available",
  runtimeCapabilityNotInstalled: "This runtime capability is not installed yet.",
  sessionImportHarness: "Harness",
  sessionImportDescription:
    "Sessions keep their original project path. If a folder is not in the Codex sidebar, add it as a project first. Original history remains managed by the Harness.",
  sessionImportAvailabilityNote:
    "Available Harnesses come from the local Host. If activity is unknown, close the session in its native client before importing to avoid concurrent writes.",
  sessionImportRefresh: "Refresh",
  sessionImportRefreshing: "Loading local sessions...",
  sessionImportUnavailable:
    "Session import is unavailable for this local Harness or its current protocol. Update the Host/plugin or choose another Harness.",
  sessionImportEmpty: "No local sessions are available to import.",
  sessionImportSearch: "Search",
  sessionImportSearchPlaceholder: "Search titles, session IDs or project paths",
  sessionImportNoMatches: "No sessions match your search.",
  sessionImportPageSize: "Per page",
  sessionImportPrevious: "Previous",
  sessionImportNext: "Next",
  sessionImportPageSummary: "Page {page} of {pages} · {total} sessions",
  sessionImportLoadFailed:
    "Local sessions could not be loaded. Check directory access or duplicate session IDs, then retry.",
  sessionImportFailed: "The session could not be imported.",
  sessionImportUntitled: "Untitled session",
  sessionImportUpdatedAt: "Updated",
  sessionImportSessionId: "Session ID",
  sessionImportRunning: "Running",
  sessionImportRunningHint:
    "Close this session in its native client before importing, then refresh.",
  sessionImportAction: "Import and open",
  sessionImportImporting: "Importing...",
  sessionImportImported: "Session imported",
  sessionImportOpenFailed:
    "The Codex sidebar has not shown it yet. Make sure the folder below is added as a project, then try opening it again.",
  sessionImportCopyProjectPath: "Copy project path",
  sessionImportPathCopied: "Copied",
  sessionImportPathCopyFailed: "Copy failed",
  sessionImportRetryOpen: "Try opening again",
  sessionImportRetrying: "Opening...",
  connectionsDescription:
    "View runtime status by Host. Select an item to inspect details or complete its setup.",
  accountConnected: "Accounts",
  accountDefaultBadge: "Current",
  accountColumnAccount: "Account",
  accountSearch: "Search accounts or Agents…",
  accountEmpty:
    "No current identities found. Sign in through Codex Desktop or your Harness's native client.",
  accountNoMatches: "No matching accounts.",
  accountNativeManagementHint:
    "This account comes from {harness}'s native authentication. This page only displays identity and limits; manage sign-in, sign-out and switching in the native client.",
  accountDefaultHint: "This is the current identity for all Codex Threads.",
  accountCreditsRemaining: "Remaining",
  accountCreditsLoading: "Loading limits…",
  accountCreditsEmpty: "No limit data available",
  accountCreditsFailed: "Could not load limits",
  accountCreditsRetry: "Retry",
  accountCreditsRefresh: "Refresh limits",
  accountLoadFailed: "Could not load Codex Accounts.",
  accountCreditsUsed: "Used",
  accountCreditsResetAt: "Quota resets: {time}",
  accountCreditsResetIn: "Quota resets in {time}",
  accountCreditsResetPending: "Awaiting refresh",
  accountCreditsResetPendingHint: "The reset time has passed; refresh to check the actual quota.",
  accountCreditsPeriodWeekly: "Weekly limit",
  accountCreditsPeriodMonthly: "Monthly limit",
  accountCreditsPeriodFiveHour: "5-hour",
  accountCreditsPeriodSevenDay: "7-day",
  accountCreditsPeriodUnknown: "Limit",
  accountCreditsBuild: "Build",
  accountResetCredits: "Reset cards",
  accountResetCreditsDetails: "Reset card details",
  accountResetCreditsCardExpiry: "Card {index} · expires {time}",
  connectionAdapter: "Renderer adapter",
  connectionHosts: "Hosts",
  connectionLocalHost: "Local",
  connectionRemoteHost: "Remote Host",
  connectionActiveHost: "Current",
  connectionReason: "Reason",
  connectionRefresh: "Run connection diagnostics",
  connectionRefreshing: "Running diagnostics...",
  connectionViewError: "View error",
  connectionCopyDetails: "Copy diagnostics",
  connectionCopied: "Copied",
  connectionCopyFailed: "Copy failed",
  connectionErrorCode: "Error code",
  connectionErrorMessage: "Error message",
  connectionRetryable: "Retryable",
  connectionFailureStage: "Failure stage",
  connectionDuration: "Duration",
  connectionDiagnostic: "Diagnostic",
  connectionNoRuntime: "The renderer request bridge is not available yet.",
  connectionStatusReady: "Ready",
  connectionStatusChecking: "Checking",
  connectionStatusNotInstalled: "Not installed",
  connectionStatusUnavailable: "Unavailable",
  connectionStatusError: "Error",
  connectionStatusInstalling: "Installing",
  connectionStatusUnsupported: "Unsupported",
  connectionComponent: "Component",
  connectionStatus: "Status",
  connectionHostsScrollLeft: "Show previous Hosts",
  connectionHostsScrollRight: "Show more Hosts",
  launchPathLabel: "Installed application path",
  launchPathPlaceholder: "Installation folder, e.g. D:\\program\\WorkBuddy",
  launchPathWorkbuddyHelp:
    "This integration requires the WorkBuddy app. If it is not detected automatically, enter its installation folder. codexhost locates the required files inside it. Restart codexhost after saving to apply.",
  launchPathSave: "Save path",
  launchPathReset: "Clear override",
  launchPathRestart: "Saved. Restart codexhost to apply; running sessions are unchanged.",
  launchPathSaved: "This Host is using the saved override. Availability is checked separately.",
  launchPathAutomatic:
    "No saved override. Uses environment configuration, then automatic discovery.",
  launchPathSaving: "Saving…",
  launchPathLoading: "Loading launch settings…",
  launchPathLoadError: "Could not load launch settings. Reopen this detail panel to retry.",
  launchPathSaveError:
    "Could not save. Enter an existing absolute installation folder on this Host and check configuration permissions.",
  connectionOpenInstallation: "Show installation instructions",
  connectionOpenHarnessWeb: "Open DeepSeek Harness Web",
  connectionDeepSeekTestedVersions:
    "Supported DSH versions: 0.1.2-rc.1, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.5-rc.3, 0.1.7-rc.1 and 0.1.7-rc.2. Other versions may connect after native protocol checks, but are not listed as supported.",
  connectionInstall: "Install",
  connectionInstallDescription: "This Harness was not detected.",
  connectionErrorTitle: "Connection check failed",
  connectionErrorLog: "Error log",
  connectionOpenIssue: "Open GitHub Issue",
  connectionIssueDescription:
    "Copy the error log and include the Host and reproduction steps when reporting the issue.",
  connectionReadyDescription: "This component is available on the selected Host.",
  connectionUnavailableDescription:
    "This component is not currently available on the selected Host.",
  connectionGroupMoreLabel: "More",
  connectionGroupMoreHintTitle: "Drag Agents here to collapse the ones you rarely use",
  connectionGroupMoreHintBody: "They fold into the picker's “More Agents” group",
  connectionGroupMoveToMore: "Move to More",
  connectionGroupMoveToMain: "Move back to Main",
  connectionGroupDragHandle: "Drag to reorder",
  connectionGroupReset: "Reset order",
  pickerMoreAgentsLabel: "More agents",
  pickerManageLink: "Manage",
  pickerHideUnusedAgentsCta: "Hide unused agents",
  enabled: "Enabled",
  disabled: "Disabled",
  openSettings: "Open codexhost settings",
  settingsButtonTitle: "codexhost settings",
  settingsUnavailableTitle: "codexhost settings unavailable",
  updateCurrentVersion: "Current version",
  updateInstallation: "Installation method",
  updateInstallationNpm: "npm",
  updateInstallationWindowsInstaller: "Windows installer",
  updateInstallationMacOsDmg: "macOS DMG",
  updateInstallationUnknown: "Unknown",
  updateLatestVersion: "Latest version",
  updateUpToDate: "You are up to date.",
  updateAvailable: "A new version is available.",
  updateWindowsManualRequired:
    "Automatic updates are unavailable on Windows. Update manually below.",
  updateAndRestart: "Update",
  updateChecking: "Checking for updates...",
  updateDownloading: "Downloading update...",
  updatePreparing: "Preparing update...",
  updateWaitingForExit: "Waiting for the application to close...",
  updateInstalling: "Installing update...",
  updateInstallingNpm: "Installing update through npm...",
  updateRequestTimeout:
    "The update service did not respond. Download the latest version from GitHub Releases below.",
  updateServiceUnavailable:
    "Automatic updates are unavailable right now. Download the latest version from GitHub Releases below.",
  updateRestarting: "Restarting to finish the update...",
  updateSucceeded: "Update installed successfully.",
  updateFailed: "Update failed.",
  updateRetry: "Retry",
  updateManualNpmDescription: "To update manually, quit codexhost and run this command:",
  updateWindowsNpmDescription:
    "Automatic updates are unavailable on Windows. Quit codexhost and run this command in a terminal:",
  updateWindowsInstallerDescription:
    "Automatic updates are unavailable on Windows. Download and run the installer for this system.",
  updateManualTitle: "Manual update",
  updateManualFallbackDescription:
    "The automatic update did not complete. Run this command in a terminal instead, then quit Codex and relaunch it with codexhost.",
  updateCopyCommand: "Copy",
  updateCommandCopied: "Copied",
  updateCopyFailed: "Copy failed",
  updateDownloadFromReleases: "Download from GitHub Releases",
  updateDownloadWindowsInstaller: "Download Windows installer",
  updateStarCallout:
    "If CodexHost has helped you, please Star it on GitHub. It means a lot to us 👉",
  updateStarLink: "GitHub",
  aboutTagline: "Run Pi and other Harnesses in Codex Desktop",
  aboutParagraphs: Object.freeze([
    "We believe Codex Desktop offers the best desktop development experience available today.",
    "But Codex is not the only excellent Agent Harness. Some developers prefer Claude Code or Pi Agent.",
    "codexhost lets you choose the Agent that actually executes tasks inside Codex Desktop, while preserving the native Codex experience and enabling them to collaborate.",
  ]),
  aboutOpenSource: "codexhost is an open-source project. The source code is available at:",
  aboutStarCallout: "⭐ If this project helps you, please give us a Star! ⭐",
  aboutRepository: "Open-source repository",
  pageLabels: Object.freeze({
    connections: "Connections",
    appearance: "General",
    accounts: "Accounts",
    "session-import": "Session Import",
    updates: "Updates",
    about: "About",
  }),
});

const CHINESE_MESSAGES: RendererSettingsMessages = Object.freeze({
  credentialImports: credentialImportChinese,
  locale: "zh-CN",
  title: "设置",
  close: "关闭设置",
  starOnGitHub: "Star 支持",
  sectionsLabel: "设置分类",
  generalSection: "通用",
  otherSection: "其他",
  appearanceDescription: "会话显示与本地资源管理。",
  appearanceGroup: "外观",
  loadedSessions: {
    title: "已加载会话",
    description:
      "仅显示本地外部 Harness。每 10 秒刷新，不唤醒会话、不重置活动时间。释放后的会话从列表移除。",
    columns: ["会话", "Harness", "状态", "距最后活动", "暂不能释放的原因"],
    empty: "暂无已加载的外部会话。",
    failed: "无法加载会话状态。",
    unavailable: "本地 Host 不支持会话状态查询或当前不可用。",
    loading: "正在加载会话状态…",
    minutes: "{minutes} 分钟",
    states: {
      idle: "空闲",
      running: "执行中",
      busy: "忙碌",
      closing: "释放中",
      failed: "释放失败",
      blocked: "不可释放",
    },
    reasons: {
      none: "—",
      disabled: "自动释放已关闭",
      timeout: "尚未达到超时",
      operation: "任务或 Host 操作尚未结束",
      background: "存在子任务、转向、命令或待处理交互",
      identity: "缺少可恢复身份或仅有快照",
      persistence: "持久化或输出异常",
      closeFailed: "需重启 Desktop 后重试",
    },
  },
  idleReleaseSection: "资源管理",
  idleReleaseTitle: "自动释放空闲会话",
  idleReleaseDescription: "空闲超时后关闭后台实例，再次使用时自动恢复。",
  idleReleaseHelpLabel: "自动释放空闲会话说明",
  idleReleaseHelp: Object.freeze([
    "Agent 回复结束后，后台进程可能仍在运行并占用内存。打开的会话越多，资源占用可能越大。",
    "开启后，codexhost 会定期检查，在会话空闲达到设定时间、且没有任务或待处理交互时，自动关闭后台实例，减少资源占用。聊天记录不会删除，再次打开或发送消息时会重新启动该进程。",
  ]),
  idleReleaseTimeout: "空闲超时",
  idleReleaseTimeoutDescription: "5～1440 分钟。",
  idleReleaseMinutes: "分钟",
  idleReleaseInvalid: "请输入 5～1440 之间的整数。",
  idleReleasePending: "同步中…",
  idleReleaseUnavailable: "当前 Host 不支持",
  idleReleaseFailed: "同步失败，请重试",
  reasoningSoftWrapTitle: "换行显示思考文本",
  reasoningSoftWrapDescription: "思考块中的长行自动换行，不影响 Shell 输出。",
  pageUnavailable: "页面不可用",
  inDevelopment: "开发中",
  notAvailable: "暂不可用",
  runtimeCapabilityNotInstalled: "运行时尚未安装该项能力，因此暂不可用。",
  sessionImportHarness: "Harness",
  sessionImportDescription:
    "会话将保留原始项目路径；若该文件夹尚未出现在 Codex 侧栏，请先将其添加为项目。原始历史仍由 Harness 管理。",
  sessionImportAvailabilityNote:
    "可选 Harness 来自本地 Host。运行状态未知时，请先在原生客户端关闭该会话再导入，避免同时写入。",
  sessionImportRefresh: "刷新",
  sessionImportRefreshing: "正在读取本地会话……",
  sessionImportUnavailable:
    "本地 Harness 或当前协议暂不支持会话导入，请更新 Host/插件或选择其他 Harness。",
  sessionImportEmpty: "没有可导入的本地会话。",
  sessionImportSearch: "搜索",
  sessionImportSearchPlaceholder: "搜索标题、会话 ID 或项目路径",
  sessionImportNoMatches: "没有匹配的会话。",
  sessionImportPageSize: "每页",
  sessionImportPrevious: "上一页",
  sessionImportNext: "下一页",
  sessionImportPageSummary: "第 {page} / {pages} 页 · 共 {total} 条",
  sessionImportLoadFailed: "无法读取本地会话，请检查目录访问权限或重复的会话 ID 后重试。",
  sessionImportFailed: "无法导入该会话。",
  sessionImportUntitled: "未命名会话",
  sessionImportUpdatedAt: "更新时间",
  sessionImportSessionId: "会话 ID",
  sessionImportRunning: "运行中",
  sessionImportRunningHint: "请先在原生客户端关闭该会话，再刷新并导入。",
  sessionImportAction: "导入并打开",
  sessionImportImporting: "正在导入……",
  sessionImportImported: "会话已导入",
  sessionImportOpenFailed: "Codex 侧栏尚未显示该会话。请确认以下文件夹已添加为项目，然后重试打开。",
  sessionImportCopyProjectPath: "复制项目路径",
  sessionImportPathCopied: "已复制",
  sessionImportPathCopyFailed: "复制失败",
  sessionImportRetryOpen: "重试打开",
  sessionImportRetrying: "正在打开……",
  connectionsDescription: "按 Host 查看运行时状态。选择一项，在右侧检查详情或完成配置。",
  accountConnected: "账号",
  accountDefaultBadge: "当前",
  accountColumnAccount: "账号",
  accountSearch: "搜索账号或 Agent…",
  accountEmpty: "尚未识别到当前身份，请在 Codex Desktop 或对应 Harness 的原生客户端登录。",
  accountNoMatches: "没有匹配的账号。",
  accountNativeManagementHint:
    "此账号来自 {harness} 的原生登录。这里只读展示身份与额度；登录、退出和切换请在其原生客户端中完成。",
  accountDefaultHint: "所有 Codex 会话当前使用此身份。",
  accountCreditsRemaining: "剩余",
  accountCreditsLoading: "正在读取额度…",
  accountCreditsEmpty: "暂无额度数据",
  accountCreditsFailed: "额度读取失败",
  accountCreditsRetry: "重试",
  accountCreditsRefresh: "刷新额度",
  accountLoadFailed: "无法加载 Codex 账号。",
  accountCreditsUsed: "已用",
  accountCreditsResetAt: "额度重置时间：{time}",
  accountCreditsResetIn: "距重置还有 {time}",
  accountCreditsResetPending: "待刷新",
  accountCreditsResetPendingHint: "重置时间已到，请刷新以确认实际额度。",
  accountCreditsPeriodWeekly: "周额度",
  accountCreditsPeriodMonthly: "月额度",
  accountCreditsPeriodFiveHour: "5 小时",
  accountCreditsPeriodSevenDay: "7 天",
  accountCreditsPeriodUnknown: "额度",
  accountCreditsBuild: "Build",
  accountResetCredits: "重置卡",
  accountResetCreditsDetails: "重置卡详情",
  accountResetCreditsCardExpiry: "第 {index} 张 · {time}到期",
  connectionAdapter: "Renderer 适配器",
  connectionHosts: "Host 列表",
  connectionLocalHost: "本地",
  connectionRemoteHost: "远程 Host",
  connectionActiveHost: "当前",
  connectionReason: "原因",
  connectionRefresh: "重新诊断连接",
  connectionRefreshing: "正在诊断...",
  connectionViewError: "查看错误",
  connectionCopyDetails: "复制诊断信息",
  connectionCopied: "已复制",
  connectionCopyFailed: "复制失败",
  connectionErrorCode: "错误码",
  connectionErrorMessage: "错误信息",
  connectionRetryable: "可重试",
  connectionFailureStage: "失败阶段",
  connectionDuration: "检查耗时",
  connectionDiagnostic: "诊断信息",
  connectionNoRuntime: "Renderer 请求桥尚未可用。",
  connectionStatusReady: "正常",
  connectionStatusChecking: "检查中",
  connectionStatusNotInstalled: "未安装",
  connectionStatusUnavailable: "不可用",
  connectionStatusError: "错误",
  connectionStatusInstalling: "安装中",
  connectionStatusUnsupported: "不支持",
  connectionComponent: "组件",
  connectionStatus: "状态",
  connectionHostsScrollLeft: "查看前面的 Host",
  connectionHostsScrollRight: "查看更多 Host",
  launchPathLabel: "应用安装路径",
  launchPathPlaceholder: "填写安装目录，例如 D:\\program\\WorkBuddy",
  launchPathWorkbuddyHelp:
    "此接入依赖 WorkBuddy 应用。若未自动识别，请填写应用安装目录，codexhost 会自动定位所需文件。保存后重启 codexhost 生效。",
  launchPathSave: "保存路径",
  launchPathReset: "清除自定义路径",
  launchPathRestart: "已保存，重启 codexhost 后生效；当前运行中的会话不受影响。",
  launchPathSaved: "此 Host 正在使用已保存的路径；是否可用仍以连接检测结果为准。",
  launchPathAutomatic: "未设置自定义路径，使用环境变量配置或自动发现。",
  launchPathSaving: "正在保存…",
  launchPathLoading: "正在读取启动设置…",
  launchPathLoadError: "无法读取启动设置，请重新打开此详情面板重试。",
  launchPathSaveError: "保存失败。请填写此 Host 上实际存在的安装目录绝对路径，并确认配置目录可写。",
  connectionOpenInstallation: "查看安装指引",
  connectionOpenHarnessWeb: "打开 DeepSeek Harness Web",
  connectionDeepSeekTestedVersions:
    "支持 DSH 版本：0.1.2-rc.1、0.1.5-rc.1、0.1.5-rc.2、0.1.5-rc.3、0.1.7-rc.1 和 0.1.7-rc.2。其他规范 SemVer 版本可以在通过原生协议检查后尝试连接，但尚未列入支持列表。",
  connectionInstall: "安装",
  connectionInstallDescription: "尚未检测到该 Harness。",
  connectionErrorTitle: "连接检查失败",
  connectionErrorLog: "错误日志",
  connectionOpenIssue: "提交 GitHub Issue",
  connectionIssueDescription: "提交前请复制错误日志，并在 Issue 中说明当前 Host 与复现步骤。",
  connectionReadyDescription: "该组件在当前 Host 上可用。",
  connectionUnavailableDescription: "该组件当前无法在所选 Host 上使用。",
  connectionGroupMoreLabel: "更多",
  connectionGroupMoreHintTitle: "拖到这里可以收起不常用的 Agent",
  connectionGroupMoreHintBody: "它们会折叠进选择器的「更多」分组",
  connectionGroupMoveToMore: "移到更多",
  connectionGroupMoveToMain: "移回常用",
  connectionGroupDragHandle: "拖动排序",
  connectionGroupReset: "恢复默认排列",
  pickerMoreAgentsLabel: "更多 Agent",
  pickerManageLink: "管理",
  pickerHideUnusedAgentsCta: "收起不常用的 Agent",
  enabled: "已开启",
  disabled: "已关闭",
  openSettings: "打开 codexhost 设置",
  settingsButtonTitle: "codexhost 设置",
  settingsUnavailableTitle: "codexhost 设置不可用",
  updateCurrentVersion: "当前版本",
  updateInstallation: "安装方式",
  updateInstallationNpm: "npm",
  updateInstallationWindowsInstaller: "Windows 安装程序",
  updateInstallationMacOsDmg: "macOS DMG",
  updateInstallationUnknown: "未知",
  updateLatestVersion: "最新版本",
  updateUpToDate: "当前已是最新版本。",
  updateAvailable: "有新版本可用。",
  updateWindowsManualRequired: "Windows 暂不支持自动更新，请在下方手动更新。",
  updateAndRestart: "更新",
  updateChecking: "正在检查更新...",
  updateDownloading: "正在下载更新...",
  updatePreparing: "正在准备更新...",
  updateWaitingForExit: "正在等待应用退出...",
  updateInstalling: "正在安装更新...",
  updateInstallingNpm: "正在通过 npm 安装...",
  updateRequestTimeout: "更新服务未响应，请通过下方 GitHub Releases 手动下载最新版本。",
  updateServiceUnavailable: "暂时无法自动更新，请通过下方 GitHub Releases 手动下载最新版本。",
  updateRestarting: "正在重启以完成更新...",
  updateSucceeded: "更新安装成功。",
  updateFailed: "更新失败。",
  updateRetry: "重试",
  updateManualNpmDescription:
    "如需手动更新，请在终端运行以下命令。更新完成后，请退出 Codex 并通过 codexhost 重新启动。",
  updateWindowsNpmDescription:
    "Windows 暂不支持自动更新。请退出 codexhost，在终端运行以下命令完成更新。",
  updateWindowsInstallerDescription:
    "Windows 暂不支持自动更新。请下载并运行适用于当前系统的安装包。",
  updateManualTitle: "手动更新",
  updateManualFallbackDescription:
    "自动更新未能完成，请改用下列命令在终端手动更新。完成后请退出 Codex 并通过 codexhost 重新启动。",
  updateCopyCommand: "复制",
  updateCommandCopied: "已复制",
  updateCopyFailed: "复制失败",
  updateDownloadFromReleases: "前往 GitHub Releases 下载",
  updateDownloadWindowsInstaller: "下载 Windows 安装包",
  updateStarCallout: "如果 CodexHost 帮到了你，请在 GitHub 点个 Star，这对我们意义重大 👉",
  updateStarLink: "GitHub",
  aboutTagline: "在 Codex Desktop 中运行 Pi 和其他 Harness",
  aboutParagraphs: Object.freeze([
    "我们认为 Codex Desktop 提供了目前最好的桌面开发交互体验。",
    "但 Codex 并不是唯一优秀的 Agent Harness，也有人偏好 Claude Code 和 Pi Agent。",
    "codexhost 让你在 Codex Desktop 中选择真正执行任务的 Agent，同时保留 Codex 的原生体验，并让它们协作完成任务。",
  ]),
  aboutOpenSource: "codexhost 是一个开源项目，开源地址：",
  aboutStarCallout: "⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐",
  aboutRepository: "开源仓库",
  pageLabels: Object.freeze({
    connections: "连接",
    appearance: "通用",
    accounts: "账号",
    "session-import": "会话导入",
    updates: "更新",
    about: "关于",
  }),
});

export const DEFAULT_RENDERER_SETTINGS_MESSAGES = ENGLISH_MESSAGES;

function languageFromTag(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag).language.toLowerCase();
  } catch {
    return undefined;
  }
}

export function resolveRendererSettingsLocale(
  languageTags: readonly string[],
): RendererSettingsLocale {
  for (const tag of languageTags) {
    const language = languageFromTag(tag);
    if (language === "zh") return "zh-CN";
    if (language === "en") return "en";
  }
  return "en";
}

export function rendererSettingsMessages(locale: RendererSettingsLocale): RendererSettingsMessages {
  return locale === "zh-CN" ? CHINESE_MESSAGES : ENGLISH_MESSAGES;
}

export function rendererSettingsLanguageSelection(
  localeOverride: string | null | undefined,
): RendererSettingsLanguageSelection {
  if (localeOverride == null) return "automatic";
  const language = languageFromTag(localeOverride);
  if (language === "zh") return "zh-CN";
  if (language === "en") return "en";
  return "other";
}

export function codexLocaleOverrideForSettingsSelection(
  selection: RendererSettingsWritableLanguageSelection,
): "en-US" | "zh-CN" | null {
  if (selection === "automatic") return null;
  return selection === "en" ? "en-US" : "zh-CN";
}
