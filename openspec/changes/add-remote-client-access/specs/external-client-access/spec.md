## MODIFIED Requirements

### Requirement: 外部客户端可以作为委派来源
外部客户端 SHALL 可以在其权限范围内调用委派与 Thread 操作，语义与输出形状与 CLI 一致。客户端未指定父 Thread 发起 `delegate start` 时，Host SHALL 创建以该客户端为来源的 Thread，并持久记录来源；指定父 Thread 时按现有父子血缘处理。以客户端为来源的 Thread SHALL 像其他 Thread 一样出现在 Desktop 侧栏，可由用户打开接管。

#### Scenario: 客户端发起无父 Thread 的委派
- **WHEN** 客户端 `grok-bot` 执行 `delegate start --harness codex --cwd <dir> --task <text>` 且未提供 `--parent-thread`
- **THEN** Host SHALL 创建并启动新 Thread，响应中的来源 SHALL 为 `client:grok-bot`
- **AND** MUST NOT 要求当前存在活跃 Turn 来推断调用方

#### Scenario: 客户端发起的 Thread 在侧栏可见
- **WHEN** 客户端发起的 Thread 已创建
- **THEN** 用户 SHALL 能在 Desktop 侧栏的对应工作目录下看到并打开它
- **AND** 打开后 SHALL 可以像普通 Thread 一样继续对话或接管

#### Scenario: 多个 Host 会话时的路由
- **WHEN** Runtime 同时有多个可受理创建的 Host 会话，且请求未指定目标
- **THEN** Host SHALL 路由到本机 Desktop 会话
- **AND** 无法唯一确定时 SHALL 以可辨识的歧义错误失败，MUST NOT 任意选择

#### Scenario: 超出权限范围
- **WHEN** 权限范围为 `read` 的客户端发起委派、发送或取消
- **THEN** 请求 SHALL 以 `FORBIDDEN` 失败，且 MUST NOT 改变任何 Thread
