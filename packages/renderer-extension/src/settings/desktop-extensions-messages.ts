import type {
  DesktopExtensionCategory,
  DesktopExtensionSlot,
  DesktopExtensionStatus,
} from "@codexhost/shared-contracts";

export interface DesktopExtensionsMessages {
  readonly moreActions: string;
  readonly contentLocaleLabel: string;
  readonly contentLocaleFollowSystem: string;
  readonly contentLocaleZh: string;
  readonly contentLocaleEn: string;
  readonly copyDirectoryMenuItem: string;
  readonly copiedDirectoryPath: string;
  readonly copyPathFailed: string;
  readonly refresh: string;
  readonly refreshing: string;
  readonly retry: string;
  readonly createButton: string;
  readonly createDialogTitle: string;
  readonly createSteps: readonly string[];
  readonly createPromptLabel: string;
  readonly createPromptTemplate: string;
  readonly createCopyPrompt: string;
  readonly createPromptCopied: string;
  readonly createPromptCopiedHint: string;
  readonly createCopyFailed: string;
  readonly createViewDocs: string;
  readonly createSubmitMarketplace: string;
  readonly importButton: string;
  readonly tabListLabel: string;
  readonly tabInstalled: string;
  readonly tabMarketplace: string;
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
  readonly downloadsLabel: string;
  readonly screenshotsTitle: string;
  readonly screenshotAlt: string;
  readonly screenshotPreviewLabel: string;
  readonly previousScreenshot: string;
  readonly nextScreenshot: string;
  readonly closePreview: string;
  readonly openExtensionSettings: string;
  readonly extensionSettingsSaving: string;
  readonly extensionSettingsSaved: string;
  readonly extensionSettingsLoadFailed: string;
  readonly extensionSettingsSaveFailed: string;
  readonly extensionSettingsReset: string;
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
  readonly importTabUrl: string;
  readonly importTabZip: string;
  readonly importUrlLabel: string;
  readonly importUrlPlaceholder: string;
  readonly importUrlHint: string;
  readonly importZipDropTitle: string;
  readonly importZipChooseFile: string;
  readonly importZipSelected: string;
  readonly importZipClear: string;
  readonly importSubmit: string;
  readonly importSubmitting: string;
  readonly importCancel: string;
  readonly importErrorEmptyUrl: string;
  readonly importErrorInvalidUrl: string;
  readonly importErrorNoFile: string;
  readonly importErrorInvalidExtension: string;
  readonly importErrorEmptyFile: string;
  readonly importErrorReadFailed: string;
  readonly importUnavailable: string;
  readonly recoveryMenuItem: string;
  readonly recoveryDialogTitle: string;
  readonly recoveryDialogDescription: string;
  readonly recoveryDialogOfflineNote: string;
  readonly recoveryDialogCancel: string;
  readonly recoveryDialogConfirm: string;
  readonly recoveryDialogBusy: string;
  readonly recoverySaved: string;
}

