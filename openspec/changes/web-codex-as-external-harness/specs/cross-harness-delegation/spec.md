# Spec Delta

## ADDED Requirements

### Requirement: 官方 Codex Thread 不委派给仅 Web 的 Harness

调用方被解析为官方 Codex Thread 时，Host SHALL 从可委派 Harness 列表中排除仅 Web 的 Harness，并 SHALL 以与 Harness 不存在相同的错误拒绝向其创建委派。调用方为外部 Thread 时，仅 Web 的 Harness SHALL 与其他已安装 Harness 一样可被列出和委派。

#### Scenario: 官方 Codex Thread 列出可委派 Harness
- **WHEN** 调用方为官方 Codex Thread 并列出可委派 Harness
- **THEN** 结果 SHALL 不包含仅 Web 的 Harness

#### Scenario: 官方 Codex Thread 委派给仅 Web 的 Harness
- **WHEN** 调用方为官方 Codex Thread 并请求委派给仅 Web 的 Harness
- **THEN** Host SHALL 以 Harness 不存在的错误拒绝且不创建子 Thread

#### Scenario: 外部 Thread 委派给仅 Web 的 Harness
- **WHEN** 调用方为外部 Thread 并请求委派给仅 Web 的 Harness
- **THEN** Host SHALL 按通用委派规则创建子 Thread
