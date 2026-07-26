## ADDED Requirements

### Requirement: 只读发现并验证 macOS 官方 Codex App

macOS 平台层 MUST 只读发现目标 Codex App bundle，并 MUST 从同一 bundle 验证 `Info.plist`、Bundle Identifier、版本、主可执行文件和配套官方 Codex CLI。实现 MUST NOT 回退到 `PATH`、Homebrew 或任意全局 `codex`，也 MUST NOT 修改 App bundle。

#### Scenario: 发现标准安装的官方 App

- **WHEN** 受支持应用目录中存在 Bundle Identifier 为 `com.openai.codex` 且内部结构有效的 Codex App
- **THEN** 平台层 MUST 返回规范化的 bundle root、版本、主可执行文件和 `Contents/Resources/codex` 绝对路径
- **AND** 返回的 Desktop 与 CLI MUST 来自同一个 App bundle

#### Scenario: 候选名称相同但身份不匹配

- **WHEN** 某个 `.app` 名称包含 Codex 但 Bundle Identifier、主可执行文件或内部 CLI 不符合要求
- **THEN** 平台层 MUST 拒绝把该候选作为官方安装
- **AND** MUST NOT 改用当前 `PATH` 中的 `codex`

#### Scenario: 发现多个合法候选

- **WHEN** 多个安装位置包含通过身份和内部一致性校验的候选
- **THEN** 平台层 MUST 按明确且可诊断的安装位置规则选择，或返回歧义错误
- **AND** MUST NOT 仅按修改时间或任意目录枚举顺序猜测目标

#### Scenario: App 或 CLI 不可执行

- **WHEN** 主可执行文件或同 bundle 配套 CLI 缺失、不可执行或无法规范化
- **THEN** 发现 MUST 以明确错误结束
- **AND** Probe MUST NOT 启动 Desktop 或其他全局 CLI

### Requirement: 隔离验证 macOS Desktop 启动和环境继承

Gate MUST 在目标 Desktop 未运行时分别验证 LaunchServices 和直接 App bundle 可执行文件的启动事实，并 MUST 只采用能够证明本次新实例继承进程级 `CODEX_CLI_PATH` 的方式。Gate MUST NOT 修改用户级/系统级环境、`launchctl` 全局环境、官方安装或 `app.asar`。

#### Scenario: Desktop 已经运行

- **WHEN** 平台层检测到目标 App bundle 的 Desktop 主进程已经运行
- **THEN** Probe MUST 拒绝复用或终止该实例
- **AND** MUST 返回可操作诊断，要求用户正常关闭后重试

#### Scenario: 候选启动方式创建新实例并继承环境

- **WHEN** Gate 以候选方式启动全新 Desktop，并为本次进程设置绝对 Shim 路径
- **THEN** Gate MUST 关联实际 Desktop PID、父子关系或进程组及 Shim Capture
- **AND** Capture MUST 证明 Desktop 发起的 CLI 调用收到本次 `CODEX_CLI_PATH`
- **AND** 环境设置 MUST 只作用于本次启动的进程树

#### Scenario: LaunchServices 复用实例或丢失环境

- **WHEN** LaunchServices 路径复用其他实例、无法识别实际新实例或不能证明环境到达 Shim
- **THEN** Gate MUST 将该启动方式记录为不成立
- **AND** MUST NOT 通过全局环境或修改 App bundle 补偿

#### Scenario: 直接执行偏离官方应用行为

- **WHEN** 直接执行 bundle 主程序虽能继承环境，但无法提供可接受的窗口、单实例、应用生命周期或退出行为
- **THEN** Gate MUST 将该方式记录为不适合作为生产启动路径
- **AND** MUST NOT 仅因 Shim 被调用就判定启动 Gate 通过

#### Scenario: 没有候选启动方式成立

- **WHEN** 所有受测方式均无法同时证明隔离环境继承和可接受的 Desktop 行为
- **THEN** macOS Gate MUST 结论为 `FAIL` 或 `BLOCKED`
- **AND** 后续实现 MUST NOT 把 macOS `CODEX_CLI_PATH` 启动标记为已验证能力

