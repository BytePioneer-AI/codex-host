## 1. 协议与规格

- [x] 1.1 核对工作树与 upstream 基线；记录两个 DSH tag、Session 格式和 rc.2→rc.3、rc.3→017 的原生协议差异矩阵。
- [x] 1.2 根据协议矩阵复核并细化现有 delta specs 中的 V0/V3/V4 版本选择、Remote、历史、控制、Fork 与迁移边界；再次运行 `openspec validate support-dsh-015rc3-017rc1 --strict`。
- [x] 1.3 确认 017 原生已知事件/字段的投影、忽略或拒绝规则，以及真实 Gate 的模型桩协议；把结论写入 design 与相应场景。

## 2. Adapter 对接

- [x] 2.1 为精确 `0.1.7-rc.1` 选择 V4 profile；验证 `0.1.5-rc.3` 的 V3 路径，不改变旧版本已验证行为。
- [x] 2.2 按固定 tag 修正必要的 Web Remote、Session 列表、模型/权限、命令、控制和历史响应校验；保持认证与错误脱敏。
- [x] 2.3 接通 V4 header、事件/surface、Assistant 流与 durable 结算，以及断线后的有界恢复；不让 DSH wire 进入公共包。
- [x] 2.4 验证并修正 V4 创建、继续、取消、导入、Fork、最后回合回滚、继承待办清理和持久化确认；跨格式 checkpoint 在 mutation 前失败。

## 3. 回归与真实版本 Gate

- [x] 3.1 用两 tag 的脱敏原生样本补定向测试：合法 V3/V4、非法字段/引用、历史分页、实时去重、控制读回与格式隔离。
- [x] 3.2 运行整个 DSH Adapter 的 `npm run test:deepseek:coverage`，保持四项现有 80% 门槛；补受影响 Host、共享契约、Renderer 的定向回归。
- [x] 3.3 隔离运行 `0.1.5-rc.3` 与 `0.1.7-rc.1` 的真实 CLI 生命周期 Gate，记录 `--version`、Web 启动、模拟模型、成功/失败点及平台；CLI 或测试桩问题分别归因。
- [x] 3.4 运行 `npm run build:typescript`、`npm run typecheck`、`npm run lint`、改动文件 Prettier、`git diff --check` 和 OpenSpec strict；仅在相关代码触及时扩大到其他 Gate。

## 4. 文档与 PR

- [x] 4.1 更新 DSH 验证记录、连接/导入/消息修订文档与 `docs/index.md`；通过真实 Gate 的版本才加入设置页已验证提示与推荐安装说明。
- [x] 4.2 将完成后的 delta 合入主 OpenSpec，核对代码、规格、测试和文档一致；保留历史归档事实。
- [ ] 4.3 审核 diff 和敏感信息，按逻辑单元写中文提交并推送 fork 分支；使用 `gh` 向 upstream `main` 提交中文 PR，填写目的、需求、Issue、实际验证和未验证边界。