export const desktopExtensionsEnglish: DesktopExtensionsMessages = Object.freeze({
  moreActions: "More actions",
  contentLocaleLabel: "Extension language",
  contentLocaleFollowSystem: "Follow system",
  contentLocaleZh: "简体中文",
  contentLocaleEn: "English",
  copyDirectoryMenuItem: "Copy extensions directory path",
  copiedDirectoryPath: "Copied extensions directory path.",
  copyPathFailed: "Copy failed",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  retry: "Retry",
  createButton: "Create plugin",
  createDialogTitle: "Create a codexhost plugin",
  createSteps: Object.freeze([
    "Copy the prompt below, replace the idea placeholder, and send it to your AI assistant.",
    "Test the generated plugin locally via “Import plugin” (GitHub URL or local .zip).",
    "Push your plugin to a public GitHub repository and submit it to the Marketplace.",
  ]),
  createPromptLabel: "Prompt for your AI assistant",
  createPromptTemplate: [
    "Please read and strictly follow the official codexhost Desktop plugin authoring guide (Skill):",
    "https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md",
    "",
    "Build a codexhost Desktop plugin for me with the following goal:",
    "[Describe what you want the plugin to do, e.g. add a sidebar widget, a full theme skin, or a custom settings dashboard]",
    "",
    "Requirements:",
    "1. Include bilingual (en & zh-CN) name, description, and Markdown details in manifest.json, plus appropriate categories and optional icon / screenshots.",
    "2. Output ready-to-install manifest.json and built desktop.js (plus optional desktop.css / backend.mjs) so it works without a build step on install.",
    "3. Show me how to test it locally via Import plugin, and how to publish my public GitHub repo to BytePioneer-AI/codexhost-extensions-registry.",
  ].join("\n"),
  createCopyPrompt: "Copy prompt",
  createPromptCopied: "Copied",
  createPromptCopiedHint: "Copied — paste this prompt into your AI assistant.",
  createCopyFailed: "Could not copy prompt",
  createViewDocs: "Authoring guide",
  createSubmitMarketplace: "Submit to Marketplace",
  importButton: "Import plugin",
  tabListLabel: "Desktop extension views",
  tabInstalled: "Installed ({count})",
  tabMarketplace: "Marketplace ({count})",
  desktopDisconnected: "Desktop disconnected",
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
    appearance: "Appearance",
    interface: "Interface",
    workflow: "Workflow",
    analytics: "Analytics",
    integrations: "Integrations",
    tools: "Tools",
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
    "The remote catalog is unreachable. You can still install extensions from a link or ZIP.",
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
  downloadsLabel: "Downloads: {count}",
  screenshotsTitle: "Screenshots",
  screenshotAlt: "{name} screenshot {index}",
  screenshotPreviewLabel: "Preview screenshot {index} of {total}",
  previousScreenshot: "Previous screenshot",
  nextScreenshot: "Next screenshot",
  closePreview: "Close preview",
  openExtensionSettings: "Open settings",
  extensionSettingsSaving: "Saving…",
  extensionSettingsSaved: "Saved",
  extensionSettingsLoadFailed: "Could not load extension settings: {message}",
  extensionSettingsSaveFailed: "Could not save extension settings: {message}",
  extensionSettingsReset: "Reset to defaults",
  slots: Object.freeze({
    "sidebar.thread-layout": "Sidebar thread layout",
    "sidebar.thread-badge": "Sidebar thread badge",
    "appearance.theme": "Appearance theme",
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
  importDialogTitle: "Import plugin",
  importTabUrl: "GitHub link",
  importTabZip: "Local .zip",
  importUrlLabel: "GitHub repository URL",
  importUrlPlaceholder: "https://github.com/owner/repo",
  importUrlHint: "Supports a GitHub repository URL, subdirectory tree link, or Release .zip URL.",
  importZipDropTitle: "Click to choose or drop a .zip file",
  importZipChooseFile: "Choose .zip file",
  importZipSelected: "{name} ({size})",
  importZipClear: "Remove",
  importSubmit: "Import",
  importSubmitting: "Importing…",
  importCancel: "Cancel",
  importErrorEmptyUrl: "Enter a GitHub repository URL.",
  importErrorInvalidUrl: "Enter a valid http:// or https:// URL.",
  importErrorNoFile: "Choose a local .zip package first.",
  importErrorInvalidExtension: "Only .zip packages are supported.",
  importErrorEmptyFile: "The selected .zip file is empty.",
  importErrorReadFailed: "Could not read the selected file: {message}",
  importUnavailable: "This Host does not support importing Desktop extensions.",
  recoveryMenuItem: "Disable all extensions & reload Desktop",
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
  moreActions: "更多操作",
  contentLocaleLabel: "扩展内容语言",
  contentLocaleFollowSystem: "跟随系统",
  contentLocaleZh: "简体中文",
  contentLocaleEn: "English",
  copyDirectoryMenuItem: "复制扩展目录路径",
  copiedDirectoryPath: "已复制扩展目录路径。",
  copyPathFailed: "复制失败",
  refresh: "刷新",
  refreshing: "刷新中…",
  retry: "重试",
  createButton: "制作插件",
  createDialogTitle: "制作 codexhost 插件",
  createSteps: Object.freeze([
    "复制下方提示词，把【】里的需求换成你的想法，直接发给你的 AI。",
    "AI 按规范生成后，点击「导入插件」在本地测试效果。",
    "推送到你的公开 GitHub 仓库，再点击下方按钮投稿到官方插件市场。",
  ]),
  createPromptLabel: "发给 AI 的提示词（可直接编辑后复制）",
  createPromptTemplate: [
    "请先阅读并严格遵循 codexhost 官方插件开发规范（Skill）：",
    "https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md",
    "",
    "帮我开发一个 codexhost Desktop 插件，需求如下：",
    "【在这里描述你想做的插件功能，例如：在侧栏显示…… / 做一个全皮肤主题 / 做一个带独立设置页的数据统计面板】",
    "",
    "要求：",
    "1. 按 Skill 规范补齐中英文 name、description、Markdown 格式 details、合适分类，以及可选的 icon 图标与 screenshots 截图路径；",
    "2. 生成可直接安装的 manifest.json 与构建后的 desktop.js（及可选 desktop.css / backend.mjs），保证推送到 GitHub 默认分支即可免打包安装；",
    "3. 完成后告诉我如何通过「导入插件」在本地测试，以及如何推送到我的公开 GitHub 仓库并投稿到官方索引库 BytePioneer-AI/codexhost-extensions-registry。",
  ].join("\n"),
  createCopyPrompt: "复制提示词",
  createPromptCopied: "已复制",
  createPromptCopiedHint: "已复制提示词，可直接粘贴发给你的 AI。",
  createCopyFailed: "复制失败",
  createViewDocs: "开发规范",
  createSubmitMarketplace: "投稿到官方市场",
  importButton: "导入插件",
  tabListLabel: "Desktop 扩展视图",
  tabInstalled: "已安装 ({count})",
  tabMarketplace: "市场 ({count})",
  desktopDisconnected: "Desktop 未连接",
  loading: "正在加载 Desktop 扩展…",
  unavailableTitle: "无法管理 Desktop 扩展",
  unavailableDescription: "请连接到支持 Desktop 扩展管理的本机 codexhost Host 后再试。",
  loadFailed: "无法加载 Desktop 扩展：{message}",
  diagnosticsTitle: "配置诊断",
  emptyTitle: "尚未发现 Desktop 扩展",
  emptyDescription: "可前往「市场」一键安装、点击「导入插件」，或将扩展目录放到以下路径后刷新：",
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
    appearance: "外观主题",
    interface: "界面增强",
    workflow: "效率与协作",
    analytics: "数据与统计",
    integrations: "外部集成",
    tools: "实用工具",
  }),
  groups: Object.freeze({
    attention: "需关注",
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
  marketplaceFallbackNotice: "远端市场目录暂不可达。你仍可通过链接或 ZIP 安装扩展。",
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
  downloadsLabel: "下载量：{count}",
  screenshotsTitle: "界面预览",
  screenshotAlt: "{name} 截图 {index}",
  screenshotPreviewLabel: "预览第 {index} 张截图（共 {total} 张）",
  previousScreenshot: "上一张截图",
  nextScreenshot: "下一张截图",
  closePreview: "收起大图",
  openExtensionSettings: "打开设置",
  extensionSettingsSaving: "保存中…",
  extensionSettingsSaved: "已保存",
  extensionSettingsLoadFailed: "无法读取扩展设置：{message}",
  extensionSettingsSaveFailed: "无法保存扩展设置：{message}",
  extensionSettingsReset: "恢复默认",
  slots: Object.freeze({
    "sidebar.thread-layout": "侧栏 Thread 布局",
    "sidebar.thread-badge": "侧栏 Thread 角标",
    "appearance.theme": "外观主题",
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
  importDialogTitle: "导入插件",
  importTabUrl: "GitHub 链接",
  importTabZip: "本地 .zip 包",
  importUrlLabel: "GitHub 仓库链接",
  importUrlPlaceholder: "https://github.com/owner/repo",
  importUrlHint: "支持 GitHub 仓库主页、子目录链接或 Release .zip 直链。",
  importZipDropTitle: "点击选择或拖拽 .zip 文件",
  importZipChooseFile: "选择 .zip 文件",
  importZipSelected: "{name}（{size}）",
  importZipClear: "移除",
  importSubmit: "开始导入",
  importSubmitting: "导入中…",
  importCancel: "取消",
  importErrorEmptyUrl: "请输入 GitHub 仓库链接。",
  importErrorInvalidUrl: "请输入有效的 http:// 或 https:// 链接。",
  importErrorNoFile: "请先选择一个本地 .zip 扩展包。",
  importErrorInvalidExtension: "仅支持 .zip 格式的扩展包。",
  importErrorEmptyFile: "所选 .zip 文件为空。",
  importErrorReadFailed: "无法读取所选文件：{message}",
  importUnavailable: "当前 Host 不支持导入 Desktop 扩展。",
  recoveryMenuItem: "禁用全部扩展并重载 Desktop",
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
