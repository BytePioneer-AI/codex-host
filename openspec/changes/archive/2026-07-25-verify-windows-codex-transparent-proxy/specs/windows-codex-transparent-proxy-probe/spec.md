## ADDED Requirements

### Requirement: 隔离启动 Windows Codex Desktop

Probe MUST 发现当前 Windows Codex Desktop 安装，并且只通过本次启动进程的环境把绝对 `CODEX_CLI_PATH` 指向实验 Shim。Probe MUST NOT 永久修改用户级或系统级环境、官方安装文件或 `app.asar`。

#### Scenario: 启动新的 Desktop Probe 实例

- **WHEN** 目标 Codex Desktop 未运行且安装可被支持的 Windows 启动方式发现
- **THEN** Probe MUST 使用仅作用于本次启动的环境启动 Desktop
- **AND** Desktop 后续 CLI 调用 MUST 到达指定实验 Shim

#### Scenario: Desktop 已经运行

- **WHEN** Probe 检测到目标 Codex Desktop 实例已经运行
- **THEN** Probe MUST 拒绝复用或终止该实例
- **AND** Probe MUST 返回可操作诊断，说明需要先正常关闭现有实例

#### Scenario: 安装或环境继承不可验证

- **WHEN** Probe 无法可靠发现目标安装、启动新实例或证明环境被继承
- **THEN** Probe MUST 以非零状态结束并保留失败证据
- **AND** Probe MUST NOT 回退到修改全局环境或官方安装内容

### Requirement: 捕获最小且脱敏的调用证据

Probe SHALL 记录判断 `CODEX_CLI_PATH` 接入所需的 argv、cwd、环境键存在性、stdio/退出分类、进程关系和产品版本。捕获 MUST 使用 allowlist，仓库 MUST NOT 接收未脱敏环境、凭据、Prompt、完整消息、Tool 输出或 Transcript。

#### Scenario: Desktop 调用实验 Shim

- **WHEN** 实验 Shim 收到 Desktop 发起的调用
- **THEN** Probe MUST 生成带 schema 版本的结构化调用记录
- **AND** 记录 MUST 足以区分 app-server 与观察到的非 app-server 调用
- **AND** 本地绝对路径和其他敏感值 MUST 在可提交 Fixture 中替换为稳定占位符

#### Scenario: 产生原始捕获

- **WHEN** Probe 为诊断暂存未经人工确认的原始记录
- **THEN** 原始记录 MUST 写入 Git 忽略的本地目录
- **AND** 只有经过确定性脱敏和人工检查的 Fixture 或摘要 MAY 进入仓库

### Requirement: 明确定位官方 Codex CLI 并阻止递归

Launcher MUST 在设置 Shim 路径前解析当前 Desktop 对应的官方 Codex CLI 绝对路径，Shim MUST 使用该明确路径启动官方 CLI。Shim MUST NOT 依赖当前 `PATH` 猜测目标，并 MUST 在创建子进程前清除或重写 `CODEX_CLI_PATH`。

#### Scenario: 转发已观察到的调用

- **WHEN** Shim 收到 app-server 或非 app-server 调用且官方 CLI 路径有效
- **THEN** Shim MUST 使用原 argv 启动该官方 CLI
- **AND** 子进程环境 MUST NOT 再把 `CODEX_CLI_PATH` 指向当前 Shim

#### Scenario: 官方 CLI 解析到 Shim 自身

- **WHEN** 规范化后的官方 CLI 路径与当前 Shim 路径相同或再次形成递归链
- **THEN** Shim MUST 在创建子进程前失败
- **AND** stdout MUST NOT 输出诊断或伪造协议数据

#### Scenario: 官方 CLI 路径无效

- **WHEN** 明确传入的官方 CLI 不存在、不可执行或不属于当前验证安装
- **THEN** Shim MUST 明确失败且不得回退到任意全局 `codex`

### Requirement: 保持 stdio 字节透明