### Requirement: 复用共享透明代理核心并保持平台边界

macOS Shim MUST 复用与 Windows 相同的 argv 转发、官方 CLI 目标校验、递归防护、stdio 字节泵、EOF 和退出终态核心。平台差异 MUST 隔离在 `platform` 的启动与进程监督实现中；本变更 MUST NOT 建立第二套 macOS 协议代理。

#### Scenario: 在 macOS 构建 Shim

- **WHEN** 工程为 macOS 构建 `codexhost-shim`
- **THEN** 产物 MUST 使用共享代理核心和 macOS 进程监督实现
- **AND** MUST NOT 解析或重写 app-server JSONL

#### Scenario: 共享核心发生重构

- **WHEN** 为支持 macOS 调整共享 Shim 或进程监督接口
- **THEN** 现有 Windows argv/env、递归、字节透明、EOF、退出码和清理测试 MUST 继续通过
- **AND** Windows Job Object 实现 MUST 保留其已验证的可观察行为

#### Scenario: Gate 捕获未显式启用

- **WHEN** Launcher 或 Shim 运行于非 Probe 路径
- **THEN** 共享生产候选代码 MUST NOT 默认写入调用 Capture、Prompt、Transcript 或 Gate 报告
- **AND** Gate-only 环境字段 MUST NOT 成为透明代理所必需的领域状态

### Requirement: 明确定位官方 CLI 并阻止 macOS 递归

Launcher MUST 将当前 App bundle 内配套官方 Codex CLI 的绝对路径明确传给 Shim。Shim MUST 在启动目标前校验路径身份，并 MUST 清除或重写子进程的 `CODEX_CLI_PATH`，不得依赖 `PATH` 猜测目标。

#### Scenario: 转发 Desktop 调用

- **WHEN** Shim 收到 app-server 或其他 Codex CLI 调用且 bundle 内目标有效
- **THEN** Shim MUST 使用原 argv 启动该明确目标
- **AND** 官方 CLI 子进程 MUST NOT 再把 `CODEX_CLI_PATH` 指向当前 Shim

#### Scenario: 目标解析为 Shim 自身

- **WHEN** 规范化、符号链接解析后的目标与 Shim 自身相同或形成递归链
- **THEN** Shim MUST 在创建子进程前失败
- **AND** stdout MUST 保持为空或只包含此前已由官方 CLI 产生的协议字节

#### Scenario: bundle 内 CLI 目标失效

- **WHEN** 明确目标不存在、不可执行或不再位于已验证 App bundle
- **THEN** Shim MUST 返回非成功终态并向 stderr 提供受限诊断
- **AND** MUST NOT 回退到全局 `codex`

### Requirement: 保持 macOS stdio 字节透明和终态语义

Shim MUST 不解析、不重新序列化且不规范化换行地双向转发父 stdin 与官方 CLI stdout，并 MUST 将官方 CLI stderr 转发到父 stderr。Shim 自身诊断 MUST NOT 污染 stdout；EOF、普通退出和信号退出 MUST 得到明确且有限的终态。

#### Scenario: 任意 chunk 和非 UTF-8 字节

- **WHEN** 父进程与假官方 CLI 交换拆分 JSONL、多行、LF/CRLF、大输出或非 UTF-8 字节序列
- **THEN** 接收端 MUST 按相同顺序收到完全相同的字节
- **AND** Shim MUST NOT 添加、删除或规范化任何字节

#### Scenario: 父 stdin 到达 EOF

- **WHEN** 父 stdin 关闭
- **THEN** Shim MUST 关闭官方 CLI stdin
- **AND** MUST 继续排空 stdout 与 stderr，直到子进程退出或有界关闭升级

#### Scenario: 官方 CLI 普通退出

- **WHEN** 官方 CLI 返回可表示的普通退出码
- **THEN** Shim MUST 在排空输出后返回相同退出码

