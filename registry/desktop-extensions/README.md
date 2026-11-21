# codexhost Desktop 扩展索引

这是可独立部署的市场元数据仓库，不负责构建第三方代码。`sources.json` 是审核过的来源清单；`catalog.json` 是客户端读取的生成结果。作者使用 Issue Form **只提交公开 GitHub 仓库 URL**；管理员从 Release ZIP 或默认分支的 `manifest.json` 读取扩展 ID，以 `community` 身份把来源加入 PR。首次上架的目标是人工花 10 秒查看 Actions 安检报告再点 Merge：确认仓库、作者、ID、档位与包都符合预期；遇到警告、可疑代码或不熟悉的发布者，应进一步审查而不是盲点 Merge。`official` 只由维护者赋予自己管理的来源。

每 30 分钟自动同步已登记来源的最新版本和 GitHub Star 数。`main` 上的 `sources.json` 发生变更时立即触发同步，也可手动运行 `Desktop extension registry`。Star 数取自 `sources.json` 登记的仓库；无法读取有效计数时省略 `stars`，不影响扩展包校验。优先使用最新稳定 Release 的 ZIP 资产；没有 Release 或没有 ZIP 资产时，验证默认分支的源码 zipball，并将索引的下载链接固定到已校验的 commit。若配置了 `sources[].asset`，则要求该 Release 资产存在，不回退。只有所有来源的扩展包通过校验且 `catalog.json` 内容确有变化时才提交并推送；校验失败时保留上一份有效索引，维护者可从运行记录下载 `safety-report.md` 定位失败的来源。此流程只更新索引，**不会自动在用户设备上更新或启用扩展**。SHA-256 校验下载完整性，不证明代码可信；静态检查不是代码审计或沙箱。

## 作者发布要求

- **默认分支源码**：在公开仓库根目录提交 `manifest.json`、`desktop.script` 声明的构建后 JS，以及声明的样式、Logo 和截图。不需要手动打包 Release；校验器不负责编译 `.ts`。索引只接受仓库主页；用户直接安装时也可以使用 `/tree/<ref>/<subdir>` 链接。
- **Release ZIP**：在公开稳定 Release 上传构建好的 `.zip` 资产。包根目录或唯一的顶层目录下须有 `manifest.json` 和声明的入口 JS、样式、Logo 和截图。Release 有多个 ZIP 资产时在 `sources[].asset` 指定文件名。
- `name` 和 `description` 必须有非空 `en` 和 `zh-CN`；`details` 若提供也须双语；`author` 必填。ZIP 字节变化时须递增 manifest `version`；源码模式下，即使只改变仓库中的文档，也会改变 zipball。
- `categories` 可省略或填 `[]` 表示未分类。按主要用途选择且不重复：`appearance`（外观主题）、`interface`（界面增强）、`workflow`（效率与协作）、`analytics`（数据与统计）、`integrations`（外部集成）、`tools`（实用工具）。不接受其他值。
- 可选 Logo（`icon`）≤ 128 KiB；截图每张 ≤ 512 KiB，最多 4 张。均只接受 PNG、JPEG 或 WebP，扩展名须匹配文件签名。Release 模式另上传同一图片作为单独资产，资产名为路径的最后一段；源码模式使用固定到同一 commit 的 Raw URL。校验器比对公开图片 URL 和 ZIP 中的字节。使用 Logo 前请确认读取索引的客户端支持 `icon`；旧客户端的严格校验会拒绝带此字段的索引。
- ZIP 仅支持 STORE/DEFLATE；不允许链接、特殊文件、越界或冲突路径，并有防解压炸弹和内存耗尽的护栏。CI 记录 ZIP 的 SHA-256（GitHub 提供 Release 资产 digest 时对照），按 Desktop v1 契约校验 manifest，并静态阻拦 `eval`、`new Function`、`child_process` 等模式。扩展代码不会在 CI 中执行。

## 迁移到独立仓库

1. 在 `BytePioneer-AI/codexhost-extensions-registry` 的 `main` 根目录放置本模板的 `README.md`、`sources.json`、`catalog.json`、`package*.json`、`runtime.mjs` 和 `validate-and-build-catalog.mjs`。将 `templates/submit-extension.yml` 放到 `.github/ISSUE_TEMPLATE/`，将 `templates/registry-sync.yml` 放到 `.github/workflows/`。不要把运行生成的 `safety-report.md` 提交到仓库。`runtime.mjs` 从 Host 契约和 ZIP 解析器生成；如契约变更，在 codexhost 工作树执行 `node tools/export-desktop-extension-registry.mjs` 后更新此文件。
2. 模板的来源清单和生成索引均为空，无需上传初始 Release 资产。扩展由作者独立发布；待来源通过审核后，加入 `sources.json` 并由同步流程生成索引。迁移已有索引时保留该仓库已审核的来源，不用空模板覆盖。
3. 以 Node 24 执行 `npm ci --ignore-scripts`、`node validate-and-build-catalog.mjs --check-only`，检查报告。去掉 `--check-only` 时才生成 `catalog.json`，无变化则不改其时间戳。提交来源变更的 PR 使用只读 token，不要改成 `pull_request_target` 执行投稿代码。为定时工作流允许专用机器人账号写 `main` 上的生成索引（若分支保护禁止机器人提交，需要调整仓库发布策略）。
4. 触发一次同步并确认 `catalog.json` 可从 `raw.githubusercontent.com/.../main/catalog.json` 公开读取。客户端以 jsDelivr 为备用，可用 `CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL` 指向测试索引。

`sources.json` 每一项登记 `id`、公开的 `repository`、可选的精确 `asset` 文件名、可选 `trustTier`（默认 `community`）和 `minCodexHostVersion`。要下架扩展，审查后从清单移除；合并到 `main` 后会自动同步，已安装的副本由用户自行卸载。

## 可选：用 Cloudflare 免费额度统计下载量

1. 在 Cloudflare Free 账号下，进入本模板的 `worker/`，运行 `npx wrangler login` 和 `npx wrangler kv namespace create STATS_KV`，将返回的 Namespace ID 填入 `worker/wrangler.toml` 的 `id`。
2. 在同一目录运行 `npx wrangler deploy`，用部署返回的 `https://…workers.dev/health` 检查是否返回 `{ "ok": true }`。Worker 没有运行时依赖，只在 KV 中保存按扩展 ID 聚合的计数。
3. 在索引仓库 **Settings → Secrets and variables → Actions → Variables** 添加 `STATS_URL`，值为 Worker 的 HTTPS 根地址（不带 `/stats.json`）。在要上报的 codexhost Host／Console 进程中，将 `CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL` 指向同一地址。定时同步会把 `/stats.json` 中有效的非负整数合并到 `catalog.json` 的可选 `downloads` 字段；无数据或 Worker 不可用时省略该字段，不影响同步。启用前请确认读取该索引的客户端已支持 `downloads`，旧客户端的严格校验会拒绝带此字段的索引。

只统计从索引成功完成的安装（含重装和更新）；客户端只发送扩展 ID，不发送账号、设备 ID 或请求体。Worker 仅接受小写字母、数字及单连字符分段的 ID，含 `.` 或 `_` 的扩展不会计数。该接口公开，KV 是最终一致的，并发和写入限额可能导致漏计，公开请求也可能抬高计数；这是下载量参考，不是精确或唯一用户统计。费用为零的前提是留在 Cloudflare Free 计划额度内。