Shim MUST 在不解析、不重新序列化且不改变 chunk 内容的情况下双向转发父 stdin 与官方 CLI stdout，并将官方 CLI stderr 转发到父 stderr。Shim 自身 MUST NOT 向 stdout 写入日志、状态文本或任何非子进程输出。

#### Scenario: 任意 chunk 边界的双向数据

- **WHEN** 父进程和官方 CLI 交换包含拆分 JSONL、多行或非 UTF-8 边界的字节序列
- **THEN** 接收端 MUST 以相同顺序收到完全相同的字节
- **AND** Shim MUST NOT 添加、删除或规范化换行

#### Scenario: 父 stdin 到达 EOF

- **WHEN** 父 stdin 关闭
- **THEN** Shim MUST 关闭官方 CLI stdin
- **AND** Shim MUST 继续排空官方 CLI stdout 与 stderr，直到子进程退出或有界关闭升级

#### Scenario: Shim 产生诊断

- **WHEN** Shim 记录启动、错误或关闭诊断
- **THEN** 诊断 MUST 只进入 stderr 或受限本地日志
- **AND** stdout MUST 仍只包含官方 CLI 输出

### Requirement: 保持进程生命周期和终态

Shim SHALL 传播官方 CLI 的正常退出和失败状态，并在取消、父进程终止或异常关闭时有界清理其创建的官方 CLI 进程树。所有 stdio 泵 MUST 在退出前得到完成、关闭或明确的超时升级结果。

#### Scenario: 官方 CLI 正常或失败退出

- **WHEN** 官方 CLI 返回可表示的退出码
- **THEN** Shim MUST 在排空输出后返回相同退出码

#### Scenario: 官方 CLI 崩溃或无法启动

- **WHEN** 官方 CLI 无法创建或异常终止且没有普通退出码
- **THEN** Shim MUST 返回非零状态并在 stderr 提供受限诊断
- **AND** Shim MUST NOT 在 stdout 注入错误对象

#### Scenario: Desktop 取消或终止 Shim

- **WHEN** Desktop 关闭输入、发送受支持的取消信号或终止 Shim
- **THEN** Shim MUST 在有界时间内结束官方 CLI 及其由本次调用创建的进程树
- **AND** 验证结束后 MUST NOT 留下由 Probe 创建的孤儿进程

### Requirement: 建立分层透明代理验证

工程 MUST 同时提供不依赖真实 Desktop 的 hermetic 测试、官方 CLI 直连/Shim 差分测试和带版本记录的真实 Windows Desktop Gate。依赖真实外部安装的 Gate MUST 通过独立命令执行，不得加入普通 `npm run check`。

#### Scenario: 执行普通质量检查

- **WHEN** 开发者或 CI 运行 `npm run check`
- **THEN** argv/env、递归、字节透明性、EOF、退出码和进程清理的 hermetic 测试 MUST 执行
- **AND** 流程 MUST NOT 启动真实 Codex Desktop 或依赖其安装

#### Scenario: 执行官方 CLI 差分

- **WHEN** 同一组无敏感测试输入分别经过官方 CLI 直连和 Shim 链路
- **THEN** 字节转发层 MUST 无差异
- **AND** 协议结果仅可按已评审的动态字段清单归一化
- **AND** 未知差异 MUST 使差分失败而不是自动更新 Golden

#### Scenario: 执行真实 Desktop Gate

- **WHEN** 在记录了 Desktop、Codex CLI、操作系统和构建版本的 Windows 环境执行 Gate
- **THEN** 验证 MUST 覆盖启动、新建 Thread、继续 Thread、流式回复、工具调用和取消
- **AND** 验证 MUST 生成 PASS、FAIL 或 BLOCKED 结论及对应证据

#### Scenario: Gate 未通过

- **WHEN** 真实 Desktop Gate 结果为 FAIL 或 BLOCKED
- **THEN** 结果 MUST 记录失败阶段、证据、影响和下一决策
- **AND** 后续正式实现 MUST NOT 把 Windows 透明代理标记为已验证能力
