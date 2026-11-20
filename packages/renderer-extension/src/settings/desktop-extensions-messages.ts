import type {
  DesktopExtensionCategory,
  DesktopExtensionSlot,
  DesktopExtensionStatus,
} from "@codexhost/shared-contracts";

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
  readonly importButton: string;
  readonly tabListLabel: string;
  readonly tabInstalled: string;
  readonly tabMarketplace: string;
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
  readonly categoryAll: string;
  readonly categoryFilterLabel: string;
  readonly searchPlaceholder: string;
  readonly searchLabel: string;
  readonly clearSearch: string;
  readonly noMatchesTitle: string;
  readonly noMatchesDescription: string;
  readonly clearFilters: string;
  readonly categories: Readonly<Record<DesktopExtensionCategory, string>>;
  readonly groups: Readonly<{
    attention: string;
    enabled: string;
    disabled: string;
  }>;
  readonly updateAvailable: string;
  readonly trustOfficial: string;
  readonly trustCommunity: string;
  readonly communityNotice: string;
  readonly install: string;
  readonly installing: string;
  readonly update: string;
  readonly updating: string;
  readonly updateToVersion: string;
  readonly installedBadge: string;
  readonly installedVersionHint: string;
  readonly updatedAtLabel: string;
  readonly uninstall: string;
  readonly uninstalling: string;
  readonly uninstallConfirmPrompt: string;
  readonly uninstallConfirm: string;
  readonly uninstallCancel: string;
  readonly marketplaceLoading: string;
  readonly marketplaceUnavailableTitle: string;
  readonly marketplaceUnavailableDescription: string;
  readonly marketplaceEmptyTitle: string;
  readonly marketplaceEmptyDescription: string;
  readonly marketplaceFallbackNotice: string;
  readonly marketplaceFallbackNoticeWithError: string;
  readonly marketplaceLoadFailed: string;
  readonly installedSuccess: string;
  readonly updatedSuccess: string;
  readonly uninstalledSuccess: string;
  readonly installFailed: string;
  readonly uninstallFailed: string;
  readonly details: string;
  readonly openDetailsLabel: string;
  readonly closeModal: string;
  readonly authorBy: string;
  readonly githubRepository: string;
  readonly screenshotsTitle: string;
  readonly screenshotAlt: string;
  readonly screenshotPreviewLabel: string;
  readonly previousScreenshot: string;
  readonly nextScreenshot: string;
  readonly closePreview: string;
  readonly technicalDetails: string;
  readonly detailId: string;
  readonly detailVersion: string;
  readonly detailSlots: string;
  readonly detailHash: string;
  readonly detailSha256: string;
  readonly detailDiagnostics: string;
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
  readonly importDialogTitle: string;
  readonly importDialogSubtitle: string;
  readonly importTabUrl: string;
  readonly importTabZip: string;
  readonly importUrlLabel: string;
  readonly importUrlPlaceholder: string;
  readonly importUrlHint: string;
  readonly importAdvancedToggle: string;
  readonly importSha256Label: string;
  readonly importSha256Placeholder: string;
  readonly importZipDropTitle: string;
  readonly importZipDropHint: string;
  readonly importZipChooseFile: string;
  readonly importZipSelected: string;
  readonly importZipClear: string;
  readonly importSubmit: string;
  readonly importSubmitting: string;
  readonly importCancel: string;
  readonly importErrorEmptyUrl: string;
  readonly importErrorInvalidUrl: string;
  readonly importErrorInvalidSha256: string;
  readonly importErrorNoFile: string;
  readonly importErrorInvalidExtension: string;
  readonly importErrorEmptyFile: string;
  readonly importErrorFileTooLarge: string;
  readonly importErrorReadFailed: string;
  readonly importUnavailable: string;
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
  importButton: "Import extension",
  tabListLabel: "Desktop extension views",
  tabInstalled: "Installed ({count})",
  tabMarketplace: "Marketplace ({count})",
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
    "Install an extension from the Marketplace, import a package, or copy an extension folder into the directory below.",
  emptyPathHint: "$CODEXHOST_DATA_DIR/desktop-extensions/<id>/",
  categoryAll: "All",
  categoryFilterLabel: "Filter by category",
  searchPlaceholder: "Search name, author, category, or description…",
  searchLabel: "Search Desktop extensions",
  clearSearch: "Clear search",
  noMatchesTitle: "No matching extensions",
  noMatchesDescription: "Try another keyword or clear the active filters.",
  clearFilters: "Clear filters",
  categories: Object.freeze({
    sidebar: "Sidebar",
    composer: "Composer",
    conversation: "Conversation",
    appearance: "Appearance",
    tools: "Tools",
    workflow: "Workflow",
    "usage-analytics": "Usage & Analytics",
    "memory-knowledge": "Memory & Knowledge",
    integrations: "Integrations",
  }),
  groups: Object.freeze({
    attention: "Needs Attention",
    enabled: "Enabled",
    disabled: "Disabled",
  }),
  updateAvailable: "Update available",
  trustOfficial: "Official",
  trustCommunity: "Community",
  communityNotice: "Community extension — review its source repository before enabling.",
  install: "Install",
  installing: "Installing…",
  update: "Update",
  updating: "Updating…",
  updateToVersion: "Update to v{version}",
  installedBadge: "Installed",
  installedVersionHint: "Installed v{version}",
  updatedAtLabel: "Updated {date}",
  uninstall: "Uninstall",
  uninstalling: "Uninstalling…",
  uninstallConfirmPrompt: "Remove this extension?",
  uninstallConfirm: "Confirm uninstall",
  uninstallCancel: "Cancel",
  marketplaceLoading: "Loading extension marketplace…",
  marketplaceUnavailableTitle: "Extension marketplace is unavailable",
  marketplaceUnavailableDescription:
    "Connect to a local codexhost Host that supports the Desktop extension marketplace, then try again.",
  marketplaceEmptyTitle: "No marketplace extensions available",
  marketplaceEmptyDescription:
    "Refresh to check for newly published extensions, or import one from GitHub or a local .zip package.",
  marketplaceFallbackNotice:
    "Showing the built-in official catalog while the remote catalog is unreachable.",
  marketplaceFallbackNoticeWithError:
    "Showing the built-in official catalog because the remote catalog could not be reached ({message}).",
  marketplaceLoadFailed: "Could not load extension marketplace: {message}",
  installedSuccess: "Installed “{name}” (v{version}). Enable it when ready.",
  updatedSuccess: "Updated “{name}” to v{version}.",
  uninstalledSuccess: "Uninstalled “{name}”.",
  installFailed: "Could not install extension: {message}",
  uninstallFailed: "Could not uninstall extension: {message}",
  details: "Details",
  openDetailsLabel: "View details for {name}",
  closeModal: "Close",
  authorBy: "By {author}",
  githubRepository: "GitHub",
  screenshotsTitle: "Screenshots",
  screenshotAlt: "{name} screenshot {index}",
  screenshotPreviewLabel: "Preview screenshot {index} of {total}",
  previousScreenshot: "Previous screenshot",
  nextScreenshot: "Next screenshot",
  closePreview: "Close preview",
  technicalDetails: "Technical details",
  detailId: "ID",
  detailVersion: "Version",
  detailSlots: "Slots",
  detailHash: "Hash",
  detailSha256: "SHA-256",
  detailDiagnostics: "Diagnostic",
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
  importDialogTitle: "Import Desktop extension",
  importDialogSubtitle:
    "Install from a GitHub repository/release link or upload a local .zip package.",
  importTabUrl: "GitHub link",
  importTabZip: "Local .zip",
  importUrlLabel: "GitHub repository or Release .zip URL",
  importUrlPlaceholder: "https://github.com/owner/repo or …/extension.zip",
  importUrlHint: "Supports a GitHub repository homepage URL or a direct .zip release link.",
  importAdvancedToggle: "Optional SHA-256 verification",
  importSha256Label: "Expected SHA-256 (optional)",
  importSha256Placeholder: "64-character hexadecimal SHA-256 digest",
  importZipDropTitle: "Drop a .zip extension package here",
  importZipDropHint: "Maximum size 5 MiB. Package must include manifest.json and desktop.js.",
  importZipChooseFile: "Choose .zip file",
  importZipSelected: "{name} ({size})",
  importZipClear: "Remove",
  importSubmit: "Import",
  importSubmitting: "Importing…",
  importCancel: "Cancel",
  importErrorEmptyUrl: "Enter a GitHub repository or .zip URL.",
  importErrorInvalidUrl: "Enter a valid http:// or https:// URL.",
  importErrorInvalidSha256: "SHA-256 must be 64 hexadecimal characters.",
  importErrorNoFile: "Choose a local .zip package first.",
  importErrorInvalidExtension: "Only .zip packages are supported.",
  importErrorEmptyFile: "The selected .zip file is empty.",
  importErrorFileTooLarge: "Package exceeds the 5 MiB limit ({size}).",
  importErrorReadFailed: "Could not read the selected file: {message}",
  importUnavailable: "This Host does not support importing Desktop extensions.",
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
  importButton: "导入扩展",
  tabListLabel: "Desktop 扩展视图",
  tabInstalled: "已安装 ({count})",
  tabMarketplace: "市场 ({count})",
  desktopConnected: "Desktop 已连接",
  desktopDisconnected: "等待 Desktop 连接",
  loading: "正在加载 Desktop 扩展…",
  unavailableTitle: "无法管理 Desktop 扩展",
  unavailableDescription: "请连接到支持 Desktop 扩展管理的本机 codexhost Host 后再试。",
  loadFailed: "无法加载 Desktop 扩展：{message}",
  diagnosticsTitle: "配置诊断",
  emptyTitle: "尚未发现 Desktop 扩展",
  emptyDescription: "可前往「市场」一键安装、点击「导入扩展」，或将扩展目录放到以下路径后刷新：",
  emptyPathHint: "$CODEXHOST_DATA_DIR/desktop-extensions/<id>/",
  categoryAll: "全部",
  categoryFilterLabel: "按分类筛选",
  searchPlaceholder: "搜索名称、作者、分类或描述…",
  searchLabel: "搜索 Desktop 扩展",
  clearSearch: "清除搜索",
  noMatchesTitle: "未找到匹配的扩展",
  noMatchesDescription: "请尝试其他关键词，或清除当前筛选条件。",
  clearFilters: "清除筛选",
  categories: Object.freeze({
    sidebar: "侧栏",
    composer: "输入框",
    conversation: "对话流",
    appearance: "外观主题",
    tools: "效率工具",
    workflow: "多会话协作",
    "usage-analytics": "用量与统计",
    "memory-knowledge": "记忆与知识",
    integrations: "外部集成",
  }),
  groups: Object.freeze({
    attention: "需要处理",
    enabled: "已启用",
    disabled: "未启用",
  }),
  updateAvailable: "可更新",
  trustOfficial: "官方",
  trustCommunity: "社区",
  communityNotice: "社区扩展，启用前建议先查看源码仓库。",
  install: "安装",
  installing: "安装中…",
  update: "更新",
  updating: "更新中…",
  updateToVersion: "更新到 v{version}",
  installedBadge: "已安装",
  installedVersionHint: "已装 v{version}",
  updatedAtLabel: "更新于 {date}",
  uninstall: "卸载",
  uninstalling: "卸载中…",
  uninstallConfirmPrompt: "确认卸载此扩展？",
  uninstallConfirm: "确认卸载",
  uninstallCancel: "取消",
  marketplaceLoading: "正在加载扩展市场…",
  marketplaceUnavailableTitle: "无法访问扩展市场",
  marketplaceUnavailableDescription: "请连接到支持 Desktop 扩展市场的本机 codexhost Host 后再试。",
  marketplaceEmptyTitle: "市场暂无可用扩展",
  marketplaceEmptyDescription: "可点击刷新获取最新目录，或通过 GitHub 链接 / 本地 .zip 包导入。",
  marketplaceFallbackNotice: "远端市场目录暂不可达，当前展示内置官方目录。",
  marketplaceFallbackNoticeWithError: "远端市场暂不可达，当前展示内置官方目录（{message}）。",
  marketplaceLoadFailed: "无法加载扩展市场：{message}",
  installedSuccess: "已安装“{name}”（v{version}），可按需开启。",
  updatedSuccess: "已将“{name}”更新至 v{version}。",
  uninstalledSuccess: "已卸载“{name}”。",
  installFailed: "安装扩展失败：{message}",
  uninstallFailed: "卸载扩展失败：{message}",
  details: "详情",
  openDetailsLabel: "查看“{name}”详情",
  closeModal: "关闭",
  authorBy: "作者：{author}",
  githubRepository: "GitHub 仓库",
  screenshotsTitle: "界面预览",
  screenshotAlt: "{name} 截图 {index}",
  screenshotPreviewLabel: "预览第 {index} 张截图（共 {total} 张）",
  previousScreenshot: "上一张截图",
  nextScreenshot: "下一张截图",
  closePreview: "收起大图",
  technicalDetails: "技术信息",
  detailId: "ID",
  detailVersion: "版本",
  detailSlots: "声明槽位",
  detailHash: "Hash",
  detailSha256: "SHA-256",
  detailDiagnostics: "诊断信息",
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
  importDialogTitle: "导入 Desktop 扩展",
  importDialogSubtitle: "支持通过 GitHub 仓库或 Release 链接安装，或上传本地 .zip 扩展包。",
  importTabUrl: "GitHub 链接",
  importTabZip: "本地 .zip 包",
  importUrlLabel: "GitHub 仓库或 Release .zip 链接",
  importUrlPlaceholder: "https://github.com/owner/repo 或 Release .zip 链接",
  importUrlHint: "支持粘贴 GitHub 仓库主页链接或 Release .zip 直链。",
  importAdvancedToggle: "可选：SHA-256 校验值",
  importSha256Label: "预期 SHA-256（可选）",
  importSha256Placeholder: "64 位十六进制 SHA-256 摘要",
  importZipDropTitle: "拖拽 .zip 扩展包到此处",
  importZipDropHint: "单包不超过 5 MiB，需包含 manifest.json 与 desktop.js。",
  importZipChooseFile: "选择 .zip 文件",
  importZipSelected: "{name}（{size}）",
  importZipClear: "移除",
  importSubmit: "开始导入",
  importSubmitting: "导入中…",
  importCancel: "取消",
  importErrorEmptyUrl: "请输入 GitHub 仓库或 .zip 链接。",
  importErrorInvalidUrl: "请输入有效的 http:// 或 https:// 链接。",
  importErrorInvalidSha256: "SHA-256 校验值需为 64 位十六进制字符。",
  importErrorNoFile: "请先选择一个本地 .zip 扩展包。",
  importErrorInvalidExtension: "仅支持 .zip 格式的扩展包。",
  importErrorEmptyFile: "所选 .zip 文件为空。",
  importErrorFileTooLarge: "文件大小超过 5 MiB 限制（当前 {size}）。",
  importErrorReadFailed: "无法读取所选文件：{message}",
  importUnavailable: "当前 Host 不支持导入 Desktop 扩展。",
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
