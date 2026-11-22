# Proposal

## Why

Web（尤其是手机）上长句输入不便。实测证明，用本机 Codex 的 ChatGPT 登录态即可调用官方语音转文字服务，无需启动 Codex Desktop 或 Codex CLI，因此可以给 Web 加一个与当前 Harness 无关的语音输入入口。

## What Changes

- Web 输入框增加麦克风按钮：录完再转写，文字插入当前草稿；停止录音只插入不发送，录音中点击发送则插入后直接提交。
- 仅当本机存在可用的 Codex ChatGPT 登录凭证时显示入口；API Key 登录或无凭证时不显示。
- Host 只读本机 Codex 凭证文件，代表用户请求官方转写服务；Web Server 只负责接收浏览器音频并交给 Host。
- 不按 HTTP／HTTPS 主动限制入口；浏览器不支持录音或拒绝权限时显示原因。
- 不改 Codex Desktop 界面，不连接 Desktop，不影响官方 Codex Thread 的原生听写。

## Decisions

- **只读凭证文件，不启动 Codex 进程、不刷新凭证。** 只开 Web 时不应依赖 Codex 进程。刷新会轮换 Refresh Token，可能让 Codex 自身掉登录或与其写入冲突；因此凭证过期时提示用户用一次 Codex 刷新登录。放弃：经官方 app-server 取凭证与刷新。
- **转写放在 Host，不放 Web Server 或 Codex CLI Adapter。** Codex Account 凭证的读取已归 Host 所有；转写属于 Account 级输入辅助，与所选 Harness 无关。
- **音频经 Web 本地文件交接，不新增二进制通道。** 沿用 Web 附件“Web 落盘、Host 按路径读取”的模式，Host 请求只带路径，不受客户端通道 1 MiB 限制。
- **第一版不做**：流式转写、语言选择、服务端转码、自动重试、录音文件上传入口、Desktop 内的语音入口、非默认 workspace 后端地址的探测。

## Capabilities

### New Capabilities

- `web-voice-input`: Web 草稿的语音输入：入口可用性、录音转写回填、凭证只读与音频不留存。

### Modified Capabilities

无。

## Impact

- `packages/host-runtime`：复用现有 Codex 凭证解析，新增转写服务及两个客户端通道方法（可用性、转写）。
- `packages/shared-contracts`：上述方法的请求、结果与错误类型，不含凭证字段。
- `packages/web-server`：新增浏览器音频上传路由与可用性查询，管理临时音频文件。
- `apps/web-ui`（`ui-codexhost`）：麦克风按钮与录音交互，使用现有输入框插入接口。
- 不新增依赖、持久化格式或 Desktop 改动；官方转写服务为内部接口，见 design 风险。
