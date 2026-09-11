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
  readonly locale: RendererSettingsLocale;
  readonly title: string;
  readonly close: string;
  readonly starOnGitHub: string;
  readonly sectionsLabel: string;
  readonly generalSection: string;
  readonly otherSection: string;
  readonly appearanceDescription: string;
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
  readonly sessionImportRunningUnknown: string;
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
  readonly accountsDescription: string;
  readonly accountAdd: string;
  readonly accountColumnAccount: string;
  readonly accountConnected: string;
  readonly accountDefaultBadge: string;
  readonly accountColumnActions: string;
  readonly accountSearch: string;
  readonly accountEmpty: string;
  readonly accountNoMatches: string;
  readonly accountNativeManaged: string;
  readonly accountNativeManagementHint: string;
  readonly accountMore: string;
  readonly accountDetailsClose: string;
  readonly accountDefaultHint: string;
  readonly accountCreditsRemaining: string;
  readonly accountCreditsLoading: string;
  readonly accountCreditsEmpty: string;
  readonly accountCreditsFailed: string;
  readonly accountCreditsRetry: string;
  readonly accountCreditsRefresh: string;
  readonly accountCreateFailed: string;
  readonly accountDelete: string;
  readonly accountDeleteConfirm: string;
  readonly accountDeleting: string;
  readonly accountDeleteFailed: string;
  readonly accountActive: string;
  readonly accountUse: string;
  readonly accountLogout: string;
  readonly accountLogoutConfirm: string;
  readonly accountLoggingOut: string;
  readonly accountLoggedOut: string;
  readonly accountLogoutFailed: string;
  readonly accountRecover: string;
  readonly accountRecovering: string;
  readonly accountRecoveryRequired: string;
  readonly accountCleanupRequired: string;
  readonly accountSignIn: string;
  readonly accountSigningIn: string;
  readonly accountVerificationDescription: string;
  readonly accountCopyCode: string;
  readonly accountCopied: string;
  readonly accountLoginCancel: string;
  readonly accountLoginSucceeded: string;
  readonly accountLoginResultUnconfirmed: string;
  readonly accountLoginFailed: string;
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
  readonly accountResetCreditsUse: string;
  readonly accountResetCreditsConfirm: string;
  readonly accountResetCreditsUsing: string;
  readonly accountResetCreditsFailed: string;
  readonly accountResetCreditsNothingToReset: string;
  readonly accountResetCreditsNoCredit: string;
  readonly accountResetCreditsAlreadyRedeemed: string;
  readonly accountResetCreditsSucceeded: string;
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
  readonly connectionOpenInstallation: string;
  readonly connectionOpenHarnessWeb: string;
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
  readonly aboutTagline: string;
  readonly aboutParagraphs: readonly string[];
  readonly aboutOpenSource: string;
  readonly aboutStarCallout: string;
  readonly aboutRepository: string;
  readonly pageLabels: Readonly<Record<DefaultRendererSettingsPageId, string>>;
}

const ENGLISH_MESSAGES: RendererSettingsMessages = Object.freeze({
  locale: "en",
  title: "Settings",
  close: "Close settings",
  starOnGitHub: "Give us a Star~",
  sectionsLabel: "Settings sections",
  generalSection: "General",
  otherSection: "Other",
  appearanceDescription: "Adjust how thinking text is displayed in the conversation.",
  reasoningSoftWrapTitle: "Wrap thinking text",
  reasoningSoftWrapDescription:
    "Wrap long thinking lines in the transcript. Ordinary shell output is unaffected. Off by default.",
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
  sessionImportRunningUnknown: "Activity unknown",
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
  accountsDescription:
    "View accounts and limits across Agents, and manage the current Codex identity.",
  accountConnected: "Accounts",
  accountDefaultBadge: "Current",
  accountAdd: "Add Codex account",
  accountColumnAccount: "Account",
  accountColumnActions: "Manage",
  accountSearch: "Search accounts or Agents…",
  accountEmpty: "No accounts yet. Add a Codex account or sign in to an Agent in its native client.",
  accountNoMatches: "No matching accounts.",
  accountNativeManaged: "Native management",
  accountNativeManagementHint:
    "This account comes from {harness}'s native authentication. This page only displays identity and limits; manage sign-in, sign-out and switching in the native client.",
  accountMore: "Codex account actions",
  accountDetailsClose: "Close account details",
  accountDefaultHint: "This is the current identity for all Codex Threads.",
  accountCreditsRemaining: "Remaining",
  accountCreditsLoading: "Loading limits…",
  accountCreditsEmpty: "No limit data available",
  accountCreditsFailed: "Could not load limits",
  accountCreditsRetry: "Retry",
  accountCreditsRefresh: "Refresh limits",
  accountCreateFailed: "Could not add the Account.",
  accountDelete: "Delete",
  accountDeleteConfirm: "Delete this Account and its local data? This cannot be undone.",
  accountDeleting: "Deleting Account...",
  accountDeleteFailed: "Could not delete the Account.",
  accountActive: "Current",
  accountUse: "Switch",
  accountLogout: "Sign out",
  accountLogoutConfirm: "Sign out the current Codex identity? Saved Accounts are retained.",
  accountLoggingOut: "Signing out...",
  accountLoggedOut: "Signed out. Saved Accounts are retained.",
  accountLogoutFailed: "Could not sign out the current Codex identity.",
  accountRecover: "Recover",
  accountRecovering: "Recovering Codex...",
  accountRecoveryRequired: "Codex Account recovery is required before work can continue.",
  accountCleanupRequired:
    "The Account change was saved, but cleanup or Codex recovery is still required.",
  accountSignIn: "Sign in",
  accountSigningIn: "Starting device sign-in...",
  accountVerificationDescription: "Open the verification page and enter this one-time code:",
  accountCopyCode: "Copy code",
  accountCopied: "Copied",
  accountLoginCancel: "Cancel sign-in",
  accountLoginSucceeded: "Sign-in completed.",
  accountLoginResultUnconfirmed:
    "Sign-in finished, but its result was not received. Inspect the saved Account state.",
  accountLoginFailed: "Sign-in failed.",
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
  accountResetCreditsUse: "Use reset",
  accountResetCreditsConfirm:
    "This uses 1 reset card and resets both the 5-hour and 7-day limits. This cannot be undone.",
  accountResetCreditsUsing: "Using reset card...",
  accountResetCreditsFailed: "Could not use the reset card.",
  accountResetCreditsNothingToReset: "Usage does not need a reset right now.",
  accountResetCreditsNoCredit: "No reset cards are available.",
  accountResetCreditsAlreadyRedeemed: "That reset card was already used.",
  accountResetCreditsSucceeded: "Limits were reset.",
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
  connectionOpenInstallation: "Open official installation page",
  connectionOpenHarnessWeb: "Open DeepSeek Harness Web",
  connectionInstall: "Install",
  connectionInstallDescription:
    "This Harness was not detected. Follow its official installation guide, then return here and run the check again.",
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
  updateRequestTimeout: "The update service did not respond. Try again.",
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
    appearance: "Appearance",
    accounts: "Accounts",
    "session-import": "Session Import",
    updates: "Updates",
    about: "About",
  }),
});

