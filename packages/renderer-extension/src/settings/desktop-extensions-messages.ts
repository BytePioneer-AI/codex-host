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
  readonly tabMarketplaceCount: string;
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
  readonly capabilityFilterLabel: string;
  readonly filterAll: string;
  readonly filterPage: string;
  readonly filterWidget: string;
  readonly filterWeb: string;
  readonly filterDesktop: string;
  readonly filterBackend: string;
  readonly platformLabel: string;
  readonly platformBoth: string;
  readonly platformDesktopOnly: string;
  readonly platformWebOnly: string;
  readonly platformWebOnlyNotice: string;
  readonly badgePage: string;
  readonly badgeWidget: string;
  readonly badgeBackend: string;
  readonly openPage: string;
  readonly pageBack: string;
  readonly pageReload: string;
  readonly pageLoading: string;
  readonly pageLoadFailedTitle: string;
  readonly pageLoadFailed: string;
  readonly pageClosedDisabled: string;
  readonly pageNoBackend: string;
  readonly searchPlaceholder: string;
  readonly searchLabel: string;
  readonly clearSearch: string;
  readonly noMatchesTitle: string;
  readonly noMatchesDescription: string;
  readonly clearFilters: string;
  readonly categories: Readonly<Record<DesktopExtensionCategory, string>>;
  readonly attentionHeading: string;
  readonly updateAvailable: string;
  readonly updateVersionCue: string;
  readonly installedUpdatesAvailable: string;
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
  readonly extensionSettingsTitle: string;
  readonly extensionSettingsDisabledHint: string;
  readonly extensionSettingsLoading: string;
  readonly extensionSettingsSaving: string;
  readonly extensionSettingsSaved: string;
  readonly extensionSettingsLoadFailed: string;
  readonly extensionSettingsSaveFailed: string;
  readonly extensionSettingsConflict: string;
  readonly extensionSettingsReset: string;
  readonly backendRunning: string;
  readonly backendStarting: string;
  readonly backendFailed: string;
  readonly backendFailedNotice: string;
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
  readonly importTabLocalDir: string;
  readonly importUrlLabel: string;
  readonly importUrlPlaceholder: string;
  readonly importUrlHint: string;
  readonly importRefLabel: string;
  readonly importRefPlaceholder: string;
  readonly importTagLabel: string;
  readonly importTagPlaceholder: string;
  readonly importAssetLabel: string;
  readonly importAssetPlaceholder: string;
  readonly importSubpathLabel: string;
  readonly importSubpathPlaceholder: string;
  readonly importLocalDirLabel: string;
  readonly importLocalDirPlaceholder: string;
  readonly importLocalDirHint: string;
  readonly importZipDropTitle: string;
  readonly importZipChooseFile: string;
  readonly importZipSelected: string;
  readonly importZipClear: string;
  readonly importSubmit: string;
  readonly importSubmitting: string;
  readonly importCancel: string;
  readonly importErrorEmptyUrl: string;
  readonly importErrorInvalidUrl: string;
  readonly importErrorEmptyLocalDir: string;
  readonly importErrorInvalidLocalDir: string;
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
    "Test the generated plugin locally via “Import plugin” (GitHub, local .zip, or local directory).",
    "Push your plugin to a public GitHub repository and submit it to the Marketplace.",
  ]),
  createPromptLabel: "Prompt for your AI assistant",
  createPromptTemplate: [
    "Please read and strictly follow the official codexhost plugin authoring guide (Skill):",
    "https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md",
    "",
    "Build a codexhost unified plugin (manifestVersion: 2) for me with the following goal:",
    "[Describe what you want the plugin to do, e.g. a standalone page with a floating timer widget]",
    "",
    "Requirements:",
    "1. Provide manifest.json (manifestVersion: 2) with bilingual (en & zh-CN) name, description, Markdown details, categories, optional settingsSchema, icon, and screenshots.",
    "2. Use page for a standalone view and widget for a main-window widget. Each uses one .mjs entry exporting mount(root, api) on both Desktop and Web, with optional CSS, --cx-page-* theme tokens, and relative .mjs imports (e.g. ../shared/timer.mjs). For widgets, set pointer-events: auto only on interactive surfaces. Add desktop, web, or backend only when needed.",
    "3. Package a .zip with manifest.json at the root. Show how to import and enable it in Desktop Settings → Plugins or Web’s top-level Plugins → Plugin Center, and publish to GitHub. In Web, enabled pages also open from that sidebar section.",
  ].join("\n"),
  createCopyPrompt: "Copy prompt",
  createPromptCopied: "Copied",
  createPromptCopiedHint: "Copied — paste this prompt into your AI assistant.",
  createCopyFailed: "Could not copy prompt",
  createViewDocs: "Authoring guide",
  createSubmitMarketplace: "Submit to Marketplace",
  importButton: "Import plugin",
  tabListLabel: "Plugin views",
  tabInstalled: "Installed ({count})",
  tabMarketplace: "Marketplace",
  tabMarketplaceCount: "Marketplace ({count})",
  desktopDisconnected: "Desktop disconnected",
  loading: "Loading plugins…",
  unavailableTitle: "Plugin management is unavailable",
  unavailableDescription:
    "Connect to a local codexhost Host that supports plugin management, then try again.",
  loadFailed: "Could not load plugins: {message}",
  diagnosticsTitle: "Configuration diagnostics",
  emptyTitle: "No plugins installed",
  emptyDescription:
    "Install a plugin from the Marketplace, import a package, or copy a plugin folder into the directory below.",
  emptyPathHint: "$CODEXHOST_DATA_DIR/host-extensions/<id>/",
  categoryAll: "All",
  categoryFilterLabel: "Filter by category",
  capabilityFilterLabel: "Filter by platform or capability",
  filterAll: "All",
  filterPage: "Page",
  filterWidget: "Widget",
  filterWeb: "CH Web",
  filterDesktop: "Codex Desktop",
  filterBackend: "Backend",
  platformLabel: "Supported platforms",
  platformBoth: "Codex Desktop & CH Web",
  platformDesktopOnly: "Codex Desktop Only",
  platformWebOnly: "CH Web Only",
  platformWebOnlyNotice:
    "Runs in CH Web only. You can still install or toggle it from Codex Desktop.",
  badgePage: "Page",
  badgeWidget: "Widget",
  badgeBackend: "Backend",
  openPage: "Open Page",
  pageBack: "Back to Plugins",
  pageReload: "Reload page",
  pageLoading: "Loading extension page…",
  pageLoadFailedTitle: "Could not open extension page",
  pageLoadFailed: "{message}",
  pageClosedDisabled: "Closed the extension page because the plugin was disabled or removed.",
  pageNoBackend: "Extension “{id}” does not declare a backend.",
  searchPlaceholder: "Search name, author, category, or description…",
  searchLabel: "Search plugins",
  clearSearch: "Clear search",
  noMatchesTitle: "No matching plugins",
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
  attentionHeading: "Needs Attention",
  updateAvailable: "Update available",
  updateVersionCue: "Update v{version}",
  installedUpdatesAvailable: "Plugin updates available",
  trustOfficial: "Official",
  trustCommunity: "Community",
  communityNotice: "Community plugin — review its source repository before enabling.",
  install: "Install",
  installing: "Installing…",
  update: "Update",
  updating: "Updating…",
  updateToVersion: "Update to v{version}",
  installedBadge: "Installed",
  uninstall: "Uninstall",
  uninstalling: "Uninstalling…",
  uninstallConfirmPrompt: "Remove this plugin?",
  uninstallConfirm: "Confirm uninstall",
  uninstallCancel: "Cancel",
  marketplaceLoading: "Loading plugin marketplace…",
  marketplaceUnavailableTitle: "Plugin marketplace is unavailable",
  marketplaceUnavailableDescription:
    "Connect to a local codexhost Host that supports the plugin marketplace, then try again.",
  marketplaceEmptyTitle: "No marketplace plugins available",
  marketplaceEmptyDescription:
    "Refresh to check for newly published plugins, or import one from GitHub, a local .zip package, or a local directory.",
  marketplaceFallbackNotice:
    "The remote catalog is unreachable. You can still install plugins from GitHub, a ZIP, or a local directory.",
  marketplaceLoadFailed: "Could not load plugin marketplace: {message}",
  installedSuccess: "Installed “{name}” (v{version}). Enable it when ready.",
  updatedSuccess: "Updated “{name}” to v{version}.",
  uninstalledSuccess: "Uninstalled “{name}”.",
  installFailed: "Could not install plugin: {message}",
  uninstallFailed: "Could not uninstall plugin: {message}",
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
  extensionSettingsTitle: "Plugin settings",
  extensionSettingsDisabledHint: "Editable while disabled",
  extensionSettingsLoading: "Loading settings…",
  extensionSettingsSaving: "Saving…",
  extensionSettingsSaved: "Saved",
  extensionSettingsLoadFailed: "Could not load plugin settings: {message}",
  extensionSettingsSaveFailed: "Could not save plugin settings: {message}",
  extensionSettingsConflict:
    "Settings were updated elsewhere. Latest values have been reloaded—please try again.",
  extensionSettingsReset: "Reset defaults",
  backendRunning: "Backend running",
  backendStarting: "Backend starting",
  backendFailed: "Backend failed",
  backendFailedNotice: "The plugin backend failed to start or exited unexpectedly.",
  slots: Object.freeze({
    "sidebar.thread-layout": "Sidebar thread layout",
    "sidebar.thread-badge": "Sidebar thread badge",
    "appearance.theme": "Appearance theme",
  }),
  states: Object.freeze({
    running: "Enabled",
    waiting: "Waiting",
    disabled: "Disabled",
    conflict: "Desktop slot conflict",
    failed: "Failed",
    incompatible: "Incompatible",
    invalid: "Invalid",
  }),
  toggleLabel: "Toggle {name}",
  toggleDisabledIncompatible: "Cannot enable an incompatible plugin.",
  toggleDisabledInvalid: "Cannot enable an invalid plugin.",
  conflictOccupiedBy: "Desktop slot occupied by {other}",
  conflictSlotDetails: "Desktop slot {slots} occupied by {other}",
  savedEnabled: "Enabled “{name}”.",
  savedDisabled: "Disabled “{name}”.",
  slotConflictBanner:
    "Could not enable “{name}”: a required Desktop slot is already occupied by {other}. Disable {other} first.",
  slotConflictBannerWithSlots:
    "Could not enable “{name}”: {slots} is already occupied by {other}. Disable {other} first.",
  revisionConflictBanner:
    "Plugin configuration was updated elsewhere. The latest list has been reloaded—please try again.",
  actionFailed: "Could not update plugin settings: {message}",
  importDialogTitle: "Import plugin",
  importTabUrl: "GitHub",
  importTabZip: "Local .zip",
  importTabLocalDir: "Local folder",
  importUrlLabel: "GitHub repository (owner/repo or URL)",
  importUrlPlaceholder: "owner/repo or https://github.com/owner/repo",
  importUrlHint:
    "Enter owner/repo or a GitHub URL. Optionally specify a branch/ref, or a release tag and .zip asset.",
  importRefLabel: "Branch / ref (optional)",
  importRefPlaceholder: "main",
  importTagLabel: "Release tag (optional)",
  importTagPlaceholder: "v1.0.0",
  importAssetLabel: "Release .zip asset (optional)",
  importAssetPlaceholder: "plugin.zip",
  importSubpathLabel: "Subdirectory (optional)",
  importSubpathPlaceholder: "packages/my-plugin",
  importLocalDirLabel: "Local directory path",
  importLocalDirPlaceholder: "/path/to/my-plugin",
  importLocalDirHint: "Absolute path on the computer running the codexhost Host.",
  importZipDropTitle: "Click to choose or drop a .zip file",
  importZipChooseFile: "Choose .zip file",
  importZipSelected: "{name} ({size})",
  importZipClear: "Remove",
  importSubmit: "Import",
  importSubmitting: "Importing…",
  importCancel: "Cancel",
  importErrorEmptyUrl: "Enter a GitHub repository (owner/repo or URL).",
  importErrorInvalidUrl:
    "Enter a valid owner/repo or GitHub URL, and do not mix branch/ref with release tag/asset.",
  importErrorEmptyLocalDir: "Enter an absolute local directory path.",
  importErrorInvalidLocalDir: "Enter a valid absolute local directory path without .. segments.",
  importErrorNoFile: "Choose a local .zip package first.",
  importErrorInvalidExtension: "Only .zip packages are supported.",
  importErrorEmptyFile: "The selected .zip file is empty.",
  importErrorReadFailed: "Could not read the selected file: {message}",
  importUnavailable: "This Host does not support importing plugins.",
  recoveryMenuItem: "Disable all plugins (recovery)",
  recoveryDialogTitle: "Disable all plugins?",
  recoveryDialogDescription:
    "All enabled plugins on the shared Host will be disabled, stopping plugin backends and unloading Desktop and Web extensions.",
  recoveryDialogOfflineNote:
    "Desktop is not currently connected. The recovery command will still be saved on the shared Host.",
  recoveryDialogCancel: "Cancel",
  recoveryDialogConfirm: "Disable all plugins",
  recoveryDialogBusy: "Saving…",
  recoverySaved: "All plugins have been disabled.",
});

