# TRAE CN Desktop 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | trae-cn |
| 原生接口与传输方式 | TRAE CN 桌面扩展桥接 `electron.ahaIpc`，调用应用自带 `harness.dll` / `ai-agent` JSON-RPC；复用应用登录 |
| 已验证的原生版本 | TRAE CN 3.4.12 / VS Code core 1.107.1，Windows x64 |
| 交付范围 | 仓库内插件 + 桌面 Companion 扩展；原生接口为应用私有接口，须独立验收版本兼容性 |
| 参考插件 | WorkBuddy 的应用发现与应用拥有的认证；公共 Harness 输出和交互契约 |
| 最后验证 | 2026-10-31 Windows；应用内测试扩展使用 Seed-Code 完成最小对话，重连后从原生历史读取到同一条完成回复 |

## 能力

在实现 TRAE CN 插件前建立。原生探测成功不等于下表已实现；未验收的能力保持「待验证」。不使用独立 Trae CLI 的登录、模型或 Session。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 待验证 | — | — | |
| A2 | 工厂 | 必做 | P0 | 待验证 | — | — | |
| A3 | 检查 | 必做 | P0 | 待验证 | — | 原生健康检查已通过 | 不创建会话，不启动桌面窗口 |
| A4 | 创建 Session | 必做 | P0 | 待验证 | — | 原生 lite/create_chat_session 路由 | |
| A5 | 执行 Turn | 必做 | P0 | 待验证 | assets/companion/native.cjs | 原生 send_message、subscribe_events、get_messages 实测完成 | 尚未实现公共 Turn 投影 |
| A6 | 取消 | 必做 | P0 | 待验证 | — | 原生 lite/stop_chat_session 路由 | |
| A7 | 只读快照 | 必做 | P0 | 待验证 | — | 原生 lite/get_chat_session 路由 | |
| A8 | 持久身份 + resume | 必做 | P0 | 待验证 | — | 原生 lite/get_chat_session、resume_message 路由 | |
| A9 | 错误与并发 | 必做 | P0 | 待验证 | assets/companion/native.cjs | test/native.test.ts | RPC 已覆盖；公共 Session 并发未实现 |
| A10 | 关闭 | 必做 | P0 | 待验证 | assets/companion/native.cjs | RPC 待处理请求与订阅清理测试、原生重连读取 | 公共 Session 关闭未实现 |
| B1 | 切换 Model | 原生有则必做 | P1 | 待验证 | assets/companion/models.cjs | 原生 model/model_list_by_function；test/models.test.ts | 与原生会话菜单一致的启用和可选规则；不自动指定默认模型 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 待验证 | — | — | |
| B3 | 权限模式 | 原生有则必做 | P1 | 待验证 | — | 原生 permission_profile_id | |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 待验证 | — | — | |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | — | 原生 lite/fork_session 路由 | |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | — | — | |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | — | 原生 lite/revert_message 路由 | |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 待验证 | — | — | |
| B9 | 审批 | 原生有则必做 | P0 | 待验证 | — | 原生 lite/send_user_decision 路由 | |
| B10 | 提问 | 原生有则必做 | P0 | 待验证 | — | — | |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | — | — | |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | — | 原生 lite/subscribe_events 路由 | |
| B13 | 会话用量 | 原生有则必做 | P1 | 待验证 | — | — | |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | — | — | |
| B15 | 接收委派 | 必做（验证项） | P1 | 待验证 | — | — | |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | — | |
| C1 | 展示元数据 | 必做 | P1 | 待验证 | — | — | |
| C2 | 手动安装指引 | 必做 | P1 | 待验证 | — | — | 应用及 Companion 扩展 |
| C3 | 版本检查与更新 | 必做 | P1 | 待验证 | — | — | 应用更新渠道 |
| C4 | 首次安装 | 可选 | P2 | 不适用 | — | 桌面应用由官方安装器分发 | |
| C5 | 自定义启动路径 | 条件必做 | P1 | 待验证 | — | — | |
| C6 | 会话导入 | 可选 | P2 | 待验证 | — | — | |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | — | — | |
| C8 | 账号额度 | 可选 | P2 | 待验证 | — | — | |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 待验证 | — | — | |
| D2 | 预装清单 | 预装时必做 | P1 | 待验证 | — | — | |
| D3 | 加载测试 | 预装时必做 | P1 | 待验证 | — | — | |
| D4 | 文档 | 预装时必做 | P1 | 待验证 | — | — | |
| D5 | 其他 | 可选 | P2 | 不适用 | — | — | |

## 受限与已知缺口

当前处于开发阶段，尚无可交付的 TRAE CN Harness。需要应用内 Companion 扩展提供本机桥接；独立 Node 进程不能直接使用 Electron 内置 IPC。登录令牌只在应用进程内用于原生调用，不导出、不持久化。

原生模型管理接口 `model_list` 与会话菜单接口 `model_list_by_function` 的范围不同。模型管理接口不作为对话目录来源；目录按原生 Agent function 读取，并过滤 `status === false` 或 `selectable === false` 的模型。自定义 Provider 的失败不等于桌面登录失败；已观察到原生服务返回 Provider HTTP 401，不能用桌面登录状态代替模型调用验收。

## 插件外改动

尚未接入预装发行。`package-lock.json` 注册开发中的 Workspace；`eslint.config.js` 为应用内 CommonJS 资源加入通用检查；`docs/index.md` 添加开发说明入口。先前独立 CLI 原型已从最终变更中撤回。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | 待实现 | 未验证 |
| 原生边界 | 独立 Extension Development Host 中加载仓库 native.cjs | 应用登录、模型目录、创建、发送、事件和原生历史读取均已实测 |
| 插件加载 | 待实现 | 未验证 |
| Host 集成 | 待实现 | 未验证 |
| 真实原生验收 | TRAE CN 3.4.12 Windows，复用桌面登录，Builder / Seed-Code | 原生 done.status=completed；重连历史 finish.summary=CODEXHOST_TRAE_CN_OK；不是 Host 端验收 |
| Desktop / 委派 | 待实现 | 未验证 |
