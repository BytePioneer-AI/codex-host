# Spec Delta

## Purpose

Web 草稿的语音输入能力：使用本机 Codex ChatGPT 登录态把用户录音转成文字并插入当前草稿，与所选 Harness 无关，不影响 Codex Desktop。

## ADDED Requirements

### Requirement: 语音入口按本机凭证显示
Web 输入框 SHALL 仅在本机 Codex 凭证文件存在、为 ChatGPT 登录且身份字段有效时显示语音入口；无凭证、API Key 登录或凭证无法解析时 MUST NOT 显示。判断 MUST NOT 启动 Codex 进程，且 SHALL 在输入框出现及页面重新可见时重新判断，以反映登录、退出与切换账号。

#### Scenario: ChatGPT 登录可用
- **WHEN** 本机 Codex 凭证为有效的 ChatGPT 登录
- **THEN** 输入框显示麦克风按钮

#### Scenario: 无凭证或 API Key 登录
- **WHEN** 本机没有 Codex 凭证文件，或凭证为 API Key 登录
- **THEN** 输入框不显示麦克风按钮，且没有启动任何 Codex 进程

#### Scenario: 页面返回前台时登录已变化
- **WHEN** 用户在其他地方退出 Codex 登录后切回 Web 页面
- **THEN** 麦克风按钮消失

### Requirement: 不按网页协议限制入口
系统 MUST NOT 因页面使用 HTTP 而隐藏或禁用语音入口，也 MUST NOT 强制跳转 HTTPS。用户点击后 SHALL 检查浏览器录音能力并申请麦克风权限；不支持、被拒绝或没有麦克风时 SHALL 显示对应原因。

#### Scenario: 浏览器禁止非安全页面录音
- **WHEN** 用户通过局域网 HTTP 地址打开 Web，并点击麦克风按钮，浏览器不提供录音能力
- **THEN** 显示“当前浏览器环境不允许录音”一类原因，按钮保持可见

#### Scenario: 用户拒绝麦克风权限
- **WHEN** 用户在浏览器权限提示中拒绝
- **THEN** 显示权限被拒绝的原因，不开始录音

### Requirement: 录音转写并插入草稿
用户 SHALL 能开始、停止、取消录音，或在录音中选择“转写并发送”。停止后系统 SHALL 把转写文字插入开始录音时的草稿位置且不发送；选择转写并发送时 SHALL 在插入成功后提交草稿。若期间草稿已变化、会话已切换或输入框被锁定，系统 MUST NOT 覆盖、插入到其他会话或发送，SHALL 保留文字供用户手动插入或复制。

#### Scenario: 正常转写
- **WHEN** 用户录音后点击停止，服务返回文字
- **THEN** 文字插入当前草稿的录音起始位置，消息未被发送

#### Scenario: 转写并发送
- **WHEN** 用户录音中点击发送，服务返回文字
- **THEN** 文字插入录音起始位置后，草稿随即被提交

#### Scenario: 转写并发送时草稿已变化
- **WHEN** 用户点击发送后、转写返回前编辑了草稿
- **THEN** 不插入也不发送，转写文字保留供用户处理

#### Scenario: 转写期间切换会话
- **WHEN** 转写进行中用户切换到另一个会话
- **THEN** 文字不插入新会话，原结果以可复制或可插入的形式保留

#### Scenario: 取消录音
- **WHEN** 用户在录音中点击取消
- **THEN** 不上传音频，并释放麦克风

### Requirement: 录音反馈与可撤销取消
录音中 SHALL 显示随真实音量变化的声波与计时，持续约 3 秒无声时 SHALL 提示没有听到声音。录音期间 MUST NOT 移动、隐藏或遮盖输入框工具栏的其他控件。录音满 15 秒后取消 SHALL 提供短时撤销，撤销后照常转写并插入草稿；未撤销则丢弃录音。错误与无法自动插入的结果 SHALL 显示在输入框内，不自动消失。

#### Scenario: 麦克风没有收到声音
- **WHEN** 录音中连续约 3 秒没有声音
- **THEN** 声波变为静止并提示没有听到声音，录音继续

#### Scenario: 撤销长录音的取消
- **WHEN** 用户录音 20 秒后点击取消，并在 5 秒内点击撤销
- **THEN** 录音被转写并插入草稿，不发送

#### Scenario: 短录音取消
- **WHEN** 用户录音 5 秒后点击取消
- **THEN** 录音立即丢弃，不上传

### Requirement: 凭证只读且不外泄
系统 SHALL 只读取本机 Codex 凭证文件，MUST NOT 启动或连接 Codex 进程、刷新凭证、修改凭证文件或连接 Codex Desktop。凭证 MUST NOT 返回浏览器、写入日志或持久化到其他位置。凭证过期或被服务拒绝认证时 SHALL 报告登录失效，并提示用户使用一次 Codex 以刷新登录。

#### Scenario: 凭证已过期
- **WHEN** 凭证已过期或服务返回认证失败
- **THEN** 报告登录失效及处理提示，凭证文件内容与修改时间不变

#### Scenario: Desktop 未运行
- **WHEN** Codex Desktop 与 Codex CLI 均未运行，仅 codexhost Host 与 Web 运行
- **THEN** 语音输入可正常转写

### Requirement: 音频不留存
音频 MUST NOT 成为会话附件、进入 Thread 历史或日志；为转写临时保存的音频 SHALL 在请求结束（成功、失败或取消）后删除。系统 SHALL 拒绝空音频及超过 10 MiB 的音频，并给出明确原因。转写失败后浏览器 SHALL 保留本次录音，直到用户重试或丢弃。

#### Scenario: 转写失败后重试
- **WHEN** 转写因网络超时失败
- **THEN** 显示失败原因，并提供重试与丢弃；服务端临时文件已删除

#### Scenario: 音频过大
- **WHEN** 上传音频超过 10 MiB
- **THEN** 请求被拒绝并提示音频过大，未发往转写服务

### Requirement: 区分失败原因
系统 SHALL 区分并显示以下失败：凭证不可用或已失效、服务限流、服务拒绝请求、网络失败或超时、音频为空或格式不被接受。系统 MUST NOT 自动重试转写请求。

#### Scenario: 服务限流
- **WHEN** 转写服务返回限流
- **THEN** 显示限流原因，不自动重试