export const desktopExtensionsChinese: DesktopExtensionsMessages = Object.freeze({
  moreActions: "更多操作",
  contentLocaleLabel: "插件内容语言",
  contentLocaleFollowSystem: "跟随系统",
  contentLocaleZh: "简体中文",
  contentLocaleEn: "English",
  copyDirectoryMenuItem: "复制插件目录路径",
  copiedDirectoryPath: "已复制插件目录路径。",
  copyPathFailed: "复制失败",
  refresh: "刷新",
  refreshing: "刷新中…",
  retry: "重试",
  createButton: "制作插件",
  createDialogTitle: "制作 codexhost 插件",
  createSteps: Object.freeze([
    "复制下方提示词，把【】里的需求换成你的想法，直接发给你的 AI。",
    "AI 按规范生成后，点击「导入插件」通过 GitHub、本地 .zip 或本地目录测试效果。",
    "推送到你的公开 GitHub 仓库，再点击下方按钮投稿到官方插件市场。",
  ]),
  createPromptLabel: "发给 AI 的提示词（可直接编辑后复制）",
  createPromptTemplate: [
    "请先阅读并严格遵循 codexhost 官方插件开发规范（Skill）：",
    "https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md",
    "",
    "帮我开发一个 codexhost 统一插件（manifestVersion: 2），需求如下：",
    "【在这里描述你想做的插件功能，例如：带悬浮计时挂件的独立页面】",
    "",
    "要求：",
    "1. 提供根级 manifest.json（manifestVersion: 2），补齐中英文 name、description、Markdown 格式 details、categories，以及可选的 settingsSchema、icon 和 screenshots；",
    "2. 独立页面用 page，主页面挂件用 widget。各入口用同一份 .mjs 在 Desktop 和 Web 运行，导出 mount(root, api)，支持可选 CSS、--cx-page-* 主题变量和相对 .mjs 导入（如 ../shared/timer.mjs）。挂件只在交互区域使用 pointer-events: auto。按需声明 desktop、web 或 backend；",
    "3. 打包为 .zip（manifest.json 位于包根），说明如何从 Desktop「设置 → 插件」或 Web 一级目录「插件 → 插件中心」导入并启用，以及如何发布到 GitHub。Web 还可从该侧栏专区打开已启用的独立页面。",
  ].join("\n"),
  createCopyPrompt: "复制提示词",
  createPromptCopied: "已复制",
  createPromptCopiedHint: "已复制提示词，可直接粘贴发给你的 AI。",
  createCopyFailed: "复制失败",
  createViewDocs: "开发规范",
  createSubmitMarketplace: "投稿到官方市场",
  importButton: "导入插件",
  tabListLabel: "插件视图",
  tabInstalled: "已安装 ({count})",
  tabMarketplace: "市场",
  tabMarketplaceCount: "市场 ({count})",
  desktopDisconnected: "Desktop 未连接",
  loading: "正在加载插件…",
  unavailableTitle: "无法管理插件",
  unavailableDescription: "请连接到支持插件管理的本机 codexhost Host 后再试。",
  loadFailed: "无法加载插件：{message}",
  diagnosticsTitle: "配置诊断",
  emptyTitle: "尚未安装插件",
  emptyDescription: "可前往「市场」一键安装、点击「导入插件」，或将插件目录放到以下路径后刷新：",
  emptyPathHint: "$CODEXHOST_DATA_DIR/host-extensions/<id>/",
  categoryAll: "全部",
  categoryFilterLabel: "按分类筛选",
  capabilityFilterLabel: "按适用平台或能力筛选",
  filterAll: "全部",
  filterPage: "独立页面",
  filterWidget: "挂件",
  filterWeb: "CH Web",
  filterDesktop: "Codex Desktop",
  filterBackend: "后台",
  platformLabel: "适用平台",
  platformBoth: "Codex Desktop · CH Web",
  platformDesktopOnly: "仅 Codex Desktop",
  platformWebOnly: "仅 CH Web",
  platformWebOnlyNotice: "此插件仅在 CH Web 界面生效，Codex Desktop 仅支持安装与启停管理。",
  badgePage: "独立页面",
  badgeWidget: "挂件",
  badgeBackend: "后台",
  openPage: "打开页面",
  pageBack: "返回插件",
  pageReload: "重新加载页面",
  pageLoading: "正在加载插件页面…",
  pageLoadFailedTitle: "无法打开插件页面",
  pageLoadFailed: "{message}",
  pageClosedDisabled: "插件已被禁用或卸载，已关闭独立页面。",
  pageNoBackend: "插件“{id}”未声明后台服务。",
  searchPlaceholder: "搜索名称、作者、分类或描述…",
  searchLabel: "搜索插件",
  clearSearch: "清除搜索",
  noMatchesTitle: "未找到匹配的插件",
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
  attentionHeading: "需要关注",
  updateAvailable: "可更新",
  updateVersionCue: "可更新 v{version}",
  installedUpdatesAvailable: "有插件可更新",
  trustOfficial: "官方",
  trustCommunity: "社区",
  communityNotice: "社区插件，启用前建议先查看源码仓库。",
  install: "安装",
  installing: "安装中…",
  update: "更新",
  updating: "更新中…",
  updateToVersion: "更新到 v{version}",
  installedBadge: "已安装",
  uninstall: "卸载",
  uninstalling: "卸载中…",
  uninstallConfirmPrompt: "确认卸载此插件？",
  uninstallConfirm: "确认卸载",
  uninstallCancel: "取消",
  marketplaceLoading: "正在加载插件市场…",
  marketplaceUnavailableTitle: "无法访问插件市场",
  marketplaceUnavailableDescription: "请连接到支持插件市场的本机 codexhost Host 后再试。",
  marketplaceEmptyTitle: "市场暂无可用插件",
  marketplaceEmptyDescription:
    "可点击刷新获取最新目录，或通过 GitHub、本地 .zip 包或本地目录导入。",
  marketplaceFallbackNotice: "远端市场目录暂不可达。你仍可通过 GitHub、ZIP 或本地目录安装插件。",
  marketplaceLoadFailed: "无法加载插件市场：{message}",
  installedSuccess: "已安装“{name}”（v{version}），可按需开启。",
  updatedSuccess: "已将“{name}”更新至 v{version}。",
  uninstalledSuccess: "已卸载“{name}”。",
  installFailed: "安装插件失败：{message}",
  uninstallFailed: "卸载插件失败：{message}",
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
  extensionSettingsTitle: "插件设置",
  extensionSettingsDisabledHint: "禁用时也可编辑",
  extensionSettingsLoading: "正在读取插件设置…",
  extensionSettingsSaving: "保存中…",
  extensionSettingsSaved: "已保存",
  extensionSettingsLoadFailed: "无法读取插件设置：{message}",
  extensionSettingsSaveFailed: "无法保存插件设置：{message}",
  extensionSettingsConflict: "插件设置已在其他入口更新，已自动刷新最新值，请重新修改。",
  extensionSettingsReset: "恢复默认",
  backendRunning: "后台运行中",
  backendStarting: "后台启动中",
  backendFailed: "后台失败",
  backendFailedNotice: "该插件的后台进程启动失败或已异常退出。",
  slots: Object.freeze({
    "sidebar.thread-layout": "侧栏 Thread 布局",
    "sidebar.thread-badge": "侧栏 Thread 角标",
    "appearance.theme": "外观主题",
  }),
  states: Object.freeze({
    running: "已启用",
    waiting: "等待中",
    disabled: "未启用",
    conflict: "Desktop 槽位冲突",
    failed: "异常",
    incompatible: "不兼容",
    invalid: "无效",
  }),
  toggleLabel: "切换 {name}",
  toggleDisabledIncompatible: "不兼容的插件无法启用。",
  toggleDisabledInvalid: "无效的插件无法启用。",
  conflictOccupiedBy: "Desktop 槽位已被 {other} 占用",
  conflictSlotDetails: "Desktop 槽位 {slots} 已被 {other} 占用",
  savedEnabled: "已启用“{name}”。",
  savedDisabled: "已禁用“{name}”。",
  slotConflictBanner: "无法启用“{name}”：所需 Desktop 槽位已被 {other} 占用，请先禁用 {other}。",
  slotConflictBannerWithSlots:
    "无法启用“{name}”：槽位 {slots} 已被 {other} 占用，请先禁用 {other}。",
  revisionConflictBanner: "插件配置已在其他入口更新，已自动刷新最新列表，请重试。",
  actionFailed: "更新插件配置失败：{message}",
  importDialogTitle: "导入插件",
  importTabUrl: "GitHub",
  importTabZip: "本地 .zip 包",
  importTabLocalDir: "本地目录",
  importUrlLabel: "GitHub 仓库（owner/repo 或链接）",
  importUrlPlaceholder: "owner/repo 或 https://github.com/owner/repo",
  importUrlHint: "输入 owner/repo 或 GitHub 仓库链接，可按需填写分支/标签或 Release .zip 资产名。",
  importRefLabel: "分支 / Ref（可选）",
  importRefPlaceholder: "main",
  importTagLabel: "Release 标签（可选）",
  importTagPlaceholder: "v1.0.0",
  importAssetLabel: "Release .zip 文件名（可选）",
  importAssetPlaceholder: "plugin.zip",
  importSubpathLabel: "子目录（可选）",
  importSubpathPlaceholder: "packages/my-plugin",
  importLocalDirLabel: "本地目录绝对路径",
  importLocalDirPlaceholder: "/path/to/my-plugin",
  importLocalDirHint: "运行 codexhost Host 的电脑上的插件目录绝对路径。",
  importZipDropTitle: "点击选择或拖拽 .zip 文件",
  importZipChooseFile: "选择 .zip 文件",
  importZipSelected: "{name}（{size}）",
  importZipClear: "移除",
  importSubmit: "开始导入",
  importSubmitting: "导入中…",
  importCancel: "取消",
  importErrorEmptyUrl: "请输入 GitHub 仓库（owner/repo 或链接）。",
  importErrorInvalidUrl:
    "请输入有效的 owner/repo 或 GitHub 链接，且分支 Ref 不能与 Release 标签/资产同时填写。",
  importErrorEmptyLocalDir: "请输入本地目录绝对路径。",
  importErrorInvalidLocalDir: "请输入有效的绝对路径，且不能包含 .. 路径段。",
  importErrorNoFile: "请先选择一个本地 .zip 插件包。",
  importErrorInvalidExtension: "仅支持 .zip 格式的插件包。",
  importErrorEmptyFile: "所选 .zip 文件为空。",
  importErrorReadFailed: "无法读取所选文件：{message}",
  importUnavailable: "当前 Host 不支持导入插件。",
  recoveryMenuItem: "禁用全部插件（恢复模式）",
  recoveryDialogTitle: "禁用全部插件？",
  recoveryDialogDescription:
    "将停用共享 Host 上全部已启用的插件，同时停止插件后台并卸载 Desktop 与 Web 扩展。",
  recoveryDialogOfflineNote: "当前未检测到在线的 Desktop 连接；恢复指令仍会保存在共享 Host 上。",
  recoveryDialogCancel: "取消",
  recoveryDialogConfirm: "确认禁用全部插件",
  recoveryDialogBusy: "保存中…",
  recoverySaved: "已禁用全部插件。",
});
