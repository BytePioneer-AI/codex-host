import type { DesktopExtensionSlot, DesktopExtensionStatus } from "@codexhost/shared-contracts";

export interface DesktopExtensionsMessages {
  readonly description: string;
  readonly directoryLabel: string;
  readonly directoryDefaultHint: string;
  readonly copyPath: string;
  readonly copiedPath: string;
  readonly copyPathFailed: string;
  readonly refresh: string;
  readonly refreshing: string;
  readonly retry: string;
  readonly desktopConnected: string;
  readonly desktopDisconnected: string;
  readonly loading: string;
  readonly unavailableTitle: string;
  readonly unavailableDescription: string;
  readonly loadFailed: string;
  readonly diagnosticsTitle: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly emptyPathHint: string;
  readonly noExclusiveSlots: string;
  readonly slots: Readonly<Record<DesktopExtensionSlot, string>>;
  readonly states: Readonly<Record<DesktopExtensionStatus["state"], string>>;
  readonly toggleLabel: string;
  readonly toggleDisabledIncompatible: string;
  readonly toggleDisabledInvalid: string;
  readonly conflictOccupiedBy: string;
  readonly conflictSlotDetails: string;
  readonly savedEnabled: string;
  readonly savedDisabled: string;
  readonly slotConflictBanner: string;
  readonly slotConflictBannerWithSlots: string;
  readonly revisionConflictBanner: string;
  readonly actionFailed: string;
  readonly recoveryTitle: string;
  readonly recoveryDescription: string;
  readonly recoveryButton: string;
  readonly recoveryDialogTitle: string;
  readonly recoveryDialogDescription: string;
  readonly recoveryDialogOfflineNote: string;
  readonly recoveryDialogCancel: string;
  readonly recoveryDialogConfirm: string;
  readonly recoveryDialogBusy: string;
  readonly recoverySaved: string;
}

export const desktopExtensionsEnglish: DesktopExtensionsMessages = Object.freeze({
  description:
    "Manage optional UI extensions for the local Codex Desktop main window. Enabling or disabling applies live without restarting Desktop.",
  directoryLabel: "Extensions directory",
  directoryDefaultHint: "Default: ~/.codexhost/desktop-extensions/",
  copyPath: "Copy path",
  copiedPath: "Copied",
  copyPathFailed: "Copy failed",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  retry: "Retry",
  desktopConnected: "Desktop connected",
  desktopDisconnected: "Waiting for Desktop",
  loading: "Loading Desktop extensions…",
  unavailableTitle: "Desktop extension management is unavailable",
  unavailableDescription:
    "Connect to a local codexhost Host that supports Desktop extension management, then try again.",
  loadFailed: "Could not load Desktop extensions: {message}",
  diagnosticsTitle: "Configuration diagnostics",
  emptyTitle: "No Desktop extensions found",
  emptyDescription:
    "Copy an extension folder containing manifest.json and desktop.js into the directory below, then refresh.",
  emptyPathHint: "$CODEXHOST_DATA_DIR/desktop-extensions/<id>/",
  noExclusiveSlots: "No exclusive slots",
  slots: Object.freeze({
    "sidebar.thread-layout": "Sidebar thread layout",
    "sidebar.thread-badge": "Sidebar thread badge",
  }),
  states: Object.freeze({
    running: "Running",
    waiting: "Waiting for Desktop",
    disabled: "Disabled",
    conflict: "Slot conflict",
    failed: "Failed",
    incompatible: "Incompatible",
    invalid: "Invalid",
  }),
  toggleLabel: "Toggle {name}",
  toggleDisabledIncompatible: "Cannot enable an incompatible extension.",
  toggleDisabledInvalid: "Cannot enable an invalid extension.",
  conflictOccupiedBy: "Slot occupied by {other}",
  conflictSlotDetails: "{slots} occupied by {other}",
  savedEnabled: "Enabled “{name}”.",
  savedDisabled: "Disabled “{name}”.",
  slotConflictBanner:
    "Could not enable “{name}”: a required slot is already occupied by {other}. Disable {other} first.",
  slotConflictBannerWithSlots:
    "Could not enable “{name}”: {slots} is already occupied by {other}. Disable {other} first.",
  revisionConflictBanner:
    "Extension settings were updated elsewhere. The latest list has been reloaded—please try again.",
  actionFailed: "Could not update extension settings: {message}",
  recoveryTitle: "Emergency recovery",
  recoveryDescription:
    "If an extension breaks the Codex Desktop sidebar or makes the window unusable, clear all enabled extensions and request the Desktop Controller to reload the window. Unsaved UI state may be lost.",
  recoveryButton: "Disable all extensions and reload Desktop window",
  recoveryDialogTitle: "Disable all extensions and reload Desktop window?",
  recoveryDialogDescription:
    "All enabled Desktop extensions will be cleared. The Desktop Controller will unload active extensions and reload the Codex Desktop main window. Unsaved UI state may be lost.",
  recoveryDialogOfflineNote:
    "Desktop is not currently connected. The recovery command will still be saved and applied when the Desktop Controller reconnects.",
  recoveryDialogCancel: "Cancel",
  recoveryDialogConfirm: "Disable all and reload",
  recoveryDialogBusy: "Saving…",
  recoverySaved: "Recovery command saved. Waiting for the Desktop Controller to reload the window.",
});

