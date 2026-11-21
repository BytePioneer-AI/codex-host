# Proposal

## Why

当前插件系统存在 Desktop（`host-runtime`）与 Web（`web-server`）两套平行安装目录、配置存储、商店目录与 Node 后端进程管理，导致同一个双端插件必须装两遍、数据割裂、界面出现两套概念。由于现阶段几乎没有存量插件，直接推倒双轨，以共享 `codexhost Host` 为唯一插件与后端托管核心，Desktop 与 Web 退回平等的前端渲染壳。

## What Changes

- **BREAKING**：移除 `web-server` 自管的平行扩展目录与子进程托管（`web-native-extensions` 独立存储与后台运行），改为由共享 `codexhost Host` 统一拥有唯一安装目录、唯一配置数据与唯一单实例 Node 后端托管。
- **BREAKING**：统一插件清单契约（`manifestVersion: 2`，兼容读取现有官方市场 v1 Desktop 清单），四个能力入口 `backend`、`page`、`desktop`、`web` 全部可选（至少声明其一）：
  - 允许纯前端无后端插件（仅 `desktop`、仅 `web` 或仅 `page`）；
  - 允许纯后台插件（仅 `backend` + 可选声明式 `settingsSchema`）；
  - 允许独立管理页插件（一份通用 `page` 前端 + 可选 `backend` 通吃 Desktop 与 Web）；
  - 允许宿主注入型双端插件（按规范拆分 `desktop` / `web` 前端，共用同一 `backend` 与配置数据）。
- 新增跨端统一的共享 Host 扩展管理、配置、资产读取与后端调用 RPC（`codexhost/extensions/*`）及客户端通道变更事件；`web-server` 仅保留现有鉴权门禁与代理转发（RPC + 静态资产 HTTP 代理）。
- Desktop 与 Web 设置界面的插件中心统一对接共享 Host 单一数据源，展示单一插件列表与能力角标，并支持在两端打开插件的通用独立 `page`。
- 原有 DSH Web 插件恢复通道（`WebUiExtensions` / `/extensions`）保持独立不变，不纳入本次合并。

## Decisions

- **推倒双轨、不做旧双目录迁移**：当前存量插件极少，不引入双目录合并冲突解决与兼容写盘逻辑，直接以共享 Host 下的单一目录为唯一真源。
- **后端常驻生命周期由 Host 持有**：只要共享 Host 运行且插件已启用，无论 Desktop 与 Web 启动了哪一端、两端全开或都未打开，均只运行唯一一个后端子进程并共享同一份数据。
- **复用 `web-server` 现有鉴权与同源边界**：不引入第二套鉴权体系；正式 Web 默认经过 `auth.gate` 与同源校验，仅在开发模式 `--no-auth` 下禁用插件管理写入与后端调用。
- **独立管理页采用零框架标准 DOM + 极简 `api` + 语义 CSS 变量**：避免绑定 React 或 Electron 私有 API，确保一份 `page` 代码可直接运行于 Desktop 与 Web。

## Capabilities

### New Capabilities

- `host-extensions`: 由共享 `codexhost Host` 唯一托管的跨端插件系统，涵盖可选组合清单、单实例后台托管、统一配置与资产代理、跨端通用独立管理页及单一插件管理中心。

### Modified Capabilities

<!-- 既有 web-ui-extensions 仅管 DSH 客户端插件恢复，需求未变；extensible-settings-shell 外壳契约未变。 -->

## Impact

- `packages/shared-contracts`：统一扩展清单、RPC、事件与通用 `page` API 契约。
- `packages/harness-plugin-files`：统一清单解析、安装包校验、单目录安装/卸载/状态/设置与 `catalog.v2.json` 读取。
- `packages/host-runtime` & `packages/console-server`：共享 Host 唯一插件管理器、单实例 `ExtensionBackendProcess` 托管、`codexhost/extensions/*` RPC 与 `extensions-changed` 事件。
- `packages/web-server`：删除平行 `WebNativeExtensions` 存储与进程管理，改为薄代理（RPC 转发、ZIP 上传中转、带鉴权资产 HTTP 代理）。
- `packages/desktop-control` & `packages/renderer-extension` & `apps/web-ui/packages/client/ui-codexhost`：统一插件中心 UI、Desktop 与 Web 跨端 `page` 容器加载器、Web 原生扩展宿主切至共享 Host 通道。
