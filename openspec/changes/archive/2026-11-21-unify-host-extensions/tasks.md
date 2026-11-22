# Tasks

## 1. 统一契约与文件原语（Stage 1，前置依赖）

- [x] 1.1 在 `packages/shared-contracts` 定义统一的 Host 扩展清单（含可选 `page`/`desktop`/`web`/`backend` 及 v1 兼容解析）、`HostExtensionPageApi`、`codexhost/extensions/*` RPC 与 `extensions-changed` 事件契约；更新导出并清理废弃的平行契约。验证：`npx tsc -b packages/shared-contracts` 与 `npx vitest run --config tests/vitest.config.js packages/shared-contracts/test/`。
- [x] 1.2 在 `packages/harness-plugin-files` 实现统一单目录（`host-extensions/` + `host-extension-data/`）发现、代次原子安装/更新/卸载、启用状态与 `settings.json` 读写、资产安全读取（禁止 `backend.entry` 与路径穿越）及 `catalog.v2.json` 并发竞速拉取。验证：`npx tsc -b packages/harness-plugin-files` 与 `npx vitest run --config tests/vitest.config.js packages/harness-plugin-files/test/`。

## 2. 共享 Host、Web 薄代理与跨端前端（Stage 2，3 路并行）

- [x] 2.1 在 `packages/host-runtime` 与 `packages/console-server` 实现共享 Host 唯一 `HostExtensionManager`：托管单实例 `ExtensionBackendProcess`（不依赖 Desktop/Web 是否打开）、处理全部 `codexhost/extensions/*` RPC（保留 SSH 托管 `-32601` 拒绝）、推送 `extensions-changed` 事件，并对接 `packages/desktop-control` 仅注入含 `desktop` 入口的启用插件。验证：`npx tsc -b packages/host-runtime packages/desktop-control packages/console-server` 与对应 `packages/host-runtime/test/` 聚焦 Vitest。
- [x] 2.2 在 `packages/web-server` 移除平行的 `WebNativeExtensions` 磁盘存储与子进程托管，改为薄代理：保留既有 `auth.gate` / 同源 / `--no-auth` 门禁，透传 `codexhost/extensions/*` RPC，提供 `/api/extensions/upload` 上传中转与 `/api/extensions/assets/:id/:activationId/:digest/*` 资产代理（验证阻断 `backend.entry`、未鉴权 403、不可变缓存头），保持传统 DSH `/extensions` 恢复入口独立可用。验证：`npx tsc -b packages/web-server` 与 `packages/web-server/test/` 对应 `node:test` 套件。
- [x] 2.3 在 `packages/renderer-extension` 与 `apps/web-ui/packages/client/ui-codexhost` 落地跨端通用 `page` 加载器（统一 `--cx-page-*` 变量、`HostExtensionPageApi`、关闭/禁用时 `AbortSignal` 回收）、Web 宿主切至共享 Host `snapshot` + `extensions-changed` 事件与 `/api/extensions/assets/`，并将 Desktop 与 Web 两端的设置「插件」中心统一为单一列表 + 能力角标 + 打开独立管理页（移除 `Web | Desktop` 切换壳）。验证：`npm run build:renderer`、`ui-codexhost` `tsdown` 构建、`apps/web-ui` `tsc --noEmit` 与 `packages/renderer-extension/test/settings/` 聚焦 Vitest。

## 3. 端到端集成验证与文档同步

- [x] 3.1 使用一个包含 `backend` + 通用 `page` 的最小示例插件在隔离临时目录与随机端口实测：Web 端安装并启用一次，验证共享 Host 仅起 1 个后端进程、Web 与 Desktop 加载同一份 `page` 并共享同一份配置数据、纯前端无后端插件不起后台进程。验证：隔离实测报告与聚焦集成测试通过。
- [x] 3.2 更新 `docs/architecture/desktop-ui-extensions.md`（及 `docs/index.md` 如改名）与 `.agents/skills/codexhost-add-desktop-extension/SKILL.md` 反映现行统一扩展契约，并在完成后归档 OpenSpec 变更。验证：`openspec validate unify-host-extensions`。
