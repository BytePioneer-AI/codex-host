---
name: codexhost-pre-push-checks
description: 在推送、标记 PR 就绪或声称“检查通过”之前，按 diff 触及的面选择最小而充分的本地检查，不反射式跑全量。覆盖 TypeScript、Rust、Renderer、发布脚本与 Gate 的选择规则，以及改写历史推送的保护。
---

# codexhost 推送前检查

目标：用最小的、回归时会失败的检查，为即将推送的 diff 提供本地证据；全量矩阵由 CI 负责。命令一律以 `package.json` 与相应配置为准，下表是选择依据，不是命令目录。

## 先看范围

```sh
git status --short --branch
git diff --stat <base>...HEAD      # 先确认真实的 PR 基线
```

CI 对仅修改 `docs/**` 与 `**/*.md` 的 PR 不触发（见 `.github/workflows/ci.yml`）；纯文档改动只需核对链接与 `docs/index.md`。

## 按改动面选择

| diff 触及 | 优先检查 |
| --- | --- |
| `packages/*/src` 逻辑 | 该包 `test/` 下的聚焦测试：`npx vitest run --config tests/vitest.config.js <file>`；共享契约变化时加相邻包测试。跨包导入经由各包 `dist`，改动了被依赖的包后先 `npm run build:typescript`（`test:typescript` 也是先构建再测试）。 |
| 类型、导出、`tsconfig` | `npm run typecheck`（包含 `tests/tsconfig.json`）。 |
| 依赖方向、跨包 import | `npm run lint`（含 `tools/check-boundaries.mjs`），改动前后各看一次结果。 |
| 格式 | `npm run format:check`；只对改动文件运行 prettier 即可定位。 |
| `crates/**`、`Cargo.*` | `npm run check:rust`，或对所属 crate 的 `cargo test` / `cargo clippy`，沿用 `package.json` 里的 features。 |
| `packages/renderer-extension` | `npm run build:renderer`；绑定与 DOM 行为用 `tests/e2e` 中对应 `renderer-*.spec.ts`（`npm run test:e2e`）；怀疑与 Codex Desktop 版本相关时用 `probe:renderer-binding` 或 `codexhost-update-impact-audit`。 |
| `scripts/release/**`、打包、发行元数据 | `tests/release/**/*.test.mjs`，必要时 `release:*` 对应脚本的烟测；发布流程参见 `codexhost-release`。 |
| `tools/gate-*`、Harness Adapter 的真实行为 | 对应 `gate:*:hermetic`；`live` 类 Gate 需要凭据与真实 CLI，只在用户明确要求且环境具备时运行，不打印密钥。 |
| 平台敏感代码（fs、进程、路径、环境变量） | 说明 macOS / Windows 未本地验证的部分，交由 CI 二级平台；可用 `CODEXHOST_TEST_SCOPE=platform` 近似二级平台的选择。 |

规则：每个行为改动至少有一个“回归时会失败”的测试或检查；没有现成的就补一个或说明缺口。不要因为即将提交就重复跑刚通过的检查。

## 完整本地预演

仅在用户要求、排查 CI 失败，或改动横跨仓库、没有更窄的可信集合时，才运行 `npm run check`。使用 `package.json` 现状，不凭记忆重建聚合命令。

## 失败处理

- 推送前相关检查失败：先修复或说明阻塞，不要“先推上去看 CI”。
- 疑似环境问题：记录确切命令、失败用例与平台差异，确认非平台相关的证据仍通过，再决定。
- 不得绕过本地钩子或门禁，除非用户明确同意，并如实报告失败内容。

## 推送

仅在用户要求推送时执行。

1. 运行已选择的检查，各一次。
2. 改写历史后推送时，先 `git fetch` 并记录远端分支的确切 OID，使用 `--force-with-lease=<branch>:<oid>`；不使用裸 `--force`。
3. 推送后核对 `git rev-parse HEAD origin/<branch>` 一致。
4. PR 用 `gh pr checks` 查看远端结果：未完成的如实报告为 pending，失败的先检查再归因。改写历史后，重新核对未解决的评审线程与批准状态，旧的 commit hash 与行内评论锚点不再是当前证据。

不得声称检查通过，除非它已被执行；被跳过或无法运行的检查，报告原因。
