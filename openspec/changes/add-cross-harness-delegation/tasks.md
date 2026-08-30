## 1. 持久化与关系模型

- [x] 1.1 在 Mapping Store 中新增 Delegation 关系记录（父子 Host Thread、双方 Harness、状态、可选 Request ID）与其读写接口
- [x] 1.2 允许调用方提供 Create Request ID 并将重复标识解析为既有 Host Thread；省略时在有界时间窗内按父 Thread、目标 Harness 与任务文本去重
- [x] 1.3 确认 Delegation 关系不触发会话列表对 Subagent 子 Thread 的排除逻辑

## 2. 委派协调器

- [x] 2.1 实现 HarnessDelegationCoordinator 的委派创建：目标 Harness 独立 Native Session、普通可写子 Thread、主动发布已开始
- [x] 2.2 实现显式 Request ID 幂等与省略 Request ID 时的有界重复检测，且不误伤任务文本不同的连续委派
- [x] 2.3 实现失败回滚，确保目标 Harness 启动失败时不留下已发布或半持久化的子 Thread
- [x] 2.4 实现结构化委派结果（子 Thread 标识、终态、摘要、可用性判定）
- [x] 2.5 为委派 Session 增加统一无人值守执行意图，并由 Claude Code（`auto`）、Grok、OMP、Pi 与原生 Codex 路径映射到各自原生行为；DeepSeek Harness 延后到兼容其当前 Host Remote 控制入口的后续变更

## 3. 委派 Skill

- [x] 3.1 产出 `codexhost-delegation` 薄 Skill 的单一权威模板，内容只描述触发边界并指向 `codexhost delegate --help`
- [x] 3.2 实现向 `~/.agents/skills/codexhost-delegation/SKILL.md` 与 `~/.claude/skills/codexhost-delegation/SKILL.md` 写入内容一致副本的安装流程
- [x] 3.3 为两处受管副本记录或推导版本与内容摘要，并在 codexhost 更新后检查缺失、旧版本和旧摘要
- [x] 3.4 使用同目录 staging 与原子替换更新受管副本；当前版本不重写，用户修改或非受管文件不静默覆盖
- [x] 3.5 安装或更新后验证两处目标均可读取、版本匹配且内容一致，并对单点冲突返回可辨识结果
- [x] 3.6 保持所有 Harness 用户 Turn 不注入委派提示，原生 Codex 请求不改写；确保目标 Harness 接收任务不依赖 Skill

## 4. 结果观察

- [x] 4.1 让 `delegate start` 在创建并投递子 Thread 后立即返回 `delegationId`、标识、Harness、深度链接与当前状态，不等待目标完成
- [x] 4.2 实现 `thread read` 的默认 `result` 视图：返回 Thread/最近 Turn 状态、最新可见进度、最终 Agent 消息、结果可用性与 `nextCursor`
- [x] 4.3 实现 `thread read --view messages`：仅返回用户与 Agent 可见消息，支持 limit、非消费性 cursor 增量和多轮 Thread
- [x] 4.4 确保首版 `thread read` / `wait` 不返回工具调用、工具参数、工具输出、文件变更、reasoning summary、隐藏推理或 Harness 私有 Transcript
- [x] 4.5 实现有界 `thread wait`：复用 `read` 的 `result|messages` 结果形状并增加 `timedOut`，超时以成功退出并报告运行中状态
- [x] 4.6 确保读取和等待不启动 Turn、不发送输入、不唤醒 Agent、不消费事件或标记消息已读；子任务完成只更新子 Thread 与 Delegation 状态

## 5. CLI

- [x] 5.1 在拉起 Harness 进程时提供 CLI 路径、Runtime 端点与令牌、当前 Host Thread 标识
- [x] 5.2 实现 `codexhost delegate start --harness <harnessId> --task <text> [--parent-thread <thread>] [--request-id <id>]`，默认结构化输出与可辨识错误代码
- [x] 5.3 实现 `codexhost thread read <thread> [--view result|messages] [--cursor <cursor>] [--limit <n>]`
- [x] 5.4 实现 `codexhost thread wait <thread> [--timeout-ms <n>] [--view result|messages] [--cursor <cursor>] [--limit <n>]`
- [x] 5.5 实现 `codexhost thread list [--cwd <path>] [--parent <thread>] [--limit <n>] [--cursor <cursor>] [--sort <mode>]`，默认当前 cwd、25 条、`created-desc` 且最多 100 条
- [x] 5.6 对所有 Thread 参数支持裸标识与深度链接规范化；支持显式父 Thread 参数作为身份来源，对缺失连接参数返回不可达错误且不回退 PATH
- [x] 5.7 将 `codexhost delegate --help` 的完整命令、参数、输出字段、错误代码和处置说明随二进制提供，确保与当前 Runtime 版本一致

## 6. 原生 Codex 支持

- [x] 6.1 先行验证原生 Codex 的工具调用能否连接本地 Runtime 端点，确定沙箱可行性与所需交汇方式
- [x] 6.2 在 `officialEnvironment()` 中新增 Runtime 连接参数白名单，保持其余内部变量剥离
- [x] 6.3 通过带外官方请求实现「委派给原生 Codex」：创建 Thread、投递任务、跟踪通知
- [x] 6.4 实现原生 Thread 的结果提取（终态与结论）与 `thread read` / `wait` 的官方请求代理
- [x] 6.5 确保原生 Codex 发起方与外部发起方使用相同的立即创建和显式 `read` / `wait` 观察语义

## 7. 验证

- [x] 7.1 为委派创建、幂等、失败回滚补充聚焦测试
- [x] 7.2 为两处 Skill 首次安装、版本/摘要检查、原子更新、内容一致性、用户修改冲突和 Turn 不注入补充回归测试
- [x] 7.3 为立即返回、`result|messages` 读取、运行中进度、最终消息、cursor 增量、消息分页、无执行轨迹、有界等待、等待超时与完成后不注入父 Session 补充聚焦测试
- [x] 7.4 为完整 CLI 参数解析、非法视图/超时/limit、深度链接规范化、原生 Thread 读取代理、列举默认值与排序补充 CLI 测试
- [x] 7.5 为官方环境白名单补充回归测试
- [x] 7.6 运行聚焦测试、typecheck、格式化、lint 与严格 OpenSpec 校验
- [x] 7.7 为各 Harness 的委派无人值守执行映射、普通创建权限不变和权限设置失败回滚补充测试并运行聚焦验证
