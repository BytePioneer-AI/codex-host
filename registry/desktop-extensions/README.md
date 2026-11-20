# codexhost Desktop 扩展索引

这是可独立部署的市场元数据仓库，不负责构建第三方代码。`sources.json` 是审核过的来源清单；`catalog.json` 是客户端读取的生成结果。作者使用 Issue Form **只提交公开 GitHub 仓库 URL**；管理员从其最新稳定 Release 的 ZIP manifest 读取扩展 ID，以 `community` 身份把来源加入 PR。首次上架的目标是人工花 10 秒查看 Actions 安检报告再点 Merge：确认仓库、作者、ID、档位与包都符合预期；遇到警告、可疑代码或不熟悉的发布者，应进一步审查而不是盲点 Merge。`official` 只由维护者赋予自己管理的来源。

合并后，每 6 小时自动检查已登记来源的最新稳定 Release，也可以手动运行 `Desktop extension registry`。只有所有来源通过校验才更新索引；任何失败都保留上一份有效索引，维护者可从运行记录下载 `safety-report.md` 定位失败的来源。此流程只更新索引，**不会自动在用户设备上更新或启用扩展**。SHA-256 校验下载完整性，不证明代码可信；静态检查不是代码审计或沙箱。

## 作者发布要求

- 在 GitHub 发布公开稳定 Release，上传构建好的 `.zip` **资产**；自动生成的 Source code ZIP 不算。包根目录（或唯一的顶层目录下）须有 `manifest.json`，声明的 `desktop.script`、可选样式与截图须随包发布。
- `name` 和 `description` 必须有非空 `en` 和 `zh-CN`；`details` 若提供也须双语；`author` 必填。发布新包时递增 manifest `version`，不要替换旧版本的 ZIP。
- 如果 manifest 声明截图，另将同一张图片作为 Release 资产上传，资产名使用路径的最后一段。每张 ≤ 512 KiB，最多 4 张，必须是 PNG、JPEG 或 WebP。校验器比较 ZIP 与单独资产字节，市场使用单独资产的 URL。
- ZIP 仅支持 STORE/DEFLATE；压缩 ≤ 5 MiB，展开 ≤ 10 MiB，最多 50 个条目，不允许链接、特殊文件、越界或冲突路径。CI 校验 Release 资产及 SHA-256（GitHub 提供 digest 时对照），按 Desktop v1 契约校验 manifest，并静态阻拦 `eval`、`new Function`、`child_process` 等模式。扩展代码不会在 CI 中执行。

## 迁移到独立仓库

1. 在 `BytePioneer-AI/codexhost-extensions-registry` 的 `main` 根目录放置本模板的 `README.md`、`sources.json`、`catalog.json`、`package*.json`、`runtime.mjs` 和 `validate-and-build-catalog.mjs`。将 `templates/submit-extension.yml` 放到 `.github/ISSUE_TEMPLATE/`，将 `templates/registry-sync.yml` 放到 `.github/workflows/`。不要把运行生成的 `safety-report.md` 提交到仓库。`runtime.mjs` 从 Host 契约和 ZIP 解析器生成；如契约变更，在 codexhost 工作树执行 `node tools/export-desktop-extension-registry.mjs` 后更新此文件。
2. 两条官方示例共用索引仓库作为 Release 源，以 `asset` 区分。先在 codexhost 工作树生成种子资产，并核对输出的 SHA-256 与随模板提供的 `catalog.json` 一致：

   ```sh
   npx tsc -b packages/harness-plugin-files
   node tools/build-desktop-extension-seeds.mjs /absolute/path/to/seed-assets
   ```

   将两个 ZIP 原样附到该独立仓库的首个公开稳定 Release `desktop-extensions-v1`（资产 URL 已写在种子索引中）。发布前内置目录只展示元数据，远端资产尚不可下载。今后若在索引仓库发新的官方 Release，仍需上传两个条目的最新 ZIP，包括未变化的那一个；其他扩展各自维护其发布仓库。如果资产移至别处，先一起更新 `sources.json`、独立索引及 Host 回退元数据，不要用占位 hash 替代实际校验值。
3. 以 Node 24 执行 `npm ci --ignore-scripts`、`node validate-and-build-catalog.mjs --check-only`，检查报告。去掉 `--check-only` 时才生成 `catalog.json`，无变化则不改其时间戳。提交来源变更的 PR 使用只读 token，不要改成 `pull_request_target` 执行投稿代码。为定时工作流允许专用机器人账号写 `main` 上的生成索引（若分支保护禁止机器人提交，需要调整仓库发布策略）。
4. 触发一次同步并确认 `catalog.json` 可从 `raw.githubusercontent.com/.../main/catalog.json` 公开读取。客户端以 jsDelivr 为备用，可用 `CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL` 指向测试索引。

`sources.json` 每一项登记 `id`、公开的 `repository`、可选的精确 `asset` 文件名、可选 `trustTier`（默认 `community`）和 `minCodexHostVersion`。要下架扩展，审查后从清单移除并手动触发同步；已安装的副本由用户自行卸载。
