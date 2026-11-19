# Design

## Context

- 本变更跨 Host、共享契约、Web Server 与 Web UI，并代表用户使用 Codex Account 凭证访问官方服务，因此需要先定下凭证与流量的归属。
- `host-runtime/src/account/codex-credential-export.ts` 已直接读取 `CODEX_HOME/auth.json`（默认 `~/.codex`），校验 ChatGPT 登录、官方客户端 ID、账号 ID 一致性与过期时间；目前用于凭证导入。
- Web 附件已采用“Web Server 写入本机文件、Host 按路径读取”的交接方式；Web 与 Host 之间的客户端通道 JSON 请求上限为 1 MiB。
- 官方 app-server 协议（`codex-cli 0.161.0`）没有听写方法；`thread/realtime/*` 是绑定 Thread 的实时语音会话，语义不同，不借用。
- 实测：`POST https://chatgpt.com/backend-api/transcribe`，multipart 字段 `file`，返回 `{ text }`；需要 `Authorization`、`ChatGPT-Account-Id`，以及服务认可的 Codex 客户端标识（`originator` 与 `User-Agent`），否则返回 HTML 403。实验脚本见 `.work/voice-transcription-probe/`。

## Decisions

- **链路**：浏览器 `MediaRecorder` → `POST /api/voice/transcribe`（原始字节，沿用 Web 认证与同源校验）→ Web Server 写入 Web 数据目录下的临时文件 → 客户端通道 `codexhost/voice/transcribe { path, mimeType }` → Host 读凭证与音频、请求官方服务 → `{ text }`。Web Server 在 `finally` 中删除临时文件。
- **可用性**：客户端通道 `codexhost/voice/status` 只读凭证文件，返回 `{ available }`；Web Server 经现有 JSON RPC 转给浏览器。不新增推送或文件监听，由输入框出现及页面重新可见时查询。凭证已过期仍返回可用，在转写时报告登录失效，避免按钮无故消失。
- **凭证**：复用现有解析逻辑，抽出供凭证导入与转写共用，不新写一份。每次请求重新读取文件；读取或解析失败时重读一次，仍失败即视为不可用（应对 Codex 正在写入）。不刷新、不缓存、不写回。
- **后端地址**：固定为 `https://chatgpt.com`，`redirect: "error"`。不探测 workspace 指定的后端地址；被服务拒绝时按“服务拒绝请求”报告。
- **客户端标识**：集中在转写模块中的一个常量，使用实测通过的值；服务改变要求时只改这一处。
- **网络**：Host 使用 Node 内置 `fetch`，依赖平台已为 Host 设置的 `NODE_USE_ENV_PROXY`；设置 90 秒超时。
- **Host 侧校验**：路径必须是普通文件，大小 1 字节至 10 MiB，MIME 为 `audio/*`。客户端通道本身是已认证的本机 Owner 通道，信任级别与 `turn/start` 相同，不再额外限定目录。
- **Web UI**：放在 `ui-codexhost`，入口与录音条都在 `conversation.input.right`：录音时麦克风原位变为“完成”，录音条向左展开，含取消、声波、计时与独立的“转写并发送”，不移动、不遮盖其他控件；错误、撤销与无法插入的结果在新增的 `conversation.input.notice`（输入框卡片内、草稿上方），这是 `ui-conversation` 的一处小幅公开扩展。快捷键 ⌘/Ctrl + Shift + Space 开始/完成，Esc 取消；开始录音时调用 `captureInsertion()`，结果用 `insertText()` 插入，返回 `false` 时保留文字并提供复制或插入。录音格式按 `MediaRecorder.isTypeSupported` 依次选择 WebM/Opus、MP4/AAC，按实际 MIME 上传；单次录音最长 5 分钟，到时自动停止。

## Risks / Trade-offs

- [官方转写为内部接口，地址、请求头或额度规则可能变化] → 请求细节集中在一个模块；失败按类别清楚报告，不静默降级。
- [使用 Desktop 的客户端标识可能被服务端视为 Desktop 流量] → 仅用于用户本人账号、用户主动发起的转写；在功能文档中说明。
- [凭证过期后需用户使用一次 Codex] → 第一版接受；如需改进，再单独评估“装有 Codex 时临时请官方进程刷新”。
- [与 Desktop 听写共用账号额度] → 文档说明，不做额度预测。
- [凭证存放在系统钥匙串的用户无法使用] → 视为无凭证，不显示入口。

## Migration

无持久化变化。回滚时移除新路由、客户端通道方法与按钮即可；更新 Host 需要重启，会中断其运行中的任务。