#### Scenario: 官方 CLI 因信号或 Crash 退出

- **WHEN** 官方 CLI 因信号或异常终止且没有普通退出码
- **THEN** Shim MUST 以非成功终态退出并保留受限的信号或异常分类诊断
- **AND** MUST NOT 向 stdout 注入错误 JSON、日志或伪造成功响应

### Requirement: 使用 macOS 原生进程身份和有界生命周期监督

macOS 平台层 SHALL 使用 PID、父 PID、process group 和规范化可执行路径识别目标 Desktop、Shim、官方 CLI 及本次启动的后代。受监督 CLI 的隔离边界 MUST 在创建进程前建立；取消、信号、Crash 或强制终止后 MUST 在有界时间内收敛，且 MUST NOT 误杀无法证明属于本次启动的进程。

#### Scenario: 启动受监督官方 CLI

- **WHEN** Shim 创建官方 CLI
- **THEN** 平台层 MUST 在子进程执行前建立可用于信号转发和清理的 process group 或等价隔离边界
- **AND** Shim MUST 持有完成正常等待和升级终止所需的监督状态

#### Scenario: Desktop 向 Shim 发送受支持信号

- **WHEN** Shim 收到 `SIGTERM`、`SIGINT`、`SIGHUP` 或实测 Desktop 使用的受支持取消信号
- **THEN** Shim MUST 将取消传递给受监督 CLI 执行边界
- **AND** MUST 串行完成输出排空、退出判定和必要的超时升级
- **AND** 同一次关闭 MUST NOT 产生多个冲突终态

#### Scenario: 温和终止超时

- **WHEN** 官方 CLI 或其后代在温和信号后的有限宽限期内未退出
- **THEN** Supervisor MUST 升级为强制终止
- **AND** MUST 在返回前复核本次调用创建且身份仍匹配的进程已退出或明确报告清理失败

#### Scenario: Shim 被强制终止

- **WHEN** 测试强制终止 Shim，使其无法自行运行普通清理逻辑
- **THEN** 外层 Launcher 或已建立的进程隔离机制 MUST 收敛本次 Shim 创建的官方 CLI 进程树
- **AND** Gate 完成后 MUST 不存在由本次 Probe 创建的孤儿 CLI 或假子进程

#### Scenario: PID 已被复用或身份不匹配

- **WHEN** 待清理 PID 的当前可执行路径、启动关系或其他身份信息不再匹配本次快照
- **THEN** Supervisor MUST 拒绝向该 PID 发送破坏性信号
- **AND** MUST 返回明确的身份冲突诊断

### Requirement: 捕获平台分区且经过脱敏的 macOS 证据

macOS Probe SHALL 以 allowlist 捕获判断 Gate 所需的 App/CLI/OS 版本、架构、argv、cwd、环境键存在性、PID/父 PID/process group、启动方式和退出分类。原始证据 MUST 保持 Git 忽略；可提交资产 MUST 与 Windows 资产分区并移除本地绝对路径、凭据、Prompt、Transcript 和 Tool 输出。

#### Scenario: Desktop 调用实验 Shim

- **WHEN** macOS Desktop 通过本次启动环境调用 Shim
- **THEN** Probe MUST 生成带 Schema 版本和平台标识的结构化记录
- **AND** 记录 MUST 足以关联启动方式、Desktop、Shim 和官方 CLI 进程
- **AND** 可提交 Fixture 中的本地路径 MUST 替换为稳定占位符

#### Scenario: 生成本地原始证据

- **WHEN** Probe 保存未经人工确认的调用、差分或生命周期记录
- **THEN** 记录 MUST 写入 macOS 专属的 Git 忽略目录
- **AND** MUST NOT 覆盖 Windows 本地或已提交证据

#### Scenario: 准备提交 Fixture

