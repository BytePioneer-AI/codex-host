## MODIFIED Requirements

### Requirement: 错误契约必须结构化且向后兼容

`HarnessError`（`packages/harness-adapter/src/text-session.ts`）与共享的 `CodexhostError`（`packages/shared-contracts/src/errors.ts`）MUST 只增加可选字段：`stage`、`durationMs`、`stderrTail`。原有必填字段（`code`、`message`、`retryable`）及其语义 MUST NOT 改变，旧错误实例 MUST 继续可解析。Adapter 或 Renderer MUST NOT 把阶段、耗时、stderr、DSH token、cookie 或完整 launch URL 拼接进单个 `message` 字符串。

#### Scenario: 旧 Harness 返回无诊断字段的错误

- **WHEN** 一个 Harness 检查失败并返回仅含 `code`、`message`、`retryable` 的错误
- **THEN** Renderer 诊断页面 MUST 仍能渲染摘要与详情
- **AND** 新增的可选字段 MUST 保持缺失而不是被填充零值或占位文本

#### Scenario: 诊断字段跨进程传输

- **WHEN** Host 把 Adapter 的 `HarnessInspection` 结果透传给 Renderer
- **THEN** `stage`、`durationMs`、`stderrTail` MUST 通过现有 `harness/inspect` 响应链路传递
- **AND** MUST NOT 为此新增诊断专用 RPC 或持久化日志文件

#### Scenario: DSH release is recognized but unsupported

- **WHEN** DeepSeek Adapter detects a release other than `0.1.1-rc.2` or `0.1.2-rc.1`
- **THEN** it SHALL return `unsupported` with `retryable: false` and a correction-oriented update message
- **AND** the message SHALL explain once in Chinese and once in English that `dsh-v0.1.2-rc.1` is the recommended release
- **AND** the message SHALL contain neither the executable path nor any authentication value

#### Scenario: External Modern DSH requires authentication

- **WHEN** the configured or default loopback root exactly matches the bounded, unauthenticated Modern Web 401 fingerprint
- **THEN** it SHALL return `authenticationRequired`, `retryable: false`, `stage: wire-handshake` and `diagnostic: externalModernWeb`
- **AND** its message SHALL first explain in Chinese and then in English that the endpoint is not authenticated for this codexhost instance and that the user should close that DSH Web instance before rerunning connection diagnostics
- **AND** it SHALL NOT claim whether the process was started manually, by another codexhost instance or left behind by an earlier process
- **AND** it SHALL NOT exchange external credentials
- **AND** existing Renderer selection and diagnostics SHALL handle that standard error code without a DSH-specific RPC
- **AND** the Adapter SHALL inspect only that known target endpoint, not scan or discover DSH on any other port

#### Scenario: Another endpoint rejects the Legacy probe with authentication

- **WHEN** the Legacy probe receives HTTP 401 or 403 but the same root does not exactly match the bounded Modern Web authentication fingerprint
- **THEN** the Adapter SHALL preserve the generic `authenticationRequired` result with `diagnostic: HTTP_401` or `HTTP_403` and `stage: wire-handshake`
- **AND** it SHALL NOT identify that service as Modern DSH or echo any response body

### Requirement: Adapter 必须在检查时采集诊断事实

每个 Harness Adapter 的 `inspect` MUST 按阶段推进并记录当前阶段（例如 `resolve-executable`、`version`、`spawn`、`startup`、`authentication`、`wire-handshake`、`model-catalog`、`capabilities`），MUST 记录检查总耗时 `durationMs`。子进程 stdout/stderr MUST 使用 `pipe` 并持续消费，避免管道背压；stderr MUST 使用 `sanitizeDiagnosticTail` 只保留尾部约 8,000 字符。任何可能承载 launch token 的 DSH readiness stdout 必须由认证解析器独占，不得复制到 diagnostic tail。检查失败时 MUST 把安全的 `stage`、`durationMs` 和可用的脱敏 `stderrTail` 放入结构化错误返回。

#### Scenario: 新增一个 Harness 的连接检查

- **WHEN** 新 Harness 的 `inspect` 在启动阶段启动子进程并失败
- **THEN** 该 Adapter MUST 返回包含失败阶段、耗时的结构化错误
- **AND** 若子进程 stderr 有输出，MUST 返回脱敏且限长后的 `stderrTail`
- **AND** stdout/stderr 采集 MUST NOT 改变成功检查返回的 `status`、`catalog`、`capabilities`

#### Scenario: stderr 包含敏感值

- **WHEN** 子进程 stderr 中出现 `API_KEY=...`、`Authorization: Bearer ...` 等常见凭证形式
- **THEN** 复制到剪贴板或展示在页面上的文本 MUST 以 `[redacted]` 替换凭证值
- **AND** 完整原始 stderr MUST NOT 出现在受版本控制文件或诊断副本中

#### Scenario: DSH readiness stdout contains a bootstrap token

- **WHEN** a managed supported Modern release prints its tokenized readiness URL
- **THEN** the Adapter SHALL parse it within a finite line/accumulator bound and pass it directly to authentication
- **AND** the full line, token and later Cookie/Set-Cookie values MUST NOT appear in `message`, `diagnostic`, `stderrTail`, logs or copied diagnostics

#### Scenario: A diagnostic input exceeds its bound

- **WHEN** stdout produces an overlong readiness line or stderr exceeds the retained tail
- **THEN** overlong readiness SHALL fail the corresponding startup safely while stderr SHALL retain only its sanitized bounded tail
- **AND** continuous pipe consumption SHALL continue until the owned process exits
