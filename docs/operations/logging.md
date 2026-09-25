# 运行日志

Host Runtime 把诊断记录写成 JSONL 文件，每行一条 JSON。日志的用途是收集和排查问题，因此只记录元数据，不记录会话内容。

## 位置

```text
<CODEXHOST_DATA_DIR 或 ~/.codexhost>/logs/
├── threads/<hostThreadId>.jsonl   # 对话级：一个外部 Harness Thread 一个文件
└── runtime/host-<日期>-<pid>.jsonl # 进程级：不属于任何 Thread 的事件
```

对话级日志只覆盖外部 Harness Thread。官方 Codex Thread 由 Codex Desktop 自己记录，Host 只做透传；Host 在转发官方请求时出错会写进进程级日志。

跟踪某个对话（PowerShell）：

```powershell
Get-Content "$env:USERPROFILE\.codexhost\logs\threads\<hostThreadId>.jsonl" -Wait
```

## 记录边界

每行都带 `ts`、`level`、`event`、`pid`，对话级日志另外带 `hostThreadId` 和 `harnessId`。

会记录：

- Thread 生命周期：创建、恢复及其耗时、空闲释放、删除
- Session：Model / Thinking / Permission Mode 的变化，以及 `session.faulted` 的错误 code、stage、可重试性和耗时
- Turn：开始，以及结束时的状态、耗时、错误、各类 Item 的数量和 token 用量
- Item：仅在完成时记一条，包含类型、状态、耗时、增量更新次数和文本字节数；命令只记退出码，工具只记名称，文件变更只记文件数
- 交互：Approval / Question 的打开与关闭及关闭原因
- 失败的 Thread 级 Desktop 请求：方法名与错误码

一概不记录：prompt、模型回复与 reasoning 正文、工具输入输出、命令行文本、文件内容与 diff、环境变量值、凭据与 Token、原始协议帧。原生错误可能回显这些内容，因此落盘时也会移除错误消息、diagnostic、stderr 尾部、异常 cause 和自由文本取消原因，仅保留结构化错误元数据；`debug` 级别同样遵守此边界。

兜底措施：凭据形状的字段名和内联密钥被替换为 `[redacted]`；路径中的用户主目录替换为 `~`；过长字符串被截断；单条记录超过 16 KiB 时只保留头部字段。

## 容量与回收

| 规则 | 默认值 |
| --- | --- |
| 单个文件上限 | 5 MiB，写满后轮转一次为 `<name>.1.jsonl` |
| 保留期 | 最后修改超过 14 天即删除 |
| `logs/` 总量上限 | 200 MiB，超出后从最旧的文件开始删 |
| 回收时机 | Host 启动 1 分钟后执行一次，之后每 24 小时一次 |

最近 1 小时内写过的文件不会因为容量上限被删除，避免影响正在运行的 Host。删除对话不会连带删除它的日志，由回收机制统一处理。

## 配置

| 变量 | 作用 |
| --- | --- |
| `CODEXHOST_LOG_LEVEL` | `error`、`warn`、`info`（默认）、`debug`，或 `off` 完全关闭 |
| `CODEXHOST_DATA_DIR` | 同时移动日志和其他 codexhost 数据 |

`debug` 会额外记录 Item 开始、用量变化和成功的 Thread 级请求，适合定位具体问题，不建议长期开启。

提交 issue 时可以附上相关对话的 JSONL 文件。文件本身不含会话内容，但仍建议提交前自行确认。
