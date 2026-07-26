## 1. Gate C 安全基线与入口

- [x] 1.1 建立 `tools/gate-c/` 模块、独立真实 Gate 命令和 Hermetic 测试入口，确保普通检查不会启动本机 Pi
- [x] 1.2 实现内部注入命令、`PI_COMMAND`、默认 `pi` 的解析优先级，以 argv 数组追加 RPC 参数且不解析 Shell 命令行
- [x] 1.3 为直接可执行文件、PATH 命令、带空格路径和 Windows 命令脚本增加跨平台启动测试
- [x] 1.4 增加断言，确保 Gate 不调用或保存 Harness 版本、不导入 Pi SDK，并且不把 ACP、Print/JSON 或 TUI 用作 RPC/生产接入路径
- [x] 1.5 定义临时 cwd、独立 Session 目录、原始证据目录和清理策略，并将所有原始 Capture/Session/日志路径加入 Git 忽略

## 2. LF JSONL Client 与进程监督

- [x] 2.1 实现按字节 LF 分帧、跨 Chunk UTF-8 解码和可配置单帧缓冲上限，覆盖拆分 JSON、多 Frame、CRLF 输入容忍、Unicode 行分隔符和尾部残帧
- [x] 2.2 实现唯一请求 ID、Pending Request、Response/Event 分流和有序事件订阅
- [x] 2.3 实现未知合法 Event/附加字段隔离、Malformed Frame、重复/未知 Response 和协议 stdout EOF 错误
- [x] 2.4 实现 stdin 写入背压、stderr 有界诊断缓冲、Command 超时和取消 Pending Request
- [x] 2.5 实现停止新请求、stdin 半关闭、输出排空、正常等待、超时升级和进程退出后的统一收敛
- [x] 2.6 建立 Fake Pi，覆盖交错 Response/Event、任意 Chunk、Malformed JSON、stderr、延迟、Crash、拒绝关闭和后代进程
- [x] 2.7 在 Windows/macOS Hermetic 测试中验证正常关闭、强制关闭和无本次 Gate 创建的孤儿进程

## 3. Capture、本地证据与合成 Fixture 契约

- [x] 3.1 定义原始 Capture、场景结果、能力矩阵和本地 Gate 报告的最小结构，不执行 Harness 版本查询
- [x] 3.2 实现真实 Capture、Session、能力矩阵和报告只写入 `.codexhost/gate-c/`的路径约束
- [x] 3.3 定义只允许 Fake Pi 固定合成数据进入仓库 Fixture 的生成边界
- [x] 3.4 增加测试，确认普通检查和 Fixture 生成不会读取本机 Pi、用户 Session、用户配置或本地真实证据
- [x] 3.5 实现只读合成 Golden 比较和显式生成命令，测试失败路径不得自动覆盖已评审 Fixture

## 4. 真实 Pi 隔离控制面

- [x] 4.1 实现真实 Pi 前置检查，只验证命令可执行、RPC 可启动和受控目录可用，不执行版本探测
- [x] 4.2 在不调用模型的隔离 Profile 中采集初始状态、Session 身份、Session 文件物化、Entries、Tree 和 active leaf
- [x] 4.3 验证创建、关闭、按原生 locator 恢复和重复控制面读取不会修改用户全局配置或其他 Native Session
- [x] 4.4 捕获未知 Command、错误 Command、错误参数和进程提前退出的真实 RPC 错误形状
- [x] 4.5 验证用户项目 Trust 和资源开关在 RPC 模式下的实际边界，并将隔离 Profile 与 Native Profile 的结果分开记录

## 5. Gate Extension 与 Interaction

- [x] 5.1 创建只用于 Gate 的最小 Extension，确定性提供 Preflight 早到 Interaction、无 Agent Loop Command 和受控 Question Tool
- [x] 5.2 覆盖 `select`、`confirm`、`input`和 `editor`的正常回答及请求 ID 关联
- [x] 5.3 覆盖 Interaction 用户取消、原生超时、重复 Response、错误 ID、Abort 和进程退出
- [x] 5.4 验证 Prompt Response 之前的 Interaction 能关联并响应，且无 Agent Loop Command 不等待不存在的 `agent_settled`
- [x] 5.5 将所有通用 Extension UI 记录为 Question，并验证权限文案或 `confirm`不会生成 Approval 结论
- [x] 5.6 分别记录默认 RPC 和显式 Gate Extension 的能力证据，禁止报告暗示生产环境默认注入 Extension

## 6. Native Live Stream、终态与 Tool

- [x] 6.1 建立显式 Native Live 命令和最小固定 Prompt，运行前提示模型/网络访问并将文件操作限制在临时项目
- [x] 6.2 采集 Prompt Response、`agent_start`、Message Stream、`turn_end`、`agent_end`、`agent_settled`和状态回读的完整顺序
- [x] 6.3 验证 Prompt 接受、Agent Loop 启动和稳定终态是独立状态，每个 Agent Run 只派生一个 Gate 终态
- [x] 6.4 构造并采集自动重试、Compaction、Steer/Follow-up 队列对 `agent_end`至 `agent_settled`的影响，无法确定性触发时保留明确的阻塞证据
- [x] 6.5 采集 Tool Start、累计 Update、End、失败和未知 Tool，并按 Call ID 验证交错生命周期
- [x] 6.6 在合成文件上验证成功 Edit 的多编辑块、CRLF 和 Unified Patch 可应用性及磁盘结果一致性
- [x] 6.7 验证失败 Edit、Write、Bash 和未知 Tool 没有可靠 Patch 时只形成 Tool 结论，不自行推断 File Change

## 7. Cancel、错误与继续执行