- **WHEN** 开发者将 macOS Gate 摘要加入仓库
- **THEN** 自动隐私测试和人工复核 MUST 确认其不包含完整环境、凭据、真实 Prompt、Transcript、Tool 输出或用户绝对路径
- **AND** Windows 既有 Fixture MUST 保持不变或经过显式评审迁移

### Requirement: 建立 macOS 分层透明代理验证

工程 MUST 同时提供跨平台共享 hermetic 测试、macOS 进程/信号 hermetic 测试、官方 CLI 直连/Shim 差分和带版本记录的真实 macOS Desktop Gate。依赖真实安装或认证的验证 MUST 使用独立命令，不得加入普通 `npm run check`。

#### Scenario: 执行普通质量检查

- **WHEN** 开发者或 CI 在 Windows 或 macOS 运行 `npm run check`
- **THEN** 对应平台的 argv/env、递归、字节透明、EOF、stderr、退出和有界清理 hermetic 测试 MUST 执行
- **AND** 流程 MUST NOT 启动真实 Codex Desktop或要求其已安装

#### Scenario: 执行 macOS 官方 CLI 差分

- **WHEN** 同一组无敏感输入分别经过 App bundle 官方 CLI 直连和共享 Shim 链路
- **THEN** 字节层 MUST 无差异
- **AND** 协议结果只可按已评审的动态字段和平台路径清单归一化
- **AND** 未知差异或非 JSON stdout MUST 使差分失败

#### Scenario: 执行真实 macOS Desktop 功能 Gate

- **WHEN** 在记录了 macOS、CPU 架构、Desktop、Codex CLI 和代码提交版本的环境执行 Gate
- **THEN** 验证 MUST 覆盖隔离启动、Thread 新建、继续、流式回复、工具调用和取消
- **AND** MUST 证明实际调用链经过 Shim 且 Codex Agent Loop 仍由官方 CLI 执行

#### Scenario: 执行真实 macOS 生命周期 Gate

- **WHEN** 对本次隔离 Desktop/Shim/CLI 链路执行正常退出、stdin EOF、CLI Crash、Shim 强制终止和 Desktop 强制终止场景
- **THEN** 每个场景 MUST 得到有界且可解释的终态
- **AND** 验证结束后 MUST 不存在由本次 Probe 创建的孤儿进程

### Requirement: 根据完整证据判定 macOS Gate A

macOS Gate A MUST 生成 `PASS`、`FAIL` 或 `BLOCKED` 结论。只有安装与 CLI 身份、隔离环境继承、共享 Shim 透明性、官方 CLI 差分、真实 Desktop 核心场景和生命周期场景全部通过时，结果才可为 `PASS`。

#### Scenario: 所有要求通过

- **WHEN** 当前记录版本上的全部自动化和真实 Desktop Gate 场景均有通过证据
- **THEN** 报告 MUST 标记为 `PASS`
- **AND** 报告 MUST 列出 macOS、架构、Desktop、CLI 和代码版本及脱敏证据位置
- **AND** macOS 原生边界 MAY 作为后续正式 Launcher/Shim 工作的已验证输入

#### Scenario: 核心不变量被证明不成立

- **WHEN** 隔离环境继承、透明转发、核心 Desktop 行为或有界生命周期中的任一不变量确定失败
- **THEN** 报告 MUST 标记为 `FAIL`
- **AND** MUST 记录失败阶段、证据、影响和下一产品或架构决策

#### Scenario: 环境或权限阻止判定

- **WHEN** 因现有实例、认证、系统权限或其他外部条件无法完成必要场景，且尚未证明核心不变量失败
- **THEN** 报告 MUST 标记为 `BLOCKED`
- **AND** MUST 明确列出已完成与被阻塞场景及解除条件

#### Scenario: Gate 未通过

- **WHEN** 报告结果不是 `PASS`
- **THEN** 开发清单和后续变更 MUST NOT 把 macOS Gate A 标记为已验证
- **AND** MUST NOT 使用全局环境修改、App bundle 改写或忽略未知差异的方式将结果提升为 `PASS`