export const desktopExtensionsChinese: DesktopExtensionsMessages = Object.freeze({
  description:
    "管理本机 Codex Desktop 主窗口的可选界面扩展。启用或禁用会实时生效，无需重启 Desktop。",
  directoryLabel: "扩展根目录",
  directoryDefaultHint: "默认 ~/.codexhost/desktop-extensions/",
  copyPath: "复制路径",
  copiedPath: "已复制",
  copyPathFailed: "复制失败",
  refresh: "刷新",
  refreshing: "刷新中…",
  retry: "重试",
  desktopConnected: "Desktop 已连接",
  desktopDisconnected: "等待 Desktop 连接",
  loading: "正在加载 Desktop 扩展…",
  unavailableTitle: "无法管理 Desktop 扩展",
  unavailableDescription: "请连接到支持 Desktop 扩展管理的本机 codexhost Host 后再试。",
  loadFailed: "无法加载 Desktop 扩展：{message}",
  diagnosticsTitle: "配置诊断",
  emptyTitle: "尚未发现 Desktop 扩展",
  emptyDescription: "请将包含 manifest.json 和 desktop.js 的扩展目录放到以下路径，然后点击刷新：",
  emptyPathHint: "$CODEXHOST_DATA_DIR/desktop-extensions/<id>/",
  noExclusiveSlots: "无独占槽位",
  slots: Object.freeze({
    "sidebar.thread-layout": "侧栏 Thread 布局",
    "sidebar.thread-badge": "侧栏 Thread 角标",
  }),
  states: Object.freeze({
    running: "运行中",
    waiting: "等待 Desktop",
    disabled: "未启用",
    conflict: "槽位冲突",
    failed: "失败",
    incompatible: "不兼容",
    invalid: "无效",
  }),
  toggleLabel: "切换 {name}",
  toggleDisabledIncompatible: "不兼容的扩展无法启用。",
  toggleDisabledInvalid: "无效的扩展无法启用。",
  conflictOccupiedBy: "槽位已被 {other} 占用",
  conflictSlotDetails: "槽位 {slots} 已被 {other} 占用",
  savedEnabled: "已启用“{name}”。",
  savedDisabled: "已禁用“{name}”。",
  slotConflictBanner: "无法启用“{name}”：所需槽位已被 {other} 占用，请先禁用 {other}。",
  slotConflictBannerWithSlots:
    "无法启用“{name}”：槽位 {slots} 已被 {other} 占用，请先禁用 {other}。",
  revisionConflictBanner: "扩展配置已在其他入口更新，已自动刷新最新列表，请重试。",
  actionFailed: "更新扩展配置失败：{message}",
  recoveryTitle: "应急恢复",
  recoveryDescription:
    "如果某个扩展导致 Codex Desktop 侧栏异常或无法操作，可禁用全部扩展并请求 Desktop Controller 重载窗口。未保存的界面状态可能会丢失。",
  recoveryButton: "禁用全部扩展并重载 Desktop 窗口",
  recoveryDialogTitle: "禁用全部扩展并重载 Desktop 窗口？",
  recoveryDialogDescription:
    "将清除全部已启用的 Desktop 扩展。Desktop Controller 会回收当前扩展并重载 Codex Desktop 主窗口，未保存的界面状态可能会丢失。",
  recoveryDialogOfflineNote:
    "当前未检测到在线的 Desktop 连接；恢复指令仍会被保存，并在 Desktop Controller 重新连接后生效。",
  recoveryDialogCancel: "取消",
  recoveryDialogConfirm: "确认禁用并重载",
  recoveryDialogBusy: "保存中…",
  recoverySaved: "恢复指令已保存，等待 Desktop Controller 重载窗口。",
});