- [x] 7.1 在 Assistant Streaming 期间执行 Abort，记录 Response、消息停止、Agent 事件、`agent_settled`和非 Streaming 状态
- [x] 7.2 在长时间 Tool 执行期间 Abort，验证 Tool 终态、子进程清理和 Agent 稳定收敛
- [x] 7.3 在 Pending Question 期间 Abort，验证 Interaction 回调关闭且不会响应到其他请求
- [x] 7.4 在取消收敛后使用同一 Session 完成下一普通 Turn，验证旧事件和 ID 不污染新请求
- [x] 7.5 验证空闲重复 Abort、鉴权失败、Model 错误、Pi Crash 和强制关闭均有唯一可解释结果

## 8. History 与 Native Turn Ref

- [x] 8.1 为成功、失败和取消 Agent Run 捕获完成前后 Entries/Tree 差异，并列出 Native Turn Ref 候选
- [x] 8.2 验证候选在同一 Session 中唯一，且实时完成、重复读取、关闭/恢复后保持一致
- [x] 8.3 使用同一 Pi 可执行程序在 RPC 关闭后通过原生客户端追加 Turn，再恢复 RPC 并验证既有候选不变、新 Turn 可读
- [x] 8.4 构造 Session Tree 分支并验证 active leaf/祖先链决定当前历史，append 顺序中的非 active 分支不进入当前投影
- [x] 8.5 对比 `get_messages`与 Entries/Tree 在分支和 Compaction 后的差异，记录完整历史事实源结论
- [x] 8.6 形成 Native Session locator、Native Turn Ref 和实时/历史对齐的证据结论，不提前创建正式公共类型

## 9. Checkpoint、Fork 与 Clone

- [x] 9.1 创建包含至少三个已完成 Turn 的来源 Session，并保存 Fork 前的 Session 身份、Entry Tree 和 active branch 摘要
- [x] 9.2 验证从非最后已完成 Turn 使用官方 `fork`及合法定位组合创建独立 Session，并断言精确上下文截止位置
- [x] 9.3 验证从当前最后已完成 Turn 使用官方 `clone`或 Fork 能力创建独立且可恢复继续的 Session
- [x] 9.4 在目标 Turn 周围加入 Model/Thinking Change Entry，验证派生 Session 的实际状态和 Entry 截止位置
- [x] 9.5 向派生 Session 追加 Turn并复核来源 Session 的 ID、文件和 Tree 未改变
- [x] 9.6 为每个可 Fork Turn 确定实际 Checkpoint 表达；无法覆盖任意当前可见已完成 Turn 时生成 FAIL/架构调整证据
- [x] 9.7 审计 Fork 实验没有直接修改 Session JSONL，也没有通过 Gate Extension 隐藏官方 RPC 缺口

## 10. Model、Thinking 与命令目录

- [x] 10.1 在本地忽略 Capture 中采集当前 Session 的 Model Catalog、有效 Model、Thinking 选项和状态结构
- [x] 10.2 在两个实际已认证 Model 之间执行 Turn 间切换，并通过状态回读和后续 Turn 验证生效
- [x] 10.3 环境没有第二个可调用 Model 时将场景标记为 BLOCKED，并记录与 Harness 版本无关的解除条件
- [x] 10.4 验证 Thinking 切换的接受、实际状态和与 Model 切换的副作用顺序
- [x] 10.5 采集 Extension Command、Prompt Template 和 Skill Catalog，验证未返回的内置 TUI 命令不会被补造
- [x] 10.6 验证 Model、状态和命令结果只进入本地真实 Capture，仓库合成 Fixture 不读取这些本机值

## 11. Gate 结论与文档收敛

- [x] 11.1 运行全部 Hermetic、隔离、Gate Extension 和 Native Live 场景，逐项生成 PASS、FAIL 或 BLOCKED 结果
- [x] 11.2 生成能力矩阵，区分 MVP 必需能力与 Approval、Reasoning、可靠 Patch 等观察能力
- [x] 11.3 只从干净且执行前后提交不变的工作树中的同一次显式 Gate 执行生成本地忽略 Pi RPC Gate C 验证记录，包含代码提交、平台/架构、命令来源类别和真实证据位置，不自动拼接独立 Profile 最新目录且不执行 Harness 版本查询
- [x] 11.4 复核仓库内 Fixture 和 Golden 全部来自 Fake Pi 固定合成场景，真实报告和 Capture 未进入版本控制
- [x] 11.5 根据证据修正 `docs/开发步骤清单.md` 中 Gate C 范围、终态、发布 E2E 和执行顺序，不机械保留不准确清单
- [x] 11.6 删除相关正式设计中的 Harness 版本字段/版本行为，并按证据更新 Native Ref、Fork、Question、Cancel、Patch 和命令目录未决项
- [x] 11.7 Gate 非 PASS 时记录产品影响和下一决策，并确保后续 Change 不把 Pi RPC 闭环标记为已验证

## 12. 质量与范围验收

- [x] 12.1 运行 Gate C Hermetic/Fixture 测试，确认普通检查不依赖本机 Pi、认证、网络或用户配置
- [x] 12.2 运行 `npm run check`和 `npm run build`，并记录实际执行结果
- [x] 12.3 审计变更未实现正式 PiAdapter、HarnessAdapter、Shared Contracts、Protocol Core、Renderer、Mapping Store、ACP 或发布打包
- [x] 12.4 审计 Git 状态，确认原始 Capture、Session、日志、下载、凭据和本地配置未进入版本控制
- [x] 12.5 运行 `openspec validate capture-pi-rpc-capabilities --strict`并确认每项 Requirement 都有对应任务、测试或 Gate 证据
