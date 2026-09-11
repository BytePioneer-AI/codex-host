## Why

DSH 012rc1／015rc1 的默认子智能体目前在 CH 中只有普通工具输出，用户无法从原生卡片持续观察后台状态或进入子会话。两个版本的真实 CLI 验证已确认目录、父子地址、流式日志与冷恢复接口可用，可以复用 CH 公共子智能体能力补齐接入。

## What Changes

- 为默认 `subagent`／`subagent_fork` 及针对已有子级的 `send_message` 提供原生子智能体卡片、独立身份、真实状态与只读详情。
- 子级观察覆盖父轮结束、成功／失败／中断、继续执行、多层子级及冷恢复；读取和关闭观察器不启动或取消原生子任务。
- 修正公共 Host 的子线程运行状态恢复和后代通知路由，保持 Harness 与父树隔离。
- 同步 OpenSpec、子智能体能力文档及 `.agents` 中已过时的 DSH 实现导航；README 与本地 plan/todo 不进入本 PR。

## Capabilities

### New Capabilities
- `deepseek-native-subagents`: 双 RC 默认原生子智能体的观察、卡片、身份、历史与生命周期。

### Modified Capabilities
- `harness-subagent-session`: 恢复或打开只读子线程时保留已观察运行状态，并在同一 Harness、原生会话和父树内路由后代状态与历史通知。

## Impact

主要修改 DeepSeek Adapter 的 journal 地址、Session 只读观察、子级投影及 Adapter 接线；公共 Host 修改仅处理通用后代查找与状态一致性，不增加 DSH 分支。不新增运行依赖或专用 Renderer 界面。跨进程提供方缺少统一内部记录，保持原生工具语义；子会话直接输入／独立控制 UI 不属于本次默认只读卡片接入。关联 #58、#242；复核公共问题 #236、#238、#247，避免重复或错误关闭。