const CHINESE_MESSAGES: RendererSettingsMessages = Object.freeze({
  locale: "zh-CN",
  title: "设置",
  close: "关闭设置",
  starOnGitHub: "点个 Star~",
  sectionsLabel: "设置分类",
  generalSection: "通用",
  otherSection: "其他",
  appearanceDescription: "调整会话中思考文本的显示方式。",
  reasoningSoftWrapTitle: "换行显示思考文本",
  reasoningSoftWrapDescription: "让思考块中的长行自动换行。普通 Shell 输出不受影响。默认关闭。",
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
  sessionImportRunningUnknown: "运行状态未知",
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
  accountsDescription: "查看各 Agent 的账号与额度，管理 Codex 当前身份。",
  accountConnected: "账号",
  accountDefaultBadge: "当前",
  accountAdd: "添加 Codex 账号",
  accountColumnAccount: "账号",
  accountColumnActions: "管理",
  accountSearch: "搜索账号或 Agent…",
  accountEmpty: "还没有账号，可添加 Codex 账号或在其他 Agent 的原生客户端登录。",
  accountNoMatches: "没有匹配的账号。",
  accountNativeManaged: "原生管理",
  accountNativeManagementHint:
    "此账号来自 {harness} 的原生登录。这里只读展示身份与额度；登录、退出和切换请在其原生客户端中完成。",
  accountMore: "Codex 账号操作",
  accountDetailsClose: "关闭账号详情",
  accountDefaultHint: "所有 Codex 会话当前使用此身份。",
  accountCreditsRemaining: "剩余",
  accountCreditsLoading: "正在读取额度…",
  accountCreditsEmpty: "暂无额度数据",
  accountCreditsFailed: "额度读取失败",
  accountCreditsRetry: "重试",
  accountCreditsRefresh: "刷新额度",
  accountCreateFailed: "添加账号失败。",
  accountDelete: "删除",
  accountDeleteConfirm: "删除此账号及其本地数据？此操作无法撤销。",
  accountDeleting: "正在删除账号...",
  accountDeleteFailed: "删除账号失败。",
  accountActive: "当前账号",
  accountUse: "切换",
  accountLogout: "退出登录",
  accountLogoutConfirm: "退出当前 Codex 身份？已保存的账号会保留。",
  accountLoggingOut: "正在退出登录...",
  accountLoggedOut: "已退出登录，保存的账号仍会保留。",
  accountLogoutFailed: "无法退出当前 Codex 身份。",
  accountRecover: "恢复",
  accountRecovering: "正在恢复 Codex...",
  accountRecoveryRequired: "继续工作前需要恢复 Codex 账号状态。",
  accountCleanupRequired: "账号变更已保存，但仍需完成清理或恢复 Codex。",
  accountSignIn: "登录",
  accountSigningIn: "正在启动设备登录...",
  accountVerificationDescription: "打开验证页面并输入以下一次性代码：",
  accountCopyCode: "复制代码",
  accountCopied: "已复制",
  accountLoginCancel: "取消登录",
  accountLoginSucceeded: "登录成功。",
  accountLoginResultUnconfirmed: "登录已结束，但未收到结果。请检查已保存的账号状态。",
  accountLoginFailed: "登录失败。",
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
  accountResetCreditsUse: "使用重置",
  accountResetCreditsConfirm: "将消耗 1 张重置卡，同时重置 5 小时和 7 天额度。此操作无法撤销。",
  accountResetCreditsUsing: "正在使用重置卡...",
  accountResetCreditsFailed: "使用重置卡失败。",
  accountResetCreditsNothingToReset: "当前额度不需要重置。",
  accountResetCreditsNoCredit: "没有可用的重置卡。",
  accountResetCreditsAlreadyRedeemed: "这张重置卡已经使用过。",
  accountResetCreditsSucceeded: "额度已重置。",
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
  connectionOpenInstallation: "前往官方安装页面",
  connectionOpenHarnessWeb: "打开 DeepSeek Harness Web",
  connectionInstall: "安装",
  connectionInstallDescription:
    "尚未检测到该 Harness。请按照官方安装指南完成安装，然后返回此页面重新检查。",
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
  updateRequestTimeout: "更新服务未响应，请重试。",
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
    appearance: "外观",
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
